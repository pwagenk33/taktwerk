import { todayZurich } from "./data";
import { and, eq, ne, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError, requireRole, requireUser } from "../app";
import { VAT_RATES } from "@taktwerk/domain";
import { customers, organizations, sessions, users, type OrgSettings } from "../db/schema";
import { actionMail } from "../mail/mailer";
import { createPasswordToken, passwordLink } from "./auth";
import { fetchFxRates } from "../fx";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Farbe als Hex-Wert, z. B. #D52B1E");

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
  .pipe(z.string().regex(/^(CH|LI)\d{2}[0-9A-Z]{17}$/, "Ungültige IBAN (CH/LI, 21 Zeichen)"));

export async function adminRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  const orgOf = async (id: string) => {
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
    if (!org) throw new HttpError(404, "Organisation nicht gefunden.");
    return org;
  };

  // ---------- settings ----------

  app.put("/api/customers/:id/address", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const { id } = req.params as { id: string };
    const address = postalAddress.parse(req.body);
    const res = await ctx.db.update(customers).set({ billingAddress: address }).where(and(eq(customers.id, id), eq(customers.organizationId, user.organizationId)));
    if (res[0].affectedRows === 0) throw new HttpError(404, "Kunde nicht gefunden.");
    return address;
  });

  app.get("/api/customers/:id/address", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const { id } = req.params as { id: string };
    const [c] = await ctx.db.select().from(customers).where(and(eq(customers.id, id), eq(customers.organizationId, user.organizationId))).limit(1);
    if (!c) throw new HttpError(404, "Kunde nicht gefunden.");
    return c.billingAddress ?? { name: c.name, street: "", zip: "", city: "", country: "CH" };
  });

  app.get("/api/settings", async (req) => {
    const user = requireUser(req);
    const org = await orgOf(user.organizationId);
    return { name: org.name, ...org.settings };
  });

  app.put("/api/settings", async (req) => {
    const user = requireRole(req, "admin");
    const body = z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        branding: z.object({ appName: z.string().trim().min(1).max(60), primaryColor: hexColor, showMotif: z.boolean() }).optional(),
        ssoAutoProvisionDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Ungültige Domain")).max(20).optional(),
        reportDay: z.number().int().min(1).max(28).optional(),
        weeklyHours: z.number().min(1).max(60).optional(),
        kmRate: z.number().min(0).max(5).optional(),
        vatRate: z.number().refine((v) => (VAT_RATES as readonly number[]).includes(v), "Ungültiger MwSt-Satz").optional(),
        hoursReminder: z.boolean().optional(),
        closingReminder: z.boolean().optional(),
        costRate: z.number().min(0).max(1000).optional(),
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
          .array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum im Format JJJJ-MM-TT"), name: z.string().trim().min(1).max(80), fraction: z.union([z.literal(0.5), z.literal(1)]) }))
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
      billing: body.billing ?? org.settings.billing,
      costRate: body.costRate ?? org.settings.costRate,
      fx: body.fx ? { rates: { ...org.settings.fx?.rates, ...body.fx.rates }, asOf: todayZurich(), source: "manuell", manual: body.fx.manual ?? true } : org.settings.fx,
    };
    await ctx.db.update(organizations).set({ name: body.name ?? org.name, settings }).where(eq(organizations.id, org.id));
    return { name: body.name ?? org.name, ...settings };
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
        subject: `${org.settings.branding.appName}: Test-E-Mail`,
        greeting: `Hallo ${user.name}`,
        lines: ["Der E-Mail-Versand über SMTP funktioniert."],
        action: "App öffnen",
        url: new URL(ctx.config.APP_URL).origin,
        footer: "Diese E-Mail wurde aus den Einstellungen ausgelöst.",
      }),
    );
    return { ok: true, smtp: Boolean(ctx.config.SMTP_HOST) };
  });

  // ---------- users ----------

  app.get("/api/users", async (req) => {
    const user = requireRole(req, "admin");
    const rows = await ctx.db.select().from(users).where(eq(users.organizationId, user.organizationId));
    return rows.map(({ passwordHash, ...u }) => ({ ...u, hasPassword: passwordHash !== null }));
  });

  /** Creates the user and e-mails an invitation link to set a password (or sign in with Microsoft/Google). */
  app.post("/api/users", async (req, reply) => {
    const admin = requireRole(req, "admin");
    const body = z
      .object({
        name: z.string().trim().min(1).max(160),
        email: z.string().trim().toLowerCase().email(),
        username: z.string().trim().min(3).max(80).regex(/^[a-zA-Z0-9._@-]+$/, "Benutzername: Buchstaben, Ziffern, . _ - @"),
        role: z.enum(["admin", "consultant", "employee"]),
        teamId: z.string().optional(),
      })
      .parse(req.body);
    const [clash] = await ctx.db
      .select({ id: users.id })
      .from(users)
      .where(or(eq(users.username, body.username), sql`lower(${users.email}) = ${body.email}`))
      .limit(1);
    if (clash) throw new HttpError(409, "Benutzername oder E-Mail ist bereits vergeben.");
    const id = randomUUID();
    await ctx.db.insert(users).values({ id, organizationId: admin.organizationId, ...body, teamId: body.teamId || null, trackingStart: todayZurich() });
    const token = await createPasswordToken(ctx, id, "invite");
    const org = await orgOf(admin.organizationId);
    await ctx.mailer.send(
      actionMail(org.settings.branding, {
        to: body.email,
        subject: `Einladung zu ${org.settings.branding.appName}`,
        greeting: `Hallo ${body.name}`,
        lines: [
          `${admin.name} hat dich zu ${org.settings.branding.appName} von ${org.name} eingeladen. Dein Benutzername ist «${body.username}».`,
          "Setze über den Link ein Passwort. Alternativ kannst du dich mit deinem Microsoft- oder Google-Konto anmelden, wenn es diese E-Mail-Adresse verwendet.",
        ],
        action: "Passwort festlegen",
        url: passwordLink(ctx, token),
        footer: "Der Link ist sieben Tage gültig.",
      }),
    );
    return reply.status(201).send({ id });
  });

  app.patch("/api/users/:id", async (req) => {
    const admin = requireRole(req, "admin");
    const { id } = req.params as { id: string };
    const body = z
      .object({ name: z.string().trim().min(1).max(160).optional(), role: z.enum(["admin", "consultant", "employee"]).optional(), active: z.boolean().optional(), teamId: z.string().nullable().optional(), costRate: z.number().min(0).max(1000).nullable().optional() })
      .parse(req.body);
    const [target] = await ctx.db.select().from(users).where(and(eq(users.id, id), eq(users.organizationId, admin.organizationId))).limit(1);
    if (!target) throw new HttpError(404, "Benutzer nicht gefunden.");
    const demotes = (body.role && body.role !== "admin") || body.active === false;
    if (target.role === "admin" && demotes) {
      const [other] = await ctx.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.organizationId, admin.organizationId), eq(users.role, "admin"), eq(users.active, true), ne(users.id, id)))
        .limit(1);
      if (!other) throw new HttpError(400, "Es muss mindestens ein aktiver Admin bleiben.");
    }
    await ctx.db.update(users).set(body).where(eq(users.id, id));
    if (body.active === false) await ctx.db.delete(sessions).where(eq(sessions.userId, id));
    return { ok: true };
  });
}
