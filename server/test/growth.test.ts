import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organizations } from "../src/db/schema";
import { PASSWORD, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
const BASE = "trackinsight.test";
const SAMPLE = `beispiel.${BASE}`;

beforeAll(async () => {
  t = await setup({ SAAS: "true", SAAS_BASE_DOMAIN: BASE, REGISTRATION_OPEN: "true" });
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

const req = (method: "GET" | "POST" | "PATCH", url: string, host: string, cookie = "", payload?: object) =>
  t.app.inject({ method, url, headers: { host, cookie }, ...(payload ? { payload } : {}) });
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => `tw_session=${res.cookies.find((x) => x.name === "tw_session")?.value ?? ""}`;
const orgBySlug = async (slug: string) => (await t.db.select().from(organizations).where(eq(organizations.slug, slug)))[0]!;

describe("recommendations and partners", () => {
  let anna = "";
  beforeAll(async () => {
    anna = cookieOf(await req("POST", "/api/auth/login", SAMPLE, "", { username: "anna.keller", password: PASSWORD }));
  });

  it("gives the recommended company a longer trial and the recommending one a free month once it pays", async () => {
    const mine = (await req("GET", "/api/referral", SAMPLE, anna)).json();
    expect(mine.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(mine.link).toBe(`https://zeit.example.ch/registrieren?ref=${mine.code}`);
    expect((await req("GET", "/api/referral", SAMPLE, anna)).json().code).toBe(mine.code);

    const info = (await req("GET", `/api/orgs/register/code?code=${mine.code.toLowerCase()}`, BASE)).json();
    expect(info).toEqual({ kind: "referral", name: "Beispiel AG", trialDays: 60 });
    expect((await req("GET", "/api/orgs/register/code?code=NOPE99", BASE)).statusCode).toBe(404);

    const reg = await req("POST", "/api/orgs/register", BASE, "", { company: "Empfohlen GmbH", name: "Eva Empf", email: "eva@empfohlen.ch", password: "ganz-sicheres-passwort-7", code: mine.code });
    expect(reg.statusCode).toBe(201);
    const fresh = await orgBySlug("empfohlen-gmbh");
    const sample = await orgBySlug("beispiel");
    expect(fresh.referredByOrgId).toBe(sample.id);
    expect(fresh.trialEndsAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 86_400_000);

    // While it tests, nothing is earned; once it pays, one free month is open until the operator credits it.
    expect((await req("GET", "/api/referral", SAMPLE, anna)).json()).toMatchObject({ earned: 0, open: 0, referred: [{ name: "Empfohlen GmbH", paying: false }] });
    await t.db.update(organizations).set({ subStatus: "active" }).where(eq(organizations.id, fresh.id));
    expect((await req("GET", "/api/referral", SAMPLE, anna)).json()).toMatchObject({ earned: 1, open: 1 });
    const ops = (await req("GET", "/api/platform/orgs", SAMPLE, anna)).json() as { orgs: { id: string; freeMonthsOpen: number }[] };
    expect(ops.orgs.find((o) => o.id === sample.id)!.freeMonthsOpen).toBe(1);
    expect((await req("POST", `/api/platform/orgs/${sample.id}/free-month`, SAMPLE, anna, {})).statusCode).toBe(200);
    expect((await req("POST", `/api/platform/orgs/${sample.id}/free-month`, SAMPLE, anna, {})).statusCode).toBe(409);
    expect((await req("GET", "/api/referral", SAMPLE, anna)).json()).toMatchObject({ earned: 1, used: 1, open: 0 });
  });

  it("tracks partner companies and the commission on their revenue", async () => {
    const created = await req("POST", "/api/platform/partners", SAMPLE, anna, { code: "treu-muster", name: "Treuhand Muster", email: "info@treu-muster.ch", commissionPercent: 20, trialDays: 60 });
    expect(created.statusCode).toBe(201);
    expect((await req("POST", "/api/platform/partners", SAMPLE, anna, { code: "TREU-MUSTER", name: "Doppelt", email: "x@y.ch", commissionPercent: 10, trialDays: 30 })).statusCode).toBe(409);

    await req("POST", "/api/orgs/register", BASE, "", { company: "Partnerkunde AG", name: "Paul Kunde", email: "paul@pk.ch", password: "ganz-sicheres-passwort-8", code: "TREU-MUSTER", plan: "business" });
    const pk = await orgBySlug("partnerkunde-ag");
    expect(pk.partnerId).toBe(created.json().id);
    await t.db.update(organizations).set({ subStatus: "active" }).where(eq(organizations.id, pk.id));

    const [p] = (await req("GET", "/api/platform/partners", SAMPLE, anna)).json() as { companies: number; paying: number; mrr: number; commission: number }[];
    expect(p).toMatchObject({ companies: 1, paying: 1 });
    expect(p!.mrr).toBeGreaterThan(0);
    expect(p!.commission).toBeCloseTo(p!.mrr * 0.2, 2);

    // Deactivated partners no longer give anything.
    await req("PATCH", `/api/platform/partners/${created.json().id}`, SAMPLE, anna, { active: false });
    expect((await req("GET", "/api/orgs/register/code?code=TREU-MUSTER", BASE)).statusCode).toBe(404);
  });
});
