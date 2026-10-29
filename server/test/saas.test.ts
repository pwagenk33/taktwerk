import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organizations } from "../src/db/schema";
import { runSubscriptionJobs } from "../src/jobs";
import { PASSWORD, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
const BASE = "trackinsight.test";
const SAMPLE = `beispiel.${BASE}`;

beforeAll(async () => {
  t = await setup({ SAAS: "true", SAAS_BASE_DOMAIN: BASE, REGISTRATION_OPEN: "true", OPERATOR_EMAIL: "betrieb@trackinsight.test" });
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

const req = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, host: string, cookie = "", payload?: object) =>
  t.app.inject({ method, url, headers: { host, cookie }, ...(payload ? { payload } : {}) });
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === "tw_session");
  return c ? `tw_session=${c.value}` : "";
};
const login = async (username: string, host = SAMPLE) => cookieOf(await req("POST", "/api/auth/login", host, "", { username, password: PASSWORD }));
const sampleOrg = async () => (await t.db.select().from(organizations).where(eq(organizations.slug, "beispiel")))[0]!;

describe("SaaS: packages, trial and own address", () => {
  it("registration on the shared address starts a trial and hands the session over to the company's address", async () => {
    const res = await req("POST", "/api/orgs/register", BASE, "", { company: "Neue Firma GmbH", name: "Nina Neu", email: "nina@neu.ch", password: "ganz-sicheres-passwort-9", plan: "start" });
    expect(res.statusCode).toBe(201);
    expect(cookieOf(res)).toBe(""); // no session on the shared address
    const { redirect, slug } = res.json();
    expect(slug).toBe("neue-firma-gmbh");
    const url = new URL(redirect);
    expect(url.host).toBe(`neue-firma-gmbh.${BASE}`);

    const hand = await req("GET", `${url.pathname}${url.search}`, url.host);
    expect(hand.statusCode).toBe(302);
    expect(hand.headers.location).toBe("/");
    const nina = cookieOf(hand);
    const me = (await req("GET", "/api/auth/me", url.host, nina)).json();
    expect(me.subscription).toMatchObject({ plan: "start", status: "trialing" });
    expect(new Date(me.subscription.trialEndsAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    // One-time: the same link does not work twice, and not on another company's address.
    expect((await req("GET", `${url.pathname}${url.search}`, url.host)).headers.location).toBe("/?anmeldung=abgelaufen");
    expect(t.mailer.outbox.some((m) => m.to === "betrieb@trackinsight.test" && m.subject.includes("Neue Firma GmbH"))).toBe(true);
    expect(t.mailer.outbox.some((m) => m.to === "nina@neu.ch" && m.text.includes(`https://neue-firma-gmbh.${BASE}`))).toBe(true);

    // The start package has neither the portal nor resource planning.
    const planning = await req("PUT", "/api/planning", url.host, nina, { employeeId: me.id, projectId: "x", week: "2026-W44", hours: 4 });
    expect(planning.statusCode).toBe(402);
    expect(planning.json().error).toContain("Ressourcenplanung");
  });

  it("people sign in only on their own company's address", async () => {
    expect(await login("anna.keller")).not.toBe("");
    const wrong = await req("POST", "/api/auth/login", `neue-firma-gmbh.${BASE}`, "", { username: "anna.keller", password: PASSWORD });
    expect(wrong.statusCode).toBe(403);
    // On the shared address the sign-in continues on the company's address.
    const shared = await req("POST", "/api/auth/login", BASE, "", { username: "anna.keller", password: PASSWORD });
    expect(shared.json().redirect).toMatch(new RegExp(`^https://${SAMPLE.replace(/\./g, "\\.")}/api/auth/handoff\\?token=`));
  });

  it("adding people is never blocked (price per person); the auditor account needs Business", async () => {
    await t.db.update(organizations).set({ plan: "start" }).where(eq(organizations.slug, "beispiel"));
    const anna = await login("anna.keller");
    const add = (i: number, role = "employee") => req("POST", "/api/users", SAMPLE, anna, { name: `Person ${i}`, email: `p${i}@beispiel.ch`, username: `person.${i}`, role });
    // The sample company has 7 people; packages are billed per person, so there is no upper limit.
    for (const i of [1, 2, 3, 4]) expect((await add(i)).statusCode).toBe(201);
    // Auditor accounts are free, but only from Business.
    expect((await add(5, "auditor")).statusCode).toBe(402);
    await t.db.update(organizations).set({ plan: "business" }).where(eq(organizations.slug, "beispiel"));
    expect((await add(5, "auditor")).statusCode).toBe(201);
  });

  it("after the trial and a grace week the company is read-only, but can still choose a package", async () => {
    await t.db.update(organizations).set({ subStatus: "trialing", trialEndsAt: new Date(Date.now() - 3 * 86_400_000) }).where(eq(organizations.slug, "beispiel"));
    let anna = await login("anna.keller");
    expect((await req("POST", "/api/customers", SAMPLE, anna, { name: "Grace AG" })).statusCode).not.toBe(402); // still in the grace week

    await t.db.update(organizations).set({ trialEndsAt: new Date(Date.now() - 10 * 86_400_000) }).where(eq(organizations.slug, "beispiel"));
    anna = await login("anna.keller");
    const locked = await req("POST", "/api/customers", SAMPLE, anna, { name: "Gesperrt AG" });
    expect(locked.statusCode).toBe(402);
    expect(locked.json().error).toContain("Testphase ist abgelaufen");
    expect((await req("GET", "/api/dataset", SAMPLE, anna)).statusCode).toBe(200);
    expect((await req("GET", "/api/auth/me", SAMPLE, anna)).json().subscription.status).toBe("trialing");
    await t.db.update(organizations).set({ subStatus: "active", trialEndsAt: null }).where(eq(organizations.id, (await sampleOrg()).id));
  });

  it("without card payment the package is booked on invoice; the operator is told and renewals follow", async () => {
    const anna = await login("anna.keller");
    await req("POST", "/api/users", SAMPLE, anna, { name: "Person 11", email: "p11@beispiel.ch", username: "person.11", role: "employee" });
    const before = (await req("GET", "/api/subscription", SAMPLE, anna)).json();
    expect(before).toMatchObject({ payment: "invoice", seats: 12 });
    expect(before.plans).toHaveLength(3);
    expect((await req("GET", "/api/subscription", SAMPLE, await login("marco.brunner"))).statusCode).toBe(403);

    const booked = await req("POST", "/api/subscription/checkout", SAMPLE, anna, { plan: "team", interval: "year" });
    expect(booked.statusCode).toBe(200);
    expect(booked.json().subscription).toMatchObject({ plan: "team", status: "active", interval: "year", billing: "invoice" });
    expect(t.mailer.outbox.some((m) => m.to === "betrieb@trackinsight.test" && m.subject === "Rechnung stellen: Beispiel AG, Team" && m.text.includes("CHF 1’800 jährlich für 12 Personen"))).toBe(true);

    // Renewal at the end of the period: the operator is told to invoice again, once.
    const org = await sampleOrg();
    const after = new Date(org.currentPeriodEnd!.getTime() + 3600_000);
    const ours = async (now: Date) => (await runSubscriptionJobs(t.app.ctx, now)).filter((x) => x.endsWith(":beispiel"));
    expect(await ours(after)).toEqual(["renewed:beispiel"]);
    expect(await ours(after)).toEqual([]);

    // Cancelling keeps everything running until the period ends.
    const cancel = await req("POST", "/api/subscription/cancel", SAMPLE, anna);
    expect(cancel.json().canceledAt).toBeTruthy();
    const end = (await sampleOrg()).currentPeriodEnd!;
    expect(await ours(new Date(end.getTime() + 60_000))).toEqual(["canceled:beispiel"]);
    expect((await req("POST", "/api/customers", SAMPLE, anna, { name: "Zu spät AG" })).statusCode).toBe(402);
    // Coming back is possible right away.
    expect((await req("POST", "/api/subscription/checkout", SAMPLE, anna, { plan: "business", interval: "month" })).json().subscription.status).toBe("active");
  });

  it("reminds before the trial ends and closes it after the grace week", async () => {
    const ends = new Date("2026-11-20T10:00:00Z");
    await t.db.update(organizations).set({ subStatus: "trialing", trialEndsAt: ends }).where(eq(organizations.slug, "neue-firma-gmbh"));
    expect(await runSubscriptionJobs(t.app.ctx, new Date("2026-11-13T12:00:00Z"))).toContain("reminder:neue-firma-gmbh:7");
    expect(await runSubscriptionJobs(t.app.ctx, new Date("2026-11-13T12:15:00Z"))).not.toContain("reminder:neue-firma-gmbh:7");
    expect(await runSubscriptionJobs(t.app.ctx, new Date("2026-11-19T12:00:00Z"))).toContain("reminder:neue-firma-gmbh:1");
    expect(t.mailer.outbox.some((m) => m.to === "nina@neu.ch" && m.subject === "Die Testphase endet morgen")).toBe(true);
    expect(await runSubscriptionJobs(t.app.ctx, new Date("2026-11-25T12:00:00Z"))).not.toContain("expired:neue-firma-gmbh");
    expect(await runSubscriptionJobs(t.app.ctx, new Date("2026-11-28T12:00:00Z"))).toContain("expired:neue-firma-gmbh");
    expect((await t.db.select().from(organizations).where(eq(organizations.slug, "neue-firma-gmbh")))[0]!.subStatus).toBe("expired");
  });

  it("certificates only for known addresses; Business companies bring their own domain", async () => {
    const check = async (d: string) => (await req("GET", `/api/tls-check?domain=${d}`, BASE)).statusCode;
    expect(await check(SAMPLE)).toBe(200);
    expect(await check(BASE)).toBe(200);
    expect(await check(`unbekannt.${BASE}`)).toBe(404);
    expect(await check("zeit.fremd.ch")).toBe(404);

    const anna = await login("anna.keller");
    await t.db.update(organizations).set({ plan: "team" }).where(eq(organizations.slug, "beispiel"));
    expect((await req("PUT", "/api/org/domain", SAMPLE, anna, { domain: "zeit.beispiel.ch" })).statusCode).toBe(402);
    await t.db.update(organizations).set({ plan: "business" }).where(eq(organizations.slug, "beispiel"));
    expect((await req("PUT", "/api/org/domain", SAMPLE, anna, { domain: `x.${BASE}` })).statusCode).toBe(400);
    const set = await req("PUT", "/api/org/domain", SAMPLE, anna, { domain: "zeit.beispiel.ch" });
    expect(set.json()).toMatchObject({ origin: "https://zeit.beispiel.ch", dns: { type: "CNAME", name: "zeit.beispiel.ch", value: SAMPLE } });
    expect(await check("zeit.beispiel.ch")).toBe(200);
    // Signing in on the subdomain now continues on the own domain.
    const moved = await req("POST", "/api/auth/login", SAMPLE, "", { username: "anna.keller", password: PASSWORD });
    expect(moved.json().redirect).toMatch(/^https:\/\/zeit\.beispiel\.ch\/api\/auth\/handoff/);
    await req("PUT", "/api/org/domain", "zeit.beispiel.ch", cookieOf(await req("GET", new URL(moved.json().redirect).pathname + new URL(moved.json().redirect).search, "zeit.beispiel.ch")), { domain: null });
    expect((await sampleOrg()).domain).toBeNull();
  });

  it("the operator sees packages, status and monthly revenue and can adjust them", async () => {
    const anna = await login("anna.keller");
    const list = (await req("GET", "/api/platform/orgs", SAMPLE, anna)).json();
    expect(list.saas).toBe(true);
    const beispiel = list.orgs.find((o: { slug: string }) => o.slug === "beispiel");
    expect(beispiel).toMatchObject({ plan: "business", status: "active", interval: "month", origin: `https://${SAMPLE}` });
    expect(beispiel.mrr).toBe(22 * Math.max(3, beispiel.seats));
    expect(list.summary).toMatchObject({ mrr: beispiel.mrr, active: 1 });
    const neu = list.orgs.find((o: { slug: string }) => o.slug === "neue-firma-gmbh");
    const patched = await req("PATCH", `/api/platform/orgs/${neu.id}`, SAMPLE, anna, { subStatus: "trialing", trialEndsAt: "2099-01-31" });
    expect(patched.json()).toMatchObject({ status: "trialing", mrr: 0 });
    expect(new Date(patched.json().trialEndsAt).toISOString()).toBe("2099-01-31T23:59:59.000Z");
  });
});
