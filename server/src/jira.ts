// Jira Cloud through Atlassian OAuth 2.0 (3LO): connect a company's site, list its projects and mirror
// epics, issues and story points into jira_issues, which feed velocity and forecast. When the company
// switches it on, bookings on Jira issues go back to Jira as worklogs.
// Docs: https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
import { createHash, randomUUID } from "node:crypto";
import { and, eq, gte, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { HttpError, type AppContext } from "./app";
import { jiraConnections, jiraIssues, jiraWorklogs, projects, subProjects, timeEntries, users } from "./db/schema";
import { tr } from "@taktwerk/domain";
import { zurichOffset } from "./tz";

export const ATLASSIAN_AUTH = "https://auth.atlassian.com";
export const ATLASSIAN_API = "https://api.atlassian.com";
/**
 * Read access to projects and issues, write access for worklogs (only used when the company switches
 * worklogs on), offline_access for the refresh token of the background sync.
 */
export const JIRA_SCOPES = ["read:jira-work", "write:jira-work", "offline_access"];
export const WRITE_SCOPE = "write:jira-work";
/** Story points live in a custom field whose name differs between company- and team-managed projects. */
const STORY_POINT_NAMES = ["story points", "story point estimate"];
/** Sub-project for issues that belong to no epic. */
export const NO_EPIC = "Ohne Epic";

export type JiraConnection = typeof jiraConnections.$inferSelect;
export const jiraOn = (ctx: AppContext) => !!(ctx.config.ATLASSIAN_CLIENT_ID && ctx.config.ATLASSIAN_CLIENT_SECRET);
export const redirectUri = (ctx: AppContext) => `${ctx.config.APP_URL.replace(/\/$/, "")}/api/jira/callback`;

export function authorizeUrl(ctx: AppContext, state: string) {
  const q = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: ctx.config.ATLASSIAN_CLIENT_ID!,
    scope: JIRA_SCOPES.join(" "),
    redirect_uri: redirectUri(ctx),
    state,
    response_type: "code",
    prompt: "consent",
  });
  return `${ATLASSIAN_AUTH}/authorize?${q}`;
}

interface TokenAnswer { access_token: string; refresh_token?: string; expires_in: number; scope?: string }

async function tokenRequest(ctx: AppContext, body: Record<string, string>): Promise<TokenAnswer> {
  const res = await fetch(`${ATLASSIAN_AUTH}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: ctx.config.ATLASSIAN_CLIENT_ID, client_secret: ctx.config.ATLASSIAN_CLIENT_SECRET, ...body }),
  });
  if (!res.ok) throw new HttpError(502, tr("Atlassian hat die Anmeldung abgelehnt ({0}).", res.status));
  return (await res.json()) as TokenAnswer;
}

export const exchangeCode = (ctx: AppContext, code: string) => tokenRequest(ctx, { grant_type: "authorization_code", code, redirect_uri: redirectUri(ctx) });

/** The Jira sites the token may use. */
export async function accessibleSites(accessToken: string) {
  const res = await fetch(`${ATLASSIAN_API}/oauth/token/accessible-resources`, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
  if (!res.ok) throw new HttpError(502, tr("Atlassian hat keine Jira-Sites geliefert ({0}).", res.status));
  return ((await res.json()) as { id: string; url: string; name: string; scopes: string[] }[]).filter((s) => s.scopes.some((x) => x.includes("jira")));
}

/** A valid access token; refreshes it shortly before it expires (Atlassian rotates the refresh token on every use). */
async function accessToken(ctx: AppContext, conn: JiraConnection, force = false) {
  if (!force && conn.expiresAt.getTime() - 60_000 > Date.now()) return conn.accessToken;
  if (!conn.refreshToken) throw new HttpError(401, tr("Die Verbindung mit Atlassian ist abgelaufen. Bitte neu verbinden."));
  let t: TokenAnswer;
  try {
    t = await tokenRequest(ctx, { grant_type: "refresh_token", refresh_token: conn.refreshToken });
  } catch {
    throw new HttpError(401, tr("Die Verbindung mit Atlassian ist abgelaufen oder wurde in Atlassian entfernt. Bitte neu verbinden."));
  }
  conn.accessToken = t.access_token;
  conn.refreshToken = t.refresh_token ?? conn.refreshToken;
  conn.expiresAt = new Date(Date.now() + t.expires_in * 1000);
  await ctx.db.update(jiraConnections).set({ accessToken: conn.accessToken, refreshToken: conn.refreshToken, expiresAt: conn.expiresAt }).where(eq(jiraConnections.organizationId, conn.organizationId));
  return conn.accessToken;
}

/** Calls the Jira REST API of the connected site; retries once with a fresh token after a 401. With missingOk, a 404 answers null. */
export async function jiraApi<T>(ctx: AppContext, conn: JiraConnection, path: string, init: { method?: string; body?: unknown; missingOk?: boolean } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(ctx, conn, attempt > 0);
    const res = await fetch(`${ATLASSIAN_API}/ex/jira/${conn.cloudId}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    if (res.status === 401 && attempt === 0) continue;
    if (res.status === 404 && init.missingOk) return null as T;
    if (!res.ok) throw new HttpError(502, tr("Jira antwortet mit Fehler {0} auf {1}.", res.status, path.split("?")[0]));
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }
}

