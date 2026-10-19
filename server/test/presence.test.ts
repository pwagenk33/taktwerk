import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let anna: string;
let lea: string;

beforeAll(async () => {
  t = await setup();
  anna = (await login(t.app, "anna.keller")).cookie;
  lea = (await login(t.app, "lea.meier")).cookie;
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

const stamp = (action: string, cookie: string) => t.app.inject({ method: "POST", url: "/api/presence/stamp", payload: { action }, headers: { cookie } });
const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(new Date());

describe("come/go recording (Art. 73 ArGV 1)", () => {
  it("is off by default and switched on per company", async () => {
    expect((await stamp("in", lea)).statusCode).toBe(409);
    const res = await t.app.inject({ method: "PUT", url: "/api/settings", headers: { cookie: anna }, payload: { timeModel: "full" } });
    expect(res.json().timeModel).toBe("full");
    expect((await t.app.inject({ method: "GET", url: "/api/dataset", headers: { cookie: lea } })).json().workModel.timeModel).toBe("full");
  });

  it("stamps in, break, resume, out and reports the day", async () => {
    expect((await stamp("resume", lea)).statusCode).toBe(409);
    const a = (await stamp("in", lea)).json();
    expect(a).toMatchObject({ date: today, state: "working" });
    expect(a.periods).toHaveLength(1);
    expect((await stamp("in", lea)).statusCode).toBe(409);
    expect((await stamp("break", lea)).json().state).toBe("break");
    expect((await stamp("resume", lea)).json().state).toBe("working");
    const out = (await stamp("out", lea)).json();
    expect(out.state).toBe("off");
    expect(out.periods).toHaveLength(3);
    expect(out.periods.every((p: { end?: string }) => p.end)).toBe(true);
    const d = (await t.app.inject({ method: "GET", url: "/api/dataset", headers: { cookie: lea } })).json();
    expect(d.workPeriods.filter((p: { date: string }) => p.date === today)).toHaveLength(3);
  });

  it("adds forgotten periods by hand, without overlaps, and checks the law", async () => {
    const post = (payload: object, cookie = lea) => t.app.inject({ method: "POST", url: "/api/presence", payload, headers: { cookie } });
    const ok = await post({ date: "2026-10-05", start: "07:00", end: "12:00" });
    expect(ok.statusCode).toBe(201);
    expect((await post({ date: "2026-10-05", start: "11:00", end: "13:00" })).statusCode).toBe(409);
    expect((await post({ date: "2026-10-05", start: "12:30", end: "12:00" })).statusCode).toBe(400);
    expect((await post({ date: "2026-10-05", start: "12:00", end: "17:30" })).statusCode).toBe(201);
    const mine = (await t.app.inject({ method: "GET", url: "/api/presence?from=2026-10-05&to=2026-10-05", headers: { cookie: lea } })).json();
    expect(mine).toHaveLength(2);
    // Jonas (plain employee) sees nothing of Lea; Anna sees everything.
    const jonas = (await login(t.app, "jonas.weber")).cookie;
    expect((await t.app.inject({ method: "GET", url: "/api/presence?from=2026-10-05&to=2026-10-05", headers: { cookie: jonas } })).json()).toHaveLength(0);
    expect((await t.app.inject({ method: "GET", url: "/api/presence?from=2026-10-05&to=2026-10-05", headers: { cookie: anna } })).json()).toHaveLength(2);
    // Editing and deleting
    const upd = await t.app.inject({ method: "PUT", url: `/api/presence/${ok.json().id}`, payload: { end: "11:30" }, headers: { cookie: lea } });
    expect(upd.json().end).toBe("11:30");
    expect((await t.app.inject({ method: "DELETE", url: `/api/presence/${ok.json().id}`, headers: { cookie: jonas } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: "DELETE", url: `/api/presence/${ok.json().id}`, headers: { cookie: lea } })).statusCode).toBe(200);
  });
});
