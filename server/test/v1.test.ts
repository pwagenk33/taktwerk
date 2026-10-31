import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { webhookDeliveries } from "../src/db/schema";
import { deliverDue, endpointProblem } from "../src/events";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let anna = "";
let readKey = "";
let writeKey = "";
const received: { headers: Record<string, string>; body: string }[] = [];
let answer = 200;

beforeAll(async () => {
  t = await setup();
  anna = (await login(t.app, "anna.keller")).cookie;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://hooks.example.com/")) {
      received.push({ headers: Object.fromEntries(new Headers(init.headers).entries()), body: String(init.body) });
      return new Response("", { status: answer });
    }
    return new Response("{}", { status: 404 });
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await t.app.close();
  await t.pool.end();
});

const v1 = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, key: string, payload?: object) =>
  t.app.inject({ method, url, headers: { authorization: `Bearer ${key}` }, ...(payload ? { payload } : {}) });

describe("API keys", () => {
  it("offer a Power BI template with the company's address", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/integrations/powerbi", headers: { cookie: anna } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("TrackInsight-PowerBI.pq");
    expect(res.payload).toContain('"https://zeit.example.ch/" meta [IsParameterQuery = true');
    expect(res.payload).toContain('fnSeiten("time-entries")');
  });

  it("are made by admins and shown once", async () => {
    const r = await t.app.inject({ method: "POST", url: "/api/integrations/keys", headers: { cookie: anna }, payload: { name: "Power BI", scope: "read" } });
    expect(r.statusCode).toBe(201);
    readKey = r.json().key;
    expect(readKey).toMatch(/^ti_[A-Za-z0-9_-]{40,}$/);
    writeKey = (await t.app.inject({ method: "POST", url: "/api/integrations/keys", headers: { cookie: anna }, payload: { name: "Ticketsystem", scope: "write" } })).json().key;
    const list = (await t.app.inject({ method: "GET", url: "/api/integrations", headers: { cookie: anna } })).json();
    expect(list.keys.map((k: { name: string }) => k.name).sort()).toEqual(["Power BI", "Ticketsystem"]);
    expect(JSON.stringify(list)).not.toContain(readKey);
    const lea = (await login(t.app, "lea.meier")).cookie;
    expect((await t.app.inject({ method: "GET", url: "/api/integrations", headers: { cookie: lea } })).statusCode).toBe(403);
  });

  it("read the public API but not the internal one", async () => {
    expect((await v1("GET", "/api/v1/me", readKey)).json()).toMatchObject({ scope: "read", actsAs: { role: "admin" } });
    const customers = (await v1("GET", "/api/v1/customers", readKey)).json().data;
    expect(customers.length).toBeGreaterThan(0);
    expect(customers[0]).toHaveProperty("rates");
    const projects = (await v1("GET", "/api/v1/projects", readKey)).json().data;
    expect(projects[0].subProjects.length).toBeGreaterThan(0);
    expect((await v1("GET", "/api/v1/budgets", readKey)).json().data[0]).toHaveProperty("forecastCost");
    expect((await v1("GET", "/api/dataset", readKey)).statusCode).toBe(401);
    expect((await v1("GET", "/api/v1/me", "ti_falschfalschfalschfalschfalsch")).statusCode).toBe(401);
    expect((await t.app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json().openapi).toBe("3.1.0");
  });

  it("page bookings and write them only with scope write", async () => {
    const today = (await t.app.inject({ method: "GET", url: "/api/dataset", headers: { cookie: anna } })).json().today as string;
    const from = `${today.slice(0, 7)}-01`;
    const page = (await v1("GET", `/api/v1/time-entries?from=${from}&to=${today}&limit=5`, readKey)).json();
    expect(page.data.length).toBeLessThanOrEqual(5);
    expect(page.total).toBeGreaterThanOrEqual(page.data.length);
    const sub = (await v1("GET", "/api/v1/projects", readKey)).json().data[0].subProjects[0].id;
    const entry = { subProjectId: sub, date: today, hours: 1.5, reason: "Aus dem Ticketsystem" };
    expect((await v1("POST", "/api/v1/time-entries", readKey, entry)).statusCode).toBe(403);
    const created = await v1("POST", "/api/v1/time-entries", writeKey, entry);
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await v1("PATCH", `/api/v1/time-entries/${id}`, writeKey, { hours: 2 })).json().hours).toBe(2);
    const bad = await v1("POST", "/api/v1/time-entries", writeKey, { ...entry, subProjectId: "nope" });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect((await v1("DELETE", `/api/v1/time-entries/${id}`, writeKey)).json()).toEqual({ ok: true });
  });

  it("stop working when revoked", async () => {
    const keys = (await t.app.inject({ method: "GET", url: "/api/integrations", headers: { cookie: anna } })).json().keys as { id: string; name: string }[];
    await t.app.inject({ method: "DELETE", url: `/api/integrations/keys/${keys.find((k) => k.name === "Power BI")!.id}`, headers: { cookie: anna } });
    expect((await v1("GET", "/api/v1/me", readKey)).statusCode).toBe(401);
  });
});

