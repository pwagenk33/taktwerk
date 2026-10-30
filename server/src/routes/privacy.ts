import { and, eq, lt, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireRole, requireUser, type AppContext } from "../app";
import { verifyPassword } from "../auth/crypto";
import { absences, allocations, auditLog, dashboards, entryComments, expenses, monthClosings, oauthAccounts, passkeys, passwordTokens, sessions, timeEntries, users, weekSubmissions } from "../db/schema";
import { tr } from "@taktwerk/domain";

/**
 * Everything the installation stores about one person, in a readable JSON (Auskunftsrecht, Art. 25 DSG).
 * Technical secrets (password hash, TOTP secret, session tokens, public keys) are not part of the data subject's
 * information and stay out.
 */
export async function personalDataExport(ctx: AppContext, userId: string) {
  const db = ctx.db;
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) throw new HttpError(404, tr("Person nicht gefunden."));
  const [entries, spent, abs, closings, weeks, allocs, comments, sess, keys, oauth, audits] = await Promise.all([
    db.select().from(timeEntries).where(eq(timeEntries.userId, userId)),
    db.select().from(expenses).where(eq(expenses.userId, userId)),
    db.select().from(absences).where(eq(absences.userId, userId)),
    db.select().from(monthClosings).where(eq(monthClosings.userId, userId)),
    db.select().from(weekSubmissions).where(eq(weekSubmissions.userId, userId)),
    db.select().from(allocations).where(eq(allocations.userId, userId)),
    db.select().from(entryComments).where(eq(entryComments.authorId, userId)),
    db.select().from(sessions).where(eq(sessions.userId, userId)),
    db.select().from(passkeys).where(eq(passkeys.userId, userId)),
    db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, userId)),
    db.select().from(auditLog).where(eq(auditLog.actorId, userId)),
  ]);
  return {
    exportiertAm: new Date().toISOString(),
    hinweis: tr("Auskunft nach Art. 25 DSG. Buchungen und Spesen bleiben als Geschäftsunterlagen 10 Jahre aufbewahrt (Art. 958f OR), Arbeitszeiten 5 Jahre (Art. 73 ArGV 1)."),
    person: {
      name: u.name,
      benutzername: u.username,
      email: u.email,
      rolle: u.role,
      aktiv: u.active,
      pensum: u.workload,
      ferientage: u.vacationDays,
      erfassungsbeginn: u.trackingStart,
      ueberzeitUebertrag: u.overtimeCarry,
      ferienUebertrag: u.vacationCarry,
      kostensatz: u.costRate,
      erinnerung: u.reminder,
      zweiterFaktorSeit: u.totpEnabledAt,
      letzteAnmeldung: u.lastLoginAt,
      erstelltAm: u.createdAt,
      anmeldungen: oauth.map((o) => ({ anbieter: o.provider, seit: o.createdAt })),
      passkeys: keys.map((k) => ({ name: k.name, erstellt: k.createdAt, zuletzt: k.lastUsedAt })),
      sitzungen: sess.map((s) => ({ geraet: s.userAgent, ip: s.ip, erstellt: s.createdAt, zuletzt: s.lastSeenAt })),
    },
    zeitbuchungen: entries.map((e) => ({ datum: e.date, stunden: e.hours, grund: e.reason, verrechenbar: e.billable, start: e.startTime, jira: e.jiraIssueKey, subprojektId: e.subProjectId })),
    spesen: spent.map((x) => ({ datum: x.date, betrag: x.amount, kategorie: x.category, grund: x.reason, status: x.status, beleg: x.receiptName })),
    absenzen: abs.map((a) => ({ art: a.type, von: a.startDate, bis: a.endDate, halbeTage: a.halfDay, notiz: a.note, status: a.status })),
    monatsabschluesse: closings.map((c) => ({ monat: c.month, status: c.status, eingereicht: c.submittedAt, freigegeben: c.approvedAt })),
    wochenfreigaben: weeks.map((w) => ({ woche: w.week, stunden: w.hours, eingereicht: w.submittedAt })),
    planung: allocs.map((a) => ({ woche: a.week, stunden: a.hours, projektId: a.projectId, notiz: a.note })),
    kommentare: comments.map((c) => ({ buchungId: c.entryId, art: c.kind, text: c.text, am: c.createdAt })),
    protokoll: audits.map((a) => ({ am: a.createdAt, objekt: a.entity, aktion: a.action })),
  };
}

