import { SAML, ValidateInResponseTo, type Profile } from "@node-saml/node-saml";
import { hasFeature, tr } from "@taktwerk/domain";
import { and, asc, count, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError, appOrigin, requireRole, type AppContext } from "../app";
import { newToken, sha256 } from "../auth/crypto";
import { organizations, sessions, users, type OrgSettings, type SsoSettings } from "../db/schema";
import { saasOn, subscriptionOf, syncSeats } from "../saas";
import { signIn } from "./auth";
import { todayZurich } from "./data";

type OrgRow = typeof organizations.$inferSelect;

const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

/** SSO is part of the Business package in SaaS mode; self-hosted installations always have it. */
function ssoAllowed(ctx: AppContext, org: OrgRow) {
  return !saasOn(ctx) || hasFeature(subscriptionOf(org), "sso");
}

const samlReady = (s?: SsoSettings) => !!(s?.saml?.enabled && s.saml.entryPoint && s.saml.cert);

/** Password sign-in is closed for this person (company enforces SAML; admins keep the password as a way in). */
export function passwordBlockedBySso(settings: OrgSettings, role: string) {
  return !!(settings.sso?.enforce && samlReady(settings.sso) && role !== "admin");
}

function spUrls(ctx: AppContext, org: OrgRow) {
  const base = `${appOrigin(ctx.config, org)}/api/auth/saml/${org.id}`;
  return { entityId: `${base}/metadata`, acs: `${base}/acs`, metadata: `${base}/metadata`, start: `${base}` };
}

function samlFor(ctx: AppContext, org: OrgRow) {
  const s = org.settings.sso?.saml;
  const sp = spUrls(ctx, org);
  return new SAML({
    entryPoint: s?.entryPoint || "https://idp.invalid/",
    idpIssuer: s?.idpIssuer || undefined,
    idpCert: s?.cert || "MISSING",
    issuer: sp.entityId,
    callbackUrl: sp.acs,
    audience: sp.entityId,
    wantAssertionsSigned: true,
    // Entra ID signs the assertion by default, not the whole response.
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.never,
    rejectReplayedAssertions: true,
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    disableRequestedAuthnContext: true,
    acceptedClockSkewMs: 120_000,
  });
}

