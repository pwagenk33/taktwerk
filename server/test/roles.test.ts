import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let anna: string;
let jonas: string; // employee, leads project «QMS Digitalisierung»
let sara: string; // employee, leads team «Support und Betrieb» (Luca, Nina)
let lea: string; // plain employee
let ids: Record<string, string>;
let qms: string;
let other: string;

const get = (url: string, cookie = "") => t.app.inject({ method: "GET", url, headers: { cookie } });
const post = (url: string, payload: object, cookie = "") => t.app.inject({ method: "POST", url, payload, headers: { cookie } });
const patch = (url: string, payload: object, cookie = "") => t.app.inject({ method: "PATCH", url, payload, headers: { cookie } });
const put = (url: string, payload: object, cookie = "") => t.app.inject({ method: "PUT", url, payload, headers: { cookie } });

beforeAll(async () => {
  t = await setup();
  anna = (await login(t.app, "anna.keller")).cookie;
  lea = (await login(t.app, "jonas.weber")).cookie;
  sara = (await login(t.app, "sara.frei")).cookie;
  jonas = (await login(t.app, "lea.meier")).cookie;
  const users = (await get("/api/users", anna)).json() as { id: string; username: string }[];
  ids = Object.fromEntries(users.map((u) => [u.username, u.id]));
  const d = (await get("/api/dataset", anna)).json();
  qms = d.projects.find((p: { name: string }) => p.name === "QMS Digitalisierung").id;
  other = d.projects.find((p: { name: string }) => p.name === "Flottenmanagement").id;
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

describe("project lead", () => {
  it("sees budget, bookings and reports of the led project only", async () => {
    const d = (await get("/api/dataset", lea)).json();
    const led = d.projects.find((p: { id: string }) => p.id === qms);
    expect(led.leadUserId).toBe(ids["jonas.weber"]);
    expect(led.budget).toBeGreaterThan(0);
    expect(d.projects.find((p: { id: string }) => p.id === other).budget).toBe(0);
    const qmsSubs = new Set(d.subProjects.filter((s: { projectId: string }) => s.projectId === qms).map((s: { id: string }) => s.id));
    const foreign = d.timeEntries.filter((e: { employeeId: string }) => e.employeeId !== ids["jonas.weber"]);
    expect(foreign.length).toBeGreaterThan(0);
    expect(foreign.every((e: { subProjectId: string }) => qmsSubs.has(e.subProjectId))).toBe(true);

    const reports = (await get("/api/reports", lea)).json();
    expect(reports.map((r: { project: { id: string } }) => r.project.id)).toEqual([qms]);
    expect((await get("/api/reports", jonas)).statusCode).toBe(403);
  });

  it("edits and plans the led project, nothing else", async () => {
    expect((await patch(`/api/projects/${other}`, { budget: 1 }, lea)).statusCode).toBe(403);
    expect((await patch(`/api/projects/${qms}`, { budget: 99000 }, lea)).json().budget).toBe(99000);
    expect((await patch(`/api/projects/${qms}`, { leadUserId: ids["lea.meier"] }, lea)).statusCode).toBe(403);
    expect((await put("/api/planning", { employeeId: ids["lea.meier"], projectId: qms, week: "2026-W45", hours: 8 }, lea)).statusCode).toBe(200);
    expect((await put("/api/planning", { employeeId: ids["lea.meier"], projectId: other, week: "2026-W45", hours: 8 }, lea)).statusCode).toBe(403);
    // Admins hand the lead over; the new lead gets the rights at once.
    expect((await patch(`/api/projects/${qms}`, { leadUserId: ids["lea.meier"] }, anna)).json().leadUserId).toBe(ids["lea.meier"]);
    expect((await get("/api/reports", jonas)).json()).toHaveLength(1);
    expect((await patch(`/api/projects/${qms}`, { leadUserId: ids["jonas.weber"] }, anna)).statusCode).toBe(200);
  });
});

describe("team lead", () => {
  it("sees and closes the months of the own team", async () => {
    const month = "2026-09";
    const names = (await get(`/api/months/${month}`, sara)).json().map((p: { name: string }) => p.name).sort();
    expect(names).toEqual(["Luca Schmid", "Nina Huber", "Sara Frei"]);
    expect((await get(`/api/months/${month}`, jonas)).json()).toHaveLength(1);
    expect((await post(`/api/months/${month}/approve`, { userId: ids["luca.schmid"] }, sara)).json().status).toBe("approved");
    expect((await post(`/api/months/${month}/approve`, { userId: ids["jonas.weber"] }, sara)).statusCode).toBe(403);
    expect((await post(`/api/months/${month}/approve`, { userId: ids["sara.frei"] }, sara)).statusCode).toBe(403);
    expect((await post(`/api/months/${month}/reopen`, { userId: ids["luca.schmid"] }, sara)).statusCode).toBe(403); // approved: admins only
    const overview = (await get("/api/weeks/overview?from=2026-W40&to=2026-W41", sara)).json();
    expect(overview).toHaveLength(3);
    expect((await get("/api/weeks/overview?from=2026-W40&to=2026-W41", jonas)).statusCode).toBe(403);
  });

  it("handles the absences of the own team", async () => {
    const own = await post("/api/absences", { type: "Ferien", startDate: "2026-12-07", endDate: "2026-12-08", halfDay: false }, sara);
    expect(own.json().status).toBe("requested");
    const forLuca = await post("/api/absences", { employeeId: ids["luca.schmid"], type: "Ferien", startDate: "2026-12-14", endDate: "2026-12-15", halfDay: false }, sara);
    expect(forLuca.json().status).toBe("approved");
    expect((await post("/api/absences", { employeeId: ids["jonas.weber"], type: "Ferien", startDate: "2026-12-14", endDate: "2026-12-15", halfDay: false }, sara)).statusCode).toBe(403);
    const nina = (await login(t.app, "nina.huber")).cookie;
    const req = (await post("/api/absences", { type: "Ferien", startDate: "2026-12-21", endDate: "2026-12-22", halfDay: false }, nina)).json();
    expect(req.status).toBe("requested");
    expect((await post(`/api/absences/${req.id}/decide`, { approve: true }, jonas)).statusCode).toBe(403);
    expect((await post(`/api/absences/${req.id}/decide`, { approve: true }, sara)).json().status).toBe("approved");
    expect((await post(`/api/absences/${own.json().id}/decide`, { approve: true }, sara)).statusCode).toBe(403);
  });
});

describe("auditor (Treuhand)", () => {
  let auditor: string;
  it("reads everything and changes nothing", async () => {
    const created = await post("/api/users", { name: "Treuhand Muster", email: "revision@treuhand.ch", username: "treuhand", role: "auditor" }, anna);
    expect(created.statusCode).toBe(201);
    const link = t.mailer.outbox.at(-1)!.text.match(/token=([^\s]+)/)!;
    const set = await post("/api/auth/password/set", { token: decodeURIComponent(link[1]), password: "revision-passwort-2026" });
    auditor = `tw_session=${set.cookies.find((c) => c.name === "tw_session")!.value}`;
    const d = (await get("/api/dataset", auditor)).json();
    expect(d.projects.every((p: { budget: number; name: string }) => p.budget > 0 || p.name === "Interne Arbeit")).toBe(true);
    expect(d.employees.some((e: { role: string }) => e.role === "auditor")).toBe(false);
    expect((await get("/api/reports", auditor)).json().length).toBeGreaterThan(1);
    expect((await get("/api/closings", auditor)).statusCode).toBe(200);
    expect((await get("/api/export/time-entries?format=csv", auditor)).statusCode).toBe(200);
    const write = await post("/api/time-entries", { subProjectId: d.subProjects[0].id, date: "2026-10-05", hours: 1, reason: "Test" }, auditor);
    expect(write.statusCode).toBe(403);
    expect(write.json().error).toMatch(/nur lesend/);
    expect((await patch(`/api/projects/${qms}`, { budget: 1 }, auditor)).statusCode).toBe(403);
    expect((await put("/api/dashboard", { layout: [] }, auditor)).statusCode).toBe(200);
  });
});

describe("teams", () => {
  it("admins manage teams and their leads", async () => {
    expect((await post("/api/teams", { name: "Neu" }, jonas)).statusCode).toBe(403);
    const created = await post("/api/teams", { name: "Beratung", leadUserId: ids["lea.meier"] }, anna);
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await patch(`/api/teams/${id}`, { leadUserId: ids["portal.medtech"] ?? "nope" }, anna)).statusCode).toBe(404);
    await patch(`/api/users/${ids["jonas.weber"]}`, { teamId: id }, anna);
    expect((await get("/api/months/2026-08", jonas)).json().map((p: { name: string }) => p.name).sort()).toEqual(["Jonas Weber", "Lea Meier"]);
    expect((await get("/api/teams", lea)).json().find((x: { id: string }) => x.id === id)).toMatchObject({ name: "Beratung", leadUserId: ids["lea.meier"] });
    expect((await t.app.inject({ method: "DELETE", url: `/api/teams/${id}`, headers: { cookie: anna } })).statusCode).toBe(200);
    expect((await get("/api/months/2026-08", jonas)).json()).toHaveLength(1);
  });
});
