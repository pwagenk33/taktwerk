import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { monitorReport, recordRequest, resetMonitor } from "../src/monitor";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  t = await setup();
  resetMonitor();
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

describe("operator monitoring", () => {
  it("computes percentiles and the slowest routes", () => {
    resetMonitor();
    for (let i = 1; i <= 100; i++) recordRequest("GET /api/a", i, 200);
    for (let i = 0; i < 5; i++) recordRequest("GET /api/slow", 900, i === 0 ? 500 : 200);
    const r = monitorReport(1);
    expect(r.requests).toBe(105);
    expect(r.serverErrors).toBe(1);
    expect(r.p50).toBe(53);
    expect(r.slowest[0]).toMatchObject({ route: "GET /api/slow", count: 5, p95: 900 });
    expect(r.perHour.at(-1)!.requests).toBe(105);
  });

  it("records API calls and browser errors, visible to the platform admin only", async () => {
    resetMonitor();
    const anna = await login(t.app, "anna.keller");
    const marco = await login(t.app, "marco.brunner");
    await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: anna.cookie } });
    const sent = await t.app.inject({ method: "POST", url: "/api/client-errors", headers: { cookie: marco.cookie }, payload: { message: "TypeError: x is undefined", page: "reports", version: "1.0.0" } });
    expect(sent.statusCode).toBe(204);
    expect((await t.app.inject({ method: "GET", url: "/api/platform/monitor", headers: { cookie: marco.cookie } })).statusCode).toBe(403);
    const r = (await t.app.inject({ method: "GET", url: "/api/platform/monitor", headers: { cookie: anna.cookie } })).json();
    expect(r.slowest.length + r.requests).toBeGreaterThan(0);
    expect(r.errors[0]).toMatchObject({ source: "app", route: "#reports", message: "TypeError: x is undefined" });
  });
});
