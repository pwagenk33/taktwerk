import { fmtDate } from "@taktwerk/domain";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError, requireUser, type SessionUser } from "../app";
import { entryComments, organizations, timeEntries, users } from "../db/schema";
import { actionMail } from "../mail/mailer";
import { tr } from "@taktwerk/domain";
import { withLocale } from "../i18n";

const isLead = (u: SessionUser) => u.role === "admin" || u.role === "consultant";

/** Comments and questions on bookings: clarification without e-mail ping-pong. */
export async function commentRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  const entryFor = async (user: SessionUser, entryId: string) => {
    const [e] = await ctx.db.select().from(timeEntries).where(and(eq(timeEntries.id, entryId), eq(timeEntries.organizationId, user.organizationId))).limit(1);
    if (!e) throw new HttpError(404, tr("Buchung nicht gefunden."));
    if (e.userId !== user.id && !isLead(user)) throw new HttpError(403, tr("Dafür fehlt dir die Berechtigung."));
    return e;
  };

  app.get("/api/time-entries/:id/comments", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await entryFor(user, id);
    const rows = await ctx.db
      .select({ c: entryComments, author: users.name })
      .from(entryComments)
      .leftJoin(users, eq(users.id, entryComments.authorId))
      .where(eq(entryComments.entryId, id))
      .orderBy(asc(entryComments.createdAt));
    return rows.map((r) => ({ id: r.c.id, kind: r.c.kind, text: r.c.text, authorId: r.c.authorId, authorName: r.author, createdAt: r.c.createdAt, resolvedAt: r.c.resolvedAt }));
  });

  /** Owner or lead writes a comment; a lead can mark it as a question, which e-mails the owner and stays open until the owner answers. */
  app.post("/api/time-entries/:id/comments", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const body = z.object({ text: z.string().trim().min(1).max(1000), question: z.boolean().optional() }).parse(req.body);
    const e = await entryFor(user, id);
    const question = Boolean(body.question) && isLead(user) && e.userId !== user.id;
    const comment = { id: randomUUID(), organizationId: user.organizationId, entryId: id, authorId: user.id, kind: question ? ("question" as const) : ("comment" as const), text: body.text };
    await ctx.db.insert(entryComments).values(comment);
    // The owner's answer closes every open question on the booking.
    if (e.userId === user.id) {
      await ctx.db.update(entryComments).set({ resolvedAt: new Date() }).where(and(eq(entryComments.entryId, id), eq(entryComments.kind, "question"), isNull(entryComments.resolvedAt)));
    }
    if (question) {
      const [owner] = await ctx.db.select().from(users).where(eq(users.id, e.userId)).limit(1);
      const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, user.organizationId)).limit(1);
      if (owner && org) {
        await ctx.mailer.send(
          withLocale(owner.locale, () => actionMail(org.settings.branding, {
            to: owner.email,
            subject: tr("{0}: Rückfrage zu deiner Buchung vom {1}", org.settings.branding.appName, fmtDate(e.date)),
            greeting: tr("Hallo {0}", owner.name.split(" ")[0]),
            lines: [tr("{0} fragt zu «{1}» ({2} h am {3}):", user.name, e.reason, e.hours.toFixed(2).replace(".", ","), fmtDate(e.date)), `«${body.text}»`, tr("Antworte direkt in der Buchung, dann ist die Rückfrage erledigt.")],
            action: tr("Buchung öffnen"),
            url: new URL(`/#zeit/e/${e.id}`, ctx.config.APP_URL).toString(),
            footer: tr("Rückfragen stellen Consultants und Admins im Monatsabschluss oder im Kalender."),
          })),
        );
      }
    }
    return { ...comment, authorName: user.name, createdAt: new Date(), resolvedAt: null };
  });

  /** Open questions the viewer should act on: own bookings (everyone) or all of the organization (leads). */
  app.get("/api/comments/open", async (req) => {
    const user = requireUser(req);
    const rows = await ctx.db
      .select({ c: entryComments, e: timeEntries, author: users.name })
      .from(entryComments)
      .innerJoin(timeEntries, eq(timeEntries.id, entryComments.entryId))
      .leftJoin(users, eq(users.id, entryComments.authorId))
      .where(and(eq(entryComments.organizationId, user.organizationId), eq(entryComments.kind, "question"), isNull(entryComments.resolvedAt)))
      .orderBy(asc(entryComments.createdAt));
    return rows
      .filter((r) => isLead(user) || r.e.userId === user.id)
      .map((r) => ({ entryId: r.e.id, ownerId: r.e.userId, date: r.e.date, reason: r.e.reason, text: r.c.text, askedBy: r.author, createdAt: r.c.createdAt }));
  });
}
