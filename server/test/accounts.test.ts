import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let anna: string;

beforeAll(async () => {
  t = await setup({ REGISTRATION_OPEN: "true" });
  anna = (await login(t.app, "anna.keller")).cookie;
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

const post = (url: string, payload: object, cookie = "") => t.app.inject({ method: "POST", url, payload, headers: cookie ? { cookie } : {} });
const get = (url: string, cookie: string) => t.app.inject({ method: "GET", url, headers: { cookie } });
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => `tw_session=${res.cookies.find((c) => c.name === "tw_session")!.value}`;

describe("one person in several companies", () => {
  it("lets a fiduciary sign in to two companies with one address and switch between them", async () => {
    // Second company with its own admin; it invites the same fiduciary as the first one.
    const reg = await post("/api/orgs/register", { company: "Mandant Zwei AG", name: "Mia Zwei", email: "mia@mandant2.ch", password: "sicheres-passwort-22" });
    expect(reg.statusCode).toBe(201);
    const mia = cookieOf(reg);
    for (const [cookie, username] of [[anna, "treu.muster"], [mia, "treu.muster.m2"]] as const) {
      const res = await post("/api/users", { username, name: "Tina Treu", email: "tina@treuhand.ch", role: "auditor" }, cookie);
      expect(res.statusCode).toBe(201);
    }
    // The same address twice in one company stays refused.
    expect((await post("/api/users", { username: "treu.zwei", name: "Tina Treu", email: "tina@treuhand.ch", role: "auditor" }, mia)).statusCode).toBe(409);

    // Both invitations accepted with the same password.
    const links = t.mailer.outbox.filter((m) => m.to === "tina@treuhand.ch").map((m) => /token=([\w-]+)/.exec(m.text)![1]!);
    expect(links).toHaveLength(2);
    for (const token of links) expect((await post("/api/auth/password/set", { token, password: "treuhand-passwort-1" })).statusCode).toBe(200);

    const first = (await post("/api/auth/login", { username: "tina@treuhand.ch", password: "treuhand-passwort-1" })).json();
    expect(first.ok).toBe(false);
    expect(first.choose.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(["Mandant Zwei AG"]));
    const pick = first.choose.find((c: { name: string }) => c.name === "Mandant Zwei AG");
    const signedIn = await post("/api/auth/login", { username: "tina@treuhand.ch", password: "treuhand-passwort-1", organizationId: pick.organizationId });
    expect(signedIn.json().ok).toBe(true);
    const tina = cookieOf(signedIn);
    expect((await get("/api/settings", tina)).json().name).toBe("Mandant Zwei AG");

    const accounts = (await get("/api/auth/accounts", tina)).json();
    expect(accounts.current.name).toBe("Mandant Zwei AG");
    expect(accounts.others).toHaveLength(1);
    const switched = await post("/api/auth/switch", { organizationId: accounts.others[0].organizationId }, tina);
    expect(switched.statusCode).toBe(200);
    const tina2 = cookieOf(switched);
    expect((await get("/api/settings", tina2)).json().name).not.toBe("Mandant Zwei AG");
    // The old session is closed; switching to a company without an account fails.
    expect((await get("/api/auth/me", tina)).statusCode).toBe(401);
    expect((await post("/api/auth/switch", { organizationId: "nope" }, tina2)).statusCode).toBe(404);

    // The fiduciary overview lists both companies with key figures.
    const mandates = (await get("/api/mandates", tina2)).json();
    expect(mandates.mandates).toHaveLength(2);
    expect(mandates.mandates.filter((m: { current: boolean }) => m.current)).toHaveLength(1);
    expect(mandates.mandates.every((m: { people: number }) => m.people >= 1)).toBe(true);
  });
});
