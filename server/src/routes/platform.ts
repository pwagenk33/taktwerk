// Operator ("Betreiber") routes: several companies on one installation, strictly separated by organization_id.
// Platform admins create and manage organizations; with REGISTRATION_OPEN companies register themselves.
import { and, count, eq, ne, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, appOrigin, organizationForHost, requireUser, type AppContext } from "../app";
import { TRIAL_DAYS, mrrOf, planById } from "@taktwerk/domain";
import { hashPassword, passwordProblem } from "../auth/crypto";
import { DEFAULT_BRANDING, organizations, sessions, users } from "../db/schema";
import { actionMail } from "../mail/mailer";
import { RESERVED_SLUGS, createOrganization, slugOf } from "../seed";
import { requireFeature, saasOn, seatsUsed } from "../saas";
import { createPasswordToken, passwordLink, signIn } from "./auth";
import { periodEnd } from "./subscription";

const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?$/, "Kürzel: Kleinbuchstaben, Ziffern und Bindestriche, 2–60 Zeichen");
const host = z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "Domain wie zeit.firma.ch, ohne https://");

/** New companies in SaaS mode start with a trial of the chosen package; without Stripe the operator bills by invoice. */
const trialFor = (ctx: AppContext, plan: "start" | "team" | "business" = "team") =>
  saasOn(ctx) ? { plan, days: TRIAL_DAYS, billingMode: ctx.config.STRIPE_SECRET_KEY ? ("stripe" as const) : ("invoice" as const) } : undefined;

// Registration abuse protection: 5 registrations per IP and hour.
const regs = new Map<string, { count: number; until: number }>();