describe("webhooks", () => {
  it("only go to public https addresses", () => {
    expect(endpointProblem("http://hooks.example.com/x")).toMatch(/https/);
    expect(endpointProblem("https://localhost/x")).not.toBeNull();
    expect(endpointProblem("https://10.0.0.5/x")).not.toBeNull();
    expect(endpointProblem("https://[::1]/x")).not.toBeNull();
    expect(endpointProblem("https://169.254.169.254/latest")).not.toBeNull();
    expect(endpointProblem("https://hooks.example.com/ti")).toBeNull();
  });

  it("deliver signed events for bookings and retry failures", async () => {
    const r = await t.app.inject({ method: "POST", url: "/api/integrations/webhooks", headers: { cookie: anna }, payload: { url: "https://hooks.example.com/ti", events: ["time_entry.created", "time_entry.deleted"] } });
    expect(r.statusCode).toBe(201);
    const { id: hookId, secret } = r.json();
    expect(secret).toMatch(/^whsec_/);

    const today = (await t.app.inject({ method: "GET", url: "/api/dataset", headers: { cookie: anna } })).json().today as string;
    const sub = (await v1("GET", "/api/v1/projects", writeKey)).json().data[0].subProjects[0].id;
    const id = (await v1("POST", "/api/v1/time-entries", writeKey, { subProjectId: sub, date: today, hours: 1, reason: "Webhook" })).json().id;
    await v1("PATCH", `/api/v1/time-entries/${id}`, writeKey, { hours: 2 }); // not subscribed
    await deliverDue(t);
    expect(received.length).toBe(1);
    const { headers, body } = received[0]!;
    const event = JSON.parse(body);
    expect(event).toMatchObject({ type: "time_entry.created", data: { id, hours: 1, reason: "Webhook" } });
    expect(event.data).not.toHaveProperty("organizationId");
    const [, ts, sig] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(headers["trackinsight-signature"]!)!;
    expect(sig).toBe(createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex"));
    expect(headers["trackinsight-event"]).toBe("time_entry.created");

    // A failing endpoint gets the event again later.
    answer = 500;
    await v1("DELETE", `/api/v1/time-entries/${id}`, writeKey);
    await deliverDue(t);
    expect(received.length).toBe(2);
    await deliverDue(t);
    expect(received.length).toBe(2); // not yet due
    answer = 200;
    await deliverDue(t, new Date(Date.now() + 2 * 60_000));
    expect(received.length).toBe(3);
    expect(JSON.parse(received[2]!.body).type).toBe("time_entry.deleted");
    const log = (await t.app.inject({ method: "GET", url: `/api/integrations/webhooks/${hookId}/deliveries`, headers: { cookie: anna } })).json();
    expect(log.find((d: { event: string }) => d.event === "time_entry.deleted")).toMatchObject({ attempts: 2, lastStatus: 200 });
    expect((await t.db.select().from(webhookDeliveries)).every((d) => d.deliveredAt)).toBe(true);

    // Test ping.
    expect((await t.app.inject({ method: "POST", url: `/api/integrations/webhooks/${hookId}/test`, headers: { cookie: anna } })).json()).toMatchObject({ ok: true, status: 200 });
    expect(JSON.parse(received.at(-1)!.body).type).toBe("ping");
  });

  it("send month and absence events from the audit trail", async () => {
    received.length = 0;
    await t.app.inject({ method: "POST", url: "/api/integrations/webhooks", headers: { cookie: anna }, payload: { url: "https://hooks.example.com/alle", events: ["*"] } });
    const lea = await login(t.app, "lea.meier");
    const r = await t.app.inject({ method: "POST", url: "/api/absences", headers: { cookie: lea.cookie }, payload: { type: "Weiterbildung", startDate: "2026-12-14", endDate: "2026-12-14", halfDay: false } });
    expect(r.statusCode).toBe(201);
    await deliverDue(t);
    const types = received.filter((x) => x.body.includes("absence.created")).map((x) => JSON.parse(x.body));
    expect(types[0].data).toMatchObject({ type: "Weiterbildung", startDate: "2026-12-14", status: "requested" });
  });
});
