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

const get = (url: string, cookie = "", host?: string) => t.app.inject({ method: "GET", url, headers: { cookie, ...(host ? { host } : {}) } });
const post = (url: string, payload: object, cookie = "", host?: string) => t.app.inject({ method: "POST", url, payload, headers: { cookie, ...(host ? { host } : {}) } });

describe("several companies on one installation", () => {
  it("the operator creates a company; its admin only sees its own data", async () => {
    expect((await get("/api/platform/orgs", (await login(t.app, "marco.brunner")).cookie)).statusCode).toBe(403);
    const before = (await get("/api/platform/orgs", anna)).json();
    expect(before.orgs).toHaveLength(1);
    expect(before.orgs[0]).toMatchObject({ name: "Beispiel AG", slug: "beispiel", users: 7 });

    const created = await post("/api/platform/orgs", { name: "Zweite GmbH", domain: "zeit.zweite.ch", adminName: "Rita Roth", adminEmail: "rita@zweite.ch" }, anna);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "Zweite GmbH", slug: "zweite-gmbh", domain: "zeit.zweite.ch", users: 1 });
    const mail = t.mailer.outbox.at(-1)!;
    expect(mail.to).toBe("rita@zweite.ch");
    const link = mail.text.match(/https:\/\/zeit\.zweite\.ch\/passwort\?token=([^\s]+)/)!;
    expect(link).toBeTruthy();

    // Rita sets her password and is signed in to an empty company.
    const set = await post("/api/auth/password/set", { token: decodeURIComponent(link[1]), password: "ganz-sicheres-passwort-9" });
    expect(set.statusCode).toBe(200);
    const rita = `tw_session=${set.cookies.find((c) => c.name === "tw_session")!.value}`;
    const me = (await get("/api/auth/me", rita)).json();
    expect(me).toMatchObject({ role: "admin", platformAdmin: false });
    const d = (await get("/api/dataset", rita)).json();
    expect(d.customers).toEqual([]);
    expect(d.employees.map((e: { name: string }) => e.name)).toEqual(["Rita Roth"]);
    expect((await get("/api/users", rita)).json()).toHaveLength(1);

    // Rita creates a customer; Anna's company does not see it, and vice versa.
    const c = await post("/api/customers", { name: "Kunde von Zweite", hourlyRate: 150 }, rita);
    expect(c.statusCode).toBe(201);
    expect((await get("/api/dataset", anna)).json().customers.some((x: { name: string }) => x.name === "Kunde von Zweite")).toBe(false);
    expect((await get("/api/dataset", rita)).json().customers.map((x: { name: string }) => x.name)).toEqual(["Kunde von Zweite"]);
    expect((await get("/api/settings", rita)).json().name).toBe("Zweite GmbH");
  });

  it("branding and sign-in follow the host name", async () => {
    const [org] = (await get("/api/platform/orgs", anna)).json().orgs.filter((o: { slug: string }) => o.slug === "zweite-gmbh");
    const admin2 = (await login(t.app, "rita@zweite.ch", "ganz-sicheres-passwort-9")).cookie;
    await t.app.inject({ method: "PUT", url: "/api/settings", headers: { cookie: admin2 }, payload: { branding: { appName: "ZweiteZeit", primaryColor: "#112233", showMotif: false } } });
    expect((await get("/api/branding", "", "zeit.zweite.ch")).json().appName).toBe("ZweiteZeit");
    // Neutral host with two companies: default branding.
    expect((await get("/api/branding")).json().appName).toBe("TrackInsight");

    // Anna cannot sign in on the second company's domain.
    const wrong = await post("/api/auth/login", { username: "anna.keller", password: "test-passwort-123" }, "", "zeit.zweite.ch");
    expect(wrong.statusCode).toBe(403);
    expect((await post("/api/auth/login", { username: "rita@zweite.ch", password: "ganz-sicheres-passwort-9" }, "", "zeit.zweite.ch")).statusCode).toBe(200);

    const key = (await t.app.inject({ method: "POST", url: "/api/integrations/keys", headers: { cookie: admin2 }, payload: { name: "BI", scope: "read" } })).json().key as string;
    const viaKey = () => t.app.inject({ method: "GET", url: "/api/v1/customers", headers: { authorization: `Bearer ${key}` } });
    expect((await viaKey()).statusCode).toBe(200);

    // Deactivating a company signs everyone out and blocks sign-in and its API keys.
    const off = await t.app.inject({ method: "PATCH", url: `/api/platform/orgs/${org.id}`, headers: { cookie: anna }, payload: { active: false } });
    expect(off.json().active).toBe(false);
    expect((await get("/api/auth/me", admin2)).statusCode).toBe(401);
    expect((await post("/api/auth/login", { username: "rita@zweite.ch", password: "ganz-sicheres-passwort-9" })).statusCode).toBe(403);
    expect((await viaKey()).statusCode).toBe(401);
    await t.app.inject({ method: "PATCH", url: `/api/platform/orgs/${org.id}`, headers: { cookie: anna }, payload: { active: true } });
  });

  it("companies register themselves when registration is open", async () => {
    const res = await post("/api/orgs/register", { company: "Dritte AG", name: "Dani Dritt", email: "dani@dritte.ch", password: "noch-ein-sicheres-pw-7" });
    expect(res.statusCode).toBe(201);
    expect(res.json().slug).toBe("dritte-ag");
    const cookie = `tw_session=${res.cookies.find((c) => c.name === "tw_session")!.value}`;
    expect((await get("/api/auth/me", cookie)).json()).toMatchObject({ name: "Dani Dritt", role: "admin" });
    expect((await post("/api/orgs/register", { company: "Dritte AG", name: "X", email: "dani@dritte.ch", password: "noch-ein-sicheres-pw-7" })).statusCode).toBe(409);
    expect((await get("/api/auth/providers")).json().registration).toBe(true);
    expect((await get("/api/platform/orgs", anna)).json().orgs).toHaveLength(3);
  });
});
