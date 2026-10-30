import { rateOn, type ImportRow } from "@taktwerk/domain";
import { and, desc, eq, inArray } from "drizzle-orm";
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError, requireRole, type AppContext } from "../app";
import { customerRates, customers, expenses, importBatches, monthClosings, projects, subProjects, timeEntries, users } from "../db/schema";
import { bookingChanged } from "./data";
import { audit } from "./billing";

const MAX_ROWS = 50_000;
const key = (s: string) => s.trim().toLowerCase();

const row = z.object({
  line: z.number().int(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  person: z.string().trim().min(1).max(200),
  email: z.string().trim().max(200).optional(),
  customer: z.string().trim().min(1).max(200),
  project: z.string().trim().min(1).max(200),
  task: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(1000),
  hours: z.number().positive().max(24),
  billable: z.boolean(),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
});

/** First worksheet of an Excel file as rows of text; dates become YYYY-MM-DD, times HH:MM, durations hours. */
export async function xlsxRows(data: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const cells: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) {
      const v = r.getCell(c).value as unknown;
      cells.push(cellText(v));
    }
    if (cells.some((x) => x.trim())) rows.push(cells);
  });
  return rows;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    // Excel stores times of day as dates on 1899-12-30; those are clock times, everything else a date.
    if (v.getUTCFullYear() < 1901) {
      const mins = v.getUTCHours() * 60 + v.getUTCMinutes();
      return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
    }
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === "object") {
    const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[] };
    if (o.richText) return o.richText.map((t) => t.text).join("");
    if (o.result !== undefined) return cellText(o.result);
    if (o.text !== undefined) return String(o.text);
  }
  return String(v);
}

/**
 * Import of bookings from Clockodo, Toggl, Harvest or any table. The browser reads the file and maps the columns
 * (packages/domain/src/import.ts); the server creates missing customers, projects and tasks, books the time on the
 * chosen people and remembers the batch so it can be undone. Months already closed are left alone.
 */
export async function importRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.post("/api/import/xlsx", { bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    requireRole(req, "admin");
    const { data } = z.object({ data: z.string().max(16 * 1024 * 1024) }).parse(req.body);
    try {
      return { rows: await xlsxRows(Buffer.from(data, "base64")) };
    } catch {
      throw new HttpError(400, "Die Excel-Datei lässt sich nicht lesen. Bitte als .xlsx speichern oder als CSV exportieren.");
    }
  });

  app.get("/api/import", async (req) => {
    const user = requireRole(req, "admin");
    return ctx.db.select().from(importBatches).where(eq(importBatches.organizationId, user.organizationId)).orderBy(desc(importBatches.createdAt)).limit(20);
  });

  app.post("/api/import", { bodyLimit: 20 * 1024 * 1024 }, async (req, reply) => {
    const user = requireRole(req, "admin");
    const body = z
      .object({
        source: z.enum(["clockodo", "toggl", "harvest", "generic"]),
        fileName: z.string().trim().min(1).max(255),
        rows: z.array(row).min(1).max(MAX_ROWS),
        /** Person in the file (e-mail or name, lower case) → user id; people left out are skipped. */
        people: z.record(z.string(), z.string()),
        /** Hourly rate for customers the import creates. */
        rate: z.number().min(0).max(10000),
      })
      .parse(req.body);
    const result = await runImport(ctx, user.organizationId, user.id, body);
    await audit(ctx, user, "import", result.id, "create", null, { source: body.source, fileName: body.fileName, ...result });
    return reply.status(201).send(result);
  });

  app.delete("/api/import/:id", async (req) => {
    const user = requireRole(req, "admin");
    const { id } = req.params as { id: string };
    const [batch] = await ctx.db.select().from(importBatches).where(and(eq(importBatches.id, id), eq(importBatches.organizationId, user.organizationId))).limit(1);
    if (!batch) throw new HttpError(404, "Import nicht gefunden.");
    if (batch.undoneAt) throw new HttpError(409, "Dieser Import wurde schon rückgängig gemacht.");
    const result = await undoImport(ctx, user.organizationId, batch);
    await audit(ctx, user, "import", id, "delete", null, result);
    return result;
  });
}