/**
 * Removes the personal data of a former employee while keeping the business records (bookings, expenses,
 * closings) under a neutral name, as the retention duties require. Irreversible.
 */
export async function anonymizeUser(ctx: AppContext, userId: string, orgId: string) {
  const db = ctx.db;
  const [u] = await db.select().from(users).where(and(eq(users.id, userId), eq(users.organizationId, orgId))).limit(1);
  if (!u) throw new HttpError(404, tr("Person nicht gefunden."));
  if (u.active) throw new HttpError(409, tr("Bitte die Person zuerst deaktivieren."));
  const short = userId.slice(0, 8);
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(passwordTokens).where(eq(passwordTokens.userId, userId));
  await db.delete(passkeys).where(eq(passkeys.userId, userId));
  await db.delete(oauthAccounts).where(eq(oauthAccounts.userId, userId));
  await db.delete(dashboards).where(eq(dashboards.userId, userId));
  await db.delete(allocations).where(eq(allocations.userId, userId));
  // Free-text notes on absences may contain health details.
  await db.update(absences).set({ note: null }).where(eq(absences.userId, userId));
  await db
    .update(users)
    .set({
      name: tr("Ehemalige Person"),
      username: `ehemalig-${short}`,
      email: `ehemalig-${short}@geloescht.invalid`,
      passwordHash: null,
      totpSecret: null,
      totpEnabledAt: null,
      recoveryCodes: null,
      reminder: null,
      costRate: null,
      teamId: null,
      platformAdmin: false,
      lastLoginAt: null,
    })
    .where(eq(users.id, userId));
  return { id: userId, name: tr("Ehemalige Person") };
}

/** Housekeeping: expired sessions and used/expired password links are removed; nothing else is touched. */
export async function purgeExpired(ctx: AppContext, now = new Date()) {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  await ctx.db.delete(sessions).where(lt(sessions.expiresAt, now));
  await ctx.db.delete(passwordTokens).where(or(lt(passwordTokens.expiresAt, weekAgo), lt(passwordTokens.usedAt, weekAgo)));
}

export async function privacyRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  /** Self-service Auskunft: the own data as JSON download. */
  app.get("/api/me/export", async (req, reply) => {
    const user = requireUser(req);
    const data = await personalDataExport(ctx, user.id);
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header("content-type", "application/json; charset=utf-8")
      .header("content-disposition", `attachment; filename="auskunft-${user.username}-${stamp}.json"`)
      .send(JSON.stringify(data, null, 2));
  });

  /** Admins: the same for any person of the organization (requests by former employees). */
  app.get("/api/users/:id/export", async (req, reply) => {
    const admin = requireRole(req, "admin");
    const { id } = req.params as { id: string };
    const [u] = await ctx.db.select({ id: users.id, username: users.username }).from(users).where(and(eq(users.id, id), eq(users.organizationId, admin.organizationId))).limit(1);
    if (!u) throw new HttpError(404, tr("Person nicht gefunden."));
    const data = await personalDataExport(ctx, id);
    return reply
      .header("content-type", "application/json; charset=utf-8")
      .header("content-disposition", `attachment; filename="auskunft-${u.username}.json"`)
      .send(JSON.stringify(data, null, 2));
  });

  /** Admins anonymize a deactivated person; the admin's password confirms the irreversible step. */
  app.post("/api/users/:id/anonymize", async (req) => {
    const admin = requireRole(req, "admin");
    const { id } = req.params as { id: string };
    const { password } = z.object({ password: z.string() }).parse(req.body);
    const [me] = await ctx.db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, admin.id)).limit(1);
    if (!me?.hash || !(await verifyPassword(password, me.hash))) throw new HttpError(403, tr("Passwort stimmt nicht."));
    if (id === admin.id) throw new HttpError(400, tr("Das eigene Konto kann nicht anonymisiert werden."));
    // Receipts stay on disk (accounting records); they carry the expense id, not the person's name.
    return anonymizeUser(ctx, id, admin.organizationId);
  });
}
