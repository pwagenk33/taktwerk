import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordHeartbeat } from "../src/routes/status";
import { login, setup } from "./helpers";

const dir = mkdtempSync(join(tmpdir(), "backups-"));
let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  process.env.BACKUP_STATUS_FILE = join(dir, "latest.json");
  t = await setup();
});
afterAll(async () => {
  delete process.env.BACKUP_STATUS_FILE;
  await t.app.close();
  await t.pool.end();
});

describe("status page", () => {
  it("shows the last backup and the weekly restore test without its details", async () => {
    const now = new Date().toISOString();
    writeFileSync(join(dir, "latest.json"), JSON.stringify({ finishedAt: now, file: "trackinsight-x.sql.gz", bytes: 2048 }));
    writeFileSync(join(dir, "verify.json"), JSON.stringify({ checkedAt: now, file: "trackinsight-x.sql.gz", ok: true, detail: "Firmen 2/2", seconds: 4 }));
    const s = (await t.app.inject({ method: "GET", url: "/api/status" })).json();
    expect(s.backup.ok).toBe(true);
    expect(s.restoreTest).toEqual({ checkedAt: now, ok: true });
    const page = (await t.app.inject({ method: "GET", url: "/status" })).payload;
    expect(page).toContain("Wiederherstellung geprüft");
    expect(page).not.toContain("Firmen 2/2");

    const old = new Date(Date.now() - 10 * 86400_000).toISOString();
    writeFileSync(join(dir, "verify.json"), JSON.stringify({ checkedAt: old, file: "x", ok: true, detail: "", seconds: 1 }));
    expect((await t.app.inject({ method: "GET", url: "/api/status" })).json().restoreTest.ok).toBe(false);
  });

  it("keeps a 90-day uptime history and shows disruptions the operator posts", async () => {
    expect(await recordHeartbeat(t, new Date())).toBe(true);
    const hist = (await t.app.inject({ method: "GET", url: "/api/status/history" })).json();
    expect(hist.uptime.days).toHaveLength(90);
    expect(hist.uptime.days.at(-1).uptime).not.toBeNull();
    expect(hist.uptime.days[0].uptime).toBeNull();

    const anna = (await login(t.app, "anna.keller")).cookie;
    const marco = (await login(t.app, "marco.brunner")).cookie;
    const payload = { title: "Anmeldung langsam", impact: "major", text: "Wir untersuchen langsame Anmeldungen." };
    expect((await t.app.inject({ method: "POST", url: "/api/platform/incidents", payload, headers: { cookie: marco } })).statusCode).toBe(403);
    const created = await t.app.inject({ method: "POST", url: "/api/platform/incidents", payload, headers: { cookie: anna } });
    expect(created.statusCode).toBe(201);
    let page = (await t.app.inject({ method: "GET", url: "/status" })).payload;
    expect(page).toContain("Störung");
    expect(page).toContain("Anmeldung langsam");
    expect(page).toContain("Wird untersucht");

    const id = created.json().id as string;
    expect((await t.app.inject({ method: "POST", url: `/api/platform/incidents/${id}/updates`, payload: { status: "completed", text: "x" }, headers: { cookie: anna } })).statusCode).toBe(400);
    await t.app.inject({ method: "POST", url: `/api/platform/incidents/${id}/updates`, payload: { status: "resolved", text: "Datenbank-Index ergänzt." }, headers: { cookie: anna } });
    const after = (await t.app.inject({ method: "GET", url: "/api/status/history" })).json();
    expect(after.incidents.active).toHaveLength(0);
    expect(after.incidents.recent[0].updates).toHaveLength(2);
    page = (await t.app.inject({ method: "GET", url: "/status", headers: { "accept-language": "fr-CH" } })).payload;
    expect(page).toContain('lang="fr"');
    expect(page).toContain("Anmeldung langsam");
  });
});