export async function runImport(
  ctx: AppContext,
  orgId: string,
  actorId: string,
  body: { source: string; fileName: string; rows: ImportRow[]; people: Record<string, string>; rate: number },
) {
  // People must belong to this company and be able to book.
  const ids = [...new Set(Object.values(body.people))];
  const staff = ids.length ? await ctx.db.select({ id: users.id, role: users.role }).from(users).where(and(eq(users.organizationId, orgId), inArray(users.id, ids))) : [];
  const allowed = new Set(staff.filter((u) => u.role !== "customer").map((u) => u.id));
  for (const uid of ids) if (!allowed.has(uid)) throw new HttpError(400, "Eine zugeordnete Person gehört nicht zu dieser Firma.");

  const closed = new Set(
    ids.length
      ? (await ctx.db.select({ userId: monthClosings.userId, month: monthClosings.month }).from(monthClosings).where(and(eq(monthClosings.organizationId, orgId), eq(monthClosings.status, "approved"), inArray(monthClosings.userId, ids)))).map((c) => `${c.userId}|${c.month}`)
      : [],
  );

  const custRows = await ctx.db.select().from(customers).where(eq(customers.organizationId, orgId));
  const rateRows = custRows.length ? await ctx.db.select().from(customerRates).where(inArray(customerRates.customerId, custRows.map((c) => c.id))) : [];
  const projRows = await ctx.db.select().from(projects).where(eq(projects.organizationId, orgId));
  const subRows = await ctx.db.select().from(subProjects).where(eq(subProjects.organizationId, orgId));

  const customerByName = new Map(custRows.map((c) => [key(c.name), { id: c.id, name: c.name, rates: rateRows.filter((r) => r.customerId === c.id).map((r) => ({ validFrom: r.validFrom, hourlyRate: r.hourlyRate })) }]));
  const projectByName = new Map(projRows.map((p) => [`${p.customerId}|${key(p.name)}`, p.id]));
  const subByName = new Map(subRows.map((s) => [`${s.projectId}|${key(s.name)}`, s.id]));
  const created = { customers: [] as string[], projects: [] as string[], subProjects: [] as string[] };

  const batchId = randomUUID();
  const entries: (typeof timeEntries.$inferInsert)[] = [];
  let skippedPeople = 0;
  let skippedClosed = 0;
  const firstDate = new Map<string, string>();
  for (const r of body.rows) firstDate.set(key(r.customer), !firstDate.get(key(r.customer)) || r.date < firstDate.get(key(r.customer))! ? r.date : firstDate.get(key(r.customer))!);

  for (const r of body.rows) {
    const userId = body.people[key(r.email || r.person)];
    if (!userId) { skippedPeople++; continue; }
    if (closed.has(`${userId}|${r.date.slice(0, 7)}`)) { skippedClosed++; continue; }

    let customer = customerByName.get(key(r.customer));
    if (!customer) {
      const id = randomUUID();
      const rates = [{ validFrom: firstDate.get(key(r.customer))!, hourlyRate: body.rate }];
      await ctx.db.insert(customers).values({ id, organizationId: orgId, name: r.customer.trim() });
      await ctx.db.insert(customerRates).values({ customerId: id, ...rates[0]! });
      customer = { id, name: r.customer.trim(), rates };
      customerByName.set(key(r.customer), customer);
      created.customers.push(id);
    }
    let projectId = projectByName.get(`${customer.id}|${key(r.project)}`);
    if (!projectId) {
      projectId = randomUUID();
      await ctx.db.insert(projects).values({ id: projectId, organizationId: orgId, customerId: customer.id, name: r.project.trim(), budget: 0 });
      projectByName.set(`${customer.id}|${key(r.project)}`, projectId);
      created.projects.push(projectId);
    }
    let subProjectId = subByName.get(`${projectId}|${key(r.task)}`);
    if (!subProjectId) {
      subProjectId = randomUUID();
      await ctx.db.insert(subProjects).values({ id: subProjectId, organizationId: orgId, projectId, name: r.task.trim(), budget: 0 });
      subByName.set(`${projectId}|${key(r.task)}`, subProjectId);
      created.subProjects.push(subProjectId);
    }
    entries.push({
      id: randomUUID(),
      organizationId: orgId,
      userId,
      subProjectId,
      date: r.date,
      hours: Math.round(r.hours * 100) / 100,
      reason: r.reason,
      billable: r.billable,
      hourlyRate: rateOn(customer, r.date),
      startTime: r.startTime ?? null,
      importBatchId: batchId,
    });
  }
  if (entries.length === 0) throw new HttpError(400, skippedClosed ? "Alle Zeilen fallen in abgeschlossene Monate." : "Keiner Zeile ist eine Person zugeordnet.");

  const hours = Math.round(entries.reduce((s, e) => s + Number(e.hours), 0) * 100) / 100;
  await ctx.db.insert(importBatches).values({ id: batchId, organizationId: orgId, source: body.source, fileName: body.fileName, entries: entries.length, hours, created, createdBy: actorId });
  for (let i = 0; i < entries.length; i += 500) await ctx.db.insert(timeEntries).values(entries.slice(i, i + 500));
  bookingChanged(orgId, entries.reduce((m, e) => (e.date < m ? e.date : m), entries[0]!.date));
  return {
    id: batchId,
    entries: entries.length,
    hours,
    customers: created.customers.length,
    projects: created.projects.length,
    subProjects: created.subProjects.length,
    skippedPeople,
    skippedClosed,
  };
}

