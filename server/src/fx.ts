/** Daily exchange rates (CHF per EUR / USD) from the ECB via frankfurter.app, with a manual fallback in the settings. */
import { eq } from "drizzle-orm";
import type { AppContext } from "./app";
import { organizations } from "./db/schema";

export const FX_URL = "https://api.frankfurter.app/latest?from=CHF&to=EUR,USD";

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Fetches 1 CHF in EUR/USD and inverts to CHF per unit, rounded to 4 places. */
export async function fetchFxRates(fetcher: Fetcher = (u) => fetch(u, { signal: AbortSignal.timeout(10_000) })): Promise<{ rates: { EUR: number; USD: number }; asOf: string; source: string }> {
  const res = await fetcher(FX_URL);
  if (!res.ok) throw new Error(`Kursdienst antwortet mit HTTP ${res.status}.`);
  const body = (await res.json()) as { date?: string; rates?: { EUR?: number; USD?: number } };
  const eur = body.rates?.EUR;
  const usd = body.rates?.USD;
  if (!eur || !usd || !body.date) throw new Error("Kursdienst lieferte keine Kurse.");
  const inv = (x: number) => Math.round((1 / x) * 10000) / 10000;
  return { rates: { EUR: inv(eur), USD: inv(usd) }, asOf: body.date, source: "EZB via frankfurter.app" };
}

/** Stores fresh rates for every organization that has not set its rates by hand. Returns the organizations updated. */
export async function refreshFxRates(ctx: AppContext, fetcher?: Fetcher, today = new Date().toISOString().slice(0, 10)) {
  const orgs = await ctx.db.select().from(organizations);
  const due = orgs.filter((o) => !o.settings.fx?.manual && o.settings.fx?.asOf !== today);
  if (due.length === 0) return [];
  const fx = await fetchFxRates(fetcher);
  for (const o of due) await ctx.db.update(organizations).set({ settings: { ...o.settings, fx } }).where(eq(organizations.id, o.id));
  return due.map((o) => o.id);
}
