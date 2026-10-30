// Version, health and a public status page: app and database reachable, last backup, uptime.
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { requireUser } from "../app";
import { tr } from "@taktwerk/domain";

const started = Date.now();

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
const fmt = (d: Date) => new Intl.DateTimeFormat("de-CH", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Zurich" }).format(d);

export async function statusRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const backupFile = process.env.BACKUP_STATUS_FILE ?? "/backups/latest.json";

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
    return { ok: db, db, version, uptimeSeconds: Math.round((Date.now() - started) / 1000), backup: backup ? { finishedAt: backup.finishedAt, file: backup.file, bytes: backup.bytes, ok: backupAge !== null && backupAge < 36 } : null };
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

  /** Public, human-readable status page. */
  app.get("/status", async (_req, reply) => {
    const s = await probe();
    const row = (label: string, ok: boolean | null, text: string) =>
      `<li><span class="dot ${ok === null ? "unknown" : ok ? "ok" : "bad"}"></span><strong>${esc(label)}</strong><span>${esc(text)}</span></li>`;
    const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Status · TrackInsight</title>
<style>body{margin:0;font-family:Inter,system-ui,sans-serif;background:#f6f6f8;color:#1d1d1f}main{max-width:560px;margin:48px auto;padding:0 20px}h1{font-size:1.4rem;margin:0 0 4px}p{color:#6e6e73;margin:0 0 20px}ul{list-style:none;padding:0;margin:0;background:#fff;border:1px solid #e3e3e6;border-radius:12px}li{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid #e3e3e6}li:last-child{border-bottom:0}li span:last-child{margin-left:auto;color:#6e6e73;font-variant-numeric:tabular-nums}.dot{width:10px;height:10px;border-radius:50%;background:#9a9aa0}.dot.ok{background:#1f9d55}.dot.bad{background:#d52b1e}.dot.unknown{background:#e0a100}footer{margin-top:16px;color:#6e6e73;font-size:.85rem}@media(prefers-color-scheme:dark){body{background:#111114;color:#f2f2f4}ul{background:#1b1b1f;border-color:#2c2c32}li{border-color:#2c2c32}}</style></head>
<body><main><h1>${s.ok ? tr("Alle Systeme laufen") : tr("Störung")}</h1><p>Stand ${esc(fmt(new Date()))} (Zürich)</p><ul>
${row(tr("Anwendung"), true, tr("Version {0}, läuft seit {1} h {2} min", s.version, Math.floor(s.uptimeSeconds / 3600), Math.floor((s.uptimeSeconds % 3600) / 60)))}
${row(tr("Datenbank"), s.db, s.db ? "erreichbar" : tr("nicht erreichbar"))}
${row(tr("Backup"), s.backup ? s.backup.ok : null, s.backup ? `zuletzt ${fmt(new Date(s.backup.finishedAt))}, ${(s.backup.bytes / 1048576).toFixed(1)} MB` : tr("noch keine Sicherung gemeldet"))}
</ul><footer>Daten werden in der Schweiz gespeichert. Diese Seite ist öffentlich und enthält keine Kundendaten.</footer></main></body></html>`;
    return reply.status(s.ok ? 200 : 503).header("content-type", "text/html; charset=utf-8").header("cache-control", "no-store").send(html);
  });
}
