import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers";

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
});
