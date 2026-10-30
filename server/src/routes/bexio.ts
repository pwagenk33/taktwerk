// Settings → Rechnung → bexio: connect the company's bexio account and transfer invoices as drafts.
import { decodeIdToken, generateCodeVerifier, generateState, CodeChallengeMethod } from "arctic";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, appOrigin, requireRole } from "../app";
import { BEXIO_AUTH, BEXIO_SCOPES, bexioApi, bexioClient, bexioOn, expiryOf, transferInvoice } from "../bexio";
import { bexioConnections, organizations } from "../db/schema";
import { tr } from "@taktwerk/domain";

/** OAuth state → who started; the callback arrives on APP_URL, which in SaaS mode is not the company's address. */
const pending = new Map<string, { orgId: string; userId: string; verifier: string; until: number }>();

export async function bexioRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const connection = async (orgId: string) => (await ctx.db.select().from(bexioConnections).where(eq(bexioConnections.organizationId, orgId)).limit(1))[0];

  app.get("/api/bexio", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const conn = await connection(user.organizationId);
    return { configured: bexioOn(ctx), connected: conn ? { account: conn.account, since: conn.createdAt } : null };
  });

  app.get("/api/bexio/connect", async (req, reply) => {
    const user = requireRole(req, "admin");
    if (!bexioOn(ctx)) throw new HttpError(400, tr("Die Verbindung mit bexio ist auf dieser Installation nicht eingerichtet (BEXIO_CLIENT_ID fehlt)."));
    for (const [k, v] of pending) if (v.until < Date.now()) pending.delete(k);
    const state = generateState();
    const verifier = generateCodeVerifier();
    pending.set(state, { orgId: user.organizationId, userId: user.id, verifier, until: Date.now() + 15 * 60_000 });
    return reply.redirect(bexioClient(ctx).createAuthorizationURLWithPKCE(`${BEXIO_AUTH}/auth`, state, CodeChallengeMethod.S256, verifier, BEXIO_SCOPES).toString());
  });

  app.get("/api/bexio/callback", async (req, reply) => {
    const q = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(req.query);
    const p = q.state ? pending.get(q.state) : undefined;
    if (!p || p.until < Date.now()) throw new HttpError(400, tr("Die Anmeldung bei bexio ist abgelaufen. Bitte in TrackInsight nochmals verbinden."));
    pending.delete(q.state!);
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, p.orgId)).limit(1);
    const back = (outcome: "ok" | "fehler") => reply.redirect(`${appOrigin(ctx.config, org)}/?bexio=${outcome}#einstellungen/billing`);
    if (q.error || !q.code) return back("fehler");
    try {
      const t = await bexioClient(ctx).validateAuthorizationCode(`${BEXIO_AUTH}/token`, q.code, p.verifier);
      const me = await bexioApi<{ id: number; email?: string }>(ctx, { accessToken: t.accessToken() }, "/3.0/users/me");
      let account = me.email ?? null;
      if (!account) try { account = String((decodeIdToken(t.idToken()) as { email?: string }).email ?? "") || null; } catch { /* display only */ }
      const before = await connection(p.orgId);
      await ctx.db.delete(bexioConnections).where(eq(bexioConnections.organizationId, p.orgId));
      await ctx.db.insert(bexioConnections).values({
        organizationId: p.orgId,
        accessToken: t.accessToken(),
        refreshToken: t.hasRefreshToken() ? t.refreshToken() : null,
        expiresAt: expiryOf(t),
        bexioUserId: me.id,
        account,
        // Contacts stay known after a reconnect to the same account.
        contacts: before?.account === account ? before.contacts : {},
        connectedBy: p.userId,
        createdAt: new Date(),
      });
      return back("ok");
    } catch (err) {
      req.log.warn({ err }, "bexio connect failed");
      return back("fehler");
    }
  });

  app.post("/api/invoices/:id/bexio", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    return transferInvoice(ctx, user.organizationId, (req.params as { id: string }).id);
  });

  app.delete("/api/bexio", async (req) => {
    const user = requireRole(req, "admin");
    await ctx.db.delete(bexioConnections).where(eq(bexioConnections.organizationId, user.organizationId));
    return { ok: true };
  });
}
