// Minimal Stripe client without the SDK: form-encoded REST calls and webhook signature check.
import type { BillingInterval, PlanId } from "@taktwerk/domain";
import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError, type AppContext } from "./app";
import { tr } from "@taktwerk/domain";

export const stripeOn = (ctx: AppContext) => !!ctx.config.STRIPE_SECRET_KEY;

/** "start_month=price_1,team_year=price_2" → lookups in both directions. */
export function stripePrices(ctx: AppContext) {
  const map = new Map<string, string>();
  for (const part of (ctx.config.STRIPE_PRICES ?? "").split(",")) {
    const [key, id] = part.split("=").map((x) => x.trim());
    if (key && id) map.set(key, id);
  }
  return {
    priceFor: (plan: PlanId, interval: BillingInterval) => map.get(`${plan}_${interval}`) ?? null,
    planOf: (priceId: string): { plan: PlanId; interval: BillingInterval } | null => {
      for (const [key, id] of map) if (id === priceId) {
        const [plan, interval] = key.split("_") as [PlanId, BillingInterval];
        return { plan, interval };
      }
      return null;
    },
  };
}

/** Stripe's form encoding: nested objects and arrays as a[b][0]=… */
function encode(params: Record<string, unknown>, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") encode(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe<T = Record<string, any>>(ctx: AppContext, method: "GET" | "POST" | "DELETE", path: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!ctx.config.STRIPE_SECRET_KEY) throw new HttpError(400, tr("Kartenzahlung ist auf dieser Installation nicht eingerichtet."));
  const body = encode(params);
  const url = `https://api.stripe.com/v1${path}${method === "GET" && body.size ? `?${body}` : ""}`;
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${ctx.config.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" },
    ...(method === "GET" ? {} : { body: body.toString() }),
  });
  const json = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new HttpError(502, `Zahlungsanbieter: ${json.error?.message ?? res.status}`);
  return json;
}

/** Checks the Stripe-Signature header (t=…,v1=…) against the raw body; five minutes tolerance. */
export function verifyStripeSignature(rawBody: string, header: string | undefined, secret: string, now = Date.now()) {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || sigs.length === 0 || Math.abs(now / 1000 - Number(t)) > 300) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), expected));
}

/** For tests and local tools: a valid signature header for a body. */
export function signStripePayload(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}
