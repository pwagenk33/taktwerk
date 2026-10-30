import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let anna = "";
beforeAll(async () => {
  t = await setup();
  anna = (await login(t.app, "anna.keller")).cookie;
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

describe("payroll export", () => {
  it("exports a month with personnel numbers and the company's wage types", async () => {
    const data = (await t.app.inject({ method: "GET", url: "/api/dataset", headers: { cookie: anna } })).json() as { employees: { id: string; name: string }[]; today: string };
    const lea = data.employees.find((e) => e.name === "Lea Meier")!;
    expect((await t.app.inject({ method: "PATCH", url: `/api/users/${lea.id}/work-model`, headers: { cookie: anna }, payload: { personnelNumber: "1042" } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "PUT", url: "/api/settings", headers: { cookie: anna }, payload: { payrollCodes: { hours: "5000" } } })).statusCode).toBe(200);

    const month = `${data.today.slice(0, 7)}`;
    const prev = new Date(Date.parse(`${month}-15`) - 31 * 86400_000).toISOString().slice(0, 7);
    const res = await t.app.inject({ method: "GET", url: `/api/export/payroll?month=${prev}`, headers: { cookie: anna } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain(`lohn-${prev}.csv`);
    const lines = res.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("personalnummer;name;periode;lohnart;bezeichnung;menge;einheit;betrag");
    expect(lines.some((l) => l.startsWith(`1042;Lea Meier;${prev};5000;Geleistete Stunden;`))).toBe(true);
    expect((await t.app.inject({ method: "GET", url: `/api/dataset`, headers: { cookie: anna } })).json().employees.find((e: { id: string }) => e.id === lea.id).personnelNumber).toBe("1042");
  });

  it("is for admins only and checks the month", async () => {
    const lea = (await login(t.app, "lea.meier")).cookie;
    expect((await t.app.inject({ method: "GET", url: "/api/export/payroll?month=2026-09", headers: { cookie: lea } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: "GET", url: "/api/export/payroll?month=2026-13", headers: { cookie: anna } })).statusCode).toBe(400);
  });
});
