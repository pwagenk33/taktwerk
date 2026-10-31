// Version, health and a public status page: app and database reachable, last backup, uptime.
import { desc, eq, gte, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { HttpError, requireUser, type AppContext } from "../app";
import { incidents, statusDays, type IncidentUpdate } from "../db/schema";
import { currentLocale } from "../i18n";
import { tr } from "@taktwerk/domain";

const started = Date.now();
const DAYS = 90;

const zurichDay = (d: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(d);
/** Midnight Zurich of a day, as a Date (handles summer time). */
function zurichMidnight(day: string) {
  const guess = new Date(`${day}T00:00:00Z`);
  const offset = new Date(guess.toLocaleString("en-US", { timeZone: "Europe/Zurich" })).getTime() - new Date(guess.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  return new Date(guess.getTime() - offset);
}

let pendingBad = 0;
/**
 * Heartbeat for the uptime history, once a minute from the scheduler. While the database is down nothing can be
 * written, so failed minutes are counted in memory and added once it answers again.
 */
export async function recordHeartbeat(ctx: AppContext, now = new Date()) {
  const day = zurichDay(now);
  try {
    await ctx.db.execute(sql`select 1`);
  } catch {
    pendingBad++;
    return false;
  }
  const bad = pendingBad;
  pendingBad = 0;
  await ctx.db.execute(
    sql`insert into status_days (day, ok_minutes, bad_minutes, first_at, last_at) values (${day}, 1, ${bad}, ${now}, ${now})
        on duplicate key update ok_minutes = ok_minutes + 1, bad_minutes = bad_minutes + ${bad}, last_at = ${now}`,
  );
  return true;
}

/** Uptime per day for the last 90 days: answered minutes over the minutes the installation should have answered. */
export async function uptimeHistory(ctx: AppContext, now = new Date()) {
  const today = zurichDay(now);
  const from = zurichDay(new Date(now.getTime() - (DAYS - 1) * 86400_000));
  const rows = await ctx.db.select().from(statusDays).where(gte(statusDays.day, from));
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const [first] = await ctx.db.select({ day: statusDays.day, firstAt: statusDays.firstAt }).from(statusDays).orderBy(statusDays.day).limit(1);
  const days: { day: string; uptime: number | null }[] = [];
  let ok = 0;
  let expected = 0;
  for (let i = DAYS - 1; i >= 0; i--) {
    const day = zurichDay(new Date(now.getTime() - i * 86400_000));
    const r = byDay.get(day);
    if (!first || day < first.day || !r) {
      days.push({ day, uptime: null });
      continue;
    }
    const startMs = day === first.day ? first.firstAt.getTime() : zurichMidnight(day).getTime();
    const endMs = day === today ? now.getTime() : zurichMidnight(day).getTime() + 86400_000;
    const exp = Math.max(1, Math.round((endMs - startMs) / 60_000));
    const got = Math.min(exp, r.okMinutes);
    ok += got;
    expected += exp;
    days.push({ day, uptime: Math.round((got / exp) * 10000) / 100 });
  }
  return { days, percent: expected ? Math.round((ok / expected) * 10000) / 100 : null };
}

type IncidentRow = typeof incidents.$inferSelect;
const isOpen = (i: IncidentRow, now: Date) =>
  i.impact === "maintenance" ? i.status !== "completed" && (!i.endsAt || i.endsAt > now) : i.status !== "resolved";

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Root package.json of the installation: /app in Docker, the repo root in development (server/ is the cwd). */
async function appVersion(): Promise<string> {
  for (const p of [resolve("package.json"), resolve("..", "package.json")]) {
    const pkg = await readJson<{ name?: string; version?: string }>(p);
    if (pkg?.name === "taktwerk" && pkg.version) return pkg.version;
  }
  return "0.0.0";
}

async function changelog(): Promise<string> {
  for (const p of [resolve("CHANGELOG.md"), resolve("..", "CHANGELOG.md")]) {
    try {
      return await readFile(p, "utf8");
    } catch {
      /* next */
    }
  }
  return "# Änderungen\n\nKeine Änderungsliste gefunden.";
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function statusRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const backupFile = process.env.BACKUP_STATUS_FILE ?? "/backups/latest.json";
  // Weekly restore test of deploy/backup.sh, next to latest.json. Its details (row counts) stay off this public page.
  const verifyFile = join(dirname(backupFile), "verify.json");

  const probe = async () => {
    const version = await appVersion();
    let db = false;
    try {
      await ctx.db.execute(sql`select 1`);
      db = true;
    } catch {
      db = false;
    }
    const backup = await readJson<{ finishedAt: string; file: string; bytes: number }>(backupFile);
    const backupAge = backup ? (Date.now() - new Date(backup.finishedAt).getTime()) / 3600_000 : null;
    const verify = await readJson<{ checkedAt: string; ok: boolean }>(verifyFile);
    const verifyAge = verify ? (Date.now() - new Date(verify.checkedAt).getTime()) / 86400_000 : null;
    return {
      ok: db,
      db,
      version,
      uptimeSeconds: Math.round((Date.now() - started) / 1000),
      backup: backup ? { finishedAt: backup.finishedAt, file: backup.file, bytes: backup.bytes, ok: backupAge !== null && backupAge < 36 } : null,
      restoreTest: verify ? { checkedAt: verify.checkedAt, ok: verify.ok && verifyAge !== null && verifyAge < 9 } : null,
    };
  };

  app.get("/api/version", async () => ({ version: await appVersion(), node: process.version }));
  app.get("/api/changelog", async (req) => {
    requireUser(req);
    return { version: await appVersion(), markdown: await changelog() };
  });

  /** Machine-readable status for uptime monitors (503 when the database is down). */
  app.get("/api/status", async (_req, reply) => {
    const s = await probe();
    return reply.status(s.ok ? 200 : 503).send(s);
  });

  const incidentLists = async (now = new Date()) => {
    const since = new Date(now.getTime() - 14 * 86400_000);
    const rows = await ctx.db.select().from(incidents).where(or(gte(incidents.startsAt, since), gte(incidents.endsAt, since), sql`${incidents.status} not in ('resolved', 'completed')`)).orderBy(desc(incidents.startsAt));
    const pub = (i: IncidentRow) => ({ id: i.id, title: i.title, impact: i.impact, status: i.status, startsAt: i.startsAt, endsAt: i.endsAt, updates: i.updates });
    return { active: rows.filter((i) => isOpen(i, now) && (i.impact !== "maintenance" || i.startsAt <= new Date(now.getTime() + 7 * 86400_000))).map(pub), recent: rows.filter((i) => !isOpen(i, now)).map(pub) };
  };

  /** Machine-readable details for the status page and other monitors. */
  app.get("/api/status/history", async () => ({ uptime: await uptimeHistory(ctx), incidents: await incidentLists() }));

  // ---------- operator: disruptions and maintenance ----------

  const requirePlatformAdmin = (req: Parameters<typeof requireUser>[0]) => {
    const u = requireUser(req);
    if (!u.platformAdmin) throw new HttpError(403, tr("Nur der Betreiber der Installation darf Firmen verwalten."));
    return u;
  };
  const STATUSES = ["investigating", "identified", "monitoring", "resolved", "scheduled", "in_progress", "completed"] as const;

  app.get("/api/platform/incidents", async (req) => {
    requirePlatformAdmin(req);
    return ctx.db.select().from(incidents).orderBy(desc(incidents.startsAt)).limit(100);
  });

  app.post("/api/platform/incidents", async (req, reply) => {
    requirePlatformAdmin(req);
    const body = z
      .object({
        title: z.string().trim().min(3).max(200),
        impact: z.enum(["minor", "major", "maintenance"]),
        text: z.string().trim().min(1).max(2000),
        startsAt: z.string().datetime({ offset: true }).optional(),
        endsAt: z.string().datetime({ offset: true }).optional(),
      })
      .parse(req.body);
    const status: IncidentUpdate["status"] = body.impact === "maintenance" ? "scheduled" : "investigating";
    const id = randomUUID();
    const startsAt = body.startsAt ? new Date(body.startsAt) : new Date();
    const endsAt = body.endsAt ? new Date(body.endsAt) : null;
    if (endsAt && endsAt <= startsAt) throw new HttpError(400, tr("Das Ende muss nach dem Beginn liegen."));
    await ctx.db.insert(incidents).values({ id, title: body.title, impact: body.impact, status, startsAt, endsAt, updates: [{ at: new Date().toISOString(), status, text: body.text }] });
    return reply.code(201).send({ id });
  });

  app.post("/api/platform/incidents/:id/updates", async (req) => {
    requirePlatformAdmin(req);
    const body = z.object({ status: z.enum(STATUSES), text: z.string().trim().min(1).max(2000) }).parse(req.body);
    const [i] = await ctx.db.select().from(incidents).where(eq(incidents.id, (req.params as { id: string }).id)).limit(1);
    if (!i) throw new HttpError(404, tr("Meldung nicht gefunden."));
    const maintenance = i.impact === "maintenance";
    if (maintenance !== ["scheduled", "in_progress", "completed"].includes(body.status)) throw new HttpError(400, tr("Dieser Status passt nicht zur Art der Meldung."));
    const closing = body.status === "resolved" || body.status === "completed";
    const now = new Date();
    await ctx.db
      .update(incidents)
      .set({ status: body.status, updates: [...i.updates, { at: now.toISOString(), status: body.status, text: body.text }], ...(closing && (!i.endsAt || i.endsAt > now) ? { endsAt: now } : {}) })
      .where(eq(incidents.id, i.id));
    return { ok: true };
  });

  /** Public, human-readable status page (status.<base domain> shows it too), in the visitor's language. */
  app.get("/status", async (_req, reply) => {
    const now = new Date();
    const [s, up, inc] = await Promise.all([probe(), uptimeHistory(ctx, now), incidentLists(now)]);
    const lang = currentLocale();
    const loc = `${lang}-CH`;
    const fmtL = (d: Date) => new Intl.DateTimeFormat(loc, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Zurich" }).format(d);
    const dayL = (d: string) => new Intl.DateTimeFormat(loc, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));
    const STATUS_TEXT: Record<IncidentUpdate["status"], string> = {
      investigating: tr("Wird untersucht"),
      identified: tr("Ursache gefunden"),
      monitoring: tr("Wird beobachtet"),
      resolved: tr("Behoben"),
      scheduled: tr("Geplant"),
      in_progress: tr("Läuft"),
      completed: tr("Abgeschlossen"),
    };
    const majorOpen = inc.active.some((i) => i.impact === "major");
    const minorOpen = inc.active.some((i) => i.impact === "minor");
    const maintNow = inc.active.some((i) => i.impact === "maintenance" && i.status === "in_progress");
    const state = !s.ok || majorOpen ? "bad" : minorOpen ? "warn" : maintNow ? "maint" : "ok";
    const headline = { bad: tr("Störung"), warn: tr("Teilweise eingeschränkt"), maint: tr("Wartung läuft"), ok: tr("Alle Systeme laufen") }[state];
    const row = (label: string, ok: boolean | null, text: string) =>
      `<li><span class="dot ${ok === null ? "unknown" : ok ? "ok" : "bad"}"></span><strong>${esc(label)}</strong><span>${esc(text)}</span></li>`;
    const bar = up.days
      .map((d) => {
        const cls = d.uptime === null ? "none" : d.uptime >= 99.9 ? "ok" : d.uptime >= 99 ? "warn" : "bad";
        const label = d.uptime === null ? tr("{0}: keine Daten", dayL(d.day)) : tr("{0}: {1} % erreichbar", dayL(d.day), d.uptime);
        return `<i class="${cls}" title="${esc(label)}"><span class="sr">${esc(label)}</span></i>`;
      })
      .join("");
    const incidentHtml = (i: (typeof inc.active)[number]) =>
      `<article class="inc ${i.impact}"><h3>${esc(i.title)}</h3><p class="meta">${esc(i.impact === "maintenance" ? tr("Wartung") : i.impact === "major" ? tr("Störung") : tr("Einschränkung"))} · ${esc(fmtL(new Date(i.startsAt)))}${i.endsAt ? ` – ${esc(fmtL(new Date(i.endsAt)))}` : ""}</p>` +
      [...i.updates].reverse().map((u) => `<p><strong>${esc(STATUS_TEXT[u.status])}</strong> <span class="meta">${esc(fmtL(new Date(u.at)))}</span><br>${esc(u.text)}</p>`).join("") +
      `</article>`;
    const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(tr("Status"))} · TrackInsight</title>
<style>:root{--bg:#f6f6f8;--card:#fff;--line:#e3e3e6;--text:#1d1d1f;--muted:#6e6e73;--ok:#1f9d55;--warn:#e0a100;--bad:#d52b1e;--none:#d6d6db;--maint:#5b5bd6}
@media(prefers-color-scheme:dark){:root{--bg:#111114;--card:#1b1b1f;--line:#2c2c32;--text:#f2f2f4;--muted:#a1a1a8;--none:#3a3a42}}
body{margin:0;font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text)}main{max-width:680px;margin:40px auto;padding:0 16px}
.head{display:flex;align-items:center;gap:12px;padding:18px 20px;border-radius:12px;color:#fff;background:var(--ok)}.head.warn{background:var(--warn)}.head.bad{background:var(--bad)}.head.maint{background:var(--maint)}
.head h1{font-size:1.25rem;margin:0}.head p{margin:0 0 0 auto;opacity:.9;font-size:.85rem}
h2{font-size:1rem;margin:28px 0 10px}ul{list-style:none;padding:0;margin:0;background:var(--card);border:1px solid var(--line);border-radius:12px}
li{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line)}li:last-child{border-bottom:0}li span:last-child{margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums;text-align:right}
.dot{width:10px;height:10px;border-radius:50%;background:var(--none);flex:none}.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}.dot.unknown{background:var(--warn)}
.uptime{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}.bars{display:grid;grid-template-columns:repeat(${DAYS},1fr);gap:2px;height:34px}
.bars i{display:block;border-radius:2px;background:var(--none)}.bars i.ok{background:var(--ok)}.bars i.warn{background:var(--warn)}.bars i.bad{background:var(--bad)}
.scale{display:flex;justify-content:space-between;color:var(--muted);font-size:.8rem;margin-top:8px}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.inc{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--warn);border-radius:12px;padding:14px 16px;margin-bottom:10px}.inc.major{border-left-color:var(--bad)}.inc.maintenance{border-left-color:var(--maint)}
.inc h3{margin:0 0 4px;font-size:1rem}.inc p{margin:8px 0 0}.meta{color:var(--muted);font-size:.85rem}.none-note{color:var(--muted);margin:0}
footer{margin:28px 0;color:var(--muted);font-size:.85rem}@media(max-width:520px){.bars{grid-template-columns:repeat(45,1fr)}.bars i:nth-child(-n+45){display:none}.head{flex-wrap:wrap}.head p{margin:0}}</style></head>
<body><main><div class="head ${state}"><h1>${esc(headline)}</h1><p>${esc(tr("Stand {0} (Zürich)", fmtL(now)))}</p></div>
${inc.active.length ? `<h2>${esc(tr("Aktuell"))}</h2>${inc.active.map(incidentHtml).join("")}` : ""}
<h2>${esc(tr("Komponenten"))}</h2><ul>
${row(tr("Anwendung"), true, tr("Version {0}, läuft seit {1} h {2} min", s.version, Math.floor(s.uptimeSeconds / 3600), Math.floor((s.uptimeSeconds % 3600) / 60)))}
${row(tr("Datenbank"), s.db, s.db ? tr("erreichbar") : tr("nicht erreichbar"))}
${row(tr("Backup"), s.backup ? s.backup.ok : null, s.backup ? tr("zuletzt {0}, {1} MB", fmtL(new Date(s.backup.finishedAt)), (s.backup.bytes / 1048576).toFixed(1)) : tr("noch keine Sicherung gemeldet"))}
${row(tr("Wiederherstellung geprüft"), s.restoreTest ? s.restoreTest.ok : null, s.restoreTest ? `${s.restoreTest.ok ? "" : `${tr("fehlgeschlagen")}, `}${fmtL(new Date(s.restoreTest.checkedAt))}` : tr("noch nicht geprüft"))}
</ul>
<h2>${esc(tr("Erreichbarkeit der letzten {0} Tage", DAYS))}</h2><div class="uptime"><div class="bars">${bar}</div><div class="scale"><span>${esc(tr("vor {0} Tagen", DAYS))}</span><span>${up.percent === null ? esc(tr("noch keine Daten")) : esc(tr("{0} % erreichbar", up.percent))}</span><span>${esc(tr("heute"))}</span></div></div>
<h2>${esc(tr("Meldungen der letzten 14 Tage"))}</h2>${inc.recent.length ? inc.recent.map(incidentHtml).join("") : `<p class="none-note">${esc(tr("Keine Störungen gemeldet."))}</p>`}
<footer>${esc(tr("Daten werden in der Schweiz gespeichert. Diese Seite ist öffentlich und enthält keine Kundendaten."))} · <a href="/api/status/history">JSON</a></footer></main></body></html>`;
    return reply.status(s.ok ? 200 : 503).header("content-type", "text/html; charset=utf-8").header("cache-control", "no-store").send(html);
  });
}