export async function platformRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  const requirePlatformAdmin = (req: Parameters<typeof requireUser>[0]) => {
    const u = requireUser(req);
    if (!u.platformAdmin) throw new HttpError(403, "Nur der Betreiber der Installation darf Firmen verwalten.");
    return u;
  };
  const view = async (o: typeof organizations.$inferSelect) => {
    const [{ n }] = await ctx.db.select({ n: count() }).from(users).where(and(eq(users.organizationId, o.id), eq(users.active, true), ne(users.role, "customer")));
    const plan = planById(o.plan);
    const seats = await seatsUsed(ctx, o.id);
    const paying = o.subStatus === "active" || o.subStatus === "past_due";
    return {
      id: o.id, name: o.name, slug: o.slug, domain: o.domain, active: o.active, appName: o.settings.branding.appName, users: n, createdAt: o.createdAt,
      origin: appOrigin(ctx.config, o),
      plan: o.plan, status: o.subStatus, interval: o.billingInterval, billing: o.billingMode, seats,
      trialEndsAt: o.trialEndsAt, currentPeriodEnd: o.currentPeriodEnd, canceledAt: o.canceledAt,
      mrr: paying && o.active ? mrrOf(plan, o.billingInterval, seats) : 0,
    };
  };
  const emailFree = async (email: string, username: string) => {
    const [clash] = await ctx.db.select({ id: users.id }).from(users).where(or(eq(users.username, username), sql`lower(${users.email}) = ${email}`)).limit(1);
    if (clash) throw new HttpError(409, "Für diese E-Mail-Adresse gibt es bereits ein Konto.");
  };

  app.get("/api/platform/orgs", async (req) => {
    requirePlatformAdmin(req);
    const rows = await ctx.db.select().from(organizations).orderBy(organizations.name);
    const orgs = await Promise.all(rows.map(view));
    const by = (s: string) => orgs.filter((o) => o.active && o.status === s).length;
    const summary = { mrr: Math.round(orgs.reduce((sum, o) => sum + o.mrr, 0) * 100) / 100, active: by("active"), trialing: by("trialing"), pastDue: by("past_due"), ended: by("canceled") + by("expired") };
    return { registrationOpen: ctx.config.REGISTRATION_OPEN === "true", saas: saasOn(ctx), mainOrigin: appOrigin(ctx.config), summary, orgs };
  });

  /** Creates a company with its first admin and mails the invitation. */
  app.post("/api/platform/orgs", async (req, reply) => {
    const me = requirePlatformAdmin(req);
    const body = z
      .object({ name: z.string().trim().min(1).max(200), slug: slug.optional(), domain: host.optional(), adminName: z.string().trim().min(1).max(160), adminEmail: z.string().trim().toLowerCase().email() })
      .parse(req.body);
    await emailFree(body.adminEmail, body.adminEmail);
    if (body.domain) {
      const [d] = await ctx.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.domain, body.domain)).limit(1);
      if (d) throw new HttpError(409, "Diese Domain ist bereits einer Firma zugeordnet.");
    }
    const { orgId, userId } = await createOrganization(ctx.db, { orgName: body.name, name: body.adminName, email: body.adminEmail, username: body.adminEmail, slug: body.slug, domain: body.domain, trial: trialFor(ctx), onboarding: true });
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    const token = await createPasswordToken(ctx, userId, "invite");
    await ctx.mailer.send(
      actionMail(DEFAULT_BRANDING, {
        to: body.adminEmail,
        subject: `${DEFAULT_BRANDING.appName}: Zugang für ${body.name}`,
        greeting: `Hallo ${body.adminName}`,
        lines: [`${me.name} hat ${body.name} auf ${DEFAULT_BRANDING.appName} eingerichtet. Du bist Admin und lädst dein Team selbst ein.`, `Dein Benutzername ist «${body.adminEmail}». Lege über den Link ein Passwort fest.`],
        action: "Passwort festlegen",
        url: passwordLink(ctx, token, org),
        footer: "Der Link ist sieben Tage gültig.",
      }),
    );
    return reply.status(201).send(await view(org!));
  });

  app.patch("/api/platform/orgs/:id", async (req) => {
    requirePlatformAdmin(req);
    const { id } = req.params as { id: string };
    const body = z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        slug: slug.optional(),
        domain: host.nullable().optional(),
        active: z.boolean().optional(),
        // Subscription by hand (invoice customers, goodwill): package, status, trial end.
        plan: z.enum(["start", "team", "business"]).optional(),
        subStatus: z.enum(["trialing", "active", "past_due", "canceled", "expired"]).optional(),
        billingInterval: z.enum(["month", "year"]).optional(),
        trialEndsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      })
      .parse(req.body);
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
    if (!org) throw new HttpError(404, "Firma nicht gefunden.");
    if (body.domain) {
      const [d] = await ctx.db.select({ id: organizations.id }).from(organizations).where(and(eq(organizations.domain, body.domain), ne(organizations.id, id))).limit(1);
      if (d) throw new HttpError(409, "Diese Domain ist bereits einer Firma zugeordnet.");
    }
    if (body.slug && RESERVED_SLUGS.includes(body.slug)) throw new HttpError(400, "Dieses Kürzel ist für die Installation reserviert.");
    if (body.slug) {
      const [d] = await ctx.db.select({ id: organizations.id }).from(organizations).where(and(eq(organizations.slug, body.slug), ne(organizations.id, id))).limit(1);
      if (d) throw new HttpError(409, "Dieses Kürzel ist bereits vergeben.");
    }
    const { trialEndsAt, ...rest } = body;
    // «Paid, set active» by hand: a new period starts unless one is still running.
    const activating = body.subStatus === "active" && org.subStatus !== "active";
    const periodRunning = org.currentPeriodEnd && org.currentPeriodEnd > new Date();
    await ctx.db
      .update(organizations)
      .set({
        ...rest,
        ...(trialEndsAt !== undefined ? { trialEndsAt: trialEndsAt ? new Date(`${trialEndsAt}T23:59:59Z`) : null } : {}),
        ...(activating ? { trialEndsAt: null, canceledAt: null, ...(periodRunning ? {} : { currentPeriodEnd: periodEnd(new Date(), body.billingInterval ?? org.billingInterval) }) } : {}),
      })
      .where(eq(organizations.id, id));
    if (body.active === false) {
      // Everyone of a deactivated company is signed out at once.
      const people = await ctx.db.select({ id: users.id }).from(users).where(eq(users.organizationId, id));
      for (const p of people) await ctx.db.delete(sessions).where(eq(sessions.userId, p.id));
    }
    const [after] = await ctx.db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
    return view(after!);
  });

  /**
   * Caddy's on-demand TLS asks here before it requests a certificate: only addresses that belong to the installation
   * (main address, status page, <slug>.<base domain> of an active company, a company's own domain) get one.
   */
  app.get("/api/tls-check", async (req, reply) => {
    const domain = String((req.query as { domain?: string }).domain ?? "").toLowerCase();
    const main = new URL(ctx.config.APP_URL).hostname;
    const base = ctx.config.SAAS_BASE_DOMAIN?.toLowerCase();
    let ok = domain === main || domain === `status.${main}` || (!!base && (domain === base || domain === `www.${base}` || domain === `status.${base}`));
    if (!ok && domain) {
      const org = await organizationForHost(ctx.db, domain, base);
      ok = !!org && org.active && (org.domain === domain || (!!base && domain === `${org.slug}.${base}`));
    }
    return reply.status(ok ? 200 : 404).send(ok ? "ok" : "unbekannt");
  });

  /** Business: a company's own domain (e.g. zeit.firma.ch, CNAME to the installation). */
  app.put("/api/org/domain", async (req) => {
    const admin = requireUser(req);
    if (admin.role !== "admin") throw new HttpError(403, "Nur Admins können die Adresse ändern.");
    requireFeature(admin, "customDomain");
    const { domain } = z.object({ domain: host.nullable() }).parse(req.body);
    const base = ctx.config.SAAS_BASE_DOMAIN?.toLowerCase();
    if (domain && (domain === new URL(ctx.config.APP_URL).hostname || (base && (domain === base || domain.endsWith(`.${base}`)))))
      throw new HttpError(400, "Bitte eine Domain deiner Firma verwenden, z. B. zeit.firma.ch.");
    if (domain) {
      const [d] = await ctx.db.select({ id: organizations.id }).from(organizations).where(and(eq(organizations.domain, domain), ne(organizations.id, admin.organizationId))).limit(1);
      if (d) throw new HttpError(409, "Diese Domain ist bereits einer Firma zugeordnet.");
    }
    await ctx.db.update(organizations).set({ domain }).where(eq(organizations.id, admin.organizationId));
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, admin.organizationId)).limit(1);
    const target = base && org ? `${org.slug}.${base}` : new URL(ctx.config.APP_URL).hostname;
    return { domain, origin: appOrigin(ctx.config, org), dns: domain ? { type: "CNAME", name: domain, value: target } : null };
  });

  /** Self-service: a company registers and its first admin is signed in right away. */
  app.post("/api/orgs/register", async (req, reply) => {
    if (ctx.config.REGISTRATION_OPEN !== "true") throw new HttpError(404, "Die Registrierung ist auf dieser Installation nicht freigeschaltet.");
    const r = regs.get(req.ip);
    if (r && r.count >= 5 && r.until > Date.now()) throw new HttpError(429, "Zu viele Registrierungen. Bitte später erneut versuchen.");
    const body = z
      .object({ company: z.string().trim().min(2).max(200), name: z.string().trim().min(1).max(160), email: z.string().trim().toLowerCase().email(), password: z.string().max(500), plan: z.enum(["start", "team", "business"]).optional() })
      .parse(req.body);
    const problem = passwordProblem(body.password);
    if (problem) throw new HttpError(400, problem);
    await emailFree(body.email, body.email);
    regs.set(req.ip, { count: (r && r.until > Date.now() ? r.count : 0) + 1, until: Date.now() + 3600_000 });
    const { orgId, userId, slug: s } = await createOrganization(ctx.db, { orgName: body.company, name: body.name, email: body.email, username: body.email, passwordHash: await hashPassword(body.password), slug: slugOf(body.company), trial: trialFor(ctx, body.plan), onboarding: true });
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    const done = await signIn(ctx, req, reply, userId);
    const origin = appOrigin(ctx.config, org);
    await ctx.mailer.send(
      actionMail(DEFAULT_BRANDING, {
        to: body.email,
        subject: `Willkommen bei ${DEFAULT_BRANDING.appName}`,
        greeting: `Hallo ${body.name}`,
        lines: [
          `${body.company} ist eingerichtet. Du bist Admin: Lade dein Team unter Einstellungen → Benutzer ein und lege Kunden und Projekte an.`,
          `Anmeldung: ${origin} mit «${body.email}».`,
          ...(saasOn(ctx) ? [`Du testest das Paket ${planById(body.plan ?? "team").name} ${TRIAL_DAYS} Tage lang kostenlos und unverbindlich. Ein Paket wählst du jederzeit unter Einstellungen → Abo.`] : []),
        ],
        footer: "Fragen? Antworte einfach auf diese E-Mail.",
      }),
    );
    if (ctx.config.OPERATOR_EMAIL)
      await ctx.mailer
        .send(
          actionMail(DEFAULT_BRANDING, {
            to: ctx.config.OPERATOR_EMAIL,
            subject: `Neue Firma: ${body.company}`,
            greeting: "Hallo",
            lines: [`${body.company} (${s}) hat sich registriert.`, `Admin: ${body.name}, ${body.email}`, `Paket: ${saasOn(ctx) ? `${planById(body.plan ?? "team").name}, Testphase` : "ohne Abo"}`, `Adresse: ${origin}`],
            footer: "Diese Meldung geht an OPERATOR_EMAIL.",
          }),
        )
        .catch((e) => req.log.warn({ err: e }, "operator mail failed"));
    return reply.status(201).send({ organizationId: orgId, slug: s, redirect: done.redirect });
  });
}