const CLAIM = {
  email: ["email", "mail", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress", "urn:oid:0.9.2342.19200300.100.1.3"],
  name: ["displayName", "http://schemas.microsoft.com/identity/claims/displayname", "name", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"],
  given: ["givenName", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname"],
  surname: ["sn", "surname", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname"],
};
function claim(p: Profile, keys: string[]) {
  for (const k of keys) {
    const v = (p as Record<string, unknown>)[k];
    const first = Array.isArray(v) ? v[0] : v;
    if (typeof first === "string" && first.trim()) return first.trim();
  }
  return "";
}

async function orgById(ctx: AppContext, id: string) {
  const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  return org ?? null;
}

/** Finds or creates the person for a verified SAML login. Returns null when the address may not sign in here. */
async function samlUser(ctx: AppContext, org: OrgRow, email: string, name: string) {
  const [existing] = await ctx.db.select().from(users).where(and(eq(users.organizationId, org.id), sql`lower(${users.email}) = ${email}`)).limit(1);
  if (existing) return existing.active ? existing.id : null;
  const domain = email.split("@")[1] ?? "";
  const allowed = [...(org.settings.sso?.domains ?? []), ...org.settings.ssoAutoProvisionDomains].map((d) => d.toLowerCase());
  if (!allowed.includes(domain)) return null;
  const [taken] = await ctx.db.select({ n: count() }).from(users).where(eq(users.username, email));
  const id = randomUUID();
  await ctx.db.insert(users).values({ id, organizationId: org.id, username: taken!.n ? `${email}#${id.slice(0, 6)}` : email, email, name: name || email, role: "employee", trackingStart: todayZurich() });
  await syncSeats(ctx, org.id);
  return id;
}

// ---------------------------------------------------------------- SCIM 2.0 ----------

const SCIM_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const SCIM_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
const SCIM_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

type UserRow = typeof users.$inferSelect;

function scimUser(ctx: AppContext, org: OrgRow, u: UserRow) {
  return {
    schemas: [SCIM_USER],
    id: u.id,
    userName: u.username,
    name: { formatted: u.name },
    displayName: u.name,
    emails: [{ value: u.email, type: "work", primary: true }],
    active: u.active,
    meta: { resourceType: "User", created: u.createdAt?.toISOString?.() ?? undefined, location: `${appOrigin(ctx.config, org)}/scim/v2/Users/${u.id}` },
  };
}

function scimFail(reply: FastifyReply, status: number, detail: string, scimType?: string) {
  return reply.code(status).type("application/scim+json").send({ schemas: [SCIM_ERROR], status: String(status), detail, ...(scimType ? { scimType } : {}) });
}

const truthy = (v: unknown) => v === true || (typeof v === "string" && v.toLowerCase() === "true");

/** Pulls name, e-mail, userName and active out of a SCIM user document (POST/PUT body or PATCH value). */
function readScimFields(body: Record<string, unknown>) {
  const out: { userName?: string; email?: string; name?: string; active?: boolean } = {};
  if (typeof body.userName === "string") out.userName = body.userName.trim();
  const emails = Array.isArray(body.emails) ? (body.emails as { value?: string; primary?: boolean | string }[]) : [];
  const mail = emails.find((e) => truthy(e.primary)) ?? emails[0];
  if (mail?.value) out.email = mail.value.trim().toLowerCase();
  const n = (body.name ?? {}) as { formatted?: string; givenName?: string; familyName?: string };
  const composed = [n.givenName, n.familyName].filter(Boolean).join(" ");
  const name = (typeof body.displayName === "string" && body.displayName) || n.formatted || composed;
  if (name) out.name = String(name).trim().slice(0, 160);
  if (body.active !== undefined) out.active = truthy(body.active);
  return out;
}

async function scimOrg(ctx: AppContext, req: FastifyRequest) {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;
  const hash = sha256(token);
  const [org] = await ctx.db.select().from(organizations).where(sql`json_value(${organizations.settings}, '$.sso.scimTokenHash') = ${hash}`).limit(1);
  if (!org || !org.active || !ssoAllowed(ctx, org)) return null;
  return org;
}

export async function ssoRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  // SAML posts the response as a form; SCIM clients send application/scim+json.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  app.addContentTypeParser("application/scim+json", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  /** Login page: which company login belongs to this address? */
  app.get("/api/auth/sso", async (req) => {
    const email = String((req.query as { email?: string }).email ?? "").trim().toLowerCase();
    const domain = email.split("@")[1] ?? "";
    if (!DOMAIN_RE.test(domain)) throw new HttpError(400, tr("Bitte gib deine geschäftliche E-Mail-Adresse ein."));
    const orgs = await ctx.db.select().from(organizations).where(and(eq(organizations.active, true), sql`json_value(${organizations.settings}, '$.sso.saml.enabled') = true`));
    const byDomain = orgs.filter((o) => (o.settings.sso?.domains ?? []).includes(domain));
    let hit = byDomain.length === 1 ? byDomain[0] : undefined;
    if (!hit) {
      const mine = await ctx.db.select({ org: users.organizationId }).from(users).where(and(sql`lower(${users.email}) = ${email}`, eq(users.active, true)));
      const withSaml = orgs.filter((o) => mine.some((m) => m.org === o.id));
      if (withSaml.length === 1) hit = withSaml[0];
    }
    if (!hit || !samlReady(hit.settings.sso) || !ssoAllowed(ctx, hit)) throw new HttpError(404, tr("Für diese Adresse ist kein Firmen-Login eingerichtet."));
    return { url: spUrls(ctx, hit).start };
  });

  app.get("/api/auth/saml/:orgId/metadata", async (req, reply) => {
    const org = await orgById(ctx, (req.params as { orgId: string }).orgId);
    if (!org) throw new HttpError(404, tr("Firma nicht gefunden."));
    return reply.type("application/samlmetadata+xml").send(samlFor(ctx, org).generateServiceProviderMetadata(null));
  });

  app.get("/api/auth/saml/:orgId", async (req, reply) => {
    const org = await orgById(ctx, (req.params as { orgId: string }).orgId);
    if (!org || !org.active || !samlReady(org.settings.sso) || !ssoAllowed(ctx, org)) throw new HttpError(404, tr("Für diese Firma ist kein Firmen-Login eingerichtet."));
    const url = await samlFor(ctx, org).getAuthorizeUrlAsync("", undefined, {});
    return reply.redirect(url);
  });

  app.post("/api/auth/saml/:orgId/acs", async (req, reply) => {
    const origin = new URL(ctx.config.APP_URL).origin;
    const fail = (code: string) => reply.redirect(`${origin}/?anmeldung=${code}`);
    const org = await orgById(ctx, (req.params as { orgId: string }).orgId);
    if (!org || !org.active || !samlReady(org.settings.sso) || !ssoAllowed(ctx, org)) return fail("abgebrochen");
    const body = (req.body ?? {}) as Record<string, string>;
    if (!body.SAMLResponse) return fail("abgebrochen");
    let profile: Profile | null;
    try {
      ({ profile } = await samlFor(ctx, org).validatePostResponseAsync({ SAMLResponse: body.SAMLResponse }));
    } catch (e) {
      req.log.warn({ err: e, org: org.id }, "saml response rejected");
      return fail("fehlgeschlagen");
    }
    if (!profile) return fail("fehlgeschlagen");
    const nameId = profile.nameID?.includes("@") ? profile.nameID : "";
    const email = (claim(profile, CLAIM.email) || nameId).toLowerCase();
    if (!email.includes("@")) return fail("fehlgeschlagen");
    const name = claim(profile, CLAIM.name) || [claim(profile, CLAIM.given), claim(profile, CLAIM.surname)].filter(Boolean).join(" ");
    const userId = await samlUser(ctx, org, email, name);
    if (!userId) return fail("unbekannt");
    const done = await signIn(ctx, req, reply, userId);
    return reply.redirect(done.redirect ?? `${appOrigin(ctx.config, org)}/`);
  });

  // ---------- admin settings ----------

  const view = (org: OrgRow) => {
    const s = org.settings.sso ?? {};
    const sp = spUrls(ctx, org);
    return {
      allowed: ssoAllowed(ctx, org),
      saml: { enabled: !!s.saml?.enabled, entryPoint: s.saml?.entryPoint ?? "", idpIssuer: s.saml?.idpIssuer ?? "", cert: s.saml?.cert ?? "" },
      domains: s.domains ?? [],
      enforce: !!s.enforce,
      scim: { active: !!s.scimTokenHash, hint: s.scimTokenHint ?? null, createdAt: s.scimCreatedAt ?? null, url: `${appOrigin(ctx.config, org)}/scim/v2` },
      sp: { entityId: sp.entityId, acs: sp.acs, metadata: sp.metadata },
    };
  };
  const saveSso = async (org: OrgRow, sso: SsoSettings) => {
    await ctx.db.update(organizations).set({ settings: { ...org.settings, sso } }).where(eq(organizations.id, org.id));
    return { ...org, settings: { ...org.settings, sso } };
  };

  app.get("/api/sso", async (req) => {
    const user = requireRole(req, "admin");
    return view((await orgById(ctx, user.organizationId))!);
  });

  app.put("/api/sso", async (req) => {
    const user = requireRole(req, "admin");
    const org = (await orgById(ctx, user.organizationId))!;
    if (!ssoAllowed(ctx, org)) throw new HttpError(402, tr("Firmen-Login (SAML) und SCIM ist erst im Paket Business enthalten. Wechseln unter Einstellungen → Abo."));
    const body = z
      .object({
        saml: z.object({
          enabled: z.boolean(),
          entryPoint: z.string().trim().max(500).refine((v) => v === "" || /^https:\/\//.test(v), tr("Die Anmelde-URL muss mit https:// beginnen.")),
          idpIssuer: z.string().trim().max(500).optional(),
          cert: z.string().trim().max(10_000),
        }),
        domains: z.array(z.string().trim().toLowerCase().regex(DOMAIN_RE, tr("Ungültige Domain"))).max(20),
        enforce: z.boolean(),
      })
      .parse(req.body);
    const cert = body.saml.cert.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
    if (body.saml.enabled && (!body.saml.entryPoint || !cert)) throw new HttpError(400, tr("Für den Firmen-Login braucht es die Anmelde-URL und das Zertifikat des Identity Providers."));
    if (cert && !/^[A-Za-z0-9+/=]{100,}$/.test(cert)) throw new HttpError(400, tr("Das Zertifikat ist ungültig. Bitte das Base64-Zertifikat aus Entra ID oder dem Identity Provider einfügen."));
    // A domain belongs to one company only, otherwise the login page could not decide.
    const others = await ctx.db.select({ id: organizations.id, settings: organizations.settings }).from(organizations).where(eq(organizations.active, true));
    const clash = body.domains.find((d) => others.some((o) => o.id !== org.id && (o.settings.sso?.domains ?? []).includes(d)));
    if (clash) throw new HttpError(409, tr("Die Domain {0} ist bereits bei einer anderen Firma für den Firmen-Login eingetragen.", clash));
    const next = await saveSso(org, {
      ...org.settings.sso,
      saml: { enabled: body.saml.enabled, entryPoint: body.saml.entryPoint, idpIssuer: body.saml.idpIssuer || undefined, cert },
      domains: [...new Set(body.domains)],
      enforce: body.enforce && body.saml.enabled,
    });
    return view(next);
  });

  app.post("/api/sso/scim-token", async (req) => {
    const user = requireRole(req, "admin");
    const org = (await orgById(ctx, user.organizationId))!;
    if (!ssoAllowed(ctx, org)) throw new HttpError(402, tr("Firmen-Login (SAML) und SCIM ist erst im Paket Business enthalten. Wechseln unter Einstellungen → Abo."));
    const token = `scim_${newToken()}`;
    const next = await saveSso(org, { ...org.settings.sso, scimTokenHash: sha256(token), scimTokenHint: token.slice(-4), scimCreatedAt: new Date().toISOString() });
    return { token, ...view(next) };
  });

  app.delete("/api/sso/scim-token", async (req) => {
    const user = requireRole(req, "admin");
    const org = (await orgById(ctx, user.organizationId))!;
    const { scimTokenHash: _h, scimTokenHint: _t, scimCreatedAt: _c, ...rest } = org.settings.sso ?? {};
    return view(await saveSso(org, rest));
  });

  // ---------- SCIM 2.0 (RFC 7643/7644), enough for Entra ID, Okta and Google provisioning ----------

  app.get("/scim/v2/ServiceProviderConfig", async (_req, reply) =>
    reply.type("application/scim+json").send({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer Token", description: tr("Token aus Einstellungen → Firmen-Login") }],
    }),
  );

  const withOrg = async (req: FastifyRequest, reply: FastifyReply) => {
    const org = await scimOrg(ctx, req);
    if (!org) {
      scimFail(reply, 401, "Invalid or missing bearer token");
      return null;
    }
    return org;
  };
  const findUser = async (org: OrgRow, id: string) => {
    const [u] = await ctx.db.select().from(users).where(and(eq(users.organizationId, org.id), eq(users.id, id))).limit(1);
    return u && u.role !== "customer" ? u : null;
  };

  app.get("/scim/v2/Users", async (req, reply) => {
    const org = await withOrg(req, reply);
    if (!org) return reply;
    const q = req.query as { filter?: string; startIndex?: string; count?: string };
    const start = Math.max(1, Number(q.startIndex) || 1);
    const size = Math.min(200, Math.max(0, Number(q.count ?? 100) || 0));
    const conds = [eq(users.organizationId, org.id), sql`${users.role} <> 'customer'`];
    if (q.filter) {
      const m = /^\s*(userName|emails(?:\.value)?|externalId)\s+eq\s+"([^"]*)"\s*$/i.exec(q.filter);
      if (!m) return scimFail(reply, 400, "Only 'userName eq', 'emails eq' and 'externalId eq' filters are supported", "invalidFilter");
      const v = m[2]!.toLowerCase();
      conds.push(m[1]!.toLowerCase() === "username" ? sql`(lower(${users.username}) = ${v} or lower(${users.email}) = ${v})` : sql`lower(${users.email}) = ${v}`);
    }
    const where = and(...conds);
    const [{ n }] = (await ctx.db.select({ n: count() }).from(users).where(where)) as [{ n: number }];
    const rows = size ? await ctx.db.select().from(users).where(where).orderBy(asc(users.createdAt), asc(users.id)).limit(size).offset(start - 1) : [];
    return reply.type("application/scim+json").send({ schemas: [SCIM_LIST], totalResults: n, startIndex: start, itemsPerPage: rows.length, Resources: rows.map((u) => scimUser(ctx, org, u)) });
  });

  app.get("/scim/v2/Users/:id", async (req, reply) => {
    const org = await withOrg(req, reply);
    if (!org) return reply;
    const u = await findUser(org, (req.params as { id: string }).id);
    if (!u) return scimFail(reply, 404, "User not found");
    return reply.type("application/scim+json").send(scimUser(ctx, org, u));
  });

  app.post("/scim/v2/Users", async (req, reply) => {
    const org = await withOrg(req, reply);
    if (!org) return reply;
    const f = readScimFields((req.body ?? {}) as Record<string, unknown>);
    const email = f.email ?? (f.userName?.includes("@") ? f.userName.toLowerCase() : "");
    if (!f.userName || !email.includes("@")) return scimFail(reply, 400, "userName and an e-mail address are required", "invalidValue");
    const [dupe] = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.organizationId, org.id), sql`lower(${users.email}) = ${email}`)).limit(1);
    if (dupe) return scimFail(reply, 409, "A user with this e-mail address already exists", "uniqueness");
    const [taken] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.username, f.userName)).limit(1);
    const id = randomUUID();
    await ctx.db.insert(users).values({
      id,
      organizationId: org.id,
      username: taken ? `${f.userName.slice(0, 70)}#${id.slice(0, 6)}` : f.userName.slice(0, 80),
      email,
      name: f.name || email,
      role: "employee",
      active: f.active ?? true,
      trackingStart: todayZurich(),
    });
    await syncSeats(ctx, org.id);
    return reply.code(201).type("application/scim+json").send(scimUser(ctx, org, (await findUser(org, id))!));
  });

  const apply = async (org: OrgRow, u: UserRow, f: ReturnType<typeof readScimFields>) => {
    const set: Partial<typeof users.$inferInsert> = {};
    if (f.name) set.name = f.name;
    if (f.email && f.email !== u.email.toLowerCase()) {
      const [dupe] = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.organizationId, org.id), sql`lower(${users.email}) = ${f.email}`)).limit(1);
      if (dupe && dupe.id !== u.id) throw new HttpError(409, "A user with this e-mail address already exists");
      set.email = f.email;
    }
    // The last active admin is never switched off from outside; the company would lock itself out.
    if (f.active !== undefined && f.active !== u.active) {
      if (!f.active && u.role === "admin") {
        const [{ n }] = (await ctx.db.select({ n: count() }).from(users).where(and(eq(users.organizationId, org.id), eq(users.role, "admin"), eq(users.active, true)))) as [{ n: number }];
        if (n <= 1) throw new HttpError(409, "The last active admin cannot be deactivated");
      }
      set.active = f.active;
    }
    if (Object.keys(set).length) await ctx.db.update(users).set(set).where(eq(users.id, u.id));
    if (set.active === false) await ctx.db.delete(sessions).where(eq(sessions.userId, u.id));
    if (set.active !== undefined) await syncSeats(ctx, org.id);
  };
  const scimWrite = async (reply: FastifyReply, fn: () => Promise<void>) => {
    try {
      await fn();
      return null;
    } catch (e) {
      if (e instanceof HttpError) return scimFail(reply, e.statusCode, e.message, e.statusCode === 409 ? "uniqueness" : undefined);
      throw e;
    }
  };

  app.put("/scim/v2/Users/:id", async (req, reply) => {
    const org = await withOrg(req, reply);
    if (!org) return reply;
    const u = await findUser(org, (req.params as { id: string }).id);
    if (!u) return scimFail(reply, 404, "User not found");
    const failed = await scimWrite(reply, () => apply(org, u, readScimFields((req.body ?? {}) as Record<string, unknown>)));
    if (failed) return failed;
    return reply.type("application/scim+json").send(scimUser(ctx, org, (await findUser(org, u.id))!));
  });

  app.patch("/scim/v2/Users/:id", async (req, reply) => {
    const org = await withOrg(req, reply);
    if (!org) return reply;
    const u = await findUser(org, (req.params as { id: string }).id);
    if (!u) return scimFail(reply, 404, "User not found");
    const body = (req.body ?? {}) as { schemas?: string[]; Operations?: { op?: string; path?: string; value?: unknown }[] };
    if (!Array.isArray(body.Operations)) return scimFail(reply, 400, `Expected ${SCIM_PATCH} with Operations`, "invalidSyntax");
    const doc: Record<string, unknown> = {};
    const name: Record<string, unknown> = {};
    for (const op of body.Operations) {
      const kind = (op.op ?? "").toLowerCase();
      if (kind !== "replace" && kind !== "add") continue;
      const path = (op.path ?? "").trim();
      const value = op.value;
      if (!path && value && typeof value === "object") {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (k.startsWith("name.")) name[k.slice(5)] = v;
          else if (k.startsWith("emails")) doc.emails = typeof v === "string" ? [{ value: v, primary: true }] : v;
          else doc[k] = v;
        }
      } else if (path === "active" || path === "displayName" || path === "userName") doc[path] = value;
      else if (path.startsWith("name.")) name[path.slice(5)] = value;
      else if (path.startsWith("emails")) doc.emails = typeof value === "string" ? [{ value, primary: true }] : Array.isArray(value) ? value : [value];
    }
    if (Object.keys(name).length) {
      const given = (name.givenName as string | undefined) ?? "";
      const family = (name.familyName as string | undefined) ?? "";
      doc.name = { formatted: (name.formatted as string | undefined) ?? (given || family ? `${given} ${family}`.trim() : undefined) };
    }
    const f = readScimFields(doc);
    delete f.userName;
    const failed = await scimWrite(reply, () => apply(org, u, f));
    if (failed) return failed;
    return reply.type("application/scim+json").send(scimUser(ctx, org, (await findUser(org, u.id))!));
  });

  /** Removing a person in the identity provider deactivates the account; bookings stay for the reports. */
  app.delete("/scim/v2/Users/:id", async (req, reply) => {
    const org = await withOrg(req, reply);
    if (!org) return reply;
    const u = await findUser(org, (req.params as { id: string }).id);
    if (!u) return scimFail(reply, 404, "User not found");
    const failed = await scimWrite(reply, () => apply(org, u, { active: false }));
    if (failed) return failed;
    return reply.code(204).send();
  });

  // Groups are not mapped (roles stay in the app); an empty list keeps the IdP's group sync quiet.
  app.get("/scim/v2/Groups", async (req, reply) => {
    const org = await withOrg(req, reply);
    if (!org) return reply;
    return reply.type("application/scim+json").send({ schemas: [SCIM_LIST], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] });
  });
}