async function undoImport(ctx: AppContext, orgId: string, batch: typeof importBatches.$inferSelect) {
  const rows = await ctx.db.select({ date: timeEntries.date }).from(timeEntries).where(and(eq(timeEntries.organizationId, orgId), eq(timeEntries.importBatchId, batch.id)));
  await ctx.db.delete(timeEntries).where(and(eq(timeEntries.organizationId, orgId), eq(timeEntries.importBatchId, batch.id)));
  if (rows.length) bookingChanged(orgId, rows.reduce((m, r) => (r.date < m ? r.date : m), rows[0]!.date));
  // What the import created goes again, unless someone has booked on it or built on it since.
  let removed = 0;
  for (const id of batch.created.subProjects) {
    const [used] = await ctx.db.select({ id: timeEntries.id }).from(timeEntries).where(eq(timeEntries.subProjectId, id)).limit(1);
    const [spent] = await ctx.db.select({ id: expenses.id }).from(expenses).where(eq(expenses.subProjectId, id)).limit(1);
    if (!used && !spent) { await ctx.db.delete(subProjects).where(and(eq(subProjects.id, id), eq(subProjects.organizationId, orgId))); removed++; }
  }
  for (const id of batch.created.projects) {
    const [left] = await ctx.db.select({ id: subProjects.id }).from(subProjects).where(eq(subProjects.projectId, id)).limit(1);
    if (!left) { await ctx.db.delete(projects).where(and(eq(projects.id, id), eq(projects.organizationId, orgId))); removed++; }
  }
  for (const id of batch.created.customers) {
    const [left] = await ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.customerId, id)).limit(1);
    if (!left) { await ctx.db.delete(customers).where(and(eq(customers.id, id), eq(customers.organizationId, orgId))); removed++; }
  }
  await ctx.db.update(importBatches).set({ undoneAt: new Date() }).where(eq(importBatches.id, batch.id));
  return { entries: rows.length, removed };
}
