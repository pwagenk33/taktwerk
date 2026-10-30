// Profile → Kalender: each person connects their Outlook or Google calendar; Zeiterfassung shows its
// meetings as booking suggestions.
import { decodeIdToken, generateCodeVerifier, generateState } from "arctic";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, appOrigin, requireUser } from "../app";
import { authorizationUrl, calendarClient, calendarEvents, expiryOf, type CalendarProvider } from "../calendar";
import { calendarConnections, organizations } from "../db/schema";
import { tr } from "@taktwerk/domain";

/** OAuth state → who started; the callback arrives on APP_URL, which in SaaS mode is not the company's address. */
const pending = new Map<string, { userId: string; orgId: string; verifier: string; until: number }>();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function calendarRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const connection = async (userId: string) => (await ctx.db.select().from(calendarConnections).where(eq(calendarConnections.userId, userId)).limit(1))[0];

  app.get("/api/calendar", async (req) => {
    const user = requireUser(req);
    const conn = await connection(user.id);
    return {
      providers: { microsoft: !!calendarClient(ctx, "microsoft"), google: !!calendarClient(ctx, "google") },
      connected: conn ? { provider: conn.provider, account: conn.account } : null,
    };
  });

  for (const provider of ["microsoft", "google"] as const satisfies CalendarProvider[]) {
    app.get(`/api/calendar/${provider}`, async (req, reply) => {
      const user = requireUser(req);
      if (!calendarClient(ctx, provider)) throw new HttpError(404, tr("Dieser Kalender ist auf dieser Installation nicht eingerichtet."));
      for (const [k, v] of pending) if (v.until < Date.now()) pending.delete(k);
      const state = generateState();
      const verifier = generateCodeVerifier();
      pending.set(state, { userId: user.id, orgId: user.organizationId, verifier, until: Date.now() + 15 * 60_000 });
      return reply.redirect(authorizationUrl(ctx, provider, state, verifier).toString());
    });

    app.get(`/api/calendar/${provider}/callback`, async (req, reply) => {
      const q = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(req.query);
      const p = q.state ? pending.get(q.state) : undefined;
      if (!p || p.until < Date.now()) throw new HttpError(400, tr("Die Anmeldung beim Kalender ist abgelaufen. Bitte im Profil nochmals verbinden."));
      pending.delete(q.state!);
      const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, p.orgId)).limit(1);
      const back = (outcome: "ok" | "fehler") => reply.redirect(`${appOrigin(ctx.config, org)}/?kalender=${outcome}#profil`);
      if (q.error || !q.code) return back("fehler");
      try {
        const t = await calendarClient(ctx, provider)!.validateAuthorizationCode(q.code, p.verifier);
        let account: string | null = null;
        try {
          const claims = decodeIdToken(t.idToken()) as Record<string, unknown>;
          account = String(claims.email ?? claims.preferred_username ?? "") || null;
        } catch { /* no id token: the account name is only for display */ }
        const row = {
          userId: p.userId,
          organizationId: p.orgId,
          provider,
          account,
          accessToken: t.accessToken(),
          refreshToken: t.hasRefreshToken() ? t.refreshToken() : null,
          expiresAt: expiryOf(t),
          createdAt: new Date(),
        };
        await ctx.db.delete(calendarConnections).where(eq(calendarConnections.userId, p.userId));
        await ctx.db.insert(calendarConnections).values(row);
        return back("ok");
      } catch (err) {
        req.log.warn({ err }, "calendar code exchange failed");
        return back("fehler");
      }
    });
  }

  /** The person's meetings from `from` to `to` (at most 6 weeks), live from the calendar. */
  app.get("/api/calendar/events", async (req) => {
    const user = requireUser(req);
    const q = z.object({ from: day, to: day }).refine((v) => v.from <= v.to && Date.parse(v.to) - Date.parse(v.from) <= 42 * 86400_000, tr("Zeitraum zu lang.")).parse(req.query);
    const conn = await connection(user.id);
    if (!conn) throw new HttpError(404, tr("Kein Kalender verbunden."));
    return calendarEvents(ctx, conn, q.from, q.to);
  });

  app.delete("/api/calendar", async (req) => {
    const user = requireUser(req);
    await ctx.db.delete(calendarConnections).where(eq(calendarConnections.userId, user.id));
    return { ok: true };
  });
}