/** Ids of the story point fields, found by name. */
export function storyPointFieldIds(fields: { id: string; name: string; custom?: boolean }[]) {
  return fields.filter((f) => STORY_POINT_NAMES.includes(f.name.trim().toLowerCase())).map((f) => f.id);
}

export interface JiraProject { key: string; name: string }

export async function listJiraProjects(ctx: AppContext, conn: JiraConnection): Promise<JiraProject[]> {
  const out: JiraProject[] = [];
  for (let startAt = 0; ; ) {
    const page = await jiraApi<{ values: { key: string; name: string }[]; isLast?: boolean; total?: number }>(ctx, conn, `/rest/api/3/project/search?startAt=${startAt}&maxResults=50&orderBy=name`);
    out.push(...page.values.map((p) => ({ key: p.key, name: p.name })));
    startAt += page.values.length;
    if (page.isLast !== false || page.values.length === 0) return out;
  }
}

interface JiraIssue {
  key: string;
  fields: Record<string, unknown> & {
    summary?: string;
    status?: { statusCategory?: { key?: string } };
    resolutiondate?: string | null;
    statuscategorychangedate?: string | null;
    parent?: { key: string };
    issuetype?: { hierarchyLevel?: number; subtask?: boolean; name?: string };
  };
}

/** All issues of one Jira project (new search endpoint with page tokens). */
async function projectIssues(ctx: AppContext, conn: JiraConnection, key: string) {
  const fields = ["summary", "status", "resolutiondate", "statuscategorychangedate", "parent", "issuetype", ...conn.storyPointFields];
  const out: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  do {
    const page = await jiraApi<{ issues: JiraIssue[]; nextPageToken?: string }>(ctx, conn, "/rest/api/3/search/jql", {
      method: "POST",
      body: { jql: `project = "${key.replace(/"/g, "")}" ORDER BY key`, fields, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) },
    });
    out.push(...page.issues);
    nextPageToken = page.nextPageToken;
  } while (nextPageToken && out.length < 50_000);
  return out;
}

const STATUS: Record<string, "To Do" | "In Progress" | "Done"> = { new: "To Do", indeterminate: "In Progress", done: "Done" };
const isEpic = (i: JiraIssue) => i.fields.issuetype?.hierarchyLevel === 1 || i.fields.issuetype?.name === "Epic";
const isSubtask = (i: JiraIssue) => !!i.fields.issuetype?.subtask || (i.fields.issuetype?.hierarchyLevel ?? 0) < 0;

export function storyPointsOf(issue: JiraIssue, fieldIds: string[]) {
  for (const f of fieldIds) {
    const v = issue.fields[f];
    if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 10) / 10;
  }
  return 0;
}

