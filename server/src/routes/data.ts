import { DEFAULT_RATES, DEFAULT_WEEKLY_HOURS, EXPENSE_CATEGORIES, VAT_RATES, defaultHolidays, projectReports, rateOn, type Dataset, type VelocitySettings } from "@taktwerk/domain";
import { and, eq, inArray, or, type ColumnBaseConfig, type SQL } from "drizzle-orm";
import type { MySqlColumn } from "drizzle-orm/mysql-core";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError, isLead, leadsProject, managedUserIds, requireRole, requireUser, seesAll, type AppContext, type SessionUser } from "../app";
import {
  absences,
  allocations,
  customerRates,
  organizations,
  customers,
  dashboards,
  expenses,
  jiraIssues,
  projects,
  subProjects,
  teams,
  timeEntries,
  users,
  workPeriods
} from "../db/schema";
import { assertBookable, audit } from "./billing";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum im Format JJJJ-MM-TT");
const projectKind = z.enum(["tm", "fixed", "retainer"]);
const currency = z.enum(["CHF", "EUR", "USD"]);

/** Today in Swiss time, as YYYY-MM-DD. */
export const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Uhrzeit im Format HH:MM");
export const todayZurich = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(new Date());

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase())
    .slice(0, 2)
    .join("");

/**
 * Loads the organization's data in the shape the domain calculations expect.
 * Employees only receive their own bookings and no budgets.
 */
