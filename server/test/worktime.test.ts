import { workBalance } from "@taktwerk/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let admin: string, lead: string, lea: string, jonas: string;
let leaId: string;

beforeAll(async () => {
  t = await setup();
  [admin, lead, lea, jonas] = await Promise.all(["anna.keller", "marco.brunner", "lea.meier", "jonas.weber"].map(async (u) => (await login(t.app, u)).cookie));
  leaId = (await get("/api/auth/me", lea)).json().id;
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

const get = (url: string, cookie: string) => t.app.inject({ method: "GET", url, headers: { cookie } });
const send = (method: "POST" | "PATCH" | "DELETE" | "PUT", url: string, cookie: string, payload: object = {}) =>
  t.app.inject({ method, url, headers: { cookie }, payload });
const request = (cookie: string, body: object) => send("POST", "/api/absences", cookie, { type: "Ferien", halfDay: false, ...body });

describe("work model in the dataset", () => {
  it("contains holidays, absences and the own work model; colleagues' details stay private", async () => {
    const d = (await get("/api/dataset", lea)).json();
    expect(d.workModel.weeklyHours).toBe(42);
    expect(d.workModel.holidays.some((h: { name: string }) => h.name === "Bundesfeier")).toBe(true);
    expect(d.absences.every((a: { employeeId: string }) => a.employeeId === leaId)).toBe(true);
    const me = d.employees.find((e: { id: string }) => e.id === leaId);
    expect(me).toMatchObject({ workload: 100, vacationDays: 25, trackingStart: "2026-01-01", overtimeCarry: -4 });
    expect(d.employees.find((e: { id: string }) => e.id !== leaId).workload).toBeUndefined();
    expect(Number.isFinite(workBalance(d, leaId).balance)).toBe(true);

    const all = (await get("/api/dataset", lead)).json();
    expect(new Set(all.absences.map((a: { employeeId: string }) => a.employeeId)).size).toBeGreaterThan(3);
  });
});

describe("absences", () => {
  it("vacation is requested, the leads get a mail, approval mails the employee", async () => {
    t.mailer.outbox.length = 0;
    const res = await request(lea, { startDate: "2026-12-07", endDate: "2026-12-11", note: "Skiferien" });
    expect(res.statusCode).toBe(201);
    const a = res.json();
    expect(a.status).toBe("requested");
    expect(t.mailer.outbox.map((m) => m.to).sort()).toEqual(["anna.keller@beispiel.ch", "marco.brunner@beispiel.ch"]);
    expect(t.mailer.outbox[0]!.text).toContain("5 Arbeitstage");

    expect((await send("POST", `/api/absences/${a.id}/decide`, jonas, { approve: true })).statusCode).toBe(403);
    t.mailer.outbox.length = 0;
    expect((await send("POST", `/api/absences/${a.id}/decide`, lead, { approve: true })).json().status).toBe("approved");
    expect(t.mailer.outbox).toHaveLength(1);
    expect(t.mailer.outbox[0]).toMatchObject({ to: "lea.meier@beispiel.ch", subject: expect.stringContaining("bewilligt") });
    expect((await send("POST", `/api/absences/${a.id}/decide`, lead, { approve: false })).statusCode).toBe(409);
    // Approved: only leads remove it.
    expect((await send("DELETE", `/api/absences/${a.id}`, lea)).statusCode).toBe(409);
  });

  it("sickness is recorded directly; overlaps and empty ranges are refused", async () => {
    const sick = await request(lea, { type: "Krankheit", startDate: "2026-10-19", endDate: "2026-10-19" });
    expect(sick.json().status).toBe("approved");
    expect((await request(lea, { startDate: "2026-10-19", endDate: "2026-10-20" })).json().error).toMatch(/Überschneidet/);
    expect((await request(lea, { startDate: "2026-10-24", endDate: "2026-10-25" })).json().error).toMatch(/kein Arbeitstag/);
    expect((await request(lea, { type: "Urlaub", startDate: "2026-10-26", endDate: "2026-10-26" })).statusCode).toBe(400);
  });

  it("employees withdraw own requests only; leads record for others", async () => {
    const a = (await request(jonas, { startDate: "2026-11-16", endDate: "2026-11-16", halfDay: true })).json();
    expect((await send("DELETE", `/api/absences/${a.id}`, lea)).statusCode).toBe(403);
    expect((await send("DELETE", `/api/absences/${a.id}`, jonas)).statusCode).toBe(200);
    expect((await request(lea, { employeeId: a.employeeId, startDate: "2026-11-16", endDate: "2026-11-16" })).statusCode).toBe(403);
    expect((await request(lead, { employeeId: a.employeeId, startDate: "2026-11-16", endDate: "2026-11-16" })).json().status).toBe("approved");
  });

  it("respects the monthly closing", async () => {
    await send("POST", "/api/months/2026-08/approve", lead, { userId: leaId });
    expect((await request(lea, { type: "Krankheit", startDate: "2026-08-31", endDate: "2026-09-01" })).statusCode).toBe(409);
    expect((await request(admin, { employeeId: leaId, type: "Krankheit", startDate: "2026-08-27", endDate: "2026-08-27" })).statusCode).toBe(409);
  });
});

describe("work model administration", () => {
  it("admins change Pensum, vacation and carry-overs; others cannot", async () => {
    expect((await send("PATCH", `/api/users/${leaId}/work-model`, lead, { workload: 80 })).statusCode).toBe(403);
    const res = await send("PATCH", `/api/users/${leaId}/work-model`, admin, { workload: 80, vacationDays: 22.5, overtimeCarry: 10 });
    expect(res.json()).toMatchObject({ workload: 80, vacationDays: 22.5, overtimeCarry: 10, trackingStart: "2026-01-01" });
    expect((await send("PATCH", `/api/users/${leaId}/work-model`, admin, { workload: 120 })).statusCode).toBe(400);
    const me = (await get("/api/dataset", lea)).json().employees.find((e: { id: string }) => e.id === leaId);
    expect(me.workload).toBe(80);
  });

  it("stores weekly hours and holidays without losing other settings", async () => {
    const holidays = [
      { date: "2026-05-01", name: "Tag der Arbeit", fraction: 1 },
      { date: "2026-01-01", name: "Neujahr", fraction: 1 },
      { date: "2026-01-01", name: "Neujahr doppelt", fraction: 1 },
    ];
    const s = (await send("PUT", "/api/settings", admin, { weeklyHours: 40, holidays })).json();
    expect(s.weeklyHours).toBe(40);
    expect(s.holidays.map((h: { date: string }) => h.date)).toEqual(["2026-01-01", "2026-05-01"]);
    expect(s.branding.appName).toBe("TrackInsight");
    expect((await send("PUT", "/api/settings", admin, { holidays: [{ date: "2026-05-01", name: "X", fraction: 0.3 }] })).statusCode).toBe(400);
    expect((await get("/api/dataset", lea)).json().workModel.weeklyHours).toBe(40);
  });

  it("new users start their time account on the day they are invited", async () => {
    const res = await send("POST", "/api/users", admin, { name: "Neu Person", email: "neu@beispiel.ch", username: "neu.person", role: "employee" });
    expect(res.statusCode).toBe(201);
    const users = (await get("/api/users", admin)).json();
    expect(users.find((u: { username: string }) => u.username === "neu.person").trackingStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
