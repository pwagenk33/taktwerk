import { WorkCalendar, isoWeekKey, weekFigures, weekRange } from "@taktwerk/domain";
import { and, eq, gte, lte, notInArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, managedUserIds, managesPeople, requireUser, seesAll } from "../app";
import { users, weekSubmissions } from "../db/schema";
import { detailStart, loadDataset, todayZurich } from "./data";

const weekParam = z.string().regex(/^\d{4}-W\d{2}$/, "Ungültige Woche");

/** Weekly submission: people confirm a week is complete, leads see at a glance who is missing hours. */
export async function weekRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  /** Submissions in a range (leads: everyone; employees: own). */
  app.get("/api/weeks", async (req) => {
    const user = requireUser(req);
    const q = z.object({ from: weekParam, to: weekParam }).parse(req.query);
    const rows = await ctx.db
      .select()
      .from(weekSubmissions)
      .where(and(eq(weekSubmissions.organizationId, user.organizationId), gte(weekSubmissions.week, q.from), lte(weekSubmissions.week, q.to)));
    const scope = await managedUserIds(ctx, user);
    return rows.filter((r) => !scope || scope.has(r.userId)).map((r) => ({ userId: r.userId, week: r.week, hours: r.hours, submittedAt: r.submittedAt }));
  });

  /** Team overview for leads: per person and week, hours due, worked and whether submitted. */
  app.get("/api/weeks/overview", async (req) => {
    const user = requireUser(req);
    if (!managesPeople(user) && !seesAll(user)) throw new HttpError(403, "Dafür fehlt dir die Berechtigung.");
    const q = z.object({ from: weekParam, to: weekParam }).parse(req.query);
    const start = weekRange(q.from).from;
    const window = detailStart(todayZurich());
    const data = await loadDataset(ctx, user, { detailFrom: start < window ? start : window });
    const scope = await managedUserIds(ctx, user);
    const people = (await ctx.db.select().from(users).where(and(eq(users.organizationId, user.organizationId), eq(users.active, true), notInArray(users.role, ["customer", "auditor"])))).filter((p) => !scope || scope.has(p.id));
    const subs = await ctx.db
      .select()
      .from(weekSubmissions)
      .where(and(eq(weekSubmissions.organizationId, user.organizationId), gte(weekSubmissions.week, q.from), lte(weekSubmissions.week, q.to)));
    const weeks: string[] = [];
    for (let k = q.from; k <= q.to && weeks.length < 12; ) {
      weeks.push(k);
      const [y, w] = k.split("-W").map(Number);
      k = w >= 52 ? `${y + 1}-W01` : `${y}-W${String(w + 1).padStart(2, "0")}`;
    }
    return people.map((p) => {
      const emp = data.employees.find((e) => e.id === p.id);
      const cal = emp ? new WorkCalendar(data, emp) : null;
      return {
        userId: p.id,
        name: p.name,
        weeks: weeks.map((week) => {
          const f = cal ? weekFigures(cal, week) : { due: 0, worked: 0 };
          const s = subs.find((x) => x.userId === p.id && x.week === week);
          return { week, due: f.due, worked: f.worked, submitted: Boolean(s), submittedAt: s?.submittedAt ?? null };
        }),
      };
    });
  });

  app.post("/api/weeks/:week/submit", async (req) => {
    const user = requireUser(req);
    const week = weekParam.parse((req.params as { week: string }).week);
    const today = new Date().toISOString().slice(0, 10);
    if (week > isoWeekKey(today)) throw new HttpError(400, "Zukünftige Wochen können nicht eingereicht werden.");
    const start = weekRange(week).from;
    const window = detailStart(todayZurich());
    const data = await loadDataset(ctx, user, { detailFrom: start < window ? start : window });
    const emp = data.employees.find((e) => e.id === user.id);
    const hours = emp ? weekFigures(new WorkCalendar(data, emp), week).worked : 0;
    await ctx.db
      .insert(weekSubmissions)
      .values({ organizationId: user.organizationId, userId: user.id, week, hours, submittedAt: new Date() })
      .onDuplicateKeyUpdate({ set: { hours, submittedAt: new Date() } });
    return { week, hours, submitted: true };
  });

  /** Withdraw an own submission (e.g. to add a forgotten booking). */
  app.delete("/api/weeks/:week/submit", async (req) => {
    const user = requireUser(req);
    const week = weekParam.parse((req.params as { week: string }).week);
    await ctx.db.delete(weekSubmissions).where(and(eq(weekSubmissions.userId, user.id), eq(weekSubmissions.week, week)));
    return { week, submitted: false };
  });
}
