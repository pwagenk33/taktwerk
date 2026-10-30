// Outlook (Microsoft 365) and Google calendars as booking suggestions. Each person connects their own
// calendar with read-only access; events of the visible week are fetched live and never stored.
import type { CalendarEvent } from "@taktwerk/domain";
import { Google, MicrosoftEntraId, type OAuth2Tokens } from "arctic";
import { eq } from "drizzle-orm";
import { HttpError, type AppContext } from "./app";
import { calendarConnections } from "./db/schema";
import { tr } from "@taktwerk/domain";
import { zurichOffset } from "./tz";

export type CalendarProvider = "microsoft" | "google";
export type CalendarConnection = typeof calendarConnections.$inferSelect;

/** Read-only access to events; offline_access / access_type=offline give the refresh token. */
export const CALENDAR_SCOPES: Record<CalendarProvider, string[]> = {
  microsoft: ["openid", "email", "offline_access", "Calendars.Read"],
  google: ["openid", "email", "https://www.googleapis.com/auth/calendar.events.readonly"],
};

export function calendarClient(ctx: AppContext, provider: CalendarProvider) {
  const c = ctx.config;
  const redirect = `${new URL(c.APP_URL).origin}/api/calendar/${provider}/callback`;
  if (provider === "microsoft" && c.MICROSOFT_CLIENT_ID && c.MICROSOFT_CLIENT_SECRET)
    return new MicrosoftEntraId(c.MICROSOFT_TENANT, c.MICROSOFT_CLIENT_ID, c.MICROSOFT_CLIENT_SECRET, redirect);
  if (provider === "google" && c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET) return new Google(c.GOOGLE_CLIENT_ID, c.GOOGLE_CLIENT_SECRET, redirect);
  return null;
}

export function authorizationUrl(ctx: AppContext, provider: CalendarProvider, state: string, verifier: string) {
  const url = calendarClient(ctx, provider)!.createAuthorizationURL(state, verifier, CALENDAR_SCOPES[provider]);
  if (provider === "google") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  }
  return url;
}

export const expiryOf = (t: OAuth2Tokens) => {
  try { return t.accessTokenExpiresAt(); } catch { return new Date(Date.now() + 3600_000); }
};

async function accessToken(ctx: AppContext, conn: CalendarConnection) {
  if (conn.expiresAt.getTime() - 60_000 > Date.now()) return conn.accessToken;
  const client = calendarClient(ctx, conn.provider);
  if (!client || !conn.refreshToken) throw new HttpError(401, tr("Die Verbindung mit dem Kalender ist abgelaufen. Bitte im Profil neu verbinden."));
  let t: OAuth2Tokens;
  try {
    t = client instanceof Google ? await client.refreshAccessToken(conn.refreshToken) : await client.refreshAccessToken(conn.refreshToken, CALENDAR_SCOPES.microsoft);
  } catch {
    throw new HttpError(401, tr("Die Verbindung mit dem Kalender ist abgelaufen. Bitte im Profil neu verbinden."));
  }
  conn.accessToken = t.accessToken();
  if (t.hasRefreshToken()) conn.refreshToken = t.refreshToken();
  conn.expiresAt = expiryOf(t);
  await ctx.db.update(calendarConnections).set({ accessToken: conn.accessToken, refreshToken: conn.refreshToken, expiresAt: conn.expiresAt }).where(eq(calendarConnections.userId, conn.userId));
  return conn.accessToken;
}

const nextDay = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10);
/** "2026-10-20T13:30:00…" in Zurich time → date and HH:MM; an event running past midnight ends at 23:59. */
const local = (start: string, end: string) => ({ date: start.slice(0, 10), start: start.slice(11, 16), end: end.slice(0, 10) === start.slice(0, 10) ? end.slice(11, 16) : "23:59" });

interface GraphEvent { id: string; subject?: string; isAllDay?: boolean; isCancelled?: boolean; showAs?: string; responseStatus?: { response?: string }; start: { dateTime: string }; end: { dateTime: string } }
interface GoogleEvent { id: string; summary?: string; status?: string; transparency?: string; attendees?: { self?: boolean; responseStatus?: string }[]; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string } }

/** Timed events between `from` and `to` (inclusive) that the person attends; all-day, declined, cancelled and «free» ones are left out. */
export async function calendarEvents(ctx: AppContext, conn: CalendarConnection, from: string, to: string): Promise<CalendarEvent[]> {
  const token = await accessToken(ctx, conn);
  const min = `${from}T00:00:00${zurichOffset(from, "00:00")}`;
  const max = `${nextDay(to)}T00:00:00${zurichOffset(nextDay(to), "00:00")}`;
  const get = async <T>(url: string, headers: Record<string, string> = {}) => {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json", ...headers } });
    if (res.status === 401) throw new HttpError(401, tr("Die Verbindung mit dem Kalender ist abgelaufen. Bitte im Profil neu verbinden."));
    if (!res.ok) throw new HttpError(502, tr("Der Kalender antwortet mit Fehler {0}.", res.status));
    return (await res.json()) as T;
  };
  const out: CalendarEvent[] = [];
  if (conn.provider === "microsoft") {
    const q = new URLSearchParams({ startDateTime: min, endDateTime: max, $select: "id,subject,start,end,isAllDay,isCancelled,showAs,responseStatus", $orderby: "start/dateTime", $top: "250" });
    let url: string | undefined = `https://graph.microsoft.com/v1.0/me/calendarView?${q}`;
    while (url && out.length < 1000) {
      const page: { value: GraphEvent[]; "@odata.nextLink"?: string } = await get(url, { prefer: 'outlook.timezone="W. Europe Standard Time"' });
      for (const e of page.value) {
        if (e.isAllDay || e.isCancelled || e.showAs === "free" || e.responseStatus?.response === "declined") continue;
        out.push({ id: e.id, title: (e.subject ?? "").trim() || tr("Termin"), ...local(e.start.dateTime, e.end.dateTime) });
      }
      url = page["@odata.nextLink"];
    }
  } else {
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ timeMin: min, timeMax: max, singleEvents: "true", orderBy: "startTime", maxResults: "250", timeZone: "Europe/Zurich", ...(pageToken ? { pageToken } : {}) });
      const page: { items: GoogleEvent[]; nextPageToken?: string } = await get(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`);
      for (const e of page.items) {
        if (e.status === "cancelled" || !e.start.dateTime || !e.end.dateTime || e.transparency === "transparent") continue;
        if (e.attendees?.find((a) => a.self)?.responseStatus === "declined") continue;
        out.push({ id: e.id, title: (e.summary ?? "").trim() || tr("Termin"), ...local(e.start.dateTime, e.end.dateTime) });
      }
      pageToken = page.nextPageToken;
    } while (pageToken && out.length < 1000);
  }
  return out.filter((e) => e.date >= from && e.date <= to);
}
