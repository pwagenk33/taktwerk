import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { customers, jiraConnections, jiraIssues, jiraWorklogs, projects, subProjects, timeEntries, users } from "../src/db/schema";
import { jiraStarted } from "../src/jira";
import { runJobs } from "../src/jobs";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let admin = "";
const calls: { url: string; body?: Record<string, unknown> }[] = [];
/** The issues Jira currently has in project SHOP. */
let shop: unknown[] = [];
/** Worklogs on the fake Jira site by id. */
const worklogs = new Map<string, { issue: string; body: Record<string, unknown> }>();

const issue = (key: string, type: { name: string; hierarchyLevel: number; subtask?: boolean }, fields: Record<string, unknown> = {}) => ({
  key,
  fields: { summary: `Titel ${key}`, issuetype: type, status: { statusCategory: { key: "new" } }, ...fields },
});
const EPIC = { name: "Epic", hierarchyLevel: 1 };
const STORY = { name: "Story", hierarchyLevel: 0 };
const SUBTASK = { name: "Sub-task", hierarchyLevel: -1, subtask: true };

beforeAll(async () => {
  t = await setup({ ATLASSIAN_CLIENT_ID: "client-1", ATLASSIAN_CLIENT_SECRET: "secret-1" });
  admin = (await login(t.app, "anna.keller")).cookie;
  shop = [
    issue("SHOP-1", EPIC, { summary: "Checkout" }),
    issue("SHOP-2", STORY, { parent: { key: "SHOP-1" }, customfield_10016: 5, status: { statusCategory: { key: "done" } }, resolutiondate: "2026-10-12T10:00:00.000+0200" }),
    issue("SHOP-3", STORY, { customfield_10016: 3, status: { statusCategory: { key: "indeterminate" } } }),
    issue("SHOP-4", SUBTASK, { parent: { key: "SHOP-2" }, customfield_10016: 1 }),
  ];
  vi.stubGlobal("fetch", async (url: string, init: { body?: string } = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url === "https://auth.atlassian.com/oauth/token") {
      if (body.grant_type === "authorization_code") return body.code === "gut" ? json({ access_token: "at1", refresh_token: "rt1", expires_in: 3600, scope: "read:jira-work write:jira-work offline_access" }) : json({ error: "invalid_grant" }, 403);
      return body.refresh_token === "rt1" ? json({ access_token: "at2", refresh_token: "rt2", expires_in: 3600 }) : json({ error: "invalid_grant" }, 403);
    }
    if (url.endsWith("/oauth/token/accessible-resources")) return json([{ id: "cloud-1", url: "https://beispiel.atlassian.net", name: "beispiel", scopes: ["read:jira-work", "read:jira-user"] }]);
    if (url.endsWith("/rest/api/3/field")) return json([{ id: "summary", name: "Summary" }, { id: "customfield_10016", name: "Story point estimate", custom: true }]);
    if (url.includes("/rest/api/3/project/search")) return json({ values: [{ key: "SHOP", name: "Webshop" }, { key: "APP", name: "App" }], isLast: true });
    const wl = url.match(/\/rest\/api\/3\/issue\/([^/]+)\/worklog(?:\/([^?]+))?\?adjustEstimate=leave$/);
    if (wl) {
      const method = (init as { method?: string }).method;
      const [, issue, id] = wl;
      if (issue === "SHOP-9") return json({ errorMessages: ["Keine Berechtigung"] }, 403);
      if (method === "POST") { const nid = String(10000 + worklogs.size + calls.length); worklogs.set(nid, { issue: issue!, body }); return json({ id: nid }, 201); }
      if (!worklogs.has(id!) || worklogs.get(id!)!.issue !== issue) return json({ errorMessages: ["nicht gefunden"] }, 404);
      if (method === "PUT") { worklogs.set(id!, { issue: issue!, body }); return json({ id }); }
      if (method === "DELETE") { worklogs.delete(id!); return new Response(null, { status: 204 }); }
    }
    if (url.endsWith("/rest/api/3/search/jql")) {
      if (body.jql.includes('"PHX"')) return json({ errorMessages: ["Das Projekt 'PHX' existiert nicht."] }, 400);
      if (!body.jql.includes('"SHOP"')) return json({ issues: [] });
      // Two pages to exercise nextPageToken.
      return body.nextPageToken ? json({ issues: shop.slice(2) }) : json({ issues: shop.slice(0, 2), nextPageToken: shop.length > 2 ? "p2" : undefined });
    }
    return json({ error: `unexpected ${url}` }, 500);
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await t.app.close();
  await t.pool.end();
});

const req = (method: "GET" | "POST" | "DELETE", url: string, cookie = admin, payload?: object) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function connect(code = "gut") {
  const start = await req("GET", "/api/jira/connect");
  expect(start.statusCode).toBe(302);
  const to = new URL(start.headers.location as string);
  expect(to.origin).toBe("https://auth.atlassian.com");
  expect(to.searchParams.get("redirect_uri")).toBe("https://zeit.example.ch/api/jira/callback");
  expect(to.searchParams.get("scope")).toContain("offline_access");
  return t.app.inject({ method: "GET", url: `/api/jira/callback?code=${code}&state=${to.searchParams.get("state")}` });
}

describe("Jira Cloud", () => {
  it("is offered but not connected yet", async () => {
    expect((await req("GET", "/api/jira")).json()).toMatchObject({ configured: true, connected: false });
    expect((await req("GET", "/api/jira/connect", (await login(t.app, "lea.meier")).cookie)).statusCode).toBe(403);
  });

  it("connects through Atlassian and finds the story point field", async () => {
    const back = await connect();
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe("https://zeit.example.ch/?jira=ok#einstellungen/jira");
    const status = (await req("GET", "/api/jira")).json();
    expect(status).toMatchObject({ connected: true, site: { name: "beispiel", url: "https://beispiel.atlassian.net" }, storyPointFields: 1 });
  });

  it("rejects an unknown or reused state", async () => {
    expect((await t.app.inject({ method: "GET", url: "/api/jira/callback?code=gut&state=erfunden" })).statusCode).toBe(400);
  });

  it("lists the Jira projects and creates a linked project with epics and issues", async () => {
    const list = (await req("GET", "/api/jira/projects")).json();
    expect(list.map((p: { key: string }) => p.key)).toEqual(["SHOP", "APP"]);
    expect(list[0].project).toBeNull();

    const [org] = await t.db.select({ id: customers.organizationId }).from(customers).limit(1);
    const [c] = await t.db.select().from(customers).where(eq(customers.organizationId, org!.id)).limit(1);
    const res = await req("POST", "/api/jira/link", admin, { jiraKey: "shop", customerId: c!.id, name: "Webshop" });
    expect(res.statusCode).toBe(200);
    const { projectId, result } = res.json();
    expect(result).toMatchObject({ ok: true, issues: 2 });

    const [p] = await t.db.select().from(projects).where(eq(projects.id, projectId));
    expect(p).toMatchObject({ name: "Webshop", jiraProjectKey: "SHOP" });
    const subs = await t.db.select().from(subProjects).where(eq(subProjects.projectId, projectId));
    expect(subs.map((s) => [s.name, s.jiraEpicKey]).sort()).toEqual([["Checkout", "SHOP-1"], ["Ohne Epic", null]]);
    const checkout = subs.find((s) => s.jiraEpicKey === "SHOP-1")!;
    const rows = await t.db.select().from(jiraIssues).where(and(eq(jiraIssues.organizationId, org!.id), eq(jiraIssues.subProjectId, checkout.id)));
    expect(rows).toEqual([expect.objectContaining({ key: "SHOP-2", storyPoints: 5, status: "Done", resolvedAt: "2026-10-12" })]);
    const [three] = await t.db.select().from(jiraIssues).where(eq(jiraIssues.key, "SHOP-3"));
    expect(three).toMatchObject({ storyPoints: 3, status: "In Progress", resolvedAt: null });
    expect(await t.db.select().from(jiraIssues).where(eq(jiraIssues.key, "SHOP-4"))).toEqual([]);

    // The link shows up in the list.
    expect((await req("GET", "/api/jira/projects")).json()[0].project).toMatchObject({ id: projectId });
  });

  it("removes issues that were deleted in Jira and refreshes an expired token", async () => {
    shop = shop.filter((i) => (i as { key: string }).key !== "SHOP-3");
    await t.db.update(jiraConnections).set({ expiresAt: new Date(Date.now() - 1000), lastSyncAt: null });
    await runJobs(t, new Date(), () => {});
    expect(await t.db.select().from(jiraIssues).where(eq(jiraIssues.key, "SHOP-3"))).toEqual([]);
    expect(calls.some((c) => c.body?.grant_type === "refresh_token" && c.body.refresh_token === "rt1")).toBe(true);
    const [conn] = await t.db.select().from(jiraConnections);
    expect(conn).toMatchObject({ accessToken: "at2", refreshToken: "rt2" });
    expect(conn!.lastResult).toMatchObject({ ok: true, issues: 1 });
  });

  it("writes bookings on Jira issues back as worklogs and keeps them in step", async () => {
    const [anna] = await t.db.select().from(users).where(eq(users.username, "anna.keller"));
    const [model] = await t.db.select().from(timeEntries).where(eq(timeEntries.userId, anna!.id)).limit(1);
    const entry = (over: Partial<typeof timeEntries.$inferInsert>) => ({ ...model!, id: randomUUID(), createdAt: new Date(), importBatchId: null, ...over });
    const a = entry({ date: "2026-10-20", hours: 1.5, startTime: "13:30", reason: "Checkout-Fehler", jiraIssueKey: "shop-2" });
    const old = entry({ date: "2026-09-01", hours: 2, jiraIssueKey: "SHOP-2" });
    const unknown = entry({ date: "2026-10-21", hours: 1, jiraIssueKey: "NOPE-1" });
    await t.db.insert(timeEntries).values([a, old, unknown]);

    expect((await req("GET", "/api/jira")).json().worklogs).toMatchObject({ canWrite: true, since: null });
    const on = (await t.app.inject({ method: "PUT", url: "/api/jira/worklogs", headers: { cookie: admin }, payload: { since: "2026-10-01" } })).json();
    expect(on).toMatchObject({ ok: true });
    // Only the booking from October on a known issue: not the September one, not the unknown key.
    expect([...worklogs.values()]).toEqual([{ issue: "SHOP-2", body: { started: "2026-10-20T13:30:00.000+0200", timeSpentSeconds: 5400, comment: expect.objectContaining({ type: "doc" }) } }]);
    expect(JSON.stringify([...worklogs.values()][0]!.body.comment)).toContain("Anna Keller: Checkout-Fehler (TrackInsight)");

    // Unchanged: nothing is sent again.
    const before = calls.length;
    await req("POST", "/api/jira/sync");
    expect(calls.slice(before).some((c) => c.url.includes("/worklog"))).toBe(false);

    // Changed hours update the same worklog; a deleted booking removes it.
    await t.db.update(timeEntries).set({ hours: 2 }).where(eq(timeEntries.id, a.id));
    await req("POST", "/api/jira/sync");
    expect([...worklogs.values()][0]!.body.timeSpentSeconds).toBe(7200);
    expect(worklogs.size).toBe(1);
    await t.db.delete(timeEntries).where(eq(timeEntries.id, a.id));
    await req("POST", "/api/jira/sync");
    expect(worklogs.size).toBe(0);
    expect(await t.db.select().from(jiraWorklogs)).toEqual([]);

    // A worklog Jira refuses is reported, the others still go through.
    shop.push(issue("SHOP-9", STORY, { summary: "Gesperrt" }));
    await t.db.insert(timeEntries).values([entry({ date: "2026-10-22", jiraIssueKey: "SHOP-9" }), entry({ date: "2026-10-23", hours: 1, jiraIssueKey: "SHOP-2" })]);
    await req("POST", "/api/jira/sync");
    const status = (await req("GET", "/api/jira")).json().worklogs;
    expect(status.lastResult).toMatchObject({ ok: false });
    expect(status.lastResult.message).toContain("SHOP-9");
    expect(worklogs.size).toBe(1);

    // Connections from before worklogs existed may only read.
    await t.db.update(jiraConnections).set({ scopes: null });
    expect((await t.app.inject({ method: "PUT", url: "/api/jira/worklogs", headers: { cookie: admin }, payload: { since: "2026-10-01" } })).statusCode).toBe(409);
    expect((await t.app.inject({ method: "PUT", url: "/api/jira/worklogs", headers: { cookie: admin }, payload: { since: null } })).statusCode).toBe(200);
    shop.pop();
  });

  it("gives Jira the Swiss offset in summer and winter", () => {
    expect(jiraStarted("2026-07-01", "08:15")).toBe("2026-07-01T08:15:00.000+0200");
    expect(jiraStarted("2026-12-01", null)).toBe("2026-12-01T09:00:00.000+0100");
  });

  it("keeps syncing the other projects when one Jira project is gone", async () => {
    const [kpr] = await t.db.select().from(projects).where(eq(projects.jiraProjectKey, "KPR"));
    await t.db.update(projects).set({ jiraProjectKey: "PHX" }).where(eq(projects.id, kpr!.id));
    const r = (await req("POST", "/api/jira/sync")).json();
    expect(r).toMatchObject({ ok: false, issues: 1 });
    expect(r.message).toContain("PHX");
  });

  it("reports a failed sign-in back to the settings page and disconnects on request", async () => {
    expect((await connect("schlecht")).headers.location).toBe("https://zeit.example.ch/?jira=fehler&grund=atlassian#einstellungen/jira");
    expect((await req("DELETE", "/api/jira")).statusCode).toBe(200);
    expect((await req("GET", "/api/jira")).json()).toMatchObject({ connected: false });
    // Loaded issues stay for velocity and forecast.
    expect((await t.db.select().from(jiraIssues).where(eq(jiraIssues.key, "SHOP-2"))).length).toBe(1);
  });
});
