import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { calendarConnections } from "../src/db/schema";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let lea = "";
const calls: { url: string; headers: Record<string, string>; body?: string }[] = [];
const jwt = (claims: object) => `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.x`;

beforeAll(async () => {
  t = await setup({ MICROSOFT_CLIENT_ID: "ms-1", MICROSOFT_CLIENT_SECRET: "ms-secret", GOOGLE_CLIENT_ID: "g-1", GOOGLE_CLIENT_SECRET: "g-secret" });
  lea = (await login(t.app, "lea.meier")).cookie;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = input instanceof Request ? await input.text() : String(init.body ?? "");
    const headers = Object.fromEntries(new Headers(input instanceof Request ? input.headers : init.headers).entries());
    calls.push({ url, headers, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://login.microsoftonline.com/") && url.endsWith("/token")) {
      const p = new URLSearchParams(body);
      if (p.get("grant_type") === "refresh_token") return json({ access_token: "ms-at2", refresh_token: "ms-rt2", expires_in: 3600, token_type: "Bearer" });
      return json({ access_token: "ms-at1", refresh_token: "ms-rt1", expires_in: 3600, token_type: "Bearer", id_token: jwt({ sub: "s", preferred_username: "lea@firma.ch" }) });
    }
    if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "g-at1", refresh_token: "g-rt1", expires_in: 3600, token_type: "Bearer", id_token: jwt({ sub: "g", email: "lea@gmail.com" }) });
    if (url.startsWith("https://graph.microsoft.com/v1.0/me/calendarView")) {
      if (url.includes("page2")) return json({ value: [{ id: "m4", subject: "Workshop", start: { dateTime: "2026-10-21T14:00:00.0000000" }, end: { dateTime: "2026-10-21T15:30:00.0000000" } }] });
      return json({
        value: [
          { id: "m1", subject: "Daily", start: { dateTime: "2026-10-20T09:00:00.0000000" }, end: { dateTime: "2026-10-20T09:15:00.0000000" } },
          { id: "m2", subject: "Ferien Team", isAllDay: true, start: { dateTime: "2026-10-20T00:00:00.0000000" }, end: { dateTime: "2026-10-21T00:00:00.0000000" } },
          { id: "m3", subject: "Abgesagt", responseStatus: { response: "declined" }, start: { dateTime: "2026-10-20T10:00:00.0000000" }, end: { dateTime: "2026-10-20T11:00:00.0000000" } },
        ],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?page2",
      });
    }
    if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events"))
      return json({ items: [
        { id: "g1", summary: "Review Alpenbank", start: { dateTime: "2026-10-22T10:00:00+02:00" }, end: { dateTime: "2026-10-22T11:00:00+02:00" } },
        { id: "g2", summary: "Geburtstag", start: { date: "2026-10-22" }, end: { date: "2026-10-23" } },
        { id: "g3", summary: "Fokuszeit", transparency: "transparent", start: { dateTime: "2026-10-22T13:00:00+02:00" }, end: { dateTime: "2026-10-22T15:00:00+02:00" } },
      ] });
    return json({ error: `unexpected ${url}` }, 500);
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await t.app.close();
  await t.pool.end();
});

async function connect(provider: "microsoft" | "google") {
  const start = await t.app.inject({ method: "GET", url: `/api/calendar/${provider}`, headers: { cookie: lea } });
  expect(start.statusCode).toBe(302);
  const to = new URL(start.headers.location as string);
  return { to, back: await t.app.inject({ method: "GET", url: `/api/calendar/${provider}/callback?code=c&state=${to.searchParams.get("state")}` }) };
}

describe("calendar suggestions", () => {
  it("offers both calendars and connects Outlook read-only", async () => {
    expect((await t.app.inject({ method: "GET", url: "/api/calendar", headers: { cookie: lea } })).json()).toEqual({ providers: { microsoft: true, google: true }, connected: null });
    const { to, back } = await connect("microsoft");
    expect(to.searchParams.get("scope")).toBe("openid email offline_access Calendars.Read");
    expect(to.searchParams.get("redirect_uri")).toBe("https://zeit.example.ch/api/calendar/microsoft/callback");
    expect(back.headers.location).toBe("https://zeit.example.ch/?kalender=ok#profil");
    expect((await t.app.inject({ method: "GET", url: "/api/calendar", headers: { cookie: lea } })).json().connected).toEqual({ provider: "microsoft", account: "lea@firma.ch" });
  });

  it("lists the week's meetings from Outlook in Swiss time, without all-day and declined ones", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/calendar/events?from=2026-10-19&to=2026-10-25", headers: { cookie: lea } });
    expect(res.json()).toEqual([
      { id: "m1", title: "Daily", date: "2026-10-20", start: "09:00", end: "09:15" },
      { id: "m4", title: "Workshop", date: "2026-10-21", start: "14:00", end: "15:30" },
    ]);
    const graph = calls.find((c) => c.url.includes("calendarView") && !c.url.includes("page2"))!;
    expect(new URL(graph.url).searchParams.get("startDateTime")).toBe("2026-10-19T00:00:00+0200");
    expect(new URL(graph.url).searchParams.get("endDateTime")).toBe("2026-10-26T00:00:00+0100");
    expect(graph.headers.authorization).toBe("Bearer ms-at1");
  });

  it("refreshes an expired token", async () => {
    await t.db.update(calendarConnections).set({ expiresAt: new Date(Date.now() - 1000) });
    await t.app.inject({ method: "GET", url: "/api/calendar/events?from=2026-10-19&to=2026-10-25", headers: { cookie: lea } });
    const [conn] = await t.db.select().from(calendarConnections);
    expect(conn).toMatchObject({ accessToken: "ms-at2", refreshToken: "ms-rt2" });
  });

  it("switches to Google and skips free and all-day events", async () => {
    const { to } = await connect("google");
    expect(to.searchParams.get("access_type")).toBe("offline");
    expect(to.searchParams.get("scope")).toContain("calendar.events.readonly");
    const res = await t.app.inject({ method: "GET", url: "/api/calendar/events?from=2026-10-19&to=2026-10-25", headers: { cookie: lea } });
    expect(res.json()).toEqual([{ id: "g1", title: "Review Alpenbank", date: "2026-10-22", start: "10:00", end: "11:00" }]);
    expect((await t.db.select().from(calendarConnections)).length).toBe(1);
  });

  it("rejects long ranges, unknown states and disconnects", async () => {
    expect((await t.app.inject({ method: "GET", url: "/api/calendar/events?from=2026-01-01&to=2026-12-31", headers: { cookie: lea } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: "GET", url: "/api/calendar/google/callback?code=c&state=erfunden" })).statusCode).toBe(400);
    expect((await t.app.inject({ method: "DELETE", url: "/api/calendar", headers: { cookie: lea } })).statusCode).toBe(200);
    const [lUser] = await t.db.select().from(calendarConnections).where(eq(calendarConnections.provider, "google"));
    expect(lUser).toBeUndefined();
  });
});
