// GitHub and GitLab commits as booking suggestions. Each person connects their own account with a read-only
// personal access token; commits of the visible days are fetched live and never stored.
import { tr, type GitCommit } from "@taktwerk/domain";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { HttpError, requireUser, type AppContext } from "../app";
import { gitConnections } from "../db/schema";

type Conn = typeof gitConnections.$inferSelect;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Private, loopback and link-local addresses: a self-hosted GitLab must be reachable on the internet. */
function privateAddress(ip: string) {
  if (ip.includes(":")) return ip === "::1" || /^(fc|fd|fe80)/i.test(ip) || ip.startsWith("::ffff:127.") || ip.startsWith("::ffff:10.") || ip.startsWith("::ffff:192.168.");
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
async function assertPublicHttps(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, tr("Die GitLab-Adresse ist ungültig."));
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new HttpError(400, tr("Die GitLab-Adresse muss mit https:// beginnen."));
  if (isIP(url.hostname) || url.hostname === "localhost" || url.hostname.endsWith(".local") || url.hostname.endsWith(".internal")) throw new HttpError(400, tr("Die GitLab-Adresse muss öffentlich erreichbar sein."));
  const addrs = await lookup(url.hostname, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw new HttpError(400, tr("Die GitLab-Adresse muss öffentlich erreichbar sein."));
  return url.origin;
}

async function call<T>(conn: Pick<Conn, "provider" | "baseUrl" | "token">, path: string): Promise<T> {
  const headers: Record<string, string> =
    conn.provider === "github"
      ? { authorization: `Bearer ${conn.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "TrackInsight" }
      : { "private-token": conn.token, accept: "application/json" };
  const res = await fetch(`${conn.baseUrl}${path}`, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 || res.status === 403) throw new HttpError(400, tr("Das Token wurde abgelehnt. Bitte ein gültiges Token mit Leserechten eintragen."));
  if (!res.ok) throw new HttpError(502, tr("{0} antwortet nicht wie erwartet ({1}).", conn.provider === "github" ? "GitHub" : "GitLab", res.status));
  return (await res.json()) as T;
}

/** The person's commits from `from` to `to` (inclusive, Zurich days; one day of margin on each side). */
export async function gitCommits(conn: Conn, from: string, to: string): Promise<GitCommit[]> {
  const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
  if (conn.provider === "github") {
    type Item = { sha: string; commit: { message: string; author: { date: string } | null; committer: { date: string } | null }; repository: { full_name: string } };
    const out: GitCommit[] = [];
    for (let page = 1; page <= 3; page++) {
      const q = encodeURIComponent(`author:${conn.account} author-date:${shift(from, -1)}..${shift(to, 1)}`);
      const r = await call<{ items: Item[] }>(conn, `/search/commits?q=${q}&sort=author-date&order=asc&per_page=100&page=${page}`);
      for (const i of r.items) out.push({ sha: i.sha, repo: i.repository.full_name, message: i.commit.message, at: i.commit.author?.date ?? i.commit.committer?.date ?? "" });
      if (r.items.length < 100) break;
    }
    return dedupe(out);
  }
  type Push = { created_at: string; project_id: number; push_data: { commit_count: number; commit_title: string | null; commit_to: string | null } | null };
  const pushes: Push[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await call<Push[]>(conn, `/api/v4/events?action=pushed&after=${shift(from, -2)}&before=${shift(to, 2)}&per_page=100&page=${page}`);
    pushes.push(...r);
    if (r.length < 100) break;
  }
  const names = new Map<number, string>();
  for (const id of new Set(pushes.map((p) => p.project_id))) {
    try {
      names.set(id, (await call<{ path_with_namespace: string }>(conn, `/api/v4/projects/${id}`)).path_with_namespace);
    } catch {
      names.set(id, `project-${id}`);
    }
  }
  return dedupe(
    pushes
      .filter((p) => p.push_data?.commit_count && p.push_data.commit_to)
      .map((p) => ({ sha: p.push_data!.commit_to!, repo: names.get(p.project_id)!, message: p.push_data!.commit_title ?? "", at: p.created_at })),
  );
}
const dedupe = (list: GitCommit[]) => [...new Map(list.filter((c) => c.at).map((c) => [c.sha, c])).values()];

export async function gitRoutes(app: FastifyInstance) {
  const ctx: AppContext = app.ctx;
  const connection = async (userId: string) => (await ctx.db.select().from(gitConnections).where(eq(gitConnections.userId, userId)).limit(1))[0] ?? null;

  app.get("/api/git", async (req) => {
    const user = requireUser(req);
    const c = await connection(user.id);
    return { connected: c ? { provider: c.provider, account: c.account, baseUrl: c.baseUrl } : null };
  });

  app.put("/api/git", async (req) => {
    const user = requireUser(req);
    const body = z.object({ provider: z.enum(["github", "gitlab"]), token: z.string().trim().min(10).max(255), baseUrl: z.string().trim().max(255).optional() }).parse(req.body);
    const baseUrl = body.provider === "github" ? "https://api.github.com" : body.baseUrl && body.baseUrl !== "https://gitlab.com" ? await assertPublicHttps(body.baseUrl) : "https://gitlab.com";
    const probe = { provider: body.provider, baseUrl, token: body.token };
    const me = body.provider === "github" ? await call<{ login: string }>(probe, "/user") : await call<{ username: string }>(probe, "/api/v4/user");
    const account = "login" in me ? me.login : me.username;
    if (!account) throw new HttpError(400, tr("Das Token wurde abgelehnt. Bitte ein gültiges Token mit Leserechten eintragen."));
    await ctx.db.delete(gitConnections).where(eq(gitConnections.userId, user.id));
    await ctx.db.insert(gitConnections).values({ userId: user.id, organizationId: user.organizationId, provider: body.provider, baseUrl, account, token: body.token });
    return { connected: { provider: body.provider, account, baseUrl } };
  });

  app.delete("/api/git", async (req) => {
    const user = requireUser(req);
    await ctx.db.delete(gitConnections).where(eq(gitConnections.userId, user.id));
    return { ok: true };
  });

  app.get("/api/git/commits", async (req) => {
    const user = requireUser(req);
    const q = z.object({ from: day, to: day }).refine((v) => v.from <= v.to && Date.parse(v.to) - Date.parse(v.from) <= 42 * 86400_000, tr("Zeitraum zu lang.")).parse(req.query);
    const conn = await connection(user.id);
    if (!conn) throw new HttpError(404, tr("Kein Git-Konto verbunden."));
    return gitCommits(conn, q.from, q.to);
  });
}
