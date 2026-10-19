import {
  ABSENCE_TYPES,
  DEFAULT_WEEKLY_HOURS,
  NEEDS_APPROVAL,
  absenceDays,
  absenceProblem,
  defaultHolidays,
  fmtDate,
  monthRange,
  type Absence,
  type Dataset,
} from "@taktwerk/domain";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError, assertManages, isLead, managesUser, requireRole, requireUser, type AppContext, type SessionUser } from "../app";
import { absences, organizations, users } from "../db/schema";
import { actionMail } from "../mail/mailer";
import { assertBookable, audit } from "./billing";
import { todayZurich } from "./data";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum im Format JJJJ-MM-TT");

type AbsenceRow = typeof absences.$inferSelect;
const toDomain = (a: AbsenceRow): Absence => ({
  id: a.id,
  employeeId: a.userId,
  type: a.type,
  startDate: a.startDate,
  endDate: a.endDate,
  halfDay: a.halfDay,
  note: a.note ?? undefined,
  status: a.status,
});

/** Minimal dataset for absence checks: the person's absences and the organization's work model. */
async function absenceContext(ctx: AppContext, orgId: string, userId: string): Promise<Dataset> {
  const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const rows = await ctx.db.select().from(absences).where(and(eq(absences.organizationId, orgId), eq(absences.userId, userId)));
  const today = todayZurich();
  const year = Number(today.slice(0, 4));
  return {
    teams: [], employees: [], customers: [], projects: [], subProjects: [], timeEntries: [], expenses: [], issues: [],
    absences: rows.map(toDomain),
    workModel: {
      weeklyHours: org?.settings.weeklyHours ?? DEFAULT_WEEKLY_HOURS,
      holidays: org?.settings.holidays ?? [year - 1, year, year + 1].flatMap(defaultHolidays),
    },
    today,
  };
}

/** Absences change target hours, so they follow the same month locks as bookings. */
async function assertAbsenceEditable(ctx: AppContext, actor: SessionUser, ownerId: string, a: { startDate: string; endDate: string }) {
  for (const m of monthRange(a.startDate.slice(0, 7), a.endDate.slice(0, 7))) {
    await assertBookable(ctx, actor, ownerId, a.startDate.slice(0, 7) === m ? a.startDate : `${m}-01`);
  }
}

const range = (a: { startDate: string; endDate: string; halfDay: boolean }) =>
  `${a.startDate === a.endDate ? fmtDate(a.startDate) : `${fmtDate(a.startDate)} bis ${fmtDate(a.endDate)}`}${a.halfDay ? " (halbe Tage)" : ""}`;

