import { todayZurich } from "./data";
import { and, eq, ne, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError, requireRole, requireUser } from "../app";
import { requireFeature, syncSeats } from "../saas";
import { PAYROLL_ITEMS, VAT_RATES, type PayrollItem } from "@taktwerk/domain";
import { customers, organizations, sessions, teams, users, type OrgSettings } from "../db/schema";
import { actionMail } from "../mail/mailer";
import { createPasswordToken, passwordLink } from "./auth";
import { fetchFxRates } from "../fx";
import { digestMail } from "../reports/digest";
import { tr } from "@taktwerk/domain";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, tr("Farbe als Hex-Wert, z. B. #D52B1E"));

export const postalAddress = z.object({
  name: z.string().trim().min(1).max(70),
  street: z.string().trim().max(70),
  zip: z.string().trim().min(1).max(16),
  city: z.string().trim().min(1).max(35),
  country: z.string().trim().toUpperCase().length(2).default("CH"),
});

const iban = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase().replace(/\s+/g, ""))
  .pipe(z.string().regex(/^(CH|LI)\d{2}[0-9A-Z]{17}$/, tr("Ungültige IBAN (CH/LI, 21 Zeichen)")));

export async function adminRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  /** A team id from the request must belong to the same company. */
  const assertOwnTeam = async (orgId: string, teamId: string | null | undefined) => {
    if (!teamId) return;
    const [team] = await ctx.db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, teamId), eq(teams.organizationId, orgId))).limit(1);
    if (!team) throw new HttpError(404, tr("Team nicht gefunden."));
  };

  const orgOf = async (id: string) => {
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
    if (!org) throw new HttpError(404, tr("Organisation nicht gefunden."));
    return org;
  };

  // ---------- settings ----------

  app.put("/api/customers/:id/address", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const { id } = req.params as { id: string };
    const address = postalAddress.parse(req.body);
    const res = await ctx.db.update(customers).set({ billingAddress: address }).where(and(eq(customers.id, id), eq(customers.organizationId, user.organizationId)));
    if (res[0].affectedRows === 0) throw new HttpError(404, tr("Kunde nicht gefunden."));
    return address;
  });

  app.get("/api/customers/:id/address", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const { id } = req.params as { id: string };
    const [c] = await ctx.db.select().from(customers).where(and(eq(customers.id, id), eq(customers.organizationId, user.organizationId))).limit(1);
    if (!c) throw new HttpError(404, tr("Kunde nicht gefunden."));
    return c.billingAddress ?? { name: c.name, street: "", zip: "", city: "", country: "CH" };
  });

  app.get("/api/settings", async (req) => {
    const user = requireUser(req);
    const org = await orgOf(user.organizationId);
    // SSO details have their own admin endpoint (/api/sso); the SCIM token hash never leaves the server.
    const { sso, chat: _chat, stampPoints, ...rest } = org.settings;
    // Stamp point links only for admins (/api/presence/points); everyone learns whether there are any.
    return { name: org.name, ...rest, ssoActive: !!sso?.saml?.enabled, stampPointCount: stampPoints?.length ?? 0 };
  });

  app.put("/api/settings", async (req) => {
    const user = requireRole(req, "admin");
    const body = z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        branding: z.object({ appName: z.string().trim().min(1).max(60), primaryColor: hexColor, showMotif: z.boolean() }).optional(),
        ssoAutoProvisionDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, tr("Ungültige Domain"))).max(20).optional(),
        reportDay: z.number().int().min(1).max(28).optional(),
        weeklyHours: z.number().min(1).max(60).optional(),
        kmRate: z.number().min(0).max(5).optional(),
        vatRate: z.number().refine((v) => (VAT_RATES as readonly number[]).includes(v), tr("Ungültiger MwSt-Satz")).optional(),
        hoursReminder: z.boolean().optional(),
        closingReminder: z.boolean().optional(),
        timeModel: z.enum(["simplified", "full"]).optional(),
        onboarding: z.enum(["open", "done"]).optional(),
        costRate: z.number().min(0).max(1000).optional(),
        autoRetainerInvoices: z.boolean().optional(),
        payrollCodes: z.record(z.enum(PAYROLL_ITEMS.map((i) => i.id) as [PayrollItem, ...PayrollItem[]]), z.string().trim().max(20)).optional(),
        scheduledReports: z
          .array(
            z.object({
              id: z.string().min(1).max(40),
              name: z.string().trim().min(1).max(80),
              kind: z.enum(["weekly", "monthly"]),
              dayOfWeek: z.number().int().min(1).max(7).optional(),
              dayOfMonth: z.number().int().min(1).max(28).optional(),
              hour: z.number().int().min(0).max(23),
              recipients: z.array(z.string().trim().email()).max(50),
              enabled: z.boolean(),
            }),
          )
          .max(20)
          .optional(),
        fx: z.object({ rates: z.object({ EUR: z.number().positive().max(100).optional(), USD: z.number().positive().max(100).optional() }), manual: z.boolean().optional() }).optional(),
        billing: z
          .object({
            address: postalAddress,
            iban,
            vatNumber: z.string().trim().max(30).optional(),
            paymentDays: z.number().int().min(0).max(120),
            footer: z.string().trim().max(500).optional(),
          })
          .optional(),
        holidays: z
          .array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, tr("Datum im Format JJJJ-MM-TT")), name: z.string().trim().min(1).max(80), fraction: z.union([z.literal(0.5), z.literal(1)]) }))
          .max(300)
          .optional(),
      })
      .parse(req.body);
    const org = await orgOf(user.organizationId);
    const settings: OrgSettings = {
      ...org.settings,
      branding: body.branding ? { ...org.settings.branding, ...body.branding } : org.settings.branding,
      ssoAutoProvisionDomains: body.ssoAutoProvisionDomains ?? org.settings.ssoAutoProvisionDomains,
      reportDay: body.reportDay ?? org.settings.reportDay ?? 3,
      weeklyHours: body.weeklyHours ?? org.settings.weeklyHours,
      holidays: body.holidays ? [...new Map(body.holidays.map((h) => [h.date, h])).values()].sort((a, b) => a.date.localeCompare(b.date)) : org.settings.holidays,
      kmRate: body.kmRate ?? org.settings.kmRate,
      vatRate: body.vatRate ?? org.settings.vatRate,
      hoursReminder: body.hoursReminder ?? org.settings.hoursReminder,
      closingReminder: body.closingReminder ?? org.settings.closingReminder,
      timeModel: body.timeModel ?? org.settings.timeModel,
      billing: body.billing ?? org.settings.billing,
      costRate: body.costRate ?? org.settings.costRate,
      payrollCodes: body.payrollCodes ?? org.settings.payrollCodes,
      autoRetainerInvoices: body.autoRetainerInvoices ?? org.settings.autoRetainerInvoices,
      scheduledReports: body.scheduledReports ?? org.settings.scheduledReports,
      fx: body.fx ? { rates: { ...org.settings.fx?.rates, ...body.fx.rates }, asOf: todayZurich(), source: "manuell", manual: body.fx.manual ?? true } : org.settings.fx,
    };
    await ctx.db.update(organizations).set({ name: body.name ?? org.name, settings }).where(eq(organizations.id, org.id));
    const { sso, chat: _chat, stampPoints, ...rest } = settings;
    return { name: body.name ?? org.name, ...rest, ssoActive: !!sso?.saml?.enabled, stampPointCount: stampPoints?.length ?? 0 };
  });

  /** Sends one scheduled report now to the requesting admin, to check its content. */
  app.post("/api/settings/reports/:id/send", async (req) => {
    const user = requireRole(req, "admin");
    const { id } = req.params as { id: string };
    const org = await orgOf(user.organizationId);
    const r = org.settings.scheduledReports?.find((x) => x.id === id);
    if (!r) throw new HttpError(404, tr("Bericht nicht gefunden."));
    const { mail } = await digestMail(ctx, org.id, org.settings, r, todayZurich());
    await ctx.mailer.send({ ...mail, to: user.email });
    return { ok: true, to: user.email };
  });

  /** Pulls today's ECB rates now and switches back to automatic daily updates. */
  app.post("/api/settings/fx/refresh", async (req) => {
    const user = requireRole(req, "admin");
    const org = await orgOf(user.organizationId);
    const fx = await fetchFxRates();
    const settings: OrgSettings = { ...org.settings, fx: { ...fx, manual: false } };
    await ctx.db.update(organizations).set({ settings }).where(eq(organizations.id, org.id));
    return settings.fx;
  });

  app.post("/api/settings/test-mail", async (req) => {
    const user = requireRole(req, "admin");
    const org = await orgOf(user.organizationId);
    await ctx.mailer.send(
      actionMail(org.settings.branding, {
        to: user.email,
        subject: tr("{0}: Test-E-Mail", org.settings.branding.appName),
        greeting: tr("Hallo {0}", user.name),
        lines: [tr("Der E-Mail-Versand über SMTP funktioniert.")],
        action: tr("App öffnen"),
        url: new URL(ctx.config.APP_URL).origin,
        footer: tr("Diese E-Mail wurde aus den Einstellungen ausgelöst."),
      }),
    );
    return { ok: true, smtp: Boolean(ctx.config.SMTP_HOST) };
  });

  // ---------- users ----------

  app.get("/api/users", async (req) => {
    const user = requireRole(req, "admin");
    const rows = await ctx.db.select().from(users).where(and(eq(users.organizationId, user.organizationId), ne(users.role, "customer")));
    return rows.map(({ passwordHash, ...u }) => ({ ...u, hasPassword: passwordHash !== null }));
  });

  /** Creates the user and e-mails an invitation link to set a password (or sign in with Microsoft/Google). */
  app.post("/api/users", async (req, reply) => {
    const admin = requireRole(req, "admin");
    const body = z
      .object({
        name: z.string().trim().min(1).max(160),
        email: z.string().trim().toLowerCase().email(),
        username: z.string().trim().min(3).max(80).regex(/^[a-zA-Z0-9._@-]+$/, tr("Benutzername: Buchstaben, Ziffern, . _ - @")),
        role: z.enum(["admin", "consultant", "employee", "auditor"]),
        teamId: z.string().optional(),
      })
      .parse(req.body);
    const [clash] = await ctx.db
      .select({ id: users.id })
      .from(users)
      .where(or(eq(users.username, body.username), and(eq(users.organizationId, admin.organizationId), sql`lower(${users.email}) = ${body.email}`)))
      .limit(1);
    if (clash) throw new HttpError(409, tr("Benutzername oder E-Mail ist bereits vergeben."));
    if (body.role === "auditor") requireFeature(admin, "auditor");
    await assertOwnTeam(admin.organizationId, body.teamId);
    const id = randomUUID();
    await ctx.db.insert(users).values({ id, organizationId: admin.organizationId, ...body, teamId: body.teamId || null, trackingStart: todayZurich() });
    await syncSeats(ctx, admin.organizationId);
    const token = await createPasswordToken(ctx, id, "invite");
    const org = await orgOf(admin.organizationId);
    await ctx.mailer.send(
      actionMail(org.settings.branding, {
        to: body.email,
        subject: tr("Einladung zu {0}", org.settings.branding.appName),
        greeting: tr("Hallo {0}", body.name),
        lines: [
          tr("{0} hat dich zu {1} von {2} eingeladen. Dein Benutzername ist «{3}».", admin.name, org.settings.branding.appName, org.name, body.username),
          tr("Setze über den Link ein Passwort. Alternativ kannst du dich mit deinem Microsoft- oder Google-Konto anmelden, wenn es diese E-Mail-Adresse verwendet."),
        ],
        action: tr("Passwort festlegen"),
        url: passwordLink(ctx, token, org),
        footer: tr("Der Link ist sieben Tage gültig."),
      }),
    );
    return reply.status(201).send({ id });
  });

  app.patch("/api/users/:id", async (req) => {
    const admin = requireRole(req, "admin");
    const { id } = req.params as { id: string };
    const body = z
      .object({ name: z.string().trim().min(1).max(160).optional(), role: z.enum(["admin", "consultant", "employee", "auditor"]).optional(), active: z.boolean().optional(), teamId: z.string().nullable().optional(), costRate: z.number().min(0).max(1000).nullable().optional() })
      .parse(req.body);
    const [target] = await ctx.db.select().from(users).where(and(eq(users.id, id), eq(users.organizationId, admin.organizationId))).limit(1);
    if (!target) throw new HttpError(404, tr("Benutzer nicht gefunden."));
    if (body.role === "auditor" && target.role !== "auditor") requireFeature(admin, "auditor");
    await assertOwnTeam(admin.organizationId, body.teamId);
    // Billed people change when someone is (de)activated or moves between a free role (auditor) and a regular one.
    const free = (r: string) => r === "auditor" || r === "customer";
    const willCount = (body.active ?? target.active) && !free(body.role ?? target.role);
    const counted = target.active && !free(target.role);
    const demotes = (body.role && body.role !== "admin") || body.active === false;
    if (target.role === "admin" && demotes) {
      const [other] = await ctx.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.organizationId, admin.organizationId), eq(users.role, "admin"), eq(users.active, true), ne(users.id, id)))
        .limit(1);
      if (!other) throw new HttpError(400, tr("Es muss mindestens ein aktiver Admin bleiben."));
    }
    await ctx.db.update(users).set(body).where(eq(users.id, id));
    if (willCount !== counted) await syncSeats(ctx, admin.organizationId);
    if (body.active === false) await ctx.db.delete(sessions).where(eq(sessions.userId, id));
    return { ok: true };
  });

  // ---------- teams ----------

  app.get("/api/teams", async (req) => {
    const user = requireUser(req);
    const rows = await ctx.db.select().from(teams).where(eq(teams.organizationId, user.organizationId));
    return rows.map((t) => ({ id: t.id, name: t.name, leadUserId: t.leadUserId ?? null }));
  });

  const teamLead = async (orgId: string, leadUserId: string | null | undefined) => {
    if (!leadUserId) return null;
    const [u] = await ctx.db.select({ id: users.id, role: users.role }).from(users).where(and(eq(users.id, leadUserId), eq(users.organizationId, orgId), eq(users.active, true))).limit(1);
    if (!u || u.role === "customer" || u.role === "auditor") throw new HttpError(404, tr("Person für die Teamleitung nicht gefunden."));
    return u.id;
  };

  app.post("/api/teams", async (req, reply) => {
    const admin = requireRole(req, "admin");
    const body = z.object({ name: z.string().trim().min(1).max(120), leadUserId: z.string().nullable().optional() }).parse(req.body);
    const id = randomUUID();
    await ctx.db.insert(teams).values({ id, organizationId: admin.organizationId, name: body.name, leadUserId: await teamLead(admin.organizationId, body.leadUserId) });
    return reply.status(201).send({ id, name: body.name, leadUserId: body.leadUserId ?? null });
  });

  app.patch("/api/teams/:id", async (req) => {
    const admin = requireRole(req, "admin");
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().trim().min(1).max(120).optional(), leadUserId: z.string().nullable().optional() }).parse(req.body);
    const [t] = await ctx.db.select().from(teams).where(and(eq(teams.id, id), eq(teams.organizationId, admin.organizationId))).limit(1);
    if (!t) throw new HttpError(404, tr("Team nicht gefunden."));
    const next = { name: body.name ?? t.name, leadUserId: body.leadUserId === undefined ? t.leadUserId : await teamLead(admin.organizationId, body.leadUserId) };
    await ctx.db.update(teams).set(next).where(eq(teams.id, id));
    return { id, ...next };
  });

  /** Removes a team; its members keep their account without a team. */
  app.delete("/api/teams/:id", async (req) => {
    const admin = requireRole(req, "admin");
    const { id } = req.params as { id: string };
    const [t] = await ctx.db.select().from(teams).where(and(eq(teams.id, id), eq(teams.organizationId, admin.organizationId))).limit(1);
    if (!t) throw new HttpError(404, tr("Team nicht gefunden."));
    await ctx.db.update(users).set({ teamId: null }).where(eq(users.teamId, id));
    await ctx.db.delete(teams).where(eq(teams.id, id));
    return { ok: true };
  });
}
