import { todayZurich } from "./data";
import { Google, MicrosoftEntraId, decodeIdToken, generateCodeVerifier, generateState } from "arctic";
import { and, eq, gt, isNull, notInArray, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError, SESSION_COOKIE, appOrigin, organizationForHost, requireUser, type AppContext } from "../app";
import { hashPassword, newToken, passwordProblem, sha256, verifyPassword } from "../auth/crypto";
import { DEFAULT_BRANDING, oauthAccounts, organizations, passkeys, passwordTokens, sessions, users } from "../db/schema";
import { actionMail } from "../mail/mailer";
import { syncSeats } from "../saas";
import { tr } from "@taktwerk/domain";

type Provider = "microsoft" | "google";

// Simple in-memory brute-force protection: 10 failed attempts per IP + username in 15 minutes.
const failures = new Map<string, { count: number; until: number }>();
const WINDOW_MS = 15 * 60 * 1000;

function oauthClient(ctx: AppContext, provider: Provider) {
  const c = ctx.config;
  const redirect = `${new URL(c.APP_URL).origin}/api/auth/${provider}/callback`;
  if (provider === "microsoft" && c.MICROSOFT_CLIENT_ID && c.MICROSOFT_CLIENT_SECRET)
    return new MicrosoftEntraId(c.MICROSOFT_TENANT, c.MICROSOFT_CLIENT_ID, c.MICROSOFT_CLIENT_SECRET, redirect);
  if (provider === "google" && c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET)
    return new Google(c.GOOGLE_CLIENT_ID, c.GOOGLE_CLIENT_SECRET, redirect);
  return null;
}

export async function startSession(ctx: AppContext, reply: FastifyReply, userId: string, req?: { headers: { "user-agent"?: string }; ip: string }) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + ctx.config.SESSION_DAYS * 86400_000);
  await ctx.db.insert(sessions).values({ id: sha256(token), userId, expiresAt, userAgent: req?.headers["user-agent"]?.slice(0, 255) ?? null, ip: req?.ip ?? null, lastSeenAt: new Date() });
  await ctx.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: ctx.config.APP_URL.startsWith("https://"),
    expires: expiresAt,
  });
}

/**
 * Opens the session. In SaaS mode a company works on its own address (<slug>.<base> or its domain); a sign-in on the
 * shared address gets a two-minute one-time link instead, which opens the session there (cookies are per host).
 */
export async function signIn(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, userId: string): Promise<{ ok: true; redirect?: string }> {
  if (ctx.config.SAAS_BASE_DOMAIN) {
    const [row] = await ctx.db.select({ org: organizations }).from(users).innerJoin(organizations, eq(organizations.id, users.organizationId)).where(eq(users.id, userId)).limit(1);
    const target = row ? appOrigin(ctx.config, row.org) : null;
    const host = (req.headers.host ?? "").toLowerCase();
    if (target && new URL(target).host !== host) {
      const token = await createPasswordToken(ctx, userId, "handoff");
      return { ok: true, redirect: `${target}/api/auth/handoff?token=${token}` };
    }
  }
  await startSession(ctx, reply, userId, req);
  return { ok: true };
}

/** Creates a one-time link token (invite: 7 days, reset: 1 hour) and returns the plain token. */
export async function createPasswordToken(ctx: AppContext, userId: string, purpose: "invite" | "reset" | "2fa" | "handoff") {
  const token = newToken();
  const hours = purpose === "invite" ? 24 * 7 : purpose === "2fa" ? 5 / 60 : purpose === "handoff" ? 2 / 60 : 1;
  await ctx.db.insert(passwordTokens).values({ id: sha256(token), userId, purpose, expiresAt: new Date(Date.now() + hours * 3600_000) });
  return token;
}

export function passwordLink(ctx: AppContext, token: string, org?: { domain?: string | null; slug?: string | null } | null) {
  return `${appOrigin(ctx.config, org)}/passwort?token=${encodeURIComponent(token)}`;
}

