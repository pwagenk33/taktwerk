import { DEFAULT_RATES, EXPENSE_CATEGORIES, VAT_RATES, rateOn } from "@taktwerk/domain";
import { and, desc, eq, notInArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { bookingChanged } from "./data";
import { HttpError, assertManages, isLead, managedUserIds, managesPeople, managesUser, requireRole, requireUser, type AppContext, type SessionUser } from "../app";
import { auditLog, customerRates, customers, expenses, monthClosings, organizations, projects, subProjects, timeEntries, users } from "../db/schema";
import { reportFile, sendCustomerReport } from "../reports/export";
import { closingReminderMail } from "../jobs";
import { tr } from "@taktwerk/domain";
import { emit, eventOfAudit } from "../events";

const monthParam = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, tr("Monat im Format JJJJ-MM"));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, tr("Datum im Format JJJJ-MM-TT"));
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, tr("Uhrzeit im Format HH:MM"));

export async function audit(
  ctx: AppContext,
  actor: SessionUser,
  entity: (typeof auditLog.$inferInsert)["entity"],
  entityId: string,
  action: (typeof auditLog.$inferInsert)["action"],
  before: unknown,
  after: unknown,
) {
  await ctx.db.insert(auditLog).values({ id: randomUUID(), organizationId: actor.organizationId, actorId: actor.id, entity, entityId, action, before, after });
  const type = eventOfAudit(entity, action);
  if (!type) return;
  const { organizationId: _o, receiptPath: _r, ...object } = ((after ?? before ?? {}) as Record<string, unknown>);
  const [userId, month] = entity === "month" ? entityId.split(":") : [];
  await emit(ctx, actor.organizationId, type, { id: entityId, ...object, ...(month ? { userId, month } : {}), actorId: actor.id });
}

export async function monthStatus(ctx: AppContext, userId: string, month: string) {
  const [row] = await ctx.db.select().from(monthClosings).where(and(eq(monthClosings.userId, userId), eq(monthClosings.month, month))).limit(1);
  return row?.status ?? null;
}

/**
 * Throws unless `actor` may create or change bookings of `ownerId` in the month of `date`.
 * Open: owner and leads. Submitted: only leads (corrections during review). Approved: nobody until reopened.
 */
export async function assertBookable(ctx: AppContext, actor: SessionUser, ownerId: string, date: string) {
  if (actor.role === "auditor") throw new HttpError(403, tr("Dein Zugang ist nur lesend (Treuhand)."));
  if (ownerId !== actor.id && !(await managesUser(ctx, actor, ownerId))) throw new HttpError(403, tr("Du kannst nur eigene Buchungen ändern."));
  const status = await monthStatus(ctx, ownerId, date.slice(0, 7));
  if (status === "approved") throw new HttpError(409, tr("Der Monat {0} ist abgeschlossen. Eine Admin-Person kann ihn wieder öffnen.", date.slice(0, 7)));
  if (status === "submitted" && ownerId === actor.id && !isLead(actor)) throw new HttpError(409, tr("Der Monat {0} ist eingereicht. Änderungen nur noch durch die Freigabe-Person.", date.slice(0, 7)));
}

async function subProjectCustomer(ctx: AppContext, org: string, subProjectId: string) {
  const [row] = await ctx.db
    .select({ customerId: projects.customerId })
    .from(subProjects)
    .innerJoin(projects, eq(projects.id, subProjects.projectId))
    .where(and(eq(subProjects.id, subProjectId), eq(subProjects.organizationId, org)))
    .limit(1);
  if (!row) throw new HttpError(404, tr("Subprojekt nicht gefunden."));
  return row.customerId;
}

