import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let admin: string, lead: string, lea: string, customerId: string;

beforeAll(async () => {
  t = await setup();
  [admin, lead, lea] = await Promise.all(["anna.keller", "marco.brunner", "lea.meier"].map(async (u) => (await login(t.app, u)).cookie));
  const d = (await get("/api/dataset", admin)).json();
  customerId = d.customers.find((c: { name: string }) => c.name.startsWith("Alpenbank")).id;
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

const get = (url: string, cookie: string) => t.app.inject({ method: "GET", url, headers: { cookie } });
const send = (method: "POST" | "PATCH" | "DELETE", url: string, cookie: string, payload: object = {}) => t.app.inject({ method, url, headers: { cookie }, payload });

describe("quotes", () => {
  it("turns an accepted quote into a project with sub-projects and budgets", async () => {
    const rate = (await get(`/api/quotes/rate?customerId=${customerId}`, lead)).json().rate;
    expect(rate).toBeGreaterThan(0);
    const body = { customerId, title: "App für Firmenkunden", kind: "fixed", validUntil: "2026-12-31", positions: [{ name: "Konzept", hours: 40, rate }, { name: "Umsetzung", hours: 120.5, rate, note: "iOS und Android" }] };
    const res = await send("POST", "/api/quotes", lead, body);
    expect(res.statusCode).toBe(201);
    const q = res.json();
    expect(q.number).toMatch(/^O-\d{4}-0001$/);
    expect(q.net).toBeCloseTo(Math.round(160.5 * rate * 20) / 20, 1);
    expect((await send("POST", "/api/quotes", lea, body)).statusCode).toBe(403);
    expect((await send("POST", "/api/quotes", lead, { ...body, positions: [] })).statusCode).toBe(400);

    const patched = (await send("PATCH", `/api/quotes/${q.id}`, lead, { positions: [{ name: "Konzept", hours: 50, rate: 100 }] })).json();
    expect(patched.net).toBe(5000);
    expect((await send("POST", `/api/quotes/${q.id}/status`, lead, { status: "sent" })).json().status).toBe("sent");
    expect((await send("DELETE", `/api/quotes/${q.id}`, lead)).statusCode).toBe(409);

    const pdf = await get(`/api/quotes/${q.id}/pdf`, lead);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe("%PDF");

    const accepted = (await send("POST", `/api/quotes/${q.id}/accept`, lead, { name: "Firmenkunden-App" })).json();
    expect(accepted.status).toBe("accepted");
    const d = (await get("/api/dataset", admin)).json();
    const p = d.projects.find((x: { id: string }) => x.id === accepted.projectId);
    expect(p).toMatchObject({ name: "Firmenkunden-App", kind: "fixed", budget: 5000, customerId });
    expect(d.subProjects.filter((s: { projectId: string }) => s.projectId === p.id)).toEqual([expect.objectContaining({ name: "Konzept", budget: 5000 })]);
    expect((await send("POST", `/api/quotes/${q.id}/accept`, lead)).statusCode).toBe(409);
    expect((await send("PATCH", `/api/quotes/${q.id}`, lead, { title: "x" })).statusCode).toBe(409);
  });

  it("numbers on, declines and deletes drafts", async () => {
    const q = (await send("POST", "/api/quotes", lead, { customerId, title: "Wartung", kind: "retainer", retainerHours: 20, validUntil: "2026-12-31", positions: [{ name: "Support", hours: 20, rate: 150 }] })).json();
    expect(q.number).toMatch(/-0002$/);
    expect(q.retainerHours).toBe(20);
    expect((await send("POST", `/api/quotes/${q.id}/status`, lead, { status: "declined" })).json().status).toBe("declined");
    const draft = (await send("POST", "/api/quotes", lead, { customerId, title: "Entwurf", validUntil: "2026-12-31", positions: [{ name: "A", hours: 1, rate: 1 }] })).json();
    expect((await send("DELETE", `/api/quotes/${draft.id}`, lead)).statusCode).toBe(200);
    expect((await get(`/api/quotes?customerId=${customerId}`, lead)).json().quotes.map((x: { title: string }) => x.title)).toEqual(["Wartung", "App für Firmenkunden"]);
  });
});
