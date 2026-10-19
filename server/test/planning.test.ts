import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoWeekKey } from "@taktwerk/domain";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let lead: string, lea: string, portal: string;

beforeAll(async () => {
  t = await setup();
  [lead, lea, portal] = await Promise.all(["marco.brunner", "lea.meier", "portal.medtech"].map(async (u) => (await login(t.app, u)).cookie));
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

const get = (url: string, cookie: string) => t.app.inject({ method: "GET", url, headers: { cookie } });
const send = (method: "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: object) => t.app.inject({ method, url, headers: { cookie }, payload });

describe("resource planning", () => {
  it("leads reserve hours per person, project and week; everyone sees what concerns them", async () => {
    const d = (await get("/api/dataset", lead)).json();
    const leaId = d.employees.find((e: { name: string }) => e.name === "Lea Meier").id;
    const project = d.projects[0].id;
    const week = isoWeekKey(d.today);

    const put = await send("PUT", "/api/planning", lead, { employeeId: leaId, projectId: project, week, hours: 16.3 });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ employeeId: leaId, projectId: project, week, hours: 16.5 });

    const again = await send("PUT", "/api/planning", lead, { employeeId: leaId, projectId: project, week, hours: 20 });
    expect(again.json().id).toBe(put.json().id);

    const mine = (await get("/api/dataset", lea)).json();
    expect(mine.allocations).toEqual([expect.objectContaining({ employeeId: leaId, projectId: project, week, hours: 20 })]);
    const all = (await get("/api/dataset", lead)).json();
    expect(all.allocations.length).toBe(1);

    expect((await send("PUT", "/api/planning", lea, { employeeId: leaId, projectId: project, week, hours: 8 })).statusCode).toBe(403);
    expect((await send("PUT", "/api/planning", lead, { employeeId: leaId, projectId: project, week: "2026-13", hours: 8 })).statusCode).toBe(400);
    expect((await send("PUT", "/api/planning", lead, { employeeId: "nope", projectId: project, week, hours: 8 })).statusCode).toBe(404);

    const gone = await send("PUT", "/api/planning", lead, { employeeId: leaId, projectId: project, week, hours: 0 });
    expect(gone.json()).toMatchObject({ removed: true });
    expect((await get("/api/dataset", lead)).json().allocations).toEqual([]);
  });
});

describe("customer portal", () => {
  it("portal accounts see their own customer only and nothing else", async () => {
    const res = await get("/api/portal", portal);
    expect(res.statusCode).toBe(200);
    const o = res.json();
    expect(o.customer.name).toBe("Medtech Basel AG");
    expect(o.customer.currency).toBe("CHF");
    expect(o.projects.length).toBeGreaterThan(0);
    expect(o.projects.every((p: { customer: { name: string } }) => p.customer.name === "Medtech Basel AG")).toBe(true);
    expect(o.months).toHaveLength(12);
    expect(o.months.at(-1).hours).toBeGreaterThan(0);
    expect(o.invoices).toEqual([]);

    expect((await get("/api/dataset", portal)).statusCode).toBe(403);
    expect((await get("/api/reports", portal)).statusCode).toBe(403);
    expect((await get("/api/invoices", portal)).statusCode).toBe(403);
    expect((await get("/api/auth/me", portal)).json()).toMatchObject({ role: "customer" });
    expect((await get("/api/portal", lead)).statusCode).toBe(403);

    const report = await get(`/api/portal/report?month=${o.months.at(-2).month}&format=pdf`, portal);
    expect(report.statusCode).toBe(200);
    expect(report.headers["content-type"]).toBe("application/pdf");

    // Portal accounts are not team members.
    const d = (await get("/api/dataset", lead)).json();
    expect(d.employees.some((e: { name: string }) => e.name === "Claudia Steiner")).toBe(false);
  });

  it("leads invite and revoke portal accounts of a customer", async () => {
    const d = (await get("/api/dataset", lead)).json();
    const alpenbank = d.customers.find((c: { name: string }) => c.name === "Alpenbank AG").id;
    const medtech = d.customers.find((c: { name: string }) => c.name === "Medtech Basel AG").id;
    expect((await get(`/api/customers/${medtech}/portal`, lead)).json()).toHaveLength(1);
    expect((await get(`/api/customers/${alpenbank}/portal`, lead)).json()).toEqual([]);

    const before = t.mailer.outbox.length;
    const created = await send("POST", `/api/customers/${alpenbank}/portal`, lead, { name: "Peter Muster", email: "Peter.Muster@alpenbank.example" });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "Peter Muster", email: "peter.muster@alpenbank.example", hasPassword: false });
    expect(t.mailer.outbox.length).toBe(before + 1);
    expect(t.mailer.outbox.at(-1)!.subject).toContain("Kundenportal");
    expect(t.mailer.outbox.at(-1)!.text).toContain("/passwort?token=");
    expect((await send("POST", `/api/customers/${alpenbank}/portal`, lead, { name: "Nochmal", email: "peter.muster@alpenbank.example" })).statusCode).toBe(409);
    expect((await send("POST", `/api/customers/${alpenbank}/portal`, lea, { name: "X", email: "x@example.com" })).statusCode).toBe(403);

    // Invited customers do not appear in the admin's user list.
    const admin = (await login(t.app, "anna.keller")).cookie;
    const list = (await get("/api/users", admin)).json();
    expect(list.some((u: { email: string }) => u.email === "peter.muster@alpenbank.example")).toBe(false);

    const del = await send("DELETE", `/api/customers/${alpenbank}/portal/${created.json().id}`, lead);
    expect(del.statusCode).toBe(200);
    expect((await get(`/api/customers/${alpenbank}/portal`, lead)).json()).toEqual([]);
  });
});