export interface SyncResult { ok: boolean; message: string; issues?: number; projects?: number }

/**
 * Mirrors every linked project: epics become sub-projects (matched by jiraEpicKey, created when missing),
 * issues land in jira_issues under their epic's sub-project or under «Ohne Epic». Sub-tasks are skipped;
 * their hours count on the parent when bookings use the parent's key.
 */
export async function syncOrganization(ctx: AppContext, orgId: string): Promise<SyncResult> {
  const [conn] = await ctx.db.select().from(jiraConnections).where(eq(jiraConnections.organizationId, orgId)).limit(1);
  if (!conn) return { ok: false, message: tr("Keine Verbindung mit Atlassian.") };
  let result: SyncResult;
  try {
    const linked = await ctx.db.select().from(projects).where(and(eq(projects.organizationId, orgId), isNotNull(projects.jiraProjectKey)));
    let total = 0;
    const failed: string[] = [];
    // One broken link (project renamed or deleted in Jira) must not stop the others.
    for (const p of linked) {
      try {
        total += await syncProject(ctx, conn, p);
      } catch (err) {
        if (err instanceof HttpError && err.statusCode === 401) throw err;
        failed.push(p.jiraProjectKey!);
      }
    }
    const done = tr("{0} Issues aus {1} Projekten abgeglichen.", total, linked.length - failed.length);
    result = !linked.length
      ? { ok: true, message: tr("Noch kein Projekt mit Jira verknüpft."), issues: 0, projects: 0 }
      : failed.length
        ? { ok: false, message: tr("{0} Nicht gefunden oder kein Zugriff in Jira: {1}.", done, failed.join(", ")), issues: total, projects: linked.length - failed.length }
        : { ok: true, message: done, issues: total, projects: linked.length };
  } catch (err) {
    result = { ok: false, message: err instanceof Error ? err.message : tr("Abgleich fehlgeschlagen.") };
  }
  await ctx.db.update(jiraConnections).set({ lastSyncAt: new Date(), lastResult: result }).where(eq(jiraConnections.organizationId, orgId));
  if (result.ok && conn.worklogsSince) await pushWorklogs(ctx, conn);
  return result;
}

async function syncProject(ctx: AppContext, conn: JiraConnection, project: typeof projects.$inferSelect) {
  const orgId = conn.organizationId;
  const issues = await projectIssues(ctx, conn, project.jiraProjectKey!);
  const subs = await ctx.db.select().from(subProjects).where(eq(subProjects.projectId, project.id));
  const byEpic = new Map(subs.filter((s) => s.jiraEpicKey).map((s) => [s.jiraEpicKey!.toUpperCase(), s.id]));
  const ensureSub = async (name: string, epicKey: string | null) => {
    const id = randomUUID();
    await ctx.db.insert(subProjects).values({ id, organizationId: orgId, projectId: project.id, name: name.slice(0, 200), budget: 0, jiraEpicKey: epicKey });
    if (epicKey) byEpic.set(epicKey.toUpperCase(), id);
    return id;
  };

  for (const e of issues.filter(isEpic)) if (!byEpic.has(e.key.toUpperCase())) await ensureSub(e.fields.summary || e.key, e.key);

  let noEpicId = subs.find((s) => !s.jiraEpicKey && s.name === NO_EPIC)?.id;
  const rows: (typeof jiraIssues.$inferInsert)[] = [];
  for (const i of issues) {
    if (isEpic(i) || isSubtask(i)) continue;
    const parent = i.fields.parent?.key?.toUpperCase();
    let subId = parent ? byEpic.get(parent) : undefined;
    if (!subId) subId = noEpicId ??= await ensureSub(NO_EPIC, null);
    const status = STATUS[i.fields.status?.statusCategory?.key ?? "new"] ?? "To Do";
    const done = status === "Done" ? (i.fields.resolutiondate ?? i.fields.statuscategorychangedate ?? null) : null;
    rows.push({ organizationId: orgId, key: i.key, subProjectId: subId, summary: (i.fields.summary || i.key).slice(0, 500), storyPoints: storyPointsOf(i, conn.storyPointFields), status, resolvedAt: done ? done.slice(0, 10) : null });
  }

  const subIds = [...new Set([...subs.map((s) => s.id), ...byEpic.values(), ...(noEpicId ? [noEpicId] : [])])];
  // Issues that were moved away or deleted in Jira disappear here too.
  const keys = rows.map((r) => r.key);
  if (subIds.length)
    await ctx.db
      .delete(jiraIssues)
      .where(and(eq(jiraIssues.organizationId, orgId), inArray(jiraIssues.subProjectId, subIds), ...(keys.length ? [notInArray(jiraIssues.key, keys)] : [])));
  for (let k = 0; k < rows.length; k += 500) {
    const chunk = rows.slice(k, k + 500);
    await ctx.db
      .insert(jiraIssues)
      .values(chunk)
      .onDuplicateKeyUpdate({ set: { subProjectId: sqlValues("sub_project_id"), summary: sqlValues("summary"), storyPoints: sqlValues("story_points"), status: sqlValues("status"), resolvedAt: sqlValues("resolved_at") } });
  }
  return rows.length;
}

