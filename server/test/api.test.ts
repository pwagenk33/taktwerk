import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organizations, users } from "../src/db/schema";
import { resolveOAuthUser } from "../src/routes/auth";
import { PASSWORD, login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  t = await setup({ GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret", MICROSOFT_CLIENT_ID: "mid", MICROSOFT_CLIENT_SECRET: "msecret" });
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

const get = (url: string, cookie: string) => t.app.inject({ method: "GET", url, headers: { cookie } });
const post = (url: string, cookie: string, payload: object, headers: Record<string, string> = {}) =>
  t.app.inject({ method: "POST", url, headers: { cookie, ...headers }, payload });

describe("login with username and password", () => {
  it("rejects a wrong password and accepts username or e-mail", async () => {
    expect((await login(t.app, "anna.keller", "falsch")).res.statusCode).toBe(401);
    const byName = await login(t.app, "anna.keller");
    expect(byName.res.statusCode).toBe(200);
    expect(byName.res.cookies[0]).toMatchObject({ httpOnly: true, sameSite: "Lax", secure: true });
    expect((await login(t.app, "Anna.Keller@Beispiel.ch")).res.statusCode).toBe(200);
  });

  it("logout ends the session", async () => {
    const { cookie } = await login(t.app, "marco.brunner");
    expect((await get("/api/auth/me", cookie)).json()).toMatchObject({ username: "marco.brunner", role: "consultant" });
    await post("/api/auth/logout", cookie, {});
    expect((await get("/api/auth/me", cookie)).statusCode).toBe(401);
  });

  it("locks after 10 failed attempts", async () => {
    for (let i = 0; i < 10; i++) await login(t.app, "sara.frei", "nope");
    expect((await login(t.app, "sara.frei")).res.statusCode).toBe(429);
  });

  it("refuses state-changing requests from another origin", async () => {
    const { cookie } = await login(t.app, "anna.keller");
    const res = await post("/api/customers", cookie, { name: "X", hourlyRate: 100 }, { origin: "https://evil.example" });
    expect(res.statusCode).toBe(403);
  });
});

describe("roles", () => {
  it("employees see only their own bookings and no budgets", async () => {
    const { cookie } = await login(t.app, "lea.meier");
    const me = (await get("/api/auth/me", cookie)).json();
    const d = (await get("/api/dataset", cookie)).json();
    expect(d.timeEntries.length).toBeGreaterThan(0);
    expect(d.timeEntries.every((e: { employeeId: string }) => e.employeeId === me.id)).toBe(true);
    expect(d.projects.every((p: { budget: number }) => p.budget === 0)).toBe(true);
    expect((await get("/api/reports", cookie)).statusCode).toBe(403);
    expect((await post("/api/customers", cookie, { name: "X", hourlyRate: 100 })).statusCode).toBe(403);
  });

  it("employees cannot book for someone else", async () => {
    const admin = await login(t.app, "anna.keller");
    const d = (await get("/api/dataset", admin.cookie)).json();
    const { cookie } = await login(t.app, "lea.meier");
    const other = d.employees.find((e: { name: string }) => e.name === "Jonas Weber").id;
    const res = await post("/api/time-entries", cookie, { employeeId: other, subProjectId: d.subProjects[0].id, date: "2026-10-16", hours: 1, reason: "Test" });
    expect(res.statusCode).toBe(403);
  });

  it("keeps at least one active admin", async () => {
    const { cookie } = await login(t.app, "anna.keller");
    const me = (await get("/api/auth/me", cookie)).json();
    const res = await t.app.inject({ method: "PATCH", url: `/api/users/${me.id}`, headers: { cookie }, payload: { role: "employee" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("bookings and reports", () => {
  it("freezes the customer rate valid on the booking date", async () => {
    const { cookie } = await login(t.app, "lea.meier");
    const d = (await get("/api/dataset", cookie)).json();
    const alpen = d.customers.find((c: { name: string }) => c.name === "Alpenbank AG");
    const project = d.projects.find((p: { customerId: string }) => p.customerId === alpen.id);
    const sub = d.subProjects.find((s: { projectId: string }) => s.projectId === project.id);
    const june = await post("/api/time-entries", cookie, { subProjectId: sub.id, date: "2026-06-30", hours: 2, reason: "Nachtrag Juni" });
    const july = await post("/api/time-entries", cookie, { subProjectId: sub.id, date: "2026-07-01", hours: 2, reason: "Nachtrag Juli" });
    expect(june.json().hourlyRate).toBe(180);
    expect(july.json().hourlyRate).toBe(190);
  });

  it("requires a reason", async () => {
    const { cookie } = await login(t.app, "lea.meier");
    const d = (await get("/api/dataset", cookie)).json();
    const res = await post("/api/time-entries", cookie, { subProjectId: d.subProjects[0].id, date: "2026-10-16", hours: 1, reason: " " });
    expect(res.statusCode).toBe(400);
  });

  it("reports budget and forecast for each project", async () => {
    const { cookie } = await login(t.app, "marco.brunner");
    const reports = (await get("/api/reports?window=3", cookie)).json();
    expect(reports).toHaveLength(5);
    for (const r of reports) expect(r.forecastCost).toBeGreaterThanOrEqual(r.actualCost);
  });
});

describe("invitation and password reset by e-mail", () => {
  it("invites a user who sets a password through the link", async () => {
    const { cookie } = await login(t.app, "anna.keller");
    const res = await post("/api/users", cookie, { name: "Reto Zürcher", email: "reto@firma.ch", username: "reto.z", role: "employee" });
    expect(res.statusCode).toBe(201);
    const mail = t.mailer.outbox.at(-1)!;
    expect(mail.to).toBe("reto@firma.ch");
    expect(mail.html).toContain("#6D4CF0");
    const token = decodeURIComponent(mail.text.match(/token=([^\s]+)/)![1]);
    expect((await post("/api/auth/password/set", "", { token, password: "kurz" })).statusCode).toBe(400);
    expect((await post("/api/auth/password/set", "", { token, password: "ein-gutes-passwort" })).statusCode).toBe(200);
    expect((await post("/api/auth/password/set", "", { token, password: "noch-ein-passwort" })).statusCode).toBe(400);
    expect((await login(t.app, "reto.z", "ein-gutes-passwort")).res.statusCode).toBe(200);
  });

  it("sends a reset mail only for known addresses but answers the same", async () => {
    const before = t.mailer.outbox.length;
    expect((await post("/api/auth/password/forgot", "", { email: "niemand@firma.ch" })).statusCode).toBe(200);
    expect(t.mailer.outbox.length).toBe(before);
    expect((await post("/api/auth/password/forgot", "", { email: "nina.huber@beispiel.ch" })).statusCode).toBe(200);
    expect(t.mailer.outbox.at(-1)!.subject).toContain("Passwort zurücksetzen");
    const token = decodeURIComponent(t.mailer.outbox.at(-1)!.text.match(/token=([^\s]+)/)![1]);
    await post("/api/auth/password/set", "", { token, password: "neues-passwort-99" });
    expect((await login(t.app, "nina.huber", PASSWORD)).res.statusCode).toBe(401);
    expect((await login(t.app, "nina.huber", "neues-passwort-99")).res.statusCode).toBe(200);
  });
});

describe("Microsoft and Google sign-in", () => {
  it("lists configured providers and redirects with PKCE and state", async () => {
    expect((await get("/api/auth/providers", "")).json()).toEqual({ password: true, microsoft: true, google: true, registration: false, saas: false });
    const g = await get("/api/auth/google", "");
    expect(g.statusCode).toBe(302);
    const url = new URL(g.headers.location as string);
    expect(url.host).toBe("accounts.google.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("https://zeit.example.ch/api/auth/google/callback");
    const m = await get("/api/auth/microsoft", "");
    expect(new URL(m.headers.location as string).host).toBe("login.microsoftonline.com");
  });

  it("rejects a callback whose state does not match", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/auth/google/callback?code=x&state=a", headers: { cookie: "tw_oauth_state=b; tw_oauth_verifier=v" } });
    expect(res.headers.location).toBe("https://zeit.example.ch/?anmeldung=abgebrochen");
  });

  it("links by e-mail, refuses unknown users, and auto-provisions allowed domains", async () => {
    const ctx = t.app.ctx;
    const linked = await resolveOAuthUser(ctx, "microsoft", "ms-sub-1", "marco.brunner@beispiel.ch", "Marco Brunner");
    const [marco] = await t.db.select().from(users).where(eq(users.username, "marco.brunner"));
    expect(linked).toBe(marco.id);
    expect(await resolveOAuthUser(ctx, "microsoft", "ms-sub-1", "", "")).toBe(marco.id); // via stored link
    expect(await resolveOAuthUser(ctx, "google", "g-unknown", "fremd@gmail.com", "Fremd")).toBeNull();

    const [org] = await t.db.select().from(organizations);
    await t.db.update(organizations).set({ settings: { ...org.settings, ssoAutoProvisionDomains: ["firma.ch"] } });
    const created = await resolveOAuthUser(ctx, "google", "g-new", "neu@firma.ch", "Neu Person");
    const [u] = await t.db.select().from(users).where(eq(users.email, "neu@firma.ch"));
    expect(created).toBe(u.id);
    expect(u.role).toBe("employee");
  });
});

describe("settings", () => {
  it("lets admins change the corporate design, shown publicly on the login page", async () => {
    const { cookie } = await login(t.app, "anna.keller");
    const res = await t.app.inject({ method: "PUT", url: "/api/settings", headers: { cookie }, payload: { branding: { appName: "Zeitwerk", primaryColor: "#7A1F2B", showMotif: false } } });
    expect(res.statusCode).toBe(200);
    expect((await get("/api/branding", "")).json()).toEqual({ appName: "Zeitwerk", primaryColor: "#7A1F2B", showMotif: false });
    const bad = await t.app.inject({ method: "PUT", url: "/api/settings", headers: { cookie }, payload: { branding: { appName: "X", primaryColor: "red", showMotif: true } } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("projects and calendar bookings", () => {
  it("leads change name, budget and JIRA keys of projects and sub-projects", async () => {
    const admin = (await login(t.app, "anna.keller")).cookie;
    const lea = (await login(t.app, "lea.meier")).cookie;
    const d = (await t.app.inject({ method: "GET", url: "/api/dataset", headers: { cookie: admin } })).json();
    const p = d.projects[0];
    const res = await t.app.inject({ method: "PATCH", url: `/api/projects/${p.id}`, headers: { cookie: admin }, payload: { budget: 123000, jiraProjectKey: "neu" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ budget: 123000, jiraProjectKey: "neu", name: p.name });
    const sub = d.subProjects.find((s: { projectId: string }) => s.projectId === p.id);
    expect((await t.app.inject({ method: "PATCH", url: `/api/sub-projects/${sub.id}`, headers: { cookie: admin }, payload: { budget: 50000, jiraEpicKey: null } })).json()).toMatchObject({ budget: 50000, jiraEpicKey: null });
    expect((await t.app.inject({ method: "PATCH", url: `/api/projects/${p.id}`, headers: { cookie: lea }, payload: { budget: 1 } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: "PATCH", url: `/api/projects/${p.id}`, headers: { cookie: admin }, payload: { budget: -5 } })).statusCode).toBe(400);
  });

  it("stores the start time of a booking placed in the calendar", async () => {
    const lea = (await login(t.app, "lea.meier")).cookie;
    const d = (await t.app.inject({ method: "GET", url: "/api/dataset", headers: { cookie: lea } })).json();
    const create = await t.app.inject({ method: "POST", url: "/api/time-entries", headers: { cookie: lea }, payload: { subProjectId: d.subProjects[0].id, date: "2026-10-07", hours: 1.5, reason: "Kalender", startTime: "09:15" } });
    expect(create.statusCode).toBe(201);
    expect(create.json().startTime).toBe("09:15");
    const moved = await t.app.inject({ method: "PATCH", url: `/api/time-entries/${create.json().id}`, headers: { cookie: lea }, payload: { startTime: "13:00", date: "2026-10-08" } });
    expect(moved.json()).toMatchObject({ startTime: "13:00", date: "2026-10-08" });
    expect((await t.app.inject({ method: "PATCH", url: `/api/time-entries/${create.json().id}`, headers: { cookie: lea }, payload: { startTime: "25:00" } })).statusCode).toBe(400);
    const again = (await t.app.inject({ method: "GET", url: "/api/dataset", headers: { cookie: lea } })).json();
    expect(again.timeEntries.find((e: { id: string }) => e.id === create.json().id).startTime).toBe("13:00");
  });
});

describe("dataset transfer", () => {
  it("sends the compact format with the same content and answers an unchanged reload with 304", async () => {
    const { cookie } = await login(t.app, "anna.keller");
    const plain = await get("/api/dataset", cookie);
    const packed = await get("/api/dataset?packed=1", cookie);
    const p = packed.json();
    const { unpack } = await import("@taktwerk/domain");
    expect(unpack(p.packed.timeEntries)).toEqual(plain.json().timeEntries);
    expect(unpack(p.packed.expenses)).toEqual(plain.json().expenses);
    expect(packed.rawPayload.length).toBeLessThan(plain.rawPayload.length);
    const again = await t.app.inject({ method: "GET", url: "/api/dataset?packed=1", headers: { cookie, "if-none-match": String(packed.headers.etag) } });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);
  });
});
