// Account security: second factor (authenticator app with recovery codes, passkeys), passwordless passkey sign-in,
// session overview with «sign out everywhere». Admins can reset a locked-out person's second factor.
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticationResponseJSON, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { and, desc, eq, gt, isNull, ne } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";
import { HttpError, requireRole, requireUser, type AppContext } from "../app";
import { sha256, verifyPassword } from "../auth/crypto";
import { newRecoveryCodes, newTotpSecret, otpauthUrl, verifyTotp } from "../auth/totp";
import { organizations, passkeys, passwordTokens, sessions, users } from "../db/schema";
import { signIn } from "./auth";

const code = z.string().trim().min(6).max(20);

/** Relying party of the current request: the host the person is using (own company domain or the main domain). */
function rp(req: FastifyRequest, ctx: AppContext) {
  const host = (req.headers.host ?? new URL(ctx.config.APP_URL).host).split(":")[0]!;
  const proto = req.headers["x-forwarded-proto"] ?? (ctx.config.APP_URL.startsWith("https") ? "https" : "http");
  const port = (req.headers.host ?? "").split(":")[1];
  return { rpID: host, origin: `${proto}://${host}${port ? `:${port}` : ""}` };
}

// Challenges live a few minutes; keyed by the challenge itself.
const challenges = new Map<string, { userId: string | null; until: number }>();
const putChallenge = (challenge: string, userId: string | null) => {
  for (const [k, v] of challenges) if (v.until < Date.now()) challenges.delete(k);
  challenges.set(challenge, { userId, until: Date.now() + 5 * 60_000 });
};
const takeChallenge = (challenge: string) => {
  const c = challenges.get(challenge);
  challenges.delete(challenge);
  return c && c.until > Date.now() ? c : null;
};
const challengeOf = (response: { response: { clientDataJSON: string } }) => {
  try {
    return String(JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8")).challenge ?? "");
  } catch {
    return "";
  }
};

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64url");

export async function securityRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  const loadUser = async (id: string) => {
    const [u] = await ctx.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!u) throw new HttpError(404, "Benutzer nicht gefunden.");
    return u;
  };
  const appName = async (orgId: string) => (await ctx.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1))[0]?.settings.branding.appName ?? "TrackInsight";

  /** Resolves a pending second-factor token (from /api/auth/login) to the user; consumed on success by the caller. */
  const pending = async (token: string) => {
    const [row] = await ctx.db
      .select()
      .from(passwordTokens)
      .where(and(eq(passwordTokens.id, sha256(token)), eq(passwordTokens.purpose, "2fa"), isNull(passwordTokens.usedAt), gt(passwordTokens.expiresAt, new Date())))
      .limit(1);
    if (!row) throw new HttpError(401, "Die Anmeldung ist abgelaufen. Bitte erneut mit Passwort anmelden.");
    return row;
  };
  const consume = (id: string) => ctx.db.update(passwordTokens).set({ usedAt: new Date() }).where(eq(passwordTokens.id, id));

  // ---------- overview ----------

  app.get("/api/me/security", async (req) => {
    const me = requireUser(req);
    const u = await loadUser(me.id);
    const keys = await ctx.db.select().from(passkeys).where(eq(passkeys.userId, me.id)).orderBy(desc(passkeys.createdAt));
    return {
      totp: !!u.totpEnabledAt,
      recoveryCodesLeft: u.recoveryCodes?.length ?? 0,
      passkeys: keys.map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, backedUp: k.backedUp })),
      hasPassword: u.passwordHash !== null,
    };
  });

  // ---------- authenticator app ----------

  app.post("/api/me/totp/setup", async (req) => {
    const me = requireUser(req);
    const secret = newTotpSecret();
    await ctx.db.update(users).set({ totpSecret: secret, totpEnabledAt: null }).where(eq(users.id, me.id));
    const url = otpauthUrl(await appName(me.organizationId), me.email, secret);
    return { secret, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) };
  });

  app.post("/api/me/totp/enable", async (req) => {
    const me = requireUser(req);
    const { code: c } = z.object({ code }).parse(req.body);
    const u = await loadUser(me.id);
    if (!u.totpSecret || u.totpEnabledAt) throw new HttpError(400, "Zuerst die Einrichtung starten.");
    if (!verifyTotp(u.totpSecret, c)) throw new HttpError(400, "Der Code stimmt nicht. Bitte den aktuellen Code aus der App eingeben.");
    const codes = newRecoveryCodes();
    await ctx.db.update(users).set({ totpEnabledAt: new Date(), recoveryCodes: codes.map(sha256) }).where(eq(users.id, me.id));
    return { ok: true, recoveryCodes: codes };
  });

  app.post("/api/me/totp/recovery", async (req) => {
    const me = requireUser(req);
    const { password } = z.object({ password: z.string().max(500) }).parse(req.body);
    const u = await loadUser(me.id);
    if (!u.totpEnabledAt) throw new HttpError(400, "Die Authenticator-App ist nicht eingerichtet.");
    if (!(await verifyPassword(password, u.passwordHash))) throw new HttpError(400, "Das Passwort ist falsch.");
    const codes = newRecoveryCodes();
    await ctx.db.update(users).set({ recoveryCodes: codes.map(sha256) }).where(eq(users.id, me.id));
    return { recoveryCodes: codes };
  });

  app.delete("/api/me/totp", async (req) => {
    const me = requireUser(req);
    const { password } = z.object({ password: z.string().max(500) }).parse(req.body);
    const u = await loadUser(me.id);
    if (u.passwordHash && !(await verifyPassword(password, u.passwordHash))) throw new HttpError(400, "Das Passwort ist falsch.");
    await ctx.db.update(users).set({ totpSecret: null, totpEnabledAt: null, recoveryCodes: null }).where(eq(users.id, me.id));
    return { ok: true };
  });

  /** Second step of the sign-in: code from the app or a recovery code. */
  app.post("/api/auth/2fa/totp", async (req, reply) => {
    const body = z.object({ token: z.string().min(10), code }).parse(req.body);
    const row = await pending(body.token);
    const u = await loadUser(row.userId);
    const c = body.code.toLowerCase().replace(/\s+/g, "");
    let ok = !!u.totpSecret && !!u.totpEnabledAt && verifyTotp(u.totpSecret, c);
    if (!ok && u.recoveryCodes?.includes(sha256(c))) {
      ok = true;
      await ctx.db.update(users).set({ recoveryCodes: u.recoveryCodes.filter((h) => h !== sha256(c)) }).where(eq(users.id, u.id));
    }
    if (!ok) throw new HttpError(401, "Der Code stimmt nicht.");
    await consume(row.id);
    return signIn(ctx, req, reply, u.id);
  });

  // ---------- passkeys ----------

  const toCredential = (k: typeof passkeys.$inferSelect) => ({ id: k.id, publicKey: new Uint8Array(Buffer.from(k.publicKey, "base64url")), counter: k.counter, transports: k.transports ?? undefined });

  app.post("/api/me/passkeys/options", async (req) => {
    const me = requireUser(req);
    const { rpID } = rp(req, ctx);
    const existing = await ctx.db.select().from(passkeys).where(eq(passkeys.userId, me.id));
    const options = await generateRegistrationOptions({
      rpName: await appName(me.organizationId),
      rpID,
      userName: me.username,
      userDisplayName: me.name,
      userID: new Uint8Array(Buffer.from(me.id.replace(/-/g, ""), "hex")),
      attestationType: "none",
      excludeCredentials: existing.map((k) => ({ id: k.id, transports: k.transports ?? undefined })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    putChallenge(options.challenge, me.id);
    return options;
  });

  app.post("/api/me/passkeys", async (req, reply) => {
    const me = requireUser(req);
    const body = z.object({ name: z.string().trim().min(1).max(80), response: z.custom<RegistrationResponseJSON>((v) => typeof v === "object" && v !== null) }).parse(req.body);
    const { rpID, origin } = rp(req, ctx);
    const ch = takeChallenge(challengeOf(body.response));
    if (!ch || ch.userId !== me.id) throw new HttpError(400, "Die Registrierung ist abgelaufen. Bitte erneut versuchen.");
    let v;
    try {
      v = await verifyRegistrationResponse({ response: body.response, expectedChallenge: (c) => c === challengeOf(body.response), expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false });
    } catch (e) {
      throw new HttpError(400, `Passkey konnte nicht geprüft werden: ${(e as Error).message}`);
    }
    if (!v.verified) throw new HttpError(400, "Passkey konnte nicht geprüft werden.");
    const c = v.registrationInfo.credential;
    await ctx.db.insert(passkeys).values({ id: c.id, userId: me.id, publicKey: b64(c.publicKey), counter: c.counter, transports: c.transports ?? null, name: body.name, backedUp: v.registrationInfo.credentialBackedUp });
    return reply.status(201).send({ id: c.id, name: body.name });
  });

  app.delete("/api/me/passkeys/:id", async (req) => {
    const me = requireUser(req);
    const { id } = req.params as { id: string };
    const res = await ctx.db.delete(passkeys).where(and(eq(passkeys.id, id), eq(passkeys.userId, me.id)));
    if (!res[0].affectedRows) throw new HttpError(404, "Passkey nicht gefunden.");
    return { ok: true };
  });

  /** Authentication options: for a pending second step (that user's keys) or passwordless (discoverable credentials). */
  app.post("/api/auth/passkey/options", async (req) => {
    const { token } = z.object({ token: z.string().optional() }).parse(req.body ?? {});
    const { rpID } = rp(req, ctx);
    let userId: string | null = null;
    let allow: { id: string; transports?: string[] }[] = [];
    if (token) {
      const row = await pending(token);
      userId = row.userId;
      allow = (await ctx.db.select().from(passkeys).where(eq(passkeys.userId, userId))).map((k) => ({ id: k.id, transports: k.transports ?? undefined }));
    }
    const options = await generateAuthenticationOptions({ rpID, allowCredentials: allow, userVerification: token ? "preferred" : "required" });
    putChallenge(options.challenge, userId);
    return options;
  });

  const verifyPasskey = async (req: FastifyRequest, reply: FastifyReply, response: AuthenticationResponseJSON, expectUser: string | null) => {
    const { rpID, origin } = rp(req, ctx);
    const ch = takeChallenge(challengeOf(response));
    if (!ch) throw new HttpError(401, "Die Anmeldung ist abgelaufen. Bitte erneut versuchen.");
    const [k] = await ctx.db.select().from(passkeys).where(eq(passkeys.id, response.id)).limit(1);
    if (!k || (expectUser && k.userId !== expectUser) || (ch.userId && ch.userId !== k.userId)) throw new HttpError(401, "Dieser Passkey ist nicht bekannt.");
    let v;
    try {
      v = await verifyAuthenticationResponse({ response, expectedChallenge: (c) => c === challengeOf(response), expectedOrigin: origin, expectedRPID: rpID, credential: toCredential(k), requireUserVerification: !expectUser });
    } catch (e) {
      throw new HttpError(401, `Passkey konnte nicht geprüft werden: ${(e as Error).message}`);
    }
    if (!v.verified) throw new HttpError(401, "Passkey konnte nicht geprüft werden.");
    await ctx.db.update(passkeys).set({ counter: v.authenticationInfo.newCounter, lastUsedAt: new Date() }).where(eq(passkeys.id, k.id));
    const u = await loadUser(k.userId);
    if (!u.active) throw new HttpError(403, "Dieses Konto ist deaktiviert.");
    return signIn(ctx, req, reply, u.id);
  };

  /** Passwordless sign-in with a passkey (no pending token). */
  app.post("/api/auth/passkey/verify", async (req, reply) => {
    const body = z.object({ token: z.string().optional(), response: z.custom<AuthenticationResponseJSON>((v) => typeof v === "object" && v !== null) }).parse(req.body);
    if (body.token) {
      const row = await pending(body.token);
      const out = await verifyPasskey(req, reply, body.response, row.userId);
      await consume(row.id);
      return out;
    }
    return verifyPasskey(req, reply, body.response, null);
  });

  // ---------- sessions ----------

  app.get("/api/me/sessions", async (req) => {
    const me = requireUser(req);
    const rows = await ctx.db.select().from(sessions).where(and(eq(sessions.userId, me.id), gt(sessions.expiresAt, new Date()))).orderBy(desc(sessions.lastSeenAt));
    return rows.map((s) => ({ id: s.id.slice(0, 12), current: s.id === me.sessionId, device: describe(s.userAgent), ip: s.ip, lastSeenAt: s.lastSeenAt ?? s.createdAt, createdAt: s.createdAt, expiresAt: s.expiresAt }));
  });

  app.delete("/api/me/sessions/:id", async (req) => {
    const me = requireUser(req);
    const { id } = req.params as { id: string };
    const rows = await ctx.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, me.id));
    const target = rows.find((s) => s.id.startsWith(id));
    if (!target) throw new HttpError(404, "Sitzung nicht gefunden.");
    await ctx.db.delete(sessions).where(eq(sessions.id, target.id));
    return { ok: true, current: target.id === me.sessionId };
  });

  /** Signs out every other device; the current session stays. */
  app.post("/api/me/sessions/logout-others", async (req) => {
    const me = requireUser(req);
    const res = await ctx.db.delete(sessions).where(and(eq(sessions.userId, me.id), ne(sessions.id, me.sessionId ?? "")));
    return { ok: true, closed: res[0].affectedRows };
  });

  /** Admins: reset a locked-out person's second factor (they sign in with password only until they set it up again). */
  app.post("/api/users/:id/security/reset", async (req) => {
    const admin = requireRole(req, "admin");
    const { id } = req.params as { id: string };
    const [u] = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.id, id), eq(users.organizationId, admin.organizationId))).limit(1);
    if (!u) throw new HttpError(404, "Benutzer nicht gefunden.");
    await ctx.db.update(users).set({ totpSecret: null, totpEnabledAt: null, recoveryCodes: null }).where(eq(users.id, id));
    await ctx.db.delete(passkeys).where(eq(passkeys.userId, id));
    await ctx.db.delete(sessions).where(eq(sessions.userId, id));
    return { ok: true };
  });
}

/** «Chrome auf Windows», «Safari auf iPhone» from a user agent string. */
export function describe(ua: string | null): string {
  if (!ua) return "Unbekanntes Gerät";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return os ? `${browser} auf ${os}` : browser;
}
