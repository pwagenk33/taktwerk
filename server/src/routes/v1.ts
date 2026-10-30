// Public API v1 (API keys, see apikeys.ts) and the admin pages for keys and webhooks.
// Field names are English and stable; internal routes may change, this surface does not.
import { projectReports, tr, type Dataset } from "@taktwerk/domain";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError, requireRole, requireUser } from "../app";
import { INTERNAL_HEADER, INTERNAL_TOKEN, newApiKey } from "../apikeys";
import { sha256 } from "../auth/crypto";
import { apiKeys, invoices, webhookDeliveries, webhookEndpoints } from "../db/schema";
import { EVENT_TYPES, endpointProblem, newSecret, sendOnce } from "../events";
import { requireFeature } from "../saas";
import { loadDataset, todayZurich } from "./data";
import { OPENAPI } from "./openapi";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const page = { limit: z.coerce.number().int().min(1).max(1000).default(200), offset: z.coerce.number().int().min(0).default(0) };
const paged = <T>(rows: T[], limit: number, offset: number) => ({ data: rows.slice(offset, offset + limit), total: rows.length, limit, offset });
const r2 = (n: number) => Math.round(n * 100) / 100;

function names(data: Dataset) {
  const sub = new Map(data.subProjects.map((s) => [s.id, s]));
  const proj = new Map(data.projects.map((p) => [p.id, p]));
  const emp = new Map(data.employees.map((e) => [e.id, e]));
  return {
    where: (subProjectId: string) => {
      const s = sub.get(subProjectId);
      const p = s ? proj.get(s.projectId) : undefined;
      return { customerId: p?.customerId ?? null, projectId: p?.id ?? null, subProjectId };
    },
    person: (id: string) => emp.get(id)?.name ?? null,
  };
}