export async function authRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.get("/api/auth/providers", async () => ({
    password: true,
    microsoft: oauthClient(ctx, "microsoft") !== null,
    google: oauthClient(ctx, "google") !== null,
    registration: ctx.config.REGISTRATION_OPEN === "true",
    saas: ctx.config.SAAS === "true",
  }));

  /** Public branding so the login page can render in the corporate design (per host, see organizationForHost). */
  app.get("/api/branding", async (req) => (await organizationForHost(ctx.db, req.headers.host, ctx.config.SAAS_BASE_DOMAIN))?.settings.branding ?? DEFAULT_BRANDING);

  app.post("/api/auth/login", async (req, reply) => {
    const body = z.object({ username: z.string().trim().min(1).max(254), password: z.string().min(1).max(500), organizationId: z.string().max(64).optional() }).parse(req.body);
    const key = `${req.ip}|${body.username.toLowerCase()}`;
    const f = failures.get(key);
    if (f && f.count >= 10 && f.until > Date.now()) throw new HttpError(429, tr("Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen."));

    // One e-mail address may have an account in several companies (e.g. a fiduciary); the username is unique everywhere.
    const hostOrg = await organizationForHost(ctx.db, req.headers.host, ctx.config.SAAS_BASE_DOMAIN);
    const hostBound = !!(hostOrg && (hostOrg.domain || ctx.config.SAAS_BASE_DOMAIN));
    const candidates = await ctx.db
      .select({ user: users, orgName: organizations.name, orgActive: organizations.active })
      .from(users)
      .innerJoin(organizations, eq(organizations.id, users.organizationId))
      .where(or(eq(users.username, body.username), sql`lower(${users.email}) = ${body.username.toLowerCase()}`))
      .limit(20);
    const matching: typeof candidates = [];
    for (const c of candidates) if (c.user.active && (await verifyPassword(body.password, c.user.passwordHash))) matching.push(c);
    if (matching.length === 0) {
      const prev = f && f.until > Date.now() ? f.count : 0;
      failures.set(key, { count: prev + 1, until: Date.now() + WINDOW_MS });
      throw new HttpError(401, tr("Benutzername oder Passwort ist falsch."));
    }
    failures.delete(key);
    // Strict tenant separation: on an organization's own domain only its users may sign in; inactive organizations are closed.
    const here = hostBound ? matching.filter((m) => m.user.organizationId === hostOrg!.id) : matching;
    if (here.length === 0) throw new HttpError(403, tr("Dieses Konto gehört zu einer anderen Firma. Bitte die Adresse deiner Firma verwenden."));
    const open = here.filter((m) => m.orgActive);
    if (open.length === 0) throw new HttpError(403, tr("Diese Firma ist deaktiviert. Bitte den Betreiber kontaktieren."));
    const picked = body.organizationId ? open.find((m) => m.user.organizationId === body.organizationId) : open.length === 1 ? open[0] : undefined;
    if (!picked) return { ok: false, choose: open.map((m) => ({ organizationId: m.user.organizationId, name: m.orgName, role: m.user.role })).sort((a, b) => a.name.localeCompare(b.name, "de")) };
    const user = picked.user;
    // Second factor: the password alone opens no session; the client completes with a code or a passkey.
    const keys = await ctx.db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, user.id));
    if (user.totpEnabledAt || keys.length > 0) {
      const token = await createPasswordToken(ctx, user.id, "2fa");
      return { ok: false, second: { token, totp: !!user.totpEnabledAt, passkey: keys.length > 0 } };
    }
    return signIn(ctx, req, reply, user.id);
  });

  /** Second half of a SaaS sign-in on the shared address: the one-time link opens the session on the company's address. */
  app.get("/api/auth/handoff", async (req, reply) => {
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.query);
    const [row] = await ctx.db
      .select()
      .from(passwordTokens)
      .where(and(eq(passwordTokens.id, sha256(token)), eq(passwordTokens.purpose, "handoff"), isNull(passwordTokens.usedAt), gt(passwordTokens.expiresAt, new Date())))
      .limit(1);
    if (!row) return reply.redirect("/?anmeldung=abgelaufen");
    await ctx.db.update(passwordTokens).set({ usedAt: new Date() }).where(eq(passwordTokens.id, row.id));
    const [user] = await ctx.db.select().from(users).where(eq(users.id, row.userId)).limit(1);
    const hostOrg = await organizationForHost(ctx.db, req.headers.host, ctx.config.SAAS_BASE_DOMAIN);
    if (!user?.active || !hostOrg || hostOrg.id !== user.organizationId) return reply.redirect("/?anmeldung=fehlgeschlagen");
    await startSession(ctx, reply, user.id, req);
    return reply.redirect("/");
  });

  const otherAccounts = (me: { id: string; email: string }) => accountsWithSameEmail(ctx, me);

  app.get("/api/auth/accounts", async (req) => {
    const me = requireUser(req);
    if (me.apiKey) return { current: null, others: [] };
    const [org] = await ctx.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, me.organizationId)).limit(1);
    return { current: { organizationId: me.organizationId, name: org?.name ?? "" }, others: (await otherAccounts(me)).map((a) => ({ organizationId: a.organizationId, name: a.name, role: a.role })) };
  });

  app.post("/api/auth/switch", async (req, reply) => {
    const me = requireUser(req);
    if (me.apiKey) throw new HttpError(403, tr("Dafür fehlt dir die Berechtigung."));
    const { organizationId } = z.object({ organizationId: z.string().max(64) }).parse(req.body);
    const target = (await otherAccounts(me)).find((a) => a.organizationId === organizationId);
    if (!target) throw new HttpError(404, tr("Kein Konto in dieser Firma."));
    const token = req.cookies[SESSION_COOKIE];
    const res = await signIn(ctx, req, reply, target.id);
    if (token && !res.redirect) await ctx.db.delete(sessions).where(eq(sessions.id, sha256(token)));
    return res;
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await ctx.db.delete(sessions).where(eq(sessions.id, sha256(token)));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => {
    const user = requireUser(req);
    return user;
  });

  /** Language of the app and of e-mails to this person. */
  app.put("/api/me/locale", async (req) => {
    const me = requireUser(req);
    const { locale } = z.object({ locale: z.enum(["de", "fr", "en", "it"]) }).parse(req.body);
    await ctx.db.update(users).set({ locale }).where(eq(users.id, me.id));
    return { locale };
  });

  /** Change the own password: current password required, same rules as for a new one. */
  app.post("/api/auth/password/change", async (req) => {
    const me = requireUser(req);
    const body = z.object({ current: z.string().max(500), next: z.string().max(500) }).parse(req.body);
    const [user] = await ctx.db.select().from(users).where(eq(users.id, me.id)).limit(1);
    if (!user || !(await verifyPassword(body.current, user.passwordHash))) throw new HttpError(400, tr("Das aktuelle Passwort ist falsch."));
    const problem = passwordProblem(body.next);
    if (problem) throw new HttpError(400, problem);
    await ctx.db.update(users).set({ passwordHash: await hashPassword(body.next) }).where(eq(users.id, user.id));
    return { ok: true };
  });

  // ---------- password reset & invitation ----------

  app.post("/api/auth/password/forgot", async (req) => {
    const { email } = z.object({ email: z.string().trim().email() }).parse(req.body);
    const accounts = await ctx.db.select().from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`).limit(20);
    // One link per company the address has an account in; each mail names its company.
    for (const user of accounts.filter((u) => u.active)) {
      const token = await createPasswordToken(ctx, user.id, "reset");
      const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, user.organizationId)).limit(1);
      const branding = org?.settings.branding ?? DEFAULT_BRANDING;
      await ctx.mailer.send(
        actionMail(branding, {
          to: user.email,
          subject: tr("{0}: Passwort zurücksetzen", branding.appName),
          greeting: tr("Hallo {0}", user.name),
          lines: [tr("Du hast ein neues Passwort angefordert. Der Link ist eine Stunde gültig.")],
          action: tr("Neues Passwort setzen"),
          url: passwordLink(ctx, token, org),
          footer: tr("Wenn du das nicht warst, kannst du diese E-Mail ignorieren. Dein Passwort bleibt unverändert."),
        }),
      );
    }
    // Same answer whether or not the address exists, so accounts cannot be probed.
    return { ok: true };
  });

  app.post("/api/auth/password/set", async (req, reply) => {
    const body = z.object({ token: z.string().min(10), password: z.string().max(500) }).parse(req.body);
    const problem = passwordProblem(body.password);
    if (problem) throw new HttpError(400, problem);
    const [row] = await ctx.db
      .select()
      .from(passwordTokens)
      .where(and(eq(passwordTokens.id, sha256(body.token)), isNull(passwordTokens.usedAt), gt(passwordTokens.expiresAt, new Date()), notInArray(passwordTokens.purpose, ["2fa", "handoff"])))
      .limit(1);
    if (!row) throw new HttpError(400, tr("Der Link ist abgelaufen oder wurde schon verwendet. Bitte fordere einen neuen an."));
    await ctx.db.update(passwordTokens).set({ usedAt: new Date() }).where(eq(passwordTokens.id, row.id));
    await ctx.db.update(users).set({ passwordHash: await hashPassword(body.password) }).where(eq(users.id, row.userId));
    await ctx.db.delete(sessions).where(eq(sessions.userId, row.userId)); // sign out everywhere else
    await startSession(ctx, reply, row.userId);
    return { ok: true };
  });

  // ---------- Microsoft / Google (OAuth 2.0 + OpenID Connect, PKCE) ----------

  for (const provider of ["microsoft", "google"] as const) {
    app.get(`/api/auth/${provider}`, async (_req, reply) => {
      const client = oauthClient(ctx, provider);
      if (!client) throw new HttpError(404, tr("Diese Anmeldeart ist nicht eingerichtet."));
      const state = generateState();
      const verifier = generateCodeVerifier();
      const url = client.createAuthorizationURL(state, verifier, ["openid", "profile", "email"]);
      const opts = { path: "/api/auth", httpOnly: true, sameSite: "lax" as const, secure: ctx.config.APP_URL.startsWith("https://"), maxAge: 600 };
      reply.setCookie("tw_oauth_state", state, opts).setCookie("tw_oauth_verifier", verifier, opts);
      return reply.redirect(url.toString());
    });

    app.get(`/api/auth/${provider}/callback`, async (req, reply) => {
      const fail = (code: string) => reply.redirect(`${new URL(ctx.config.APP_URL).origin}/?anmeldung=${code}`);
      const client = oauthClient(ctx, provider);
      const q = req.query as { code?: string; state?: string };
      const state = req.cookies.tw_oauth_state;
      const verifier = req.cookies.tw_oauth_verifier;
      reply.clearCookie("tw_oauth_state", { path: "/api/auth" }).clearCookie("tw_oauth_verifier", { path: "/api/auth" });
      if (!client || !q.code || !state || q.state !== state || !verifier) return fail("abgebrochen");

      let claims: Record<string, unknown>;
      try {
        const tokens = await client.validateAuthorizationCode(q.code, verifier);
        claims = decodeIdToken(tokens.idToken()) as Record<string, unknown>;
      } catch (e) {
        req.log.warn({ err: e }, "oauth code exchange failed");
        return fail("fehlgeschlagen");
      }
      const subject = String(claims.sub ?? "");
      const email = String(claims.email ?? claims.preferred_username ?? "").toLowerCase();
      const name = String(claims.name ?? email);
      if (!subject) return fail("fehlgeschlagen");
      if (provider === "google" && claims.email_verified !== true) return fail("email_unbestaetigt");

      const userId = await resolveOAuthUser(ctx, provider, subject, email, name);
      if (!userId) return fail(tr("unbekannt"));
      const done = await signIn(ctx, req, reply, userId);
      return reply.redirect(done.redirect ?? `${new URL(ctx.config.APP_URL).origin}/`);
    });
  }
}

/** Existing link → user; else link by e-mail; else auto-provision when the domain is allowed. */
export async function resolveOAuthUser(ctx: AppContext, provider: Provider, subject: string, email: string, name: string) {
  const [linked] = await ctx.db
    .select({ id: users.id, active: users.active })
    .from(oauthAccounts)
    .innerJoin(users, eq(users.id, oauthAccounts.userId))
    .where(and(eq(oauthAccounts.provider, provider), eq(oauthAccounts.providerUserId, subject)))
    .limit(1);
  if (linked) return linked.active ? linked.id : null;
  if (!email.includes("@")) return null;

  // With accounts in several companies, the one used last opens; the others are a click away (switch).
  const [byEmail] = await ctx.db.select().from(users).where(and(sql`lower(${users.email}) = ${email}`, eq(users.active, true))).orderBy(sql`${users.lastLoginAt} is null`, sql`${users.lastLoginAt} desc`).limit(1);
  let userId = byEmail?.active ? byEmail.id : null;
  if (!byEmail) {
    // Auto-provisioning: the organization that lists the e-mail domain (exactly one may claim a domain).
    const domain = email.split("@")[1]!;
    const all = await ctx.db.select().from(organizations).where(eq(organizations.active, true));
    const claiming = all.filter((o) => o.settings.ssoAutoProvisionDomains.map((d) => d.toLowerCase()).includes(domain));
    const org = claiming.length === 1 ? claiming[0]! : null;
    if (!org) return null;
    userId = randomUUID();
    await ctx.db.insert(users).values({ id: userId, organizationId: org.id, username: email, email, name, role: "employee", trackingStart: todayZurich() });
    await syncSeats(ctx, org.id);
  }
  if (!userId) return null;
  await ctx.db.insert(oauthAccounts).values({ provider, providerUserId: subject, userId });
  return userId;
}

/**
 * The other companies the signed-in person has an account in (same e-mail address, password already set or used).
 * The address was proven when that account's invitation link was used, so switching needs no second password.
 */
export async function accountsWithSameEmail(ctx: AppContext, me: { id: string; email: string }) {
  if (!me.email) return [];
  const rows = await ctx.db
    .select({ id: users.id, organizationId: users.organizationId, role: users.role, name: organizations.name, passwordHash: users.passwordHash, lastLoginAt: users.lastLoginAt })
    .from(users)
    .innerJoin(organizations, eq(organizations.id, users.organizationId))
    .where(and(sql`lower(${users.email}) = ${me.email.toLowerCase()}`, eq(users.active, true), eq(organizations.active, true)))
    .limit(50);
  return rows.filter((r) => r.id !== me.id && (r.passwordHash || r.lastLoginAt)).sort((a, b) => a.name.localeCompare(b.name, "de"));
}