export async function loadDataset(ctx: AppContext, user: SessionUser): Promise<Dataset> {
  const org = user.organizationId;
  const db = ctx.db;
  const own = user.role === "employee";
  // Employees see their own data, plus the people of teams they lead and the projects they lead.
  const scope = own ? await managedUserIds(ctx, user) : null;
  const scopeIds = scope ? [...scope] : [];
  const ledProjects = own ? (user.leadsProjects ?? []) : [];
  const ledSubIds = ledProjects.length ? (await db.select({ id: subProjects.id }).from(subProjects).where(inArray(subProjects.projectId, ledProjects))).map((r) => r.id) : [];
  type Col = MySqlColumn<ColumnBaseConfig<"string", string>>;
  const orgOf = (t: { organizationId: Col }) => eq(t.organizationId, org);
  const byPerson = (t: { organizationId: Col; userId: Col }) => (own ? and(orgOf(t), inArray(t.userId, scopeIds)) : orgOf(t));
  const byPersonOrProject = (t: { organizationId: Col; userId: Col; subProjectId: Col }) => {
    if (!own) return orgOf(t);
    const parts: SQL[] = [inArray(t.userId, scopeIds)];
    if (ledSubIds.length) parts.push(inArray(t.subProjectId, ledSubIds));
    return and(orgOf(t), or(...parts));
  };
  const [teamRows, userRows, customerRows, rateRows, projectRows, subRows, entryRows, expenseRows, issueRows, absenceRows, [orgRow], allocationRows, periodRows] = await Promise.all([
    db.select().from(teams).where(eq(teams.organizationId, org)),
    db.select().from(users).where(eq(users.organizationId, org)),
    db.select().from(customers).where(eq(customers.organizationId, org)),
    db.select({ r: customerRates }).from(customerRates).innerJoin(customers, eq(customers.id, customerRates.customerId)).where(eq(customers.organizationId, org)),
    db.select().from(projects).where(eq(projects.organizationId, org)),
    db.select().from(subProjects).where(eq(subProjects.organizationId, org)),
    db.select().from(timeEntries).where(byPersonOrProject(timeEntries)),
    db.select().from(expenses).where(byPersonOrProject(expenses)),
    db.select().from(jiraIssues).where(eq(jiraIssues.organizationId, org)),
    db.select().from(absences).where(byPerson(absences)),
    db.select().from(organizations).where(eq(organizations.id, org)).limit(1),
    db.select().from(allocations).where(own ? and(eq(allocations.organizationId, org), ledProjects.length ? or(inArray(allocations.userId, scopeIds), inArray(allocations.projectId, ledProjects)) : inArray(allocations.userId, scopeIds)) : eq(allocations.organizationId, org)),
    db.select().from(workPeriods).where(byPerson(workPeriods)),
  ]);
  const seesPerson = (id: string) => !own || scope!.has(id);
  const seesBudget = (projectId: string) => !own || ledProjects.includes(projectId);
  const today = todayZurich();
  const year = Number(today.slice(0, 4));

  return {
    today,
    teams: teamRows.map((t) => ({ id: t.id, name: t.name, leadUserId: t.leadUserId ?? undefined })),
    employees: userRows
      .filter((u) => u.active && u.role !== "customer" && u.role !== "auditor")
      .sort((a, b) => a.name.localeCompare(b.name, "de"))
      .map((u) => ({
        id: u.id,
        name: u.name,
        initials: initials(u.name),
        role: u.role,
        teamId: u.teamId ?? "",
        // Work model and balances of colleagues stay private for employees; cost rates only for leads.
        ...(!seesPerson(u.id)
          ? {}
          : { workload: u.workload, vacationDays: u.vacationDays, trackingStart: u.trackingStart ?? undefined, overtimeCarry: u.overtimeCarry, vacationCarry: u.vacationCarry }),
        ...(own ? {} : { costRate: u.costRate ?? undefined }),
      })),
    customers: customerRows.map((c) => ({
      id: c.id,
      name: c.name,
      currency: c.currency,
      rates: rateRows.filter((r) => r.r.customerId === c.id).map((r) => ({ validFrom: r.r.validFrom, hourlyRate: r.r.hourlyRate })),
    })),
    projects: projectRows.map((p) => ({ id: p.id, customerId: p.customerId, name: p.name, budget: seesBudget(p.id) ? p.budget : 0, jiraProjectKey: p.jiraProjectKey ?? undefined, leadUserId: p.leadUserId ?? undefined, kind: p.kind, retainerHours: p.retainerHours ?? undefined })),
    subProjects: subRows.map((s) => ({ id: s.id, projectId: s.projectId, name: s.name, budget: seesBudget(s.projectId) ? s.budget : 0, jiraEpicKey: s.jiraEpicKey ?? undefined })),
    timeEntries: entryRows.map((e) => ({
      id: e.id,
      employeeId: e.userId,
      subProjectId: e.subProjectId,
      date: e.date,
      hours: e.hours,
      reason: e.reason,
      billable: e.billable,
      hourlyRate: e.hourlyRate,
      jiraIssueKey: e.jiraIssueKey ?? undefined,
      startTime: e.startTime ?? undefined,
    })),
    expenses: expenseRows.map((x) => ({
      id: x.id,
      employeeId: x.userId,
      subProjectId: x.subProjectId,
      date: x.date,
      amount: x.amount,
      category: x.category,
      reason: x.reason,
      billable: x.billable,
      status: x.status,
      vatRate: x.vatRate,
      km: x.km ?? undefined,
      receipt: x.receiptName && x.receiptMime ? { name: x.receiptName, mime: x.receiptMime } : undefined,
    })),
    absences: absenceRows.map((a) => ({
      id: a.id,
      employeeId: a.userId,
      type: a.type,
      startDate: a.startDate,
      endDate: a.endDate,
      halfDay: a.halfDay,
      note: a.note ?? undefined,
      status: a.status,
    })),
    workModel: {
      weeklyHours: orgRow?.settings.weeklyHours ?? DEFAULT_WEEKLY_HOURS,
      holidays: orgRow?.settings.holidays ?? [year - 1, year, year + 1].flatMap(defaultHolidays),
      timeModel: orgRow?.settings.timeModel ?? "simplified",
    },
    workPeriods: periodRows.map((p) => ({ id: p.id, employeeId: p.userId, date: p.date, kind: p.kind, start: p.start, end: p.end ?? undefined })),
    rates: {
      kmRate: orgRow?.settings.kmRate ?? DEFAULT_RATES.kmRate,
      vatRate: orgRow?.settings.vatRate ?? DEFAULT_RATES.vatRate,
      ...(own ? {} : { costRate: orgRow?.settings.costRate }),
    },
    allocations: allocationRows.map((a) => ({ id: a.id, employeeId: a.userId, projectId: a.projectId, week: a.week, hours: a.hours, note: a.note ?? undefined })),
    fx: orgRow?.settings.fx ? { rates: orgRow.settings.fx.rates, asOf: orgRow.settings.fx.asOf, source: orgRow.settings.fx.source } : undefined,
    issues: issueRows.map((i) => ({
      key: i.key,
      summary: i.summary,
      subProjectId: i.subProjectId,
      storyPoints: i.storyPoints,
      status: i.status,
      resolvedAt: i.resolvedAt ?? undefined,
    })),
  };
}