export async function worktimeRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  const orgOf = async (id: string) => (await ctx.db.select().from(organizations).where(eq(organizations.id, id)).limit(1))[0]!;
  const appUrl = () => new URL("/#arbeitszeit", ctx.config.APP_URL).toString();

  app.post("/api/absences", async (req, reply) => {
    const user = requireUser(req);
    const body = z
      .object({
        employeeId: z.string().optional(),
        type: z.enum(ABSENCE_TYPES as [Absence["type"], ...Absence["type"][]]),
        startDate: isoDate,
        endDate: isoDate,
        halfDay: z.boolean().default(false),
        note: z.string().trim().max(500).optional(),
      })
      .parse(req.body);
    const ownerId = body.employeeId ?? user.id;
    if (ownerId !== user.id && !(await managesUser(ctx, user, ownerId))) throw new HttpError(403, "Du kannst nur eigene Absenzen erfassen.");
    const [owner] = await ctx.db.select().from(users).where(and(eq(users.id, ownerId), eq(users.organizationId, user.organizationId))).limit(1);
    if (!owner) throw new HttpError(404, "Person nicht gefunden.");
    await assertAbsenceEditable(ctx, user, ownerId, body);

    const data = await absenceContext(ctx, user.organizationId, ownerId);
    const problem = absenceProblem(data, { ...body, employeeId: ownerId });
    if (problem) throw new HttpError(400, problem);

    // Leads record absences directly; employees request vacation, compensation, training and «other».
    // Leads and team leads (for their members) approve directly; own requests of a team lead still need a decision.
    const direct = isLead(user) || (ownerId !== user.id && (await managesUser(ctx, user, ownerId)));
    const status = direct || !NEEDS_APPROVAL.includes(body.type) ? "approved" : "requested";
    const row = {
      id: randomUUID(),
      organizationId: user.organizationId,
      userId: ownerId,
      type: body.type,
      startDate: body.startDate,
      endDate: body.endDate,
      halfDay: body.halfDay,
      note: body.note || null,
      status,
      decidedBy: status === "approved" ? user.id : null,
      decidedAt: status === "approved" ? new Date() : null,
    } as const;
    await ctx.db.insert(absences).values(row);
    await audit(ctx, user, "absence", row.id, "create", null, row);

    if (status === "requested") {
      const org = await orgOf(user.organizationId);
      const leads = await ctx.db
        .select()
        .from(users)
        .where(and(eq(users.organizationId, user.organizationId), eq(users.active, true), inArray(users.role, ["admin", "consultant"]), ne(users.id, user.id)));
      const days = absenceDays(data, body);
      for (const lead of leads) {
        await ctx.mailer.send(
          actionMail(org.settings.branding, {
            to: lead.email,
            subject: `${org.settings.branding.appName}: Antrag ${body.type} von ${owner.name}`,
            greeting: `Hallo ${lead.name.split(" ")[0]}`,
            lines: [`${owner.name} beantragt ${body.type}: ${range(body)}, ${days} ${days === 1 ? "Arbeitstag" : "Arbeitstage"}.`, ...(body.note ? [`Bemerkung: ${body.note}`] : [])],
            action: "Antrag ansehen",
            url: appUrl(),
            footer: "Bewilligen oder ablehnen kannst du unter Absenzen.",
          }),
        );
      }
    }
    return reply.status(201).send({ ...toDomain(row as unknown as AbsenceRow) });
  });

  app.post("/api/absences/:id/decide", async (req) => {
    const lead = requireUser(req);
    const { id } = req.params as { id: string };
    const { approve } = z.object({ approve: z.boolean() }).parse(req.body);
    const [row] = await ctx.db.select().from(absences).where(and(eq(absences.id, id), eq(absences.organizationId, lead.organizationId))).limit(1);
    if (!row) throw new HttpError(404, "Absenz nicht gefunden.");
    if (row.userId === lead.id && !isLead(lead)) throw new HttpError(403, "Über den eigenen Antrag entscheidet die vorgesetzte Person.");
    await assertManages(ctx, lead, row.userId);
    if (row.status !== "requested") throw new HttpError(409, "Über diesen Antrag wurde bereits entschieden.");
    await assertAbsenceEditable(ctx, lead, row.userId, row);
    const status = approve ? "approved" : "rejected";
    await ctx.db.update(absences).set({ status, decidedBy: lead.id, decidedAt: new Date() }).where(eq(absences.id, id));
    await audit(ctx, lead, "absence", id, approve ? "approve" : "reject", { status: row.status }, { status });

    const [owner] = await ctx.db.select().from(users).where(eq(users.id, row.userId)).limit(1);
    if (owner && owner.id !== lead.id) {
      const org = await orgOf(lead.organizationId);
      await ctx.mailer.send(
        actionMail(org.settings.branding, {
          to: owner.email,
          subject: `${org.settings.branding.appName}: ${row.type} ${approve ? "bewilligt" : "abgelehnt"}`,
          greeting: `Hallo ${owner.name.split(" ")[0]}`,
          lines: [`${lead.name} hat deinen Antrag ${row.type} (${range(row)}) ${approve ? "bewilligt" : "abgelehnt"}.`],
          action: "Arbeitszeit öffnen",
          url: appUrl(),
          footer: approve ? "Die Absenz ist jetzt in deinem Saldo berücksichtigt." : "Bei Fragen melde dich direkt bei der Person, die entschieden hat.",
        }),
      );
    }
    return { ...toDomain(row), status };
  });

  /** Owners withdraw requests or remove rejected ones; leads may remove any absence in an open month. */
  app.delete("/api/absences/:id", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const [row] = await ctx.db.select().from(absences).where(and(eq(absences.id, id), eq(absences.organizationId, user.organizationId))).limit(1);
    if (!row) throw new HttpError(404, "Absenz nicht gefunden.");
    if (!isLead(user)) {
      if (row.userId !== user.id && !(await managesUser(ctx, user, row.userId))) throw new HttpError(403, "Du kannst nur eigene Absenzen löschen.");
      if (row.status === "approved" && row.userId === user.id) throw new HttpError(409, "Eine bewilligte Absenz kann nur die vorgesetzte Person entfernen.");
    }
    await assertAbsenceEditable(ctx, user, row.userId, row);
    await ctx.db.delete(absences).where(eq(absences.id, id));
    await audit(ctx, user, "absence", id, "delete", row, null);
    return { ok: true };
  });

  app.patch("/api/users/:id/work-model", async (req) => {
    const admin = requireRole(req, "admin");
    const { id } = req.params as { id: string };
    const body = z
      .object({
        workload: z.number().int().min(1).max(100).optional(),
        vacationDays: z.number().min(0).max(60).multipleOf(0.5).optional(),
        trackingStart: isoDate.nullable().optional(),
        overtimeCarry: z.number().min(-1000).max(1000).optional(),
        vacationCarry: z.number().min(-60).max(100).multipleOf(0.5).optional(),
      })
      .parse(req.body);
    const [row] = await ctx.db.select().from(users).where(and(eq(users.id, id), eq(users.organizationId, admin.organizationId))).limit(1);
    if (!row) throw new HttpError(404, "Person nicht gefunden.");
    const pick = (u: typeof row) => ({ workload: u.workload, vacationDays: u.vacationDays, trackingStart: u.trackingStart, overtimeCarry: u.overtimeCarry, vacationCarry: u.vacationCarry });
    const next = { ...pick(row), ...body };
    await ctx.db.update(users).set(body).where(eq(users.id, id));
    await audit(ctx, admin, "work_model", id, "update", pick(row), next);
    return next;
  });
}
