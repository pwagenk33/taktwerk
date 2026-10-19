import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoWeekKey, weekRange } from "@taktwerk/domain";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let lead: string, lea: string, jonas: string;

beforeAll(async () => {
  t = await setup();
  [lead, lea, jonas] = await Promise.all(["marco.brunner", "lea.meier", "jonas.weber"].map(async (u) => (await login(t.app, u)).cookie));
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

const get = (url: string, cookie: string) => t.app.inject({ method: "GET", url, headers: { cookie } });
const send = (method: "POST" | "DELETE", url: string, cookie: string) => t.app.inject({ method, url, headers: { cookie } });

describe("week keys", () => {
  it("computes ISO weeks and their ranges", () => {
    expect(isoWeekKey("2026-10-14")).toBe("2026-W42");
    expect(weekRange("2026-W42")).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(isoWeekKey("2027-01-01")).toBe("2026-W53");
    expect(weekRange("2026-W53").from).toBe("2026-12-28");
  });
});

describe("weekly submission", () => {
  it("employees submit and withdraw own weeks, leads see the team overview", async () => {
    const sub = await send("POST", "/api/weeks/2026-W41/submit", lea);
    expect(sub.statusCode).toBe(200);
    expect(sub.json()).toMatchObject({ week: "2026-W41", submitted: true });
    expect(sub.json().hours).toBeGreaterThan(0);
    expect((await send("POST", "/api/weeks/2099-W01/submit", lea)).statusCode).toBe(400);

    const mine = (await get("/api/weeks?from=2026-W40&to=2026-W42", lea)).json();
    expect(mine.map((w: { week: string }) => w.week)).toEqual(["2026-W41"]);
    expect((await get("/api/weeks?from=2026-W40&to=2026-W42", jonas)).json()).toEqual([]);

    expect((await get("/api/weeks/overview?from=2026-W40&to=2026-W42", lea)).statusCode).toBe(403);
    const ov = (await get("/api/weeks/overview?from=2026-W40&to=2026-W42", lead)).json();
    const row = ov.find((p: { name: string }) => p.name === "Lea Meier");
    expect(row.weeks.map((w: { week: string }) => w.week)).toEqual(["2026-W40", "2026-W41", "2026-W42"]);
    expect(row.weeks[1]).toMatchObject({ submitted: true });
    expect(row.weeks[1].due).toBeGreaterThan(30);

    expect((await send("DELETE", "/api/weeks/2026-W41/submit", lea)).json()).toEqual({ week: "2026-W41", submitted: false });
    expect((await get("/api/weeks?from=2026-W40&to=2026-W42", lea)).json()).toEqual([]);
  });
});
