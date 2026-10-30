// Settings → Jira: connect the company's Jira Cloud site, link Jira projects to projects and sync on demand.
// The background job (jobs.ts) repeats the sync every 15 minutes.
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, appOrigin, requireRole } from "../app";
import { customers, jiraConnections, jiraWorklogs, organizations, projects } from "../db/schema";
import { accessibleSites, authorizeUrl, canWrite, exchangeCode, jiraApi, jiraOn, listJiraProjects, pushWorklogs, storyPointFieldIds, syncOrganization } from "../jira";
import { requireFeature } from "../saas";
import { tr } from "@taktwerk/domain";

/** OAuth state → who started the connection; the callback comes back on APP_URL, maybe without the session cookie. */
const pending = new Map<string, { orgId: string; userId: string; until: number }>();

export async function jiraRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const back = async (orgId: string, outcome: "ok" | "fehler", reason = "") => {
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    return `${appOrigin(ctx.config, org)}/?jira=${outcome}${reason ? `&grund=${encodeURIComponent(reason)}` : ""}#einstellungen/jira`;
  };
  const connection = async (orgId: string) => (await ctx.db.select().from(jiraConnections).where(eq(jiraConnections.organizationId, orgId)).limit(1))[0];

  app.get("/api/jira", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const conn = await connection(user.organizationId);
    return {
      configured: jiraOn(ctx),
      connected: !!conn,
      ...(conn
        ? {
            site: { name: conn.siteName, url: conn.siteUrl },
            storyPointFields: conn.storyPointFields.length,
            lastSyncAt: conn.lastSyncAt,
            lastResult: conn.lastResult,
            worklogs: { canWrite: canWrite(conn), since: conn.worklogsSince, lastResult: conn.lastWorklogResult },
          }
        : {}),
    };
  });

  /** Starts the Atlassian sign-in; the browser follows this link. */
  app.get("/api/jira/connect", async (req, reply) => {
    const user = requireRole(req, "admin");
    requireFeature(user, "forecast");
    if (!jiraOn(ctx)) throw new HttpError(400, tr("Die Verbindung mit Atlassian ist auf dieser Installation nicht eingerichtet (ATLASSIAN_CLIENT_ID fehlt)."));
    for (const [k, v] of pending) if (v.until < Date.now()) pending.delete(k);
    const state = randomBytes(24).toString("base64url");
    pending.set(state, { orgId: user.organizationId, userId: user.id, until: Date.now() + 15 * 60_000 });
    return reply.redirect(authorizeUrl(ctx, state));
  });

  app.get("/api/jira/callback", async (req, reply) => {
    const q = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(req.query);
    const p = q.state ? pending.get(q.state) : undefined;
    if (!p || p.until < Date.now()) throw new HttpError(400, tr("Die Anmeldung bei Atlassian ist abgelaufen. Bitte in TrackInsight nochmals auf «Mit Atlassian verbinden» klicken."));
    pending.delete(q.state!);
    if (q.error || !q.code) return reply.redirect(await back(p.orgId, "fehler", q.error === "access_denied" ? "abgebrochen" : "atlassian"));
    try {
      const t = await exchangeCode(ctx, q.code);
      const sites = await accessibleSites(t.access_token);
      if (!sites.length) return reply.redirect(await back(p.orgId, "fehler", "keine-site"));
      const site = sites[0]!;
      // A reconnect (for example to grant the write scope) keeps the worklog setting.
      const before = await connection(p.orgId);
      const conn = {
        organizationId: p.orgId,
        cloudId: site.id,
        siteUrl: site.url,
        siteName: site.name,
        accessToken: t.access_token,
        refreshToken: t.refresh_token ?? null,
        expiresAt: new Date(Date.now() + t.expires_in * 1000),
        storyPointFields: [] as string[],
        connectedBy: p.userId,
        lastSyncAt: null,
        lastResult: null,
        scopes: t.scope ? t.scope.split(" ") : [],
        worklogsSince: before?.cloudId === site.id ? before.worklogsSince : null,
        lastWorklogResult: null,
        createdAt: new Date(),
      };
      conn.storyPointFields = storyPointFieldIds(await jiraApi<{ id: string; name: string }[]>(ctx, conn, "/rest/api/3/field"));
      // Worklog ids only mean something on the site they were written to.
      if (before && before.cloudId !== site.id) await ctx.db.delete(jiraWorklogs).where(eq(jiraWorklogs.organizationId, p.orgId));
      await ctx.db.delete(jiraConnections).where(eq(jiraConnections.organizationId, p.orgId));
      await ctx.db.insert(jiraConnections).values(conn);
      await syncOrganization(ctx, p.orgId);
      return reply.redirect(await back(p.orgId, "ok"));
    } catch (err) {
      req.log.error(err);
      return reply.redirect(await back(p.orgId, "fehler", "atlassian"));
    }
  });

  /** Jira projects of the site with the project each one is linked to. */
  app.get("/api/jira/projects", async (req) => {
    const user = requireRole(req, "admin");
    const conn = await connection(user.organizationId);
    if (!conn) throw new HttpError(404, tr("Keine Verbindung mit Atlassian."));
    const list = await listJiraProjects(ctx, conn);
    const linked = await ctx.db.select({ id: projects.id, name: projects.name, key: projects.jiraProjectKey }).from(projects).where(eq(projects.organizationId, user.organizationId));
    return list.map((j) => ({ ...j, project: linked.find((l) => l.key?.toUpperCase() === j.key.toUpperCase()) ?? null }));
  });

  /** Links a Jira project to an existing project, or creates a new project for a customer, then syncs. */
  app.post("/api/jira/link", async (req) => {
    const user = requireRole(req, "admin");
    requireFeature(user, "forecast");
    const body = z
      .object({ jiraKey: z.string().trim().min(1).max(20), name: z.string().trim().max(200).optional(), projectId: z.string().optional(), customerId: z.string().optional() })
      .refine((b) => !!b.projectId !== !!b.customerId, tr("Entweder ein bestehendes Projekt oder einen Kunden angeben."))
      .parse(req.body);
    if (!(await connection(user.organizationId))) throw new HttpError(404, tr("Keine Verbindung mit Atlassian."));
    const key = body.jiraKey.toUpperCase();
    let projectId = body.projectId;
    if (projectId) {
      const [p] = await ctx.db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.organizationId, user.organizationId))).limit(1);
      if (!p) throw new HttpError(404, tr("Projekt nicht gefunden."));
    } else {
      const [c] = await ctx.db.select().from(customers).where(and(eq(customers.id, body.customerId!), eq(customers.organizationId, user.organizationId))).limit(1);
      if (!c) throw new HttpError(404, tr("Kunde nicht gefunden."));
      projectId = randomUUID();
      await ctx.db.insert(projects).values({ id: projectId, organizationId: user.organizationId, customerId: c.id, name: body.name || key, budget: 0 });
    }
    // One Jira project feeds one project.
    await ctx.db.update(projects).set({ jiraProjectKey: null }).where(and(eq(projects.organizationId, user.organizationId), eq(projects.jiraProjectKey, key), ne(projects.id, projectId)));
    await ctx.db.update(projects).set({ jiraProjectKey: key }).where(eq(projects.id, projectId));
    return { projectId, result: await syncOrganization(ctx, user.organizationId) };
  });

  app.post("/api/jira/unlink", async (req) => {
    const user = requireRole(req, "admin");
    const { projectId } = z.object({ projectId: z.string() }).parse(req.body);
    await ctx.db.update(projects).set({ jiraProjectKey: null }).where(and(eq(projects.id, projectId), eq(projects.organizationId, user.organizationId)));
    return { ok: true };
  });

  app.post("/api/jira/sync", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    if (!(await connection(user.organizationId))) throw new HttpError(404, tr("Keine Verbindung mit Atlassian."));
    return syncOrganization(ctx, user.organizationId);
  });

  /** Switches worklogs on (bookings from `since` on) or off. Worklogs already in Jira stay when switched off. */
  app.put("/api/jira/worklogs", async (req) => {
    const user = requireRole(req, "admin");
    requireFeature(user, "forecast");
    const body = z.object({ since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }).parse(req.body);
    const conn = await connection(user.organizationId);
    if (!conn) throw new HttpError(404, tr("Keine Verbindung mit Atlassian."));
    if (body.since && !canWrite(conn)) throw new HttpError(409, tr("TrackInsight darf in Jira noch nicht schreiben. Bitte die Verbindung mit Atlassian neu herstellen."));
    await ctx.db.update(jiraConnections).set({ worklogsSince: body.since }).where(eq(jiraConnections.organizationId, user.organizationId));
    if (!body.since) return { ok: true, message: tr("Worklogs ausgeschaltet") };
    conn.worklogsSince = body.since;
    return pushWorklogs(ctx, conn);
  });

  /** Disconnects; already loaded issues and links stay so velocity and forecast keep working. */
  app.delete("/api/jira", async (req) => {
    const user = requireRole(req, "admin");
    await ctx.db.delete(jiraConnections).where(eq(jiraConnections.organizationId, user.organizationId));
    return { ok: true };
  });
}