export async function billingRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  // ---------- edit and delete bookings ----------

  const entryPatch = z.object({
    subProjectId: z.string().optional(),
    date: isoDate.optional(),
    hours: z.number().positive().max(24).optional(),
    reason: z.string().trim().min(1, tr("Grund fehlt")).max(1000).optional(),
    billable: z.boolean().optional(),
    jiraIssueKey: z.string().max(40).nullable().optional(),
    startTime: clockTime.nullable().optional(),
  });

  app.patch("/api/time-entries/:id", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const body = entryPatch.parse(req.body);
    const [row] = await ctx.db.select().from(timeEntries).where(and(eq(timeEntries.id, id), eq(timeEntries.organizationId, user.organizationId))).limit(1);
    if (!row) throw new HttpError(404, tr("Eintrag nicht gefunden."));
    await assertBookable(ctx, user, row.userId, row.date);
    const next = { ...row, ...body, jiraIssueKey: body.jiraIssueKey === undefined ? row.jiraIssueKey : body.jiraIssueKey || null };
    if (next.date !== row.date) await assertBookable(ctx, user, row.userId, next.date);
    if (next.date !== row.date || next.subProjectId !== row.subProjectId) {
      // New date or customer: freeze the rate valid then, like a new booking.
      const customerId = await subProjectCustomer(ctx, user.organizationId, next.subProjectId);
      const rates = await ctx.db.select().from(customerRates).where(eq(customerRates.customerId, customerId));
      next.hourlyRate = rateOn({ id: customerId, name: "", rates }, next.date);
    }
    const { id: _id, organizationId: _o, userId: _u, createdAt: _c, ...set } = next;
    if (Object.entries(set).every(([k, v]) => row[k as keyof typeof row] === v)) return row;
    await ctx.db.update(timeEntries).set(set).where(eq(timeEntries.id, id));
    bookingChanged(user.organizationId, row.date, next.date);
    await audit(ctx, user, "time_entry", id, "update", row, next);
    return next;
  });

  app.delete("/api/time-entries/:id", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const [row] = await ctx.db.select().from(timeEntries).where(and(eq(timeEntries.id, id), eq(timeEntries.organizationId, user.organizationId))).limit(1);
    if (!row) throw new HttpError(404, tr("Eintrag nicht gefunden."));
    await assertBookable(ctx, user, row.userId, row.date);
    await ctx.db.delete(timeEntries).where(eq(timeEntries.id, id));
    bookingChanged(user.organizationId, row.date);
    await audit(ctx, user, "time_entry", id, "delete", row, null);
    return { ok: true };
  });

  app.patch("/api/expenses/:id", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const body = z
      .object({
        subProjectId: z.string().optional(),
        date: isoDate.optional(),
        amount: z.number().positive().max(100000).optional(),
        category: z.enum(EXPENSE_CATEGORIES).optional(),
        reason: z.string().trim().min(1, tr("Grund fehlt")).max(1000).optional(),
        billable: z.boolean().optional(),
        vatRate: z.number().refine((v) => (VAT_RATES as readonly number[]).includes(v), tr("Ungültiger MwSt-Satz")).optional(),
        km: z.number().positive().max(10000).optional(),
      })
      .parse(req.body);
    const [row] = await ctx.db.select().from(expenses).where(and(eq(expenses.id, id), eq(expenses.organizationId, user.organizationId))).limit(1);
    if (!row) throw new HttpError(404, tr("Spese nicht gefunden."));
    await assertBookable(ctx, user, row.userId, row.date);
    if (body.date && body.date !== row.date) await assertBookable(ctx, user, row.userId, body.date);
    if (body.subProjectId) await subProjectCustomer(ctx, user.organizationId, body.subProjectId);
    if (row.status === "approved" && user.role === "employee" && (body.amount !== undefined || body.km !== undefined || body.billable !== undefined)) {
      throw new HttpError(409, tr("Eine bewilligte Spese kann nur noch von der Freigabe-Person geändert werden."));
    }
    if ((body.category ?? row.category) === "Kilometer" && body.km) {
      const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, user.organizationId)).limit(1);
      body.amount = Math.round(body.km * (org?.settings.kmRate ?? DEFAULT_RATES.kmRate) * 20) / 20;
      body.vatRate = 0;
    }
    const next = { ...row, ...body };
    if (Object.entries(body).every(([k, v]) => row[k as keyof typeof row] === v)) return row;
    await ctx.db.update(expenses).set(body).where(eq(expenses.id, id));
    await audit(ctx, user, "expense", id, "update", row, next);
    return next;
  });

  app.delete("/api/expenses/:id", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const [row] = await ctx.db.select().from(expenses).where(and(eq(expenses.id, id), eq(expenses.organizationId, user.organizationId))).limit(1);
    if (!row) throw new HttpError(404, tr("Spese nicht gefunden."));
    await assertBookable(ctx, user, row.userId, row.date);
    await ctx.db.delete(expenses).where(eq(expenses.id, id));
    await audit(ctx, user, "expense", id, "delete", row, null);
    return { ok: true };
  });

  /** Change history of one booking. */
  app.get("/api/audit/:entityId", async (req) => {
    const user = requireUser(req);
    const { entityId } = req.params as { entityId: string };
    const rows = await ctx.db
      .select({ log: auditLog, actor: users.name })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .where(and(eq(auditLog.organizationId, user.organizationId), eq(auditLog.entityId, entityId)))
      .orderBy(desc(auditLog.createdAt));
    const ownerId = (rows[0]?.log.before ?? rows[0]?.log.after) as { userId?: string } | null;
    if (ownerId?.userId && !(await managesUser(ctx, user, ownerId.userId))) throw new HttpError(403, tr("Dafür fehlt dir die Berechtigung."));
    return rows.map((r) => ({ ...r.log, actorName: r.actor }));
  });

  // ---------- monthly closing ----------

  /** All submitted/approved months (leads: everyone; employees: own). Months without a row are open. */
  app.get("/api/closings", async (req) => {
    const user = requireUser(req);
    const rows = await ctx.db.select().from(monthClosings).where(eq(monthClosings.organizationId, user.organizationId));
    const scope = await managedUserIds(ctx, user);
    return rows.filter((r) => !scope || scope.has(r.userId)).map((r) => ({ userId: r.userId, month: r.month, status: r.status }));
  });

  /** Status of every active person for a month (leads) or only the own status (employees). */
  app.get("/api/months/:month", async (req) => {
    const user = requireUser(req);
    const month = monthParam.parse((req.params as { month: string }).month);
    const people = await ctx.db.select().from(users).where(and(eq(users.organizationId, user.organizationId), eq(users.active, true), notInArray(users.role, ["customer", "auditor"])));
    const closings = await ctx.db.select().from(monthClosings).where(and(eq(monthClosings.organizationId, user.organizationId), eq(monthClosings.month, month)));
    const scope = await managedUserIds(ctx, user);
    return people
      .filter((p) => !scope || scope.has(p.id))
      .map((p) => {
        const c = closings.find((x) => x.userId === p.id);
        return { userId: p.id, name: p.name, status: c?.status ?? "open", submittedAt: c?.submittedAt ?? null, approvedAt: c?.approvedAt ?? null };
      });
  });

  app.post("/api/months/:month/submit", async (req) => {
    const user = requireUser(req);
    const month = monthParam.parse((req.params as { month: string }).month);
    if ((await monthStatus(ctx, user.id, month)) !== null) throw new HttpError(409, tr("Dieser Monat ist bereits eingereicht."));
    await ctx.db.insert(monthClosings).values({ organizationId: user.organizationId, userId: user.id, month, status: "submitted", submittedAt: new Date() });
    await audit(ctx, user, "month", `${user.id}:${month}`, "submit", null, { month });
    return { status: "submitted" };
  });

  app.post("/api/months/:month/approve", async (req) => {
    const lead = requireUser(req);
    const month = monthParam.parse((req.params as { month: string }).month);
    const { userId } = z.object({ userId: z.string() }).parse(req.body);
    if (userId === lead.id && !isLead(lead)) throw new HttpError(403, tr("Den eigenen Monat kann nur eine vorgesetzte Person freigeben."));
    await assertManages(ctx, lead, userId);
    const [person] = await ctx.db.select().from(users).where(and(eq(users.id, userId), eq(users.organizationId, lead.organizationId))).limit(1);
    if (!person) throw new HttpError(404, tr("Person nicht gefunden."));
    const status = await monthStatus(ctx, userId, month);
    if (status === "approved") throw new HttpError(409, tr("Dieser Monat ist bereits freigegeben."));
    // Leads may approve directly (e.g. for someone on holiday) without a prior submission.
    await ctx.db
      .insert(monthClosings)
      .values({ organizationId: lead.organizationId, userId, month, status: "approved", submittedAt: new Date(), approvedBy: lead.id, approvedAt: new Date() })
      .onDuplicateKeyUpdate({ set: { status: "approved", approvedBy: lead.id, approvedAt: new Date() } });
    await audit(ctx, lead, "month", `${userId}:${month}`, "approve", { status }, { status: "approved" });
    return { status: "approved" };
  });

  /** Reject a submission (leads) or reopen an approved month (admins only). */
  app.post("/api/months/:month/reopen", async (req) => {
    const lead = requireUser(req);
    const month = monthParam.parse((req.params as { month: string }).month);
    const { userId } = z.object({ userId: z.string() }).parse(req.body);
    if (userId === lead.id && !isLead(lead)) throw new HttpError(403, tr("Den eigenen Monat kann nur eine vorgesetzte Person zurückweisen."));
    await assertManages(ctx, lead, userId);
    const status = await monthStatus(ctx, userId, month);
    if (status === null) throw new HttpError(409, tr("Dieser Monat ist bereits offen."));
    if (status === "approved" && lead.role !== "admin") throw new HttpError(403, tr("Nur Admins können einen freigegebenen Monat wieder öffnen."));
    await ctx.db.delete(monthClosings).where(and(eq(monthClosings.userId, userId), eq(monthClosings.month, month), eq(monthClosings.organizationId, lead.organizationId)));
    await audit(ctx, lead, "month", `${userId}:${month}`, "reopen", { status }, { status: "open" });
    return { status: "open" };
  });

  /** Leads: approve every submitted month of the organization in one go. */
  app.post("/api/months/:month/approve-all", async (req) => {
    const lead = requireUser(req);
    if (!managesPeople(lead)) throw new HttpError(403, tr("Dafür fehlt dir die Berechtigung."));
    const month = monthParam.parse((req.params as { month: string }).month);
    const scope = await managedUserIds(ctx, lead);
    const rows = (
      await ctx.db
        .select()
        .from(monthClosings)
        .where(and(eq(monthClosings.organizationId, lead.organizationId), eq(monthClosings.month, month), eq(monthClosings.status, "submitted")))
    ).filter((r) => (!scope || scope.has(r.userId)) && (r.userId !== lead.id || isLead(lead)));
    for (const r of rows) {
      await ctx.db.update(monthClosings).set({ status: "approved", approvedBy: lead.id, approvedAt: new Date() }).where(and(eq(monthClosings.userId, r.userId), eq(monthClosings.month, month), eq(monthClosings.organizationId, lead.organizationId)));
      await audit(ctx, lead, "month", `${r.userId}:${month}`, "approve", { status: "submitted" }, { status: "approved" });
    }
    return { approved: rows.length };
  });

  /** Leads: send the «please submit» mail to one person right now. */
  app.post("/api/months/:month/remind", async (req) => {
    const lead = requireUser(req);
    const month = monthParam.parse((req.params as { month: string }).month);
    const { userId } = z.object({ userId: z.string() }).parse(req.body);
    if (userId === lead.id && !isLead(lead)) throw new HttpError(403, tr("Dafür fehlt dir die Berechtigung."));
    await assertManages(ctx, lead, userId);
    const [person] = await ctx.db.select().from(users).where(and(eq(users.id, userId), eq(users.organizationId, lead.organizationId))).limit(1);
    if (!person) throw new HttpError(404, tr("Person nicht gefunden."));
    if ((await monthStatus(ctx, userId, month)) !== null) throw new HttpError(409, tr("Dieser Monat ist bereits eingereicht."));
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, lead.organizationId)).limit(1);
    await ctx.mailer.send(closingReminderMail(org.settings, person, month, ctx.config.APP_URL));
    return { sent: true, to: person.email };
  });

  // ---------- customer reports ----------

  app.get("/api/customers/:id/report", async (req, reply) => {
    const user = requireRole(req, "admin", "consultant");
    const { id } = req.params as { id: string };
    const q = z.object({ month: monthParam, format: z.enum(["pdf", "xlsx"]) }).parse(req.query);
    const file = await reportFile(ctx, user.organizationId, id, q.month, q.format);
    return reply
      .header("content-type", file.contentType)
      .header("content-disposition", `attachment; filename="${file.filename}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`)
      .send(file.data);
  });

  app.put("/api/customers/:id/recipients", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const { id } = req.params as { id: string };
    const { recipients } = z.object({ recipients: z.array(z.string().trim().toLowerCase().email(tr("Ungültige E-Mail-Adresse"))).max(20) }).parse(req.body);
    const res = await ctx.db.update(customers).set({ reportRecipients: recipients }).where(and(eq(customers.id, id), eq(customers.organizationId, user.organizationId)));
    if (res[0].affectedRows === 0) throw new HttpError(404, tr("Kunde nicht gefunden."));
    return { recipients };
  });

  app.get("/api/customers/:id/recipients", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const { id } = req.params as { id: string };
    const [c] = await ctx.db.select().from(customers).where(and(eq(customers.id, id), eq(customers.organizationId, user.organizationId))).limit(1);
    if (!c) throw new HttpError(404, tr("Kunde nicht gefunden."));
    return { recipients: c.reportRecipients };
  });

  /** Send the report for a month now (in addition to the automatic monthly dispatch). */
  app.post("/api/customers/:id/report/send", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const { id } = req.params as { id: string };
    const { month } = z.object({ month: monthParam }).parse(req.body);
    const sentTo = await sendCustomerReport(ctx, user.organizationId, id, month);
    if (sentTo.length === 0) throw new HttpError(400, tr("Für diesen Kunden sind keine Empfänger hinterlegt."));
    return { sentTo };
  });
}