/** MariaDB's VALUES(col) in ON DUPLICATE KEY UPDATE: the value the insert would have written. */
const sqlValues = (col: string) => sql.raw(`VALUES(\`${col}\`)`);

/** Background job: companies whose last sync is older than 15 minutes. */
export async function syncAllJira(ctx: AppContext, now = new Date(), log: (msg: string, err?: unknown) => void = console.error) {
  if (!jiraOn(ctx)) return;
  const conns = await ctx.db.select().from(jiraConnections);
  for (const c of conns) {
    if (c.lastSyncAt && now.getTime() - c.lastSyncAt.getTime() < 14 * 60_000) continue;
    const r = await syncOrganization(ctx, c.organizationId);
    if (!r.ok) log(`[jira] ${c.siteName}: ${r.message}`);
  }
}


// ---------------------------------------------------------------------------------------------
// Worklogs: bookings on Jira issues go back to Jira, so the issue shows the time spent.

export const canWrite = (conn: Pick<JiraConnection, "scopes">) => !!conn.scopes?.includes(WRITE_SCOPE);

/** Jira wants the start with a UTC offset; bookings are Swiss local time. */
export function jiraStarted(date: string, time: string | null) {
  const t = time ?? "09:00";
  return `${date}T${t}:00.000${zurichOffset(date, t)}`;
}

const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

/** Writes per run at most this many changes, so a first run over a long history cannot block the job. */
const MAX_CHANGES = 300;

export interface WorklogResult { ok: boolean; message: string; at: string }

/**
 * Brings Jira's worklogs in line with the bookings: new bookings on known issues (from worklogsSince on)
 * create a worklog, changed bookings update it, deleted bookings or a removed issue key delete it.
 * Worklogs appear under the Atlassian account that connected TrackInsight; the text names the person.
 */
