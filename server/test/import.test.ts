import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let anna: string;
let ids: Record<string, string>;
const send = (method: "GET" | "POST" | "DELETE", url: string, cookie: string, payload?: object) => t.app.inject({ method, url, payload, headers: { cookie } });

beforeAll(async () => {
  t = await setup();
  anna = (await login(t.app, "anna.keller")).cookie;
  const users = (await send("GET", "/api/users", anna)).json() as { id: string; username: string }[];
  ids = Object.fromEntries(users.map((u) => [u.username, u.id]));
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

const row = (o: object) => ({ line: 2, date: "2026-06-03", person: "Lea Meier", customer: "Neukunde AG", project: "Website", task: "Design", reason: "Entwurf", hours: 2, billable: true, ...o });

describe("import", () => {
  it("creates missing customers, projects and tasks, books on the chosen people and skips closed months", async () => {
    const lea = ids["lea.meier"]!;
    const lead = (await login(t.app, "marco.brunner")).cookie;
    // Lea's May is closed: the import must leave it alone.
    await send("POST", "/api/months/2026-05/approve", anna, { userId: lea });
    const res = await send("POST", "/api/import", anna, {
      source: "toggl",
      fileName: "toggl.csv",
      rate: 150,
      people: { "lea meier": lea },
      rows: [
        row({}),
        row({ line: 3, date: "2026-06-04", task: "Design", hours: 1.5, startTime: "08:00" }),
        row({ line: 4, customer: "alpenbank ag", project: "Kundenportal Relaunch", task: "Altdaten", hours: 3 }),
        row({ line: 5, date: "2026-05-20" }),
        row({ line: 6, person: "Unbekannt" }),
      ],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ entries: 3, hours: 6.5, customers: 1, projects: 1, subProjects: 2, skippedPeople: 1, skippedClosed: 1 });
    const d = (await send("GET", "/api/dataset?all=1", anna)).json();
    const neu = d.customers.find((c: { name: string }) => c.name === "Neukunde AG");
    expect(neu.rates).toEqual([{ validFrom: "2026-05-20", hourlyRate: 150 }]);
    const booked = d.timeEntries.filter((e: { reason: string; employeeId: string }) => e.reason === "Entwurf" && e.employeeId === lea);
    expect(booked).toHaveLength(3);
    expect(booked.find((e: { date: string }) => e.date === "2026-06-04").startTime).toBe("08:00");
    // Only admins import.
    expect((await send("POST", "/api/import", lead, { source: "toggl", fileName: "x", rate: 1, people: {}, rows: [row({})] })).statusCode).toBe(403);
  });

  it("refuses people from another company", async () => {
    const res = await send("POST", "/api/import", anna, { source: "generic", fileName: "x.csv", rate: 1, people: { "lea meier": "00000000-0000-0000-0000-000000000000" }, rows: [row({})] });
    expect(res.statusCode).toBe(400);
  });

  it("undoes an import and removes what it created", async () => {
    const [batch] = (await send("GET", "/api/import", anna)).json();
    expect(batch).toMatchObject({ fileName: "toggl.csv", entries: 3 });
    const undo = await send("DELETE", `/api/import/${batch.id}`, anna);
    expect(undo.json()).toEqual({ entries: 3, removed: 4 });
    const d = (await send("GET", "/api/dataset?all=1", anna)).json();
    expect(d.customers.some((c: { name: string }) => c.name === "Neukunde AG")).toBe(false);
    expect(d.subProjects.some((s: { name: string }) => s.name === "Altdaten")).toBe(false);
    expect((await send("DELETE", `/api/import/${batch.id}`, anna)).statusCode).toBe(409);
  });

  it("loads sample data once and removes it again", async () => {
    const res = await send("POST", "/api/onboarding/sample", anna);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ customers: 3, projects: 3, skippedPeople: 0 });
    expect(res.json().entries).toBeGreaterThan(50);
    expect((await send("POST", "/api/onboarding/sample", anna)).statusCode).toBe(409);
    const state = (await send("GET", "/api/onboarding", anna)).json();
    expect(state.sampleBatchId).toBe(res.json().id);
    const d = (await send("GET", "/api/dataset?all=1", anna)).json();
    expect(d.projects.find((p: { name: string }) => p.name === "Online-Shop").budget).toBe(30000);
    await send("DELETE", `/api/import/${state.sampleBatchId}`, anna);
    expect((await send("GET", "/api/onboarding", anna)).json().sampleBatchId).toBeNull();
    expect((await send("GET", "/api/dataset?all=1", anna)).json().customers.some((c: { name: string }) => c.name.startsWith("Beispiel:"))).toBe(false);
  });

  it("reads the first sheet of an Excel file", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Zeiten");
    ws.addRow(["Datum", "Person", "Stunden"]);
    ws.addRow([new Date(Date.UTC(2026, 8, 1)), "Lea Meier", 1.5]);
    const data = Buffer.from(await wb.xlsx.writeBuffer()).toString("base64");
    const res = await send("POST", "/api/import/xlsx", anna, { data });
    expect(res.json()).toEqual({ rows: [["Datum", "Person", "Stunden"], ["2026-09-01", "Lea Meier", "1.5"]] });
    expect((await send("POST", "/api/import/xlsx", anna, { data: "bm9wZQ==" })).statusCode).toBe(400);
  });
});
