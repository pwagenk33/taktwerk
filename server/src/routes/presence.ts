import { applyStamp, dayPresence, presenceIssues, toMinutes, type StampAction, type WorkPeriod } from "@taktwerk/domain";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError, managedUserIds, managesUser, requireUser, type AppContext, type SessionUser } from "../app";
import { organizations, workPeriods } from "../db/schema";
import { assertBookable } from "./billing";
import { clockTime, todayZurich } from "./data";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum im Format JJJJ-MM-TT");
export const nowZurich = () => new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()).replace(".", ":");

type Row = typeof workPeriods.$inferSelect;
const toDomain = (p: Row): WorkPeriod => ({ id: p.id, employeeId: p.userId, date: p.date, kind: p.kind, start: p.start, end: p.end ?? undefined });

async function assertFullModel(ctx: AppContext, user: SessionUser) {
  const [org] = await ctx.db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, user.organizationId)).limit(1);
  if (org?.settings.timeModel !== "full") throw new HttpError(409, "Kommen/Gehen ist für diese Firma nicht eingeschaltet (Einstellungen → Arbeitszeit).");
}

/** Come/go recording with breaks (Art. 73 ArGV 1), switched on per organization. */
export async function presenceRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  const dayOf = async (userId: string, date: string) => (await ctx.db.select().from(workPeriods).where(and(eq(workPeriods.userId, userId), eq(workPeriods.date, date)))).map(toDomain);

  /** Periods in a date range: own, plus the people the viewer manages. */
  app.get("/api/presence", async (req) => {
    const user = requireUser(req);
    const q = z.object({ from: isoDate, to: isoDate, employeeId: z.string().optional() }).parse(req.query);
    const scope = await managedUserIds(ctx, user);
    const rows = await ctx.db
      .select()
      .from(workPeriods)
      .where(and(eq(workPeriods.organizationId, user.organizationId), gte(workPeriods.date, q.from), lte(workPeriods.date, q.to), ...(scope ? [inArray(workPeriods.userId, [...scope])] : []), ...(q.employeeId ? [eq(workPeriods.userId, q.employeeId)] : [])));
    return rows.map(toDomain);
  });

  /** Stamp now (Zurich time): in | break | resume | out. Returns today's periods and figures. */
  app.post("/api/presence/stamp", async (req) => {
    const user = requireUser(req);
    await assertFullModel(ctx, user);
    const { action } = z.object({ action: z.enum(["in", "break", "resume", "out"]) }).parse(req.body);
    const date = todayZurich();
    const now = nowZurich();
    const before = await dayOf(user.id, date);
    let next: WorkPeriod[];
    try {
      next = applyStamp(before, action as StampAction, user.id, date, now, randomUUID);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
    for (const p of next) {
      const old = before.find((x) => x.id === p.id);
      if (!old) await ctx.db.insert(workPeriods).values({ id: p.id, organizationId: user.organizationId, userId: user.id, date, kind: p.kind, start: p.start, end: p.end ?? null });
      else if (old.end !== p.end) await ctx.db.update(workPeriods).set({ end: p.end ?? null }).where(eq(workPeriods.id, p.id));
    }
    const day = dayPresence(next, date, now);
    return { date, now, periods: next, work: day.work, breaks: day.breaks, state: day.state, issues: presenceIssues(day) };
  });

  /** Add a period by hand (forgotten stamp); leads and team leads also for their people. */
  app.post("/api/presence", async (req, reply) => {
    const user = requireUser(req);
    await assertFullModel(ctx, user);
    const body = z.object({ employeeId: z.string().optional(), date: isoDate, kind: z.enum(["work", "break"]).default("work"), start: clockTime, end: clockTime }).parse(req.body);
    const ownerId = body.employeeId ?? user.id;
    if (ownerId !== user.id && !(await managesUser(ctx, user, ownerId))) throw new HttpError(403, "Du kannst nur eigene Zeiten erfassen.");
    if (toMinutes(body.end) <= toMinutes(body.start)) throw new HttpError(400, "Ende muss nach dem Beginn liegen.");
    await assertBookable(ctx, user, ownerId, body.date);
    const overlap = (await dayOf(ownerId, body.date)).some((p) => p.end && toMinutes(p.start) < toMinutes(body.end) && toMinutes(p.end) > toMinutes(body.start));
    if (overlap) throw new HttpError(409, "Die Zeit überschneidet sich mit einem bestehenden Abschnitt.");
    const id = randomUUID();
    await ctx.db.insert(workPeriods).values({ id, organizationId: user.organizationId, userId: ownerId, date: body.date, kind: body.kind, start: body.start, end: body.end });
    return reply.status(201).send({ id, employeeId: ownerId, date: body.date, kind: body.kind, start: body.start, end: body.end });
  });

  app.put("/api/presence/:id", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const body = z.object({ kind: z.enum(["work", "break"]).optional(), start: clockTime.optional(), end: clockTime.nullable().optional() }).parse(req.body);
    const [row] = await ctx.db.select().from(workPeriods).where(and(eq(workPeriods.id, id), eq(workPeriods.organizationId, user.organizationId))).limit(1);
    if (!row) throw new HttpError(404, "Abschnitt nicht gefunden.");
    await assertBookable(ctx, user, row.userId, row.date);
    const next = { kind: body.kind ?? row.kind, start: body.start ?? row.start, end: body.end === undefined ? row.end : body.end };
    if (next.end && toMinutes(next.end) <= toMinutes(next.start)) throw new HttpError(400, "Ende muss nach dem Beginn liegen.");
    await ctx.db.update(workPeriods).set(next).where(eq(workPeriods.id, id));
    return toDomain({ ...row, ...next });
  });

  app.delete("/api/presence/:id", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const [row] = await ctx.db.select().from(workPeriods).where(and(eq(workPeriods.id, id), eq(workPeriods.organizationId, user.organizationId))).limit(1);
    if (!row) throw new HttpError(404, "Abschnitt nicht gefunden.");
    await assertBookable(ctx, user, row.userId, row.date);
    await ctx.db.delete(workPeriods).where(eq(workPeriods.id, id));
    return { ok: true };
  });
}