export async function v1Routes(app: FastifyInstance) {
  const ctx = app.ctx;
  const data = async (req: FastifyRequest, from?: string) => loadDataset(ctx, requireUser(req), { detailFrom: from });

  /** Forwards a write to the internal route with the same key, so permissions and checks stay in one place. */
  const forward = async (req: FastifyRequest, reply: FastifyReply, method: "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, payload: payload as object, headers: { authorization: req.headers.authorization!, [INTERNAL_HEADER]: INTERNAL_TOKEN, "accept-language": req.headers["accept-language"] ?? "de" } });
    return reply.status(res.statusCode).type("application/json").send(res.body);
  };

  app.get("/api/v1/openapi.json", async () => OPENAPI);

  app.get("/api/v1/me", async (req) => {
    const u = requireUser(req);
    return { organizationId: u.organizationId, actsAs: { id: u.id, name: u.name, role: u.role }, scope: u.apiKey?.scope ?? null };
  });

  app.get("/api/v1/customers", async (req) => {
    const d = await data(req);
    return { data: d.customers.map((c) => ({ id: c.id, name: c.name, currency: c.currency ?? "CHF", language: c.locale ?? "de", rates: c.rates.map((r) => ({ validFrom: r.validFrom, hourlyRate: r.hourlyRate })) })) };
  });

  app.get("/api/v1/projects", async (req) => {
    const d = await data(req);
    return {
      data: d.projects.map((p) => ({
        id: p.id, customerId: p.customerId, name: p.name, budget: p.budget, kind: p.kind ?? "tm", jiraProjectKey: p.jiraProjectKey ?? null, leadUserId: p.leadUserId ?? null,
        subProjects: d.subProjects.filter((s) => s.projectId === p.id).map((s) => ({ id: s.id, name: s.name, budget: s.budget, jiraEpicKey: s.jiraEpicKey ?? null })),
      })),
    };
  });

  app.get("/api/v1/employees", async (req) => {
    const d = await data(req);
    return { data: d.employees.map((e) => ({ id: e.id, name: e.name, role: e.role, teamId: e.teamId || null, workload: e.workload ?? null, personnelNumber: e.personnelNumber ?? null })) };
  });

  app.get("/api/v1/time-entries", async (req) => {
    const q = z.object({ from: isoDate, to: isoDate, employeeId: z.string().optional(), projectId: z.string().optional(), ...page }).refine((v) => v.from <= v.to && Date.parse(v.to) - Date.parse(v.from) <= 366 * 86400_000, tr("Zeitraum höchstens ein Jahr.")).parse(req.query);
    const d = await data(req, q.from);
    const n = names(d);
    const rows = d.timeEntries
      .filter((e) => !e.summary && e.date >= q.from && e.date <= q.to && (!q.employeeId || e.employeeId === q.employeeId))
      .map((e) => ({ id: e.id, date: e.date, startTime: e.startTime ?? null, hours: e.hours, employeeId: e.employeeId, employeeName: n.person(e.employeeId), ...n.where(e.subProjectId), reason: e.reason, billable: e.billable, hourlyRate: e.hourlyRate, amount: e.billable ? r2(e.hours * e.hourlyRate) : 0, jiraIssueKey: e.jiraIssueKey ?? null }))
      .filter((e) => !q.projectId || e.projectId === q.projectId)
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    return paged(rows, q.limit, q.offset);
  });

  const entryBody = z.object({
    employeeId: z.string().optional(),
    subProjectId: z.string(),
    date: isoDate,
    hours: z.number(),
    reason: z.string(),
    billable: z.boolean().optional(),
    startTime: z.string().optional(),
    jiraIssueKey: z.string().optional(),
  });
  app.post("/api/v1/time-entries", async (req, reply) => forward(req, reply, "POST", "/api/time-entries", entryBody.parse(req.body)));
  app.patch("/api/v1/time-entries/:id", async (req, reply) => forward(req, reply, "PATCH", `/api/time-entries/${encodeURIComponent((req.params as { id: string }).id)}`, entryBody.omit({ employeeId: true }).partial().parse(req.body)));
  app.delete("/api/v1/time-entries/:id", async (req, reply) => forward(req, reply, "DELETE", `/api/time-entries/${encodeURIComponent((req.params as { id: string }).id)}`));

  app.get("/api/v1/expenses", async (req) => {
    const q = z.object({ from: isoDate, to: isoDate, ...page }).parse(req.query);
    const d = await data(req, q.from);
    const n = names(d);
    const rows = d.expenses
      .filter((x) => x.date >= q.from && x.date <= q.to)
      .map((x) => ({ id: x.id, date: x.date, employeeId: x.employeeId, employeeName: n.person(x.employeeId), ...n.where(x.subProjectId), category: x.category, amount: x.amount, vatRate: x.vatRate ?? null, km: x.km ?? null, reason: x.reason, billable: x.billable, status: x.status ?? "approved" }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return paged(rows, q.limit, q.offset);
  });

  app.get("/api/v1/absences", async (req) => {
    const q = z.object({ from: isoDate, to: isoDate }).parse(req.query);
    const d = await data(req);
    const n = names(d);
    return { data: (d.absences ?? []).filter((a) => a.endDate >= q.from && a.startDate <= q.to).map((a) => ({ id: a.id, employeeId: a.employeeId, employeeName: n.person(a.employeeId), type: a.type, startDate: a.startDate, endDate: a.endDate, halfDay: a.halfDay, status: a.status })) };
  });

  app.get("/api/v1/budgets", async (req) => {
    const d = await data(req, `${todayZurich().slice(0, 4)}-01-01`);
    const fig = (f: { budget: number; hoursBooked: number; actualCost: number; remainingBudget: number; spDone: number; spOpen: number; remainingHours: number; forecastCost: number; variance: number; status: string }) => ({
      budget: f.budget, hoursBooked: r2(f.hoursBooked), actualCost: r2(f.actualCost), remainingBudget: r2(f.remainingBudget), storyPointsDone: f.spDone, storyPointsOpen: f.spOpen, remainingHours: r2(f.remainingHours), forecastCost: r2(f.forecastCost), variance: r2(f.variance), status: f.status,
    });
    return {
      data: projectReports(d, { method: "rolling", window: 3 }).map((r) => ({ projectId: r.project.id, customerId: r.customer.id, currency: r.currency, ...fig(r), subProjects: r.subs.map((s) => ({ subProjectId: s.subProject.id, ...fig(s) })) })),
    };
  });

  app.get("/api/v1/invoices", async (req) => {
    const u = requireUser(req);
    if (u.role !== "admin" && u.role !== "consultant") throw new HttpError(403, tr("Dafür fehlt dir die Berechtigung."));
    const rows = await ctx.db.select().from(invoices).where(eq(invoices.organizationId, u.organizationId)).orderBy(desc(invoices.number));
    return { data: rows.map((i) => ({ id: i.id, number: i.number, customerId: i.customerId, month: i.month, issueDate: i.issueDate, dueDate: i.dueDate, status: i.status, net: i.net, vatRate: i.vatRate, vat: i.vat, gross: i.gross, currency: i.snapshot.currency ?? "CHF", sentAt: i.sentAt, paidAt: i.paidAt })) };
  });

  // ---------- Settings → API: keys and webhooks (session, admins) ----------

  const admin = (req: FastifyRequest) => {
    const u = requireRole(req, "admin");
    if (u.apiKey) throw new HttpError(403, tr("API-Schlüssel und Webhooks verwaltet ein Admin in der App."));
    requireFeature(u, "api");
    return u;
  };

  app.get("/api/integrations", async (req) => {
    const u = admin(req);
    const keys = await ctx.db.select().from(apiKeys).where(and(eq(apiKeys.organizationId, u.organizationId), isNull(apiKeys.revokedAt))).orderBy(desc(apiKeys.createdAt));
    const hooks = await ctx.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.organizationId, u.organizationId)).orderBy(desc(webhookEndpoints.createdAt));
    return {
      events: EVENT_TYPES,
      keys: keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, scope: k.scope, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt })),
      webhooks: hooks.map((h) => ({ id: h.id, url: h.url, description: h.description, events: h.events, active: h.active, failures: h.failures, lastStatus: h.lastStatus, lastDeliveryAt: h.lastDeliveryAt, secret: h.secret })),
    };
  });

  app.post("/api/integrations/keys", async (req, reply) => {
    const u = admin(req);
    const body = z.object({ name: z.string().trim().min(1, tr("Name fehlt")).max(80), scope: z.enum(["read", "write"]) }).parse(req.body);
    const key = newApiKey();
    const row = { id: randomUUID(), organizationId: u.organizationId, name: body.name, prefix: key.slice(0, 10), hash: sha256(key), scope: body.scope, userId: u.id, createdAt: new Date() };
    await ctx.db.insert(apiKeys).values(row);
    // The key itself is shown once; only its hash stays.
    return reply.status(201).send({ id: row.id, name: row.name, prefix: row.prefix, scope: row.scope, key });
  });

  app.delete("/api/integrations/keys/:id", async (req) => {
    const u = admin(req);
    await ctx.db.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.id, (req.params as { id: string }).id), eq(apiKeys.organizationId, u.organizationId)));
    return { ok: true };
  });

  const hookBody = z.object({
    url: z.string().trim().max(500),
    description: z.string().trim().max(120).optional(),
    events: z.array(z.enum(["*", ...EVENT_TYPES])).min(1, tr("Mindestens ein Ereignis wählen.")),
    active: z.boolean().optional(),
  });
  app.post("/api/integrations/webhooks", async (req, reply) => {
    const u = admin(req);
    const body = hookBody.parse(req.body);
    const problem = endpointProblem(body.url);
    if (problem) throw new HttpError(400, problem);
    const row = { id: randomUUID(), organizationId: u.organizationId, url: body.url, description: body.description || null, events: body.events, secret: newSecret(), active: true, createdAt: new Date() };
    await ctx.db.insert(webhookEndpoints).values(row);
    return reply.status(201).send(row);
  });

  app.patch("/api/integrations/webhooks/:id", async (req) => {
    const u = admin(req);
    const body = hookBody.partial().parse(req.body);
    if (body.url) {
      const problem = endpointProblem(body.url);
      if (problem) throw new HttpError(400, problem);
    }
    const id = (req.params as { id: string }).id;
    // Switching on again starts with a clean failure count.
    await ctx.db.update(webhookEndpoints).set({ ...body, ...(body.active ? { failures: 0 } : {}) }).where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.organizationId, u.organizationId)));
    return { ok: true };
  });

  app.delete("/api/integrations/webhooks/:id", async (req) => {
    const u = admin(req);
    await ctx.db.delete(webhookEndpoints).where(and(eq(webhookEndpoints.id, (req.params as { id: string }).id), eq(webhookEndpoints.organizationId, u.organizationId)));
    return { ok: true };
  });

  /** Sends a «ping» event right away and reports the answer. */
  app.post("/api/integrations/webhooks/:id/test", async (req) => {
    const u = admin(req);
    const [h] = await ctx.db.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.id, (req.params as { id: string }).id), eq(webhookEndpoints.organizationId, u.organizationId))).limit(1);
    if (!h) throw new HttpError(404, tr("Webhook nicht gefunden."));
    const id = randomUUID();
    const r = await sendOnce(ctx, h, id, "ping", { id, type: "ping", createdAt: new Date().toISOString(), data: { message: "TrackInsight webhook test" } });
    return { ok: !r.error, status: r.status, error: r.error };
  });

  app.get("/api/integrations/webhooks/:id/deliveries", async (req) => {
    const u = admin(req);
    const rows = await ctx.db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.endpointId, (req.params as { id: string }).id), eq(webhookDeliveries.organizationId, u.organizationId)))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(50);
    return rows.map((d) => ({ id: d.id, event: d.event, createdAt: d.createdAt, attempts: d.attempts, deliveredAt: d.deliveredAt, failedAt: d.failedAt, nextAttemptAt: d.nextAttemptAt, lastStatus: d.lastStatus, lastError: d.lastError }));
  });
}
