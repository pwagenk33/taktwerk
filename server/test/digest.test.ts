import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendScheduledReports } from "../src/jobs";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let admin = "";
let employee = "";

beforeAll(async () => {
  t = await setup();
  admin = (await login(t.app, "anna.keller")).cookie;
  employee = (await login(t.app, "lea.meier")).cookie;
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

describe("scheduled reports and exports", () => {
  it("stores scheduled reports, sends them once per period and on demand", async () => {
    const reports = [
      { id: "w1", name: "Wochenmail PL", kind: "weekly", dayOfWeek: 1, hour: 7, recipients: ["pl@beispiel.ch"], enabled: true },
      { id: "m1", name: "Monatsmail GL", kind: "monthly", dayOfMonth: 2, hour: 8, recipients: ["gl@beispiel.ch", "cfo@beispiel.ch"], enabled: true },
    ];
    const saved = await t.app.inject({ method: "PUT", url: "/api/settings", headers: { cookie: admin }, payload: { scheduledReports: reports } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().scheduledReports).toHaveLength(2);

    t.mailer.outbox.length = 0;
    // Monday 2026-11-02 06:30 Zurich: too early for both.
    expect(await sendScheduledReports(t.app.ctx, new Date("2026-11-02T05:30:00Z"))).toEqual([]);
    // Monday 07:30: weekly goes out; monthly is due on the 2nd from 08:00.
    const first = await sendScheduledReports(t.app.ctx, new Date("2026-11-02T06:30:00Z"));
    expect(first.map((s) => s.id)).toEqual(["w1"]);
    expect(t.mailer.outbox[0]?.subject).toContain("Wochenbericht KW 44");
    expect(t.mailer.outbox[0]?.text).toContain("Stunden gebucht");
    const second = await sendScheduledReports(t.app.ctx, new Date("2026-11-02T08:30:00Z"));
    expect(second.map((s) => s.id)).toEqual(["m1"]);
    expect(t.mailer.outbox[1]?.to).toBe("gl@beispiel.ch, cfo@beispiel.ch");
    expect(t.mailer.outbox[1]?.text).toContain("Oktober 2026");
    expect(t.mailer.outbox[1]?.text).toContain("Auslastung");
    // Same week / month again: nothing.
    expect(await sendScheduledReports(t.app.ctx, new Date("2026-11-02T10:00:00Z"))).toEqual([]);
    expect(await sendScheduledReports(t.app.ctx, new Date("2026-11-03T10:00:00Z"))).toEqual([]);

    const now = await t.app.inject({ method: "POST", url: "/api/settings/reports/m1/send", headers: { cookie: admin }, payload: {} });
    expect(now.statusCode).toBe(200);
    expect(t.mailer.outbox.at(-1)?.to).toBe("anna.keller@beispiel.ch");
  });

  it("exports CSV and JSON with the viewer's permissions", async () => {
    const csv = await t.app.inject({ method: "GET", url: "/api/export/time-entries?from=2026-10-01&to=2026-10-31", headers: { cookie: admin } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.startsWith("﻿datum;")).toBe(true);
    expect(csv.body.split("\r\n").length).toBeGreaterThan(5);

    const json = await t.app.inject({ method: "GET", url: "/api/export/projects?format=json", headers: { cookie: admin } });
    expect(json.json()[0]).toHaveProperty("projektart");

    const own = await t.app.inject({ method: "GET", url: "/api/export/time-entries?format=json", headers: { cookie: employee } });
    const people = new Set((own.json() as { person: string }[]).map((r) => r.person));
    expect([...people]).toEqual(["Lea Meier"]);
    expect((await t.app.inject({ method: "GET", url: "/api/export/employees", headers: { cookie: employee } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: "GET", url: "/api/export/invoices?format=json", headers: { cookie: admin } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: "/api/export/nope", headers: { cookie: admin } })).statusCode).toBe(404);
  });
});
