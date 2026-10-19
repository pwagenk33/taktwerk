import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PASSWORD, login, setup } from "./helpers";
import { purgeExpired } from "../src/routes/privacy";

let t: Awaited<ReturnType<typeof setup>>;
let anna: string;
let ids: Record<string, string>;

beforeAll(async () => {
  t = await setup();
  anna = (await login(t.app, "anna.keller")).cookie;
  const users = (await t.app.inject({ method: "GET", url: "/api/users", headers: { cookie: anna } })).json() as { id: string; username: string }[];
  ids = Object.fromEntries(users.map((u) => [u.username, u.id]));
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

describe("data protection (DSG)", () => {
  it("everyone downloads the own data; admins that of any person", async () => {
    const lea = (await login(t.app, "lea.meier")).cookie;
    const res = await t.app.inject({ method: "GET", url: "/api/me/export", headers: { cookie: lea } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/auskunft-lea\.meier-\d{4}-\d{2}-\d{2}\.json/);
    const data = res.json();
    expect(data.person).toMatchObject({ name: "Lea Meier", email: "lea.meier@beispiel.ch", rolle: "employee" });
    expect(data.person.passwordHash).toBeUndefined();
    expect(data.zeitbuchungen.length).toBeGreaterThan(10);
    expect(data.person.sitzungen.length).toBeGreaterThan(0);
    expect((await t.app.inject({ method: "GET", url: `/api/users/${ids["lea.meier"]}/export`, headers: { cookie: lea } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: "GET", url: `/api/users/${ids["lea.meier"]}/export`, headers: { cookie: anna } })).json().person.name).toBe("Lea Meier");
  });

  it("anonymizes a deactivated person and keeps the bookings", async () => {
    const id = ids["luca.schmid"];
    const post = (payload: object) => t.app.inject({ method: "POST", url: `/api/users/${id}/anonymize`, headers: { cookie: anna }, payload });
    expect((await post({ password: PASSWORD })).statusCode).toBe(409); // still active
    await t.app.inject({ method: "PATCH", url: `/api/users/${id}`, headers: { cookie: anna }, payload: { active: false } });
    expect((await post({ password: "falsch" })).statusCode).toBe(403);
    const before = (await t.app.inject({ method: "GET", url: "/api/dataset", headers: { cookie: anna } })).json().timeEntries.filter((e: { employeeId: string }) => e.employeeId === id).length;
    expect(before).toBeGreaterThan(0);
    expect((await post({ password: PASSWORD })).json()).toEqual({ id, name: "Ehemalige Person" });
    const users = (await t.app.inject({ method: "GET", url: "/api/users", headers: { cookie: anna } })).json() as { id: string; name: string; email: string; username: string }[];
    const u = users.find((x) => x.id === id)!;
    expect(u.name).toBe("Ehemalige Person");
    expect(u.email).toMatch(/@geloescht\.invalid$/);
    expect((await login(t.app, "luca.schmid")).res.statusCode).not.toBe(200);
    const after = (await t.app.inject({ method: "GET", url: "/api/dataset", headers: { cookie: anna } })).json().timeEntries.filter((e: { employeeId: string }) => e.employeeId === id).length;
    expect(after).toBe(before);
  });

  it("the cleanup job removes expired sessions only", async () => {
    const lea = (await login(t.app, "lea.meier")).cookie;
    await purgeExpired(t.app.ctx, new Date(Date.now() + 400 * 86_400_000));
    expect((await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: lea } })).statusCode).toBe(401);
    expect((await login(t.app, "lea.meier")).res.statusCode).toBe(200);
  });
});
