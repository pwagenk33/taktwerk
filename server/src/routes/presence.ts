import { applyStamp, dayPresence, pointAt, presenceIssues, stampOptions, toMinutes, type StampAction, type WorkPeriod } from "@taktwerk/domain";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError, appOrigin, managedUserIds, managesUser, requireRole, requireUser, type AppContext, type SessionUser } from "../app";
import { newToken } from "../auth/crypto";
import { organizations, workPeriods, type StampPoint } from "../db/schema";
import QRCode from "qrcode";
import { assertBookable } from "./billing";
import { clockTime, todayZurich } from "./data";
import { tr } from "@taktwerk/domain";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, tr("Datum im Format JJJJ-MM-TT"));
export const nowZurich = () => new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()).replace(".", ":");

type Row = typeof workPeriods.$inferSelect;
const toDomain = (p: Row): WorkPeriod => ({ id: p.id, employeeId: p.userId, date: p.date, kind: p.kind, start: p.start, end: p.end ?? undefined });

async function assertFullModel(ctx: AppContext, user: SessionUser) {
  const [org] = await ctx.db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, user.organizationId)).limit(1);
  if (org?.settings.timeModel !== "full") throw new HttpError(409, tr("Kommen/Gehen ist für diese Firma nicht eingeschaltet (Einstellungen → Arbeitszeit)."));
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

  const orgOf = async (id: string) => (await ctx.db.select().from(organizations).where(eq(organizations.id, id)).limit(1))[0]!;

  /**
   * Stamp now (Zurich time): in | break | resume | out. Returns today's periods and figures.
   * With `point` (the token from an NFC tag or QR code) the stamp counts as made at that point. When the company
   * requires the location, app stamps need lat/lng within a point's radius; without them the answer is 428.
   */
  app.post("/api/presence/stamp", async (req) => {
    const user = requireUser(req);
    await assertFullModel(ctx, user);
    const body = z
      .object({ action: z.enum(["in", "break", "resume", "out"]), point: z.string().max(80).optional(), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(), accuracy: z.number().min(0).max(100_000).optional() })
      .parse(req.body);
    const org = await orgOf(user.organizationId);
    const points = org.settings.stampPoints ?? [];
    let source: "app" | "nfc" | "location" = "app";
    let pointId: string | null = null;
    if (body.point) {
      const p = points.find((x) => x.token === body.point);
      if (!p) throw new HttpError(404, tr("Dieser Stempelpunkt ist nicht (mehr) gültig."));
      source = "nfc";
      pointId = p.id;
    } else if (org.settings.stampGeofence) {
      if (body.lat === undefined || body.lng === undefined) throw new HttpError(428, tr("Zum Stempeln braucht es deinen Standort. Bitte freigeben oder am NFC-Punkt stempeln."));
      const p = pointAt(points, { lat: body.lat, lng: body.lng, accuracy: body.accuracy });
      if (!p) throw new HttpError(409, tr("Du bist nicht an einem Arbeitsort. Stempeln geht nur in der Nähe eines Stempelpunkts."));
      source = "location";
      pointId = p.id;
    }
    const date = todayZurich();
    const now = nowZurich();
    const before = await dayOf(user.id, date);
    let next: WorkPeriod[];
    try {
      next = applyStamp(before, body.action as StampAction, user.id, date, now, randomUUID);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
    for (const p of next) {
      const old = before.find((x) => x.id === p.id);
      if (!old) await ctx.db.insert(workPeriods).values({ id: p.id, organizationId: user.organizationId, userId: user.id, date, kind: p.kind, start: p.start, end: p.end ?? null, source, pointId });
      else if (old.end !== p.end) await ctx.db.update(workPeriods).set({ end: p.end ?? null }).where(eq(workPeriods.id, p.id));
    }
    const day = dayPresence(next, date, now);
    return { date, now, periods: next, work: day.work, breaks: day.breaks, state: day.state, issues: presenceIssues(day) };
  });

  /** Landing page of an NFC tag or QR code: the point's name and what the person can stamp now. */
  app.get("/api/presence/point/:token", async (req) => {
    const user = requireUser(req);
    await assertFullModel(ctx, user);
    const org = await orgOf(user.organizationId);
    const p = (org.settings.stampPoints ?? []).find((x) => x.token === (req.params as { token: string }).token);
    if (!p) throw new HttpError(404, tr("Dieser Stempelpunkt ist nicht (mehr) gültig."));
    const day = dayPresence(await dayOf(user.id, todayZurich()), todayZurich(), nowZurich());
    return { name: p.name, state: day.state, since: day.open?.start ?? null, options: stampOptions(day.state), now: nowZurich() };
  });

  // ---------- admin: stamp points ----------

  const pointView = (org: typeof organizations.$inferSelect, p: StampPoint) => ({ id: p.id, name: p.name, lat: p.lat ?? null, lng: p.lng ?? null, radius: p.radius ?? null, url: `${appOrigin(ctx.config, org)}/#stempeln/${p.token}` });
  const savePoints = async (org: typeof organizations.$inferSelect, stampPoints: StampPoint[], extra: { stampGeofence?: boolean } = {}) => {
    const settings = { ...org.settings, stampPoints, ...extra };
    await ctx.db.update(organizations).set({ settings }).where(eq(organizations.id, org.id));
    return { points: stampPoints.map((p) => pointView({ ...org, settings }, p)), geofence: !!settings.stampGeofence };
  };
  const pointBody = z.object({
    name: z.string().trim().min(1).max(80),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
    radius: z.number().int().min(20).max(2000).nullable().optional(),
  });

  app.get("/api/presence/points", async (req) => {
    const user = requireRole(req, "admin");
    const org = await orgOf(user.organizationId);
    return { points: (org.settings.stampPoints ?? []).map((p) => pointView(org, p)), geofence: !!org.settings.stampGeofence };
  });

  app.post("/api/presence/points", async (req, reply) => {
    const user = requireRole(req, "admin");
    const body = pointBody.parse(req.body);
    const org = await orgOf(user.organizationId);
    const list = org.settings.stampPoints ?? [];
    if (list.length >= 50) throw new HttpError(409, tr("Höchstens 50 Stempelpunkte."));
    const point: StampPoint = { id: randomUUID(), name: body.name, token: newToken().slice(0, 24).replace(/[^A-Za-z0-9]/g, "x"), ...(body.lat != null && body.lng != null ? { lat: body.lat, lng: body.lng, radius: body.radius ?? 150 } : {}) };
    return reply.code(201).send(await savePoints(org, [...list, point]));
  });

  app.patch("/api/presence/points/:id", async (req) => {
    const user = requireRole(req, "admin");
    const body = pointBody.partial().extend({ renewToken: z.boolean().optional() }).parse(req.body);
    const org = await orgOf(user.organizationId);
    const id = (req.params as { id: string }).id;
    const list = org.settings.stampPoints ?? [];
    if (!list.some((p) => p.id === id)) throw new HttpError(404, tr("Stempelpunkt nicht gefunden."));
    return savePoints(org, list.map((p) => {
      if (p.id !== id) return p;
      const next: StampPoint = { ...p, ...(body.name ? { name: body.name } : {}), ...(body.renewToken ? { token: newToken().slice(0, 24).replace(/[^A-Za-z0-9]/g, "x") } : {}) };
      if (body.lat === null || body.lng === null) { delete next.lat; delete next.lng; delete next.radius; }
      else if (body.lat !== undefined && body.lng !== undefined) Object.assign(next, { lat: body.lat, lng: body.lng, radius: body.radius ?? p.radius ?? 150 });
      else if (body.radius) next.radius = body.radius;
      return next;
    }));
  });

  app.delete("/api/presence/points/:id", async (req) => {
    const user = requireRole(req, "admin");
    const org = await orgOf(user.organizationId);
    return savePoints(org, (org.settings.stampPoints ?? []).filter((p) => p.id !== (req.params as { id: string }).id));
  });

  app.put("/api/presence/geofence", async (req) => {
    const user = requireRole(req, "admin");
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    const org = await orgOf(user.organizationId);
    if (on && !(org.settings.stampPoints ?? []).some((p) => p.lat !== undefined)) throw new HttpError(409, tr("Zuerst einen Stempelpunkt mit Standort anlegen."));
    return savePoints(org, org.settings.stampPoints ?? [], { stampGeofence: on });
  });

  /** QR code of a point's link, to print next to the NFC tag (or instead of it). */
  app.get("/api/presence/points/:id/qr.svg", async (req, reply) => {
    const user = requireRole(req, "admin");
    const org = await orgOf(user.organizationId);
    const p = (org.settings.stampPoints ?? []).find((x) => x.id === (req.params as { id: string }).id);
    if (!p) throw new HttpError(404, tr("Stempelpunkt nicht gefunden."));
    const svg = await QRCode.toString(pointView(org, p).url, { type: "svg", margin: 2, errorCorrectionLevel: "M" });
    return reply.type("image/svg+xml").header("content-disposition", `inline; filename="stempelpunkt-${p.name.replace(/[^A-Za-z0-9-]+/g, "-")}.svg"`).send(svg);
  });

  /** Add a period by hand (forgotten stamp); leads and team leads also for their people. */
  app.post("/api/presence", async (req, reply) => {
    const user = requireUser(req);
    await assertFullModel(ctx, user);
    const body = z.object({ employeeId: z.string().optional(), date: isoDate, kind: z.enum(["work", "break"]).default("work"), start: clockTime, end: clockTime }).parse(req.body);
    const ownerId = body.employeeId ?? user.id;
    if (ownerId !== user.id && !(await managesUser(ctx, user, ownerId))) throw new HttpError(403, tr("Du kannst nur eigene Zeiten erfassen."));
    if (toMinutes(body.end) <= toMinutes(body.start)) throw new HttpError(400, tr("Ende muss nach dem Beginn liegen."));
    await assertBookable(ctx, user, ownerId, body.date);
    const overlap = (await dayOf(ownerId, body.date)).some((p) => p.end && toMinutes(p.start) < toMinutes(body.end) && toMinutes(p.end) > toMinutes(body.start));
    if (overlap) throw new HttpError(409, tr("Die Zeit überschneidet sich mit einem bestehenden Abschnitt."));
    const id = randomUUID();
    await ctx.db.insert(workPeriods).values({ id, organizationId: user.organizationId, userId: ownerId, date: body.date, kind: body.kind, start: body.start, end: body.end, source: "manual" });
    return reply.status(201).send({ id, employeeId: ownerId, date: body.date, kind: body.kind, start: body.start, end: body.end });
  });

  app.put("/api/presence/:id", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const body = z.object({ kind: z.enum(["work", "break"]).optional(), start: clockTime.optional(), end: clockTime.nullable().optional() }).parse(req.body);
    const [row] = await ctx.db.select().from(workPeriods).where(and(eq(workPeriods.id, id), eq(workPeriods.organizationId, user.organizationId))).limit(1);
    if (!row) throw new HttpError(404, tr("Abschnitt nicht gefunden."));
    await assertBookable(ctx, user, row.userId, row.date);
    const next = { kind: body.kind ?? row.kind, start: body.start ?? row.start, end: body.end === undefined ? row.end : body.end };
    if (next.end && toMinutes(next.end) <= toMinutes(next.start)) throw new HttpError(400, tr("Ende muss nach dem Beginn liegen."));
    await ctx.db.update(workPeriods).set(next).where(eq(workPeriods.id, id));
    return toDomain({ ...row, ...next });
  });

  app.delete("/api/presence/:id", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const [row] = await ctx.db.select().from(workPeriods).where(and(eq(workPeriods.id, id), eq(workPeriods.organizationId, user.organizationId))).limit(1);
    if (!row) throw new HttpError(404, tr("Abschnitt nicht gefunden."));
    await assertBookable(ctx, user, row.userId, row.date);
    await ctx.db.delete(workPeriods).where(eq(workPeriods.id, id));
    return { ok: true };
  });
}
