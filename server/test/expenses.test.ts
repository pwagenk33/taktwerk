import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendHoursReminders } from "../src/jobs";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let admin: string, lead: string, lea: string, jonas: string;
let subId: string;

beforeAll(async () => {
  t = await setup();
  [admin, lead, lea, jonas] = await Promise.all(["anna.keller", "marco.brunner", "lea.meier", "jonas.weber"].map(async (u) => (await login(t.app, u)).cookie));
  const d = (await get("/api/dataset", admin)).json();
  subId = d.subProjects[0].id;
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

const get = (url: string, cookie: string) => t.app.inject({ method: "GET", url, headers: { cookie } });
const send = (method: "POST" | "PATCH" | "DELETE" | "PUT", url: string, cookie: string, payload: object = {}) =>
  t.app.inject({ method, url, headers: { cookie }, payload });
const expense = (cookie: string, extra: object = {}) =>
  send("POST", "/api/expenses", cookie, { subProjectId: subId, date: "2026-10-06", amount: 42, category: "Reise", reason: "SBB", billable: true, ...extra });
const upload = (url: string, cookie: string, bytes: Uint8Array, type: string, name: string) => {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  return t.app.inject({ method: "POST", url, headers: { cookie }, payload: form });
};

describe("expenses", () => {
  it("prices kilometres with the organization's rate and no VAT", async () => {
    const res = await expense(lead, { category: "Kilometer", km: 50, amount: 0 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ amount: 35, vatRate: 0, km: 50, status: "approved" });
    expect((await expense(lead, { category: "Kilometer" })).statusCode).toBe(400);
    await send("PUT", "/api/settings", admin, { kmRate: 0.8 });
    expect((await expense(lead, { category: "Kilometer", km: 10 })).json().amount).toBe(8);
    await send("PUT", "/api/settings", admin, { kmRate: 0.7 });
  });

  it("employees' expenses wait for approval; leads' are approved at once", async () => {
    const mine = (await expense(lea, { vatRate: 2.6 })).json();
    expect(mine).toMatchObject({ status: "requested", vatRate: 2.6 });
    expect((await expense(lead)).json().status).toBe("approved");
    // Employees may not decide, not even on their own.
    expect((await send("POST", `/api/expenses/${mine.id}/decide`, lea, { approve: true })).statusCode).toBe(403);
    expect((await send("POST", `/api/expenses/${mine.id}/decide`, jonas, { approve: true })).statusCode).toBe(403);
    expect((await send("POST", `/api/expenses/${mine.id}/decide`, lead, { approve: true })).json()).toMatchObject({ status: "approved" });
    expect((await send("POST", `/api/expenses/${mine.id}/decide`, lead, { approve: true })).statusCode).toBe(409);
    // Once approved, the amount is fixed for the employee.
    expect((await send("PATCH", `/api/expenses/${mine.id}`, lea, { amount: 99 })).statusCode).toBe(409);
    expect((await send("PATCH", `/api/expenses/${mine.id}`, lea, { reason: "SBB Zürich" })).statusCode).toBe(200);
  });

  it("rejecting sends a mail with the reason, resubmitting starts over", async () => {
    const mine = (await expense(lea, { date: "2026-10-07" })).json();
    t.mailer.outbox.length = 0;
    expect((await send("POST", `/api/expenses/${mine.id}/decide`, lead, { approve: false, comment: "Beleg fehlt" })).json().status).toBe("rejected");
    const mail = t.mailer.outbox[0]!;
    expect(mail.to).toBe("lea.meier@beispiel.ch");
    expect(mail.subject).toContain("abgelehnt");
    expect(mail.text).toContain("Beleg fehlt");
    expect((await send("POST", `/api/expenses/${mine.id}/resubmit`, jonas)).statusCode).toBe(403);
    expect((await send("POST", `/api/expenses/${mine.id}/resubmit`, lea)).json().status).toBe("requested");
    expect((await send("POST", `/api/expenses/${mine.id}/resubmit`, lea)).statusCode).toBe(409);
    const log = (await get(`/api/audit/${mine.id}`, lea)).json();
    expect(log.map((l: { action: string }) => l.action)).toEqual(["submit", "reject", "create"]);
    expect(log[1].after).toMatchObject({ status: "rejected", comment: "Beleg fehlt" });
  });

  it("stores, serves and removes receipts", async () => {
    const mine = (await expense(lea, { date: "2026-10-08" })).json();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    expect((await upload(`/api/expenses/${mine.id}/receipt`, lea, png, "text/plain", "x.txt")).statusCode).toBe(400);
    const up = await upload(`/api/expenses/${mine.id}/receipt`, lea, png, "image/png", "Quittung.png");
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ name: "Quittung.png", mime: "image/png", size: png.length });
    const got = await get(`/api/expenses/${mine.id}/receipt`, lead);
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(new Uint8Array(got.rawPayload)).toEqual(png);
    expect((await get(`/api/expenses/${mine.id}/receipt`, jonas)).statusCode).toBe(403);
    const d = (await get("/api/dataset", lea)).json();
    expect(d.expenses.find((x: { id: string }) => x.id === mine.id).receipt).toEqual({ name: "Quittung.png", mime: "image/png" });
    expect((await send("DELETE", `/api/expenses/${mine.id}/receipt`, lea)).statusCode).toBe(200);
    expect((await get(`/api/expenses/${mine.id}/receipt`, lea)).statusCode).toBe(404);
  });
});

describe("hours reminder", () => {
  it("reminds people who are more than two hours short, once per week", async () => {
    // Monday 19 October 2026: the week before is 12–18 October. Lea's bookings of that week disappear.
    const d = (await get("/api/dataset", admin)).json();
    const leaId = d.employees.find((e: { name: string }) => e.name === "Lea Meier").id;
    for (const e of d.timeEntries.filter((x: { employeeId: string; date: string }) => x.employeeId === leaId && x.date >= "2026-10-12" && x.date <= "2026-10-18")) {
      expect((await send("DELETE", `/api/time-entries/${e.id}`, admin)).statusCode).toBe(200);
    }
    t.mailer.outbox.length = 0;
    expect(await sendHoursReminders(t.app.ctx, new Date("2026-10-19T06:30:00Z"))).toEqual([]); // 08:30 Zurich: too early
    const sent = await sendHoursReminders(t.app.ctx, new Date("2026-10-19T08:00:00Z"));
    const lea = sent.find((s) => s.userId === leaId);
    expect(lea?.missing).toBeGreaterThan(30);
    const mail = t.mailer.outbox.find((m) => m.to === "lea.meier@beispiel.ch")!;
    expect(mail.subject).toMatch(/Stunden fehlen/);
    expect(mail.text).toContain("12.10.2026 bis 18.10.2026");
    // Same week again, even on Tuesday: nothing.
    expect((await sendHoursReminders(t.app.ctx, new Date("2026-10-20T10:00:00Z"))).find((s) => s.userId === leaId)).toBeUndefined();
    // Switched off: nothing for the next week either.
    await send("PUT", "/api/settings", admin, { hoursReminder: false });
    expect(await sendHoursReminders(t.app.ctx, new Date("2026-10-26T10:00:00Z"))).toEqual([]);
    await send("PUT", "/api/settings", admin, { hoursReminder: true });
  });
});
