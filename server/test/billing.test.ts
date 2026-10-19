import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkBudgetAlerts, sendClosingReminders, sendMonthlyReports } from "../src/jobs";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let admin: string, lead: string, lea: string, jonas: string;
let leaId: string, subId: string, customerId: string;

beforeAll(async () => {
  t = await setup();
  [admin, lead, lea, jonas] = await Promise.all(["anna.keller", "marco.brunner", "lea.meier", "jonas.weber"].map(async (u) => (await login(t.app, u)).cookie));
  const d = (await get("/api/dataset", admin)).json();
  leaId = d.employees.find((e: { name: string }) => e.name === "Lea Meier").id;
  subId = d.subProjects[0].id;
  customerId = d.projects.find((p: { id: string }) => p.id === d.subProjects[0].projectId).customerId;
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

const get = (url: string, cookie: string) => t.app.inject({ method: "GET", url, headers: { cookie } });
const send = (method: "POST" | "PATCH" | "DELETE" | "PUT", url: string, cookie: string, payload: object = {}) =>
  t.app.inject({ method, url, headers: { cookie }, payload });
const book = (cookie: string, date: string, extra: object = {}) => send("POST", "/api/time-entries", cookie, { subProjectId: subId, date, hours: 2, reason: "Workshop", ...extra });

describe("edit and delete bookings", () => {
  it("updates an own entry and records the change", async () => {
    const id = (await book(lea, "2026-10-05")).json().id;
    const res = await send("PATCH", `/api/time-entries/${id}`, lea, { hours: 3.5, reason: "Workshop mit Kunde" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hours: 3.5, reason: "Workshop mit Kunde" });
    // Saving without changes adds nothing to the history.
    await send("PATCH", `/api/time-entries/${id}`, lea, { hours: 3.5 });
    const log = (await get(`/api/audit/${id}`, lea)).json();
    expect(log.map((l: { action: string }) => l.action)).toEqual(["update", "create"]);
    expect(log[0]).toMatchObject({ actorName: "Lea Meier", before: { hours: 2 }, after: { hours: 3.5 } });
    // Someone else's history stays private for employees.
    expect((await get(`/api/audit/${id}`, jonas)).statusCode).toBe(403);
  });

  it("re-freezes the rate when the date moves into another rate period", async () => {
    const d = (await get("/api/dataset", admin)).json();
    const alpen = d.customers.find((c: { name: string }) => c.name.startsWith("Alpenbank"));
    const proj = d.projects.find((p: { customerId: string }) => p.customerId === alpen.id);
    const sub = d.subProjects.find((s: { projectId: string }) => s.projectId === proj.id);
    const id = (await book(lea, "2026-07-02", { subProjectId: sub.id })).json().id;
    const moved = (await send("PATCH", `/api/time-entries/${id}`, lea, { date: "2026-06-30" })).json();
    expect(moved.hourlyRate).toBe(180);
  });

  it("employees cannot change other people's entries", async () => {
    const id = (await book(lea, "2026-10-06")).json().id;
    expect((await send("PATCH", `/api/time-entries/${id}`, jonas, { hours: 1 })).statusCode).toBe(403);
    expect((await send("DELETE", `/api/time-entries/${id}`, jonas)).statusCode).toBe(403);
    expect((await send("DELETE", `/api/time-entries/${id}`, lea)).statusCode).toBe(200);
    expect((await get(`/api/audit/${id}`, admin)).json()[0]).toMatchObject({ action: "delete", after: null });
  });

  it("edits and deletes expenses", async () => {
    const x = (await send("POST", "/api/expenses", lea, { subProjectId: subId, date: "2026-10-07", amount: 42.5, category: "Reise", reason: "Zug" })).json();
    expect((await send("PATCH", `/api/expenses/${x.id}`, lea, { amount: 48 })).json()).toMatchObject({ amount: 48 });
    expect((await send("DELETE", `/api/expenses/${x.id}`, lea)).statusCode).toBe(200);
  });
});

describe("monthly closing", () => {
  it("submit locks the month for the employee, leads can still correct", async () => {
    const id = (await book(lea, "2026-08-12")).json().id;
    expect((await send("POST", "/api/months/2026-08/submit", lea)).statusCode).toBe(200);
    expect((await send("POST", "/api/months/2026-08/submit", lea)).statusCode).toBe(409);
    expect((await book(lea, "2026-08-13")).statusCode).toBe(409);
    expect((await send("PATCH", `/api/time-entries/${id}`, lea, { hours: 1 })).statusCode).toBe(409);
    expect((await send("PATCH", `/api/time-entries/${id}`, lead, { hours: 1 })).statusCode).toBe(200);
    // Other people's months are unaffected.
    expect((await book(jonas, "2026-08-13")).statusCode).toBe(201);
  });

  it("approval locks for everyone; only admins reopen", async () => {
    expect((await send("POST", "/api/months/2026-08/approve", lead, { userId: leaId })).json()).toEqual({ status: "approved" });
    expect((await book(lead, "2026-08-14", { employeeId: leaId })).statusCode).toBe(409);
    expect((await send("POST", "/api/months/2026-08/reopen", lead, { userId: leaId })).statusCode).toBe(403);
    expect((await send("POST", "/api/months/2026-08/approve", lea, { userId: leaId })).statusCode).toBe(403);

    const status = (await get("/api/months/2026-08", lead)).json();
    expect(status.find((s: { userId: string }) => s.userId === leaId).status).toBe("approved");
    expect((await get("/api/months/2026-08", lea)).json()).toHaveLength(1);
    expect((await get("/api/closings", lea)).json()).toEqual([{ userId: leaId, month: "2026-08", status: "approved" }]);
    expect((await get("/api/closings", jonas)).json()).toEqual([]);

    expect((await send("POST", "/api/months/2026-08/reopen", admin, { userId: leaId })).json()).toEqual({ status: "open" });
    expect((await book(lea, "2026-08-14")).statusCode).toBe(201);
  });

  it("leads can reject a submission", async () => {
    await send("POST", "/api/months/2026-07/submit", lea);
    expect((await send("POST", "/api/months/2026-07/reopen", lead, { userId: leaId })).statusCode).toBe(200);
    expect((await book(lea, "2026-07-14")).statusCode).toBe(201);
  });
});

describe("customer reports", () => {
  it("exports PDF and Excel for leads only", async () => {
    const pdf = await get(`/api/customers/${customerId}/report?month=2026-09&format=pdf`, lead);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.headers["content-disposition"]).toMatch(/attachment; filename="Report-.*-2026-09\.pdf"/);

    const xlsx = await get(`/api/customers/${customerId}/report?month=2026-09&format=xlsx`, admin);
    expect(xlsx.headers["content-type"]).toContain("spreadsheetml");
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe("PK");

    expect((await get(`/api/customers/${customerId}/report?month=2026-09&format=pdf`, lea)).statusCode).toBe(403);
    expect((await get(`/api/customers/${customerId}/report?month=2026-13&format=pdf`, admin)).statusCode).toBe(400);
  });

  it("sends the report with both attachments to the recipients", async () => {
    expect((await send("POST", `/api/customers/${customerId}/report/send`, admin, { month: "2026-09" })).statusCode).toBe(400);
    const put = await send("PUT", `/api/customers/${customerId}/recipients`, admin, { recipients: ["Einkauf@Kunde.ch", "pl@kunde.ch"] });
    expect(put.json()).toEqual({ recipients: ["einkauf@kunde.ch", "pl@kunde.ch"] });
    expect((await send("PUT", `/api/customers/${customerId}/recipients`, admin, { recipients: ["kein-mail"] })).statusCode).toBe(400);

    t.mailer.outbox.length = 0;
    const res = await send("POST", `/api/customers/${customerId}/report/send`, lead, { month: "2026-09" });
    expect(res.json()).toEqual({ sentTo: ["einkauf@kunde.ch", "pl@kunde.ch"] });
    const mail = t.mailer.outbox[0]!;
    expect(mail.to).toBe("einkauf@kunde.ch, pl@kunde.ch");
    expect(mail.subject).toContain("September 2026");
    expect(mail.attachments?.map((a) => a.contentType)).toEqual(["application/pdf", expect.stringContaining("spreadsheetml")]);
  });
});

describe("scheduled jobs", () => {
  it("sends last month's reports once, from the report day 07:00 Zurich", async () => {
    t.mailer.outbox.length = 0;
    // 3 Nov 2026 06:30 Zurich (CET = UTC+1): too early.
    expect(await sendMonthlyReports(t.app.ctx, new Date("2026-11-03T05:30:00Z"))).toEqual([]);
    const sent = await sendMonthlyReports(t.app.ctx, new Date("2026-11-03T06:05:00Z"));
    expect(sent).toEqual([{ customerId, month: "2026-10", to: ["einkauf@kunde.ch", "pl@kunde.ch"] }]);
    expect(await sendMonthlyReports(t.app.ctx, new Date("2026-11-04T10:00:00Z"))).toEqual([]);
    expect(t.mailer.outbox).toHaveLength(1);
  });

  it("uses the configured report day and keeps it when other settings change", async () => {
    expect((await send("PUT", "/api/settings", admin, { reportDay: 5 })).json()).toMatchObject({ reportDay: 5 });
    expect((await send("PUT", "/api/settings", admin, { ssoAutoProvisionDomains: ["beispiel.ch"] })).json()).toMatchObject({ reportDay: 5 });
    expect((await send("PUT", "/api/settings", admin, { reportDay: 31 })).statusCode).toBe(400);
    // December report run: 4 Dec is before day 5, 5 Dec 07:00 sends November.
    expect(await sendMonthlyReports(t.app.ctx, new Date("2026-12-04T09:00:00Z"))).toEqual([]);
    expect((await sendMonthlyReports(t.app.ctx, new Date("2026-12-05T06:00:00Z")))[0]).toMatchObject({ month: "2026-11" });
  });

  it("reminds people on the 1st and leads on the 5th, once per month", async () => {
    t.mailer.outbox.length = 0;
    // 1 Nov 2026 08:30 Zurich (CET): too early.
    expect(await sendClosingReminders(t.app.ctx, new Date("2026-11-01T07:30:00Z"))).toEqual([]);
    const first = await sendClosingReminders(t.app.ctx, new Date("2026-11-01T08:30:00Z"));
    expect(first.every((x) => x.kind === "person" && x.month === "2026-10")).toBe(true);
    expect(first.map((x) => x.to)).toContain("lea.meier@beispiel.ch");
    expect(t.mailer.outbox[0].subject).toContain("Oktober 2026 einreichen");
    // Nothing twice; the digest only from the 5th and then once.
    expect(await sendClosingReminders(t.app.ctx, new Date("2026-11-02T10:00:00Z"))).toEqual([]);
    const digest = await sendClosingReminders(t.app.ctx, new Date("2026-11-05T09:00:00Z"));
    expect(digest.every((x) => x.kind === "digest")).toBe(true);
    expect(digest.map((x) => x.to)).toContain("anna.keller@beispiel.ch");
    expect(digest.map((x) => x.to)).not.toContain("lea.meier@beispiel.ch");
    expect(await sendClosingReminders(t.app.ctx, new Date("2026-11-06T09:00:00Z"))).toEqual([]);
    // Switched off: nothing for the next month.
    expect((await send("PUT", "/api/settings", admin, { closingReminder: false })).json()).toMatchObject({ closingReminder: false });
    expect(await sendClosingReminders(t.app.ctx, new Date("2026-12-01T10:00:00Z"))).toEqual([]);
  });

  it("leads can remind one person now and approve all submitted months at once", async () => {
    t.mailer.outbox.length = 0;
    expect((await send("POST", "/api/months/2026-08/remind", lea, { userId: leaId })).statusCode).toBe(403);
    expect((await send("POST", "/api/months/2026-08/remind", lead, { userId: leaId })).json()).toMatchObject({ sent: true, to: "lea.meier@beispiel.ch" });
    expect(t.mailer.outbox).toHaveLength(1);
    expect((await send("POST", "/api/months/2026-08/submit", lea)).statusCode).toBe(200);
    expect((await send("POST", "/api/months/2026-08/remind", lead, { userId: leaId })).statusCode).toBe(409);
    expect((await send("POST", "/api/months/2026-08/approve-all", lead)).json()).toEqual({ approved: 1 });
    expect((await get("/api/months/2026-08", lead)).json().find((p: { userId: string }) => p.userId === leaId).status).toBe("approved");
    expect((await send("POST", "/api/months/2026-08/approve-all", lead)).json()).toEqual({ approved: 0 });
  });

  it("raises each budget threshold once", async () => {
    t.mailer.outbox.length = 0;
    const first = await checkBudgetAlerts(t.app.ctx);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((a) => a.forecast >= (a.budget * Number(a.threshold)) / 100)).toBe(true);
    // One mail per admin/consultant, not per project.
    const recipients = t.mailer.outbox.map((m) => m.to).sort();
    expect(new Set(recipients).size).toBe(recipients.length);
    expect(recipients).toContain("anna.keller@beispiel.ch");
    expect(recipients).not.toContain("lea.meier@beispiel.ch");

    t.mailer.outbox.length = 0;
    expect(await checkBudgetAlerts(t.app.ctx)).toEqual([]);
    expect(t.mailer.outbox).toHaveLength(0);
  });
});