async function subProjectInOrg(ctx: AppContext, org: string, subProjectId: string) {
  const [row] = await ctx.db
    .select({ sub: subProjects, customerId: projects.customerId })
    .from(subProjects)
    .innerJoin(projects, eq(projects.id, subProjects.projectId))
    .where(and(eq(subProjects.id, subProjectId), eq(subProjects.organizationId, org)))
    .limit(1);
  if (!row) throw new HttpError(404, "Subprojekt nicht gefunden.");
  return row;
}

/** Admins and consultants may book for others; employees only for themselves. */
async function bookingUser(ctx: AppContext, user: SessionUser, employeeId?: string) {
  if (!employeeId || employeeId === user.id) return user.id;
  if (user.role === "employee") throw new HttpError(403, "Du kannst nur für dich selbst buchen.");
  const [u] = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.id, employeeId), eq(users.organizationId, user.organizationId))).limit(1);
  if (!u) throw new HttpError(404, "Mitarbeitende Person nicht gefunden.");
  return u.id;
}

export async function dataRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.get("/api/dataset", async (req) => loadDataset(ctx, requireUser(req)));

  /** Project reports: leads and the auditor see all, project leads the projects they lead. */
  app.get("/api/reports", async (req) => {
    const user = requireUser(req);
    const led = user.leadsProjects ?? [];
    if (!seesAll(user) && led.length === 0) throw new HttpError(403, "Dafür fehlt dir die Berechtigung.");
    const q = z
      .object({ customerId: z.string().optional(), method: z.enum(["rolling", "ewma"]).default("rolling"), window: z.coerce.number().int().min(1).max(12).default(3) })
      .parse(req.query);
    const settings: VelocitySettings = { method: q.method, window: q.window };
    const reports = projectReports(await loadDataset(ctx, user), settings, q.customerId);
    return seesAll(user) ? reports : reports.filter((r) => led.includes(r.project.id));
  });

  app.post("/api/time-entries", async (req, reply) => {
    const user = requireUser(req);
    const body = z
      .object({
        employeeId: z.string().optional(),
        subProjectId: z.string(),
        date: isoDate,
        hours: z.number().positive().max(24),
        reason: z.string().trim().min(1, "Grund fehlt").max(1000),
        billable: z.boolean().default(true),
        jiraIssueKey: z.string().max(40).optional(),
        startTime: clockTime.optional(),
      })
      .parse(req.body);
    const { customerId } = await subProjectInOrg(ctx, user.organizationId, body.subProjectId);
    const rates = await ctx.db.select().from(customerRates).where(eq(customerRates.customerId, customerId));
    const userId = await bookingUser(ctx, user, body.employeeId);
    await assertBookable(ctx, user, userId, body.date);
    const id = randomUUID();
    const row = {
      id,
      organizationId: user.organizationId,
      userId,
      subProjectId: body.subProjectId,
      date: body.date,
      hours: Math.round(body.hours * 100) / 100,
      reason: body.reason,
      billable: body.billable,
      hourlyRate: rateOn({ id: customerId, name: "", rates: rates.map((r) => ({ validFrom: r.validFrom, hourlyRate: r.hourlyRate })) }, body.date),
      jiraIssueKey: body.jiraIssueKey || null,
      startTime: body.startTime ?? null,
    };
    await ctx.db.insert(timeEntries).values(row);
    await audit(ctx, user, "time_entry", id, "create", null, row);
    return reply.status(201).send(row);
  });

  app.post("/api/expenses", async (req, reply) => {
    const user = requireUser(req);
    const body = z
      .object({
        employeeId: z.string().optional(),
        subProjectId: z.string(),
        date: isoDate,
        amount: z.number().min(0).max(100000),
        category: z.enum(EXPENSE_CATEGORIES),
        reason: z.string().trim().min(1, "Grund fehlt").max(1000),
        billable: z.boolean().default(true),
        vatRate: z.number().refine((v) => (VAT_RATES as readonly number[]).includes(v), "Ungültiger MwSt-Satz").optional(),
        km: z.number().positive().max(10000).optional(),
      })
      .parse(req.body);
    await subProjectInOrg(ctx, user.organizationId, body.subProjectId);
    const { employeeId, ...rest } = body;
    const userId = await bookingUser(ctx, user, employeeId);
    await assertBookable(ctx, user, userId, body.date);
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, user.organizationId)).limit(1);
    // Kilometres are priced with the organization's rate; the client only sends the distance.
    if (body.category === "Kilometer") {
      if (!body.km) throw new HttpError(400, "Bitte die Kilometer angeben.");
      rest.amount = Math.round(body.km * (org?.settings.kmRate ?? DEFAULT_RATES.kmRate) * 20) / 20;
      rest.vatRate = 0;
    } else if (!(body.amount > 0)) throw new HttpError(400, "Bitte einen Betrag grösser als 0 eingeben.");
    // Employees' expenses wait for approval; consultants and admins record them as approved.
    const approved = user.role !== "employee";
    const row = {
      id: randomUUID(),
      organizationId: user.organizationId,
      userId,
      ...rest,
      vatRate: rest.vatRate ?? 8.1,
      km: body.category === "Kilometer" ? body.km : null,
      status: approved ? ("approved" as const) : ("requested" as const),
      decidedBy: approved ? user.id : null,
      decidedAt: approved ? new Date() : null,
    };
    await ctx.db.insert(expenses).values(row);
    await audit(ctx, user, "expense", row.id, "create", null, row);
    return reply.status(201).send(row);
  });

  // ---------- master data (admin) ----------

  app.post("/api/customers", async (req, reply) => {
    const user = requireRole(req, "admin");
    const body = z.object({ name: z.string().trim().min(1).max(200), hourlyRate: z.number().positive(), validFrom: isoDate.optional(), currency: currency.optional() }).parse(req.body);
    const id = randomUUID();
    await ctx.db.insert(customers).values({ id, organizationId: user.organizationId, name: body.name, currency: body.currency ?? "CHF" });
    await ctx.db.insert(customerRates).values({ customerId: id, validFrom: body.validFrom ?? "2000-01-01", hourlyRate: body.hourlyRate });
    return reply.status(201).send({ id });
  });

  /** Name and currency of a customer. The currency applies to rates, budgets and new invoices. */
  app.patch("/api/customers/:id", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().trim().min(1).max(200).optional(), currency: currency.optional() }).parse(req.body);
    const [c] = await ctx.db.select().from(customers).where(and(eq(customers.id, id), eq(customers.organizationId, user.organizationId))).limit(1);
    if (!c) throw new HttpError(404, "Kunde nicht gefunden.");
    const next = { name: body.name ?? c.name, currency: body.currency ?? c.currency };
    await ctx.db.update(customers).set(next).where(eq(customers.id, id));
    return { id, ...next };
  });

  app.post("/api/customers/:id/rates", async (req, reply) => {
    const user = requireRole(req, "admin");
    const { id } = req.params as { id: string };
    const body = z.object({ hourlyRate: z.number().positive(), validFrom: isoDate }).parse(req.body);
    const [c] = await ctx.db.select().from(customers).where(and(eq(customers.id, id), eq(customers.organizationId, user.organizationId))).limit(1);
    if (!c) throw new HttpError(404, "Kunde nicht gefunden.");
    await ctx.db.insert(customerRates).values({ customerId: id, ...body }).onDuplicateKeyUpdate({ set: { hourlyRate: body.hourlyRate } });
    return reply.status(201).send({ ok: true });
  });

  app.post("/api/projects", async (req, reply) => {
    const user = requireRole(req, "admin");
    const body = z.object({ customerId: z.string(), name: z.string().trim().min(1).max(200), budget: z.number().min(0), jiraProjectKey: z.string().max(20).optional(), kind: projectKind.optional(), retainerHours: z.number().min(0).max(10000).optional() }).parse(req.body);
    const [c] = await ctx.db.select().from(customers).where(and(eq(customers.id, body.customerId), eq(customers.organizationId, user.organizationId))).limit(1);
    if (!c) throw new HttpError(404, "Kunde nicht gefunden.");
    const id = randomUUID();
    await ctx.db.insert(projects).values({ id, organizationId: user.organizationId, ...body, jiraProjectKey: body.jiraProjectKey || null, kind: body.kind ?? "tm", retainerHours: body.kind === "retainer" ? body.retainerHours ?? null : null });
    return reply.status(201).send({ id });
  });

  app.post("/api/sub-projects", async (req, reply) => {
    const user = requireRole(req, "admin");
    const body = z.object({ projectId: z.string(), name: z.string().trim().min(1).max(200), budget: z.number().min(0), jiraEpicKey: z.string().max(40).optional() }).parse(req.body);
    const [p] = await ctx.db.select().from(projects).where(and(eq(projects.id, body.projectId), eq(projects.organizationId, user.organizationId))).limit(1);
    if (!p) throw new HttpError(404, "Projekt nicht gefunden.");
    const id = randomUUID();
    await ctx.db.insert(subProjects).values({ id, organizationId: user.organizationId, ...body, jiraEpicKey: body.jiraEpicKey || null });
    return reply.status(201).send({ id });
  });

  /** Leads edit every project; a project lead the own ones (the lead person itself is set by admins and consultants). */
  app.patch("/api/projects/:id", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    if (!leadsProject(user, id)) throw new HttpError(403, "Dafür fehlt dir die Berechtigung.");
    const body = z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        budget: z.number().min(0).optional(),
        jiraProjectKey: z.string().max(20).nullable().optional(),
        kind: projectKind.optional(),
        retainerHours: z.number().min(0).max(10000).nullable().optional(),
        leadUserId: z.string().nullable().optional(),
      })
      .parse(req.body);
    const [p] = await ctx.db.select().from(projects).where(and(eq(projects.id, id), eq(projects.organizationId, user.organizationId))).limit(1);
    if (!p) throw new HttpError(404, "Projekt nicht gefunden.");
    if (body.leadUserId !== undefined && !isLead(user)) throw new HttpError(403, "Die Projektleitung vergeben Admins und Consultants.");
    if (body.leadUserId) {
      const [lead] = await ctx.db.select({ id: users.id, role: users.role }).from(users).where(and(eq(users.id, body.leadUserId), eq(users.organizationId, user.organizationId), eq(users.active, true))).limit(1);
      if (!lead || lead.role === "customer" || lead.role === "auditor") throw new HttpError(404, "Person für die Projektleitung nicht gefunden.");
    }
    const kind = body.kind ?? p.kind;
    const next = {
      name: body.name ?? p.name,
      budget: body.budget ?? p.budget,
      jiraProjectKey: body.jiraProjectKey === undefined ? p.jiraProjectKey : body.jiraProjectKey || null,
      kind,
      retainerHours: kind !== "retainer" ? null : body.retainerHours === undefined ? p.retainerHours : body.retainerHours,
      leadUserId: body.leadUserId === undefined ? p.leadUserId : body.leadUserId,
    };
    await ctx.db.update(projects).set(next).where(eq(projects.id, id));
    return { id, ...next };
  });

  app.patch("/api/sub-projects/:id", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().trim().min(1).max(200).optional(), budget: z.number().min(0).optional(), jiraEpicKey: z.string().max(40).nullable().optional() }).parse(req.body);
    const [sp] = await ctx.db.select().from(subProjects).where(and(eq(subProjects.id, id), eq(subProjects.organizationId, user.organizationId))).limit(1);
    if (!sp) throw new HttpError(404, "Subprojekt nicht gefunden.");
    if (!leadsProject(user, sp.projectId)) throw new HttpError(403, "Dafür fehlt dir die Berechtigung.");
    const next = { name: body.name ?? sp.name, budget: body.budget ?? sp.budget, jiraEpicKey: body.jiraEpicKey === undefined ? sp.jiraEpicKey : body.jiraEpicKey || null };
    await ctx.db.update(subProjects).set(next).where(eq(subProjects.id, id));
    return { id, ...next };
  });

  // ---------- personal dashboard layout ----------

  app.get("/api/dashboard", async (req) => {
    const user = requireUser(req);
    const [row] = await ctx.db.select().from(dashboards).where(eq(dashboards.userId, user.id)).limit(1);
    return { layout: row?.layout ?? null };
  });

  app.put("/api/dashboard", async (req) => {
    const user = requireUser(req);
    const { layout } = z.object({ layout: z.unknown() }).parse(req.body);
    if (JSON.stringify(layout).length > 100_000) throw new HttpError(400, "Dashboard-Konfiguration ist zu gross.");
    await ctx.db.insert(dashboards).values({ userId: user.id, layout }).onDuplicateKeyUpdate({ set: { layout } });
    return { ok: true };
  });
}

