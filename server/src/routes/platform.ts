// Operator ("Betreiber") routes: several companies on one installation, strictly separated by organization_id.
// Platform admins create and manage organizations; with REGISTRATION_OPEN companies register themselves.
import { and, count, eq, ne, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, appOrigin, requireUser } from "../app";
import { hashPassword, passwordProblem } from "../auth/crypto";
import { DEFAULT_BRANDING, organizations, sessions, users } from "../db/schema";
import { actionMail } from "../mail/mailer";
import { createOrganization, slugOf } from "../seed";
import { createPasswordToken, passwordLink, startSession } from "./auth";

const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?$/, "Kürzel: Kleinbuchstaben, Ziffern und Bindestriche, 2–60 Zeichen");
const host = z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "Domain wie zeit.firma.ch, ohne https://");

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
    return { id: o.id, name: o.name, slug: o.slug, domain: o.domain, active: o.active, appName: o.settings.branding.appName, users: n, createdAt: o.createdAt };
  };
  const emailFree = async (email: string, username: string) => {
    const [clash] = await ctx.db.select({ id: users.id }).from(users).where(or(eq(users.username, username), sql`lower(${users.email}) = ${email}`)).limit(1);
    if (clash) throw new HttpError(409, "Für diese E-Mail-Adresse gibt es bereits ein Konto.");
  };

  app.get("/api/platform/orgs", async (req) => {
    requirePlatformAdmin(req);
    const rows = await ctx.db.select().from(organizations).orderBy(organizations.name);
    return { registrationOpen: ctx.config.REGISTRATION_OPEN === "true", mainOrigin: appOrigin(ctx.config), orgs: await Promise.all(rows.map(view)) };
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
    const { orgId, userId } = await createOrganization(ctx.db, { orgName: body.name, name: body.adminName, email: body.adminEmail, username: body.adminEmail, slug: body.slug, domain: body.domain });
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
    const body = z.object({ name: z.string().trim().min(1).max(200).optional(), slug: slug.optional(), domain: host.nullable().optional(), active: z.boolean().optional() }).parse(req.body);
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
    if (!org) throw new HttpError(404, "Firma nicht gefunden.");
    if (body.domain) {
      const [d] = await ctx.db.select({ id: organizations.id }).from(organizations).where(and(eq(organizations.domain, body.domain), ne(organizations.id, id))).limit(1);
      if (d) throw new HttpError(409, "Diese Domain ist bereits einer Firma zugeordnet.");
    }
    if (body.slug) {
      const [d] = await ctx.db.select({ id: organizations.id }).from(organizations).where(and(eq(organizations.slug, body.slug), ne(organizations.id, id))).limit(1);
      if (d) throw new HttpError(409, "Dieses Kürzel ist bereits vergeben.");
    }
    await ctx.db.update(organizations).set(body).where(eq(organizations.id, id));
    if (body.active === false) {
      // Everyone of a deactivated company is signed out at once.
      const people = await ctx.db.select({ id: users.id }).from(users).where(eq(users.organizationId, id));
      for (const p of people) await ctx.db.delete(sessions).where(eq(sessions.userId, p.id));
    }
    const [after] = await ctx.db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
    return view(after!);
  });

  /** Self-service: a company registers and its first admin is signed in right away. */
  app.post("/api/orgs/register", async (req, reply) => {
    if (ctx.config.REGISTRATION_OPEN !== "true") throw new HttpError(404, "Die Registrierung ist auf dieser Installation nicht freigeschaltet.");
    const r = regs.get(req.ip);
    if (r && r.count >= 5 && r.until > Date.now()) throw new HttpError(429, "Zu viele Registrierungen. Bitte später erneut versuchen.");
    const body = z
      .object({ company: z.string().trim().min(2).max(200), name: z.string().trim().min(1).max(160), email: z.string().trim().toLowerCase().email(), password: z.string().max(500) })
      .parse(req.body);
    const problem = passwordProblem(body.password);
    if (problem) throw new HttpError(400, problem);
    await emailFree(body.email, body.email);
    regs.set(req.ip, { count: (r && r.until > Date.now() ? r.count : 0) + 1, until: Date.now() + 3600_000 });
    const { orgId, userId, slug: s } = await createOrganization(ctx.db, { orgName: body.company, name: body.name, email: body.email, username: body.email, passwordHash: await hashPassword(body.password), slug: slugOf(body.company) });
    await startSession(ctx, reply, userId);
    await ctx.mailer.send(
      actionMail(DEFAULT_BRANDING, {
        to: body.email,
        subject: `Willkommen bei ${DEFAULT_BRANDING.appName}`,
        greeting: `Hallo ${body.name}`,
        lines: [`${body.company} ist eingerichtet. Du bist Admin: Lade dein Team unter Einstellungen → Benutzer ein und lege Kunden und Projekte an.`, `Anmeldung: ${appOrigin(ctx.config)} mit «${body.email}».`],
        footer: "Fragen? Antworte einfach auf diese E-Mail.",
      }),
    );
    return reply.status(201).send({ organizationId: orgId, slug: s });
  });
}
