import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchFxRates, refreshFxRates } from "../src/fx";
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

const stubFetch = (date = "2026-10-19") => async () => ({ ok: true, status: 200, json: async () => ({ date, rates: { EUR: 1.0638, USD: 1.25 } }) });

describe("project kinds, currencies and cost rates", () => {
  it("stores kind and retainer hours on projects and the currency on customers", async () => {
    const ds = await t.app.inject({ method: "GET", url: "/api/dataset", headers: { cookie: admin } });
    const project = ds.json().projects.find((p: { kind: string }) => p.kind === "tm");
    const customer = ds.json().customers[0];
    expect(project.kind).toBe("tm");

    const r = await t.app.inject({ method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie: admin }, payload: { kind: "retainer", retainerHours: 80 } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ kind: "retainer", retainerHours: 80 });
    const back = await t.app.inject({ method: "PATCH", url: `/api/projects/${project.id}`, headers: { cookie: admin }, payload: { kind: "fixed" } });
    expect(back.json().retainerHours).toBeNull();

    const c = await t.app.inject({ method: "PATCH", url: `/api/customers/${customer.id}`, headers: { cookie: admin }, payload: { currency: "EUR" } });
    expect(c.json().currency).toBe("EUR");
    const forbidden = await t.app.inject({ method: "PATCH", url: `/api/customers/${customer.id}`, headers: { cookie: employee }, payload: { currency: "USD" } });
    expect(forbidden.statusCode).toBe(403);
  });

  it("keeps cost rates away from employees and exposes them to leads", async () => {
    const users = (await t.app.inject({ method: "GET", url: "/api/users", headers: { cookie: admin } })).json() as { id: string; username: string }[];
    const lea = users.find((u) => u.username === "lea.meier")!;
    await t.app.inject({ method: "PATCH", url: `/api/users/${lea.id}`, headers: { cookie: admin }, payload: { costRate: 92.5 } });
    await t.app.inject({ method: "PUT", url: "/api/settings", headers: { cookie: admin }, payload: { costRate: 100 } });
    const lead = (await t.app.inject({ method: "GET", url: "/api/dataset", headers: { cookie: admin } })).json();
    expect(lead.employees.find((e: { id: string }) => e.id === lea.id).costRate).toBe(92.5);
    expect(lead.rates.costRate).toBe(100);
    const own = (await t.app.inject({ method: "GET", url: "/api/dataset", headers: { cookie: employee } })).json();
    expect(own.employees.find((e: { id: string }) => e.id === lea.id).costRate).toBeUndefined();
    expect(own.rates.costRate).toBeUndefined();
  });

  it("fetches ECB rates once a day and honours manual rates", async () => {
    const fx = await fetchFxRates(stubFetch());
    expect(fx.rates.EUR).toBeCloseTo(0.94, 2);
    expect(fx.rates.USD).toBeCloseTo(0.8, 2);
    expect(await refreshFxRates(t.app.ctx, stubFetch(), "2026-10-19")).toHaveLength(1);
    expect(await refreshFxRates(t.app.ctx, stubFetch(), "2026-10-19")).toHaveLength(0); // already today
    const ds = (await t.app.inject({ method: "GET", url: "/api/dataset", headers: { cookie: admin } })).json();
    expect(ds.fx.rates.EUR).toBeCloseTo(0.94, 2);
    // Manual rates stop the daily refresh.
    const manual = await t.app.inject({ method: "PUT", url: "/api/settings", headers: { cookie: admin }, payload: { fx: { rates: { EUR: 0.95 } } } });
    expect(manual.json().fx).toMatchObject({ rates: { EUR: 0.95 }, manual: true });
    expect(await refreshFxRates(t.app.ctx, stubFetch("2026-10-20"), "2026-10-20")).toHaveLength(0);
  });
});
