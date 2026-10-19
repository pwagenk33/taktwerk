import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let anna: string;

beforeAll(async () => {
  t = await setup();
  anna = (await login(t.app, "anna.keller")).cookie;
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

type Entry = { employeeId: string; subProjectId: string; date: string; hours: number; hourlyRate: number; billable: boolean; summary?: boolean };
const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: "GET", url, headers: { cookie: anna, ...headers } });
const sums = (list: Entry[]) => {
  const m = new Map<string, number>();
  for (const e of list) {
    const k = `${e.employeeId}|${e.subProjectId}|${e.date.slice(0, 7)}`;
    m.set(k, Math.round(((m.get(k) ?? 0) + e.hours * e.hourlyRate) * 100) / 100);
  }
  return m;
};

describe("large data sets", () => {
  it("sends older months as exact monthly totals and keeps all figures", async () => {
    const all = (await get("/api/dataset?all=1")).json();
    const windowed = (await get("/api/dataset")).json();
    expect(windowed.detailFrom).toMatch(/^\d{4}-\d{2}-01$/);
    expect(windowed.timeEntries.length).toBeLessThan(all.timeEntries.length);
    const older = windowed.timeEntries.filter((e: Entry) => e.summary);
    expect(older.length).toBeGreaterThan(0);
    expect(older.every((e: Entry) => e.date < windowed.detailFrom && e.date.endsWith("-01"))).toBe(true);
    expect(windowed.timeEntries.filter((e: Entry) => !e.summary).every((e: Entry) => e.date >= windowed.detailFrom)).toBe(true);
    expect(sums(windowed.timeEntries)).toEqual(sums(all.timeEntries));
  });

  it("loads single bookings further back on request", async () => {
    const w = (await get("/api/dataset")).json();
    const earlier = (await get("/api/dataset?from=2026-01-05")).json();
    expect(earlier.detailFrom).toBe("2026-01-05");
    expect(earlier.timeEntries.filter((e: Entry) => !e.summary).length).toBeGreaterThan(w.timeEntries.filter((e: Entry) => !e.summary).length);
  });

  it("updates the totals when an older booking changes", async () => {
    const w = (await get("/api/dataset")).json();
    const all = (await get("/api/dataset?all=1")).json();
    const old = all.timeEntries.find((e: Entry & { id: string }) => e.date < w.detailFrom);
    const total = (d: { timeEntries: Entry[] }) => d.timeEntries.reduce((s, e) => s + e.hours, 0);
    const before = total(w);
    // Reopen is not needed: the sample's old months are open. Change the hours of one old booking.
    const res = await t.app.inject({ method: "PATCH", url: `/api/time-entries/${old.id}`, headers: { cookie: anna }, payload: { hours: old.hours + 1 } });
    expect(res.statusCode).toBe(200);
    expect(total((await get("/api/dataset")).json())).toBeCloseTo(before + 1, 5);
  });

  it("compresses large answers", async () => {
    const res = await get("/api/dataset", { "accept-encoding": "gzip, br" });
    expect(res.headers["content-encoding"]).toBe("gzip");
    const plain = await get("/api/dataset");
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(res.rawPayload.length * 4).toBeLessThan(plain.rawPayload.length);
  });
});
