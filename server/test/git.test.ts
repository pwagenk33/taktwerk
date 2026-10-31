import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let lea = "";
const seen: string[] = [];

beforeAll(async () => {
  t = await setup();
  lea = (await login(t.app, "lea.meier")).cookie;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    seen.push(url);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url === "https://api.github.com/user") return headers.authorization === "Bearer ghp_valid_token_123" ? json({ login: "lea-dev" }) : json({ message: "Bad credentials" }, 401);
    if (url.startsWith("https://api.github.com/search/commits"))
      return json({
        items: [
          { sha: "a1", commit: { message: "SHOP-7 Checkout", author: { date: "2026-10-20T07:00:00Z" }, committer: null }, repository: { full_name: "beispiel/shop" } },
          { sha: "a1", commit: { message: "SHOP-7 Checkout", author: { date: "2026-10-20T07:00:00Z" }, committer: null }, repository: { full_name: "beispiel/shop" } },
        ],
      });
    if (url === "https://gitlab.com/api/v4/user") return json({ username: "lea.gl" });
    if (url.startsWith("https://gitlab.com/api/v4/events"))
      return json([
        { created_at: "2026-10-21T13:00:00Z", project_id: 5, push_data: { commit_count: 2, commit_title: "Fix", commit_to: "b2" } },
        { created_at: "2026-10-21T13:05:00Z", project_id: 5, push_data: { commit_count: 0, commit_title: null, commit_to: null } },
      ]);
    if (url === "https://gitlab.com/api/v4/projects/5") return json({ path_with_namespace: "team/app" });
    return json({}, 404);
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await t.app.close();
  await t.pool.end();
});

const req = (method: "GET" | "PUT" | "DELETE", url: string, payload?: object) => t.app.inject({ method, url, payload, headers: { cookie: lea } });

describe("GitHub and GitLab commits as booking suggestions", () => {
  it("connects with a token, returns the person's commits and never hands the token back", async () => {
    expect((await req("PUT", "/api/git", { provider: "github", token: "ghp_wrong_token_000" })).statusCode).toBe(400);
    const ok = await req("PUT", "/api/git", { provider: "github", token: "ghp_valid_token_123" });
    expect(ok.json()).toEqual({ connected: { provider: "github", account: "lea-dev", baseUrl: "https://api.github.com" } });
    expect(JSON.stringify((await req("GET", "/api/git")).json())).not.toContain("ghp_valid");

    const commits = (await req("GET", "/api/git/commits?from=2026-10-20&to=2026-10-24")).json();
    expect(commits).toEqual([{ sha: "a1", repo: "beispiel/shop", message: "SHOP-7 Checkout", at: "2026-10-20T07:00:00Z" }]);
    expect(decodeURIComponent(seen.find((u) => u.includes("search/commits"))!)).toContain("author:lea-dev author-date:2026-10-19..2026-10-25");

    await req("PUT", "/api/git", { provider: "gitlab", token: "glpat-valid-token" });
    expect((await req("GET", "/api/git/commits?from=2026-10-20&to=2026-10-24")).json()).toEqual([{ sha: "b2", repo: "team/app", message: "Fix", at: "2026-10-21T13:00:00Z" }]);

    // Own GitLab must be public https; internal addresses are refused before any request.
    expect((await req("PUT", "/api/git", { provider: "gitlab", token: "glpat-valid-token", baseUrl: "https://127.0.0.1" })).statusCode).toBe(400);
    expect((await req("PUT", "/api/git", { provider: "gitlab", token: "glpat-valid-token", baseUrl: "http://gitlab.firma.ch" })).statusCode).toBe(400);

    await req("DELETE", "/api/git");
    expect((await req("GET", "/api/git")).json()).toEqual({ connected: null });
    expect((await req("GET", "/api/git/commits?from=2026-10-20&to=2026-10-24")).statusCode).toBe(404);
  });
});
