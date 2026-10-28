// Customer portal: customers sign in with their own account (role "customer") and see budgets, forecasts, reports and
// invoices of their company only. Leads invite and revoke portal accounts from the customer page.
import { fmtMonth, monthOf, projectReports, type Dataset } from "@taktwerk/domain";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError, requireRole, requireUser, type AppContext } from "../app";
import { requireFeature } from "../saas";
import { customers, invoices, organizations, sessions, users } from "../db/schema";
import { actionMail } from "../mail/mailer";
import { renderInvoicePdf } from "../reports/invoice";
import { reportFile } from "../reports/export";
import { createPasswordToken, passwordLink } from "./auth";
import { loadDataset } from "./data";

const monthParam = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Monat im Format JJJJ-MM");

export interface PortalOverview {
  customer: { id: string; name: string; currency: "CHF" | "EUR" | "USD" };
  orgName: string;
  today: string;
  projects: ReturnType<typeof projectReports>;
  /** Billable hours and amount per month, oldest first (last 12 months). */
  months: { month: string; label: string; hours: number; amount: number }[];
  invoices: { id: string; number: string; month: string; issueDate: string; dueDate: string; status: "sent" | "paid"; net: number; gross: number }[];
}

export async function portalOverview(ctx: AppContext, orgId: string, customerId: string): Promise<PortalOverview> {
  const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const [customer] = await ctx.db.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.organizationId, orgId))).limit(1);
  if (!org || !customer) throw new HttpError(404, "Kunde nicht gefunden.");
  const data: Dataset = await loadDataset(ctx, { id: "", organizationId: orgId, name: "", username: "", email: "", role: "admin" });
  const reports = projectReports(data, { method: "rolling", window: 3 }, customerId);
  const subIds = new Set(reports.flatMap((r) => r.subs.map((s) => s.subProject.id)));
  const months: PortalOverview["months"] = [];
  const cur = monthOf(data.today);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(`${cur}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - i);
    const month = d.toISOString().slice(0, 7);
    const own = data.timeEntries.filter((e) => e.billable && subIds.has(e.subProjectId) && monthOf(e.date) === month);
    months.push({ month, label: fmtMonth(month), hours: Math.round(own.reduce((s, e) => s + e.hours, 0) * 10) / 10, amount: Math.round(own.reduce((s, e) => s + e.hours * e.hourlyRate, 0)) });
  }
  const invoiceRows = await ctx.db
    .select()
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), eq(invoices.organizationId, orgId), inArray(invoices.status, ["sent", "paid"])))
    .orderBy(desc(invoices.number));
  // Portal accounts never see hourly rates of the organization's cost side; reports carry the customer's own rates only.
  return {
    customer: { id: customer.id, name: customer.name, currency: customer.currency },
    orgName: org.name,
    today: data.today,
    projects: reports,
    months,
    invoices: invoiceRows.map((i) => ({ id: i.id, number: i.number, month: i.month, issueDate: i.issueDate, dueDate: i.dueDate, status: i.status as "sent" | "paid", net: i.net, gross: i.gross })),
  };
}

export async function portalRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  const portalUser = (req: Parameters<typeof requireUser>[0]) => {
    const user = requireUser(req);
    if (user.role !== "customer" || !user.customerId) throw new HttpError(403, "Das Kundenportal steht nur Kundenkonten offen.");
    return user as typeof user & { customerId: string };
  };

  app.get("/api/portal", async (req) => {
    const user = portalUser(req);
    return portalOverview(ctx, user.organizationId, user.customerId);
  });

  app.get("/api/portal/invoices/:id/pdf", async (req, reply) => {
    const user = portalUser(req);
    const { id } = req.params as { id: string };
    const [inv] = await ctx.db.select().from(invoices).where(and(eq(invoices.id, id), eq(invoices.customerId, user.customerId), inArray(invoices.status, ["sent", "paid"]))).limit(1);
    if (!inv) throw new HttpError(404, "Rechnung nicht gefunden.");
    const pdf = await renderInvoicePdf(inv);
    return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="Rechnung-${inv.number}.pdf"`).send(pdf);
  });

  app.get("/api/portal/report", async (req, reply) => {
    const user = portalUser(req);
    const q = z.object({ month: monthParam, format: z.enum(["pdf", "xlsx"]).default("pdf") }).parse(req.query);
    const file = await reportFile(ctx, user.organizationId, user.customerId, q.month, q.format);
    return reply.header("content-type", file.contentType).header("content-disposition", `attachment; filename="${file.filename}"`).send(file.data);
  });

  // ---------- Lead side: who has access ----------

  const customerInOrg = async (orgId: string, customerId: string) => {
    const [c] = await ctx.db.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.organizationId, orgId))).limit(1);
    if (!c) throw new HttpError(404, "Kunde nicht gefunden.");
    return c;
  };
  const accountView = (u: typeof users.$inferSelect) => ({ id: u.id, name: u.name, email: u.email, username: u.username, active: u.active, lastLoginAt: u.lastLoginAt, hasPassword: u.passwordHash !== null });

  app.get("/api/customers/:id/portal", async (req) => {
    const lead = requireRole(req, "admin", "consultant");
    const { id } = req.params as { id: string };
    await customerInOrg(lead.organizationId, id);
    const rows = await ctx.db.select().from(users).where(and(eq(users.customerId, id), eq(users.role, "customer"), eq(users.active, true)));
    return rows.map(accountView);
  });

  /** Creates a portal account and mails the invitation with a link to set a password. */
  app.post("/api/customers/:id/portal", async (req, reply) => {
    const lead = requireRole(req, "admin", "consultant");
    requireFeature(lead, "portal");
    const { id } = req.params as { id: string };
    const customer = await customerInOrg(lead.organizationId, id);
    const body = z.object({ name: z.string().trim().min(1).max(160), email: z.string().trim().toLowerCase().email() }).parse(req.body);
    const [clash] = await ctx.db.select({ id: users.id }).from(users).where(or(eq(users.username, body.email), sql`lower(${users.email}) = ${body.email}`)).limit(1);
    if (clash) throw new HttpError(409, "Für diese E-Mail-Adresse gibt es bereits ein Konto.");
    const userId = randomUUID();
    await ctx.db.insert(users).values({ id: userId, organizationId: lead.organizationId, customerId: id, name: body.name, email: body.email, username: body.email, role: "customer" });
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, lead.organizationId)).limit(1);
    const branding = org!.settings.branding;
    const token = await createPasswordToken(ctx, userId, "invite");
    await ctx.mailer.send(
      actionMail(branding, {
        to: body.email,
        subject: `Ihr Zugang zum Kundenportal von ${org!.name}`,
        greeting: `Guten Tag ${body.name}`,
        lines: [
          `${lead.name} hat für Sie einen Zugang zum Kundenportal von ${org!.name} eingerichtet. Dort sehen Sie jederzeit Budget, Restbudget und Prognose Ihrer Projekte (${customer.name}), die Monatsreports und Ihre Rechnungen.`,
          `Ihr Benutzername ist Ihre E-Mail-Adresse «${body.email}». Legen Sie über den Link ein Passwort fest.`,
        ],
        action: "Passwort festlegen",
        url: passwordLink(ctx, token, org),
        footer: "Der Link ist sieben Tage gültig. Bei Fragen antworten Sie einfach auf diese E-Mail.",
      }),
    );
    const [row] = await ctx.db.select().from(users).where(eq(users.id, userId)).limit(1);
    return reply.status(201).send(accountView(row!));
  });

  /** Revokes a portal account: deactivates it and ends its sessions. */
  app.delete("/api/customers/:id/portal/:userId", async (req) => {
    const lead = requireRole(req, "admin", "consultant");
    const { id, userId } = req.params as { id: string; userId: string };
    await customerInOrg(lead.organizationId, id);
    const [row] = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.customerId, id), eq(users.role, "customer"))).limit(1);
    if (!row) throw new HttpError(404, "Konto nicht gefunden.");
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, userId));
    await ctx.db.delete(sessions).where(eq(sessions.userId, userId));
    return { ok: true };
  });
}