export async function pushWorklogs(ctx: AppContext, conn: JiraConnection): Promise<WorklogResult> {
  const orgId = conn.organizationId;
  const at = new Date().toISOString();
  let result: WorklogResult;
  if (!canWrite(conn)) {
    result = { ok: false, message: tr("TrackInsight darf in Jira noch nicht schreiben. Bitte die Verbindung mit Atlassian neu herstellen."), at };
  } else {
    const known = new Set((await ctx.db.select({ key: jiraIssues.key }).from(jiraIssues).where(eq(jiraIssues.organizationId, orgId))).map((r) => r.key.toUpperCase()));
    const entries = await ctx.db
      .select({ id: timeEntries.id, key: timeEntries.jiraIssueKey, date: timeEntries.date, start: timeEntries.startTime, hours: timeEntries.hours, reason: timeEntries.reason, name: users.name })
      .from(timeEntries)
      .innerJoin(users, eq(users.id, timeEntries.userId))
      .where(and(eq(timeEntries.organizationId, orgId), isNotNull(timeEntries.jiraIssueKey), gte(timeEntries.date, conn.worklogsSince!)));
    const wanted = new Map<string, { key: string; body: Record<string, unknown>; hash: string }>();
    for (const e of entries) {
      const key = e.key!.trim().toUpperCase();
      const seconds = Math.round(e.hours * 3600);
      if (!known.has(key) || seconds < 60) continue;
      const body = { started: jiraStarted(e.date, e.start), timeSpentSeconds: seconds, comment: adf(`${e.name}: ${e.reason} (TrackInsight)`) };
      wanted.set(e.id, { key, body, hash: createHash("sha1").update(JSON.stringify([key, body])).digest("hex") });
    }
    const done = new Map((await ctx.db.select().from(jiraWorklogs).where(eq(jiraWorklogs.organizationId, orgId))).map((w) => [w.timeEntryId, w]));

    let created = 0, updated = 0, removed = 0, changes = 0;
    const failed: string[] = [];
    const path = (key: string, id?: string) => `/rest/api/3/issue/${encodeURIComponent(key)}/worklog${id ? `/${encodeURIComponent(id)}` : ""}?adjustEstimate=leave`;
    const remove = async (w: typeof jiraWorklogs.$inferSelect) => {
      await jiraApi(ctx, conn, path(w.issueKey, w.worklogId), { method: "DELETE", missingOk: true });
      await ctx.db.delete(jiraWorklogs).where(eq(jiraWorklogs.timeEntryId, w.timeEntryId));
    };
    const create = async (entryId: string, want: { key: string; body: Record<string, unknown>; hash: string }) => {
      const r = await jiraApi<{ id: string }>(ctx, conn, path(want.key), { method: "POST", body: want.body });
      await ctx.db.insert(jiraWorklogs).values({ timeEntryId: entryId, organizationId: orgId, issueKey: want.key, worklogId: String(r.id), hash: want.hash, syncedAt: new Date() });
    };

    for (const [entryId, w] of done) {
      if (changes >= MAX_CHANGES) break;
      if (wanted.has(entryId)) continue;
      try { await remove(w); removed++; changes++; } catch (err) { if (err instanceof HttpError && err.statusCode === 401) throw err; failed.push(w.issueKey); }
    }
    for (const [entryId, want] of wanted) {
      if (changes >= MAX_CHANGES) break;
      const w = done.get(entryId);
      if (w?.hash === want.hash) continue;
      try {
        if (!w) { await create(entryId, want); created++; }
        else if (w.issueKey !== want.key) { await remove(w); await create(entryId, want); updated++; }
        else {
          const r = await jiraApi<{ id: string } | null>(ctx, conn, path(want.key, w.worklogId), { method: "PUT", body: want.body, missingOk: true });
          // Deleted by hand in Jira: write it again.
          if (!r) { await ctx.db.delete(jiraWorklogs).where(eq(jiraWorklogs.timeEntryId, entryId)); await create(entryId, want); }
          else await ctx.db.update(jiraWorklogs).set({ hash: want.hash, syncedAt: new Date() }).where(eq(jiraWorklogs.timeEntryId, entryId));
          updated++;
        }
        changes++;
      } catch (err) {
        if (err instanceof HttpError && err.statusCode === 401) throw err;
        failed.push(want.key);
      }
    }
    const parts = [tr("{0} neu", created), tr("{0} geändert", updated), tr("{0} entfernt", removed)].join(", ");
    const more = changes >= MAX_CHANGES ? ` ${tr("Der Rest folgt beim nächsten Abgleich.")}` : "";
    result = failed.length
      ? { ok: false, message: tr("Worklogs: {0}. Fehlgeschlagen bei {1}; meist fehlt in Jira die Berechtigung «Work on issues».", parts, [...new Set(failed)].slice(0, 5).join(", ")) + more, at }
      : { ok: true, message: tr("Worklogs: {0}.", parts) + more, at };
  }
  await ctx.db.update(jiraConnections).set({ lastWorklogResult: result }).where(eq(jiraConnections.organizationId, orgId));
  return result;
}
