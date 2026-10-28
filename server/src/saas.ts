// SaaS mode: packages, trial, limits and the subscription state of a company. Self-hosted installations
// (SAAS unset) run without any of this: every check here passes.
import { GRACE_DAYS, canWrite, hasFeature, planById, FEATURE_LABEL, PLANS, type Feature, type Subscription } from "@taktwerk/domain";
import { and, count, eq, notInArray } from "drizzle-orm";
import { HttpError, type AppContext, type SessionUser } from "./app";
import { organizations, users } from "./db/schema";

type OrgRow = typeof organizations.$inferSelect;

export const saasOn = (ctx: AppContext) => ctx.config.SAAS === "true";

export function subscriptionOf(org: Pick<OrgRow, "plan" | "subStatus" | "billingInterval" | "trialEndsAt" | "currentPeriodEnd" | "billingMode">): Subscription {
  return {
    plan: org.plan,
    status: org.subStatus,
    interval: org.billingInterval,
    trialEndsAt: org.trialEndsAt?.toISOString() ?? null,
    currentPeriodEnd: org.currentPeriodEnd?.toISOString() ?? null,
    billing: org.billingMode,
  };
}

/** The subscription of the user's company in SaaS mode, else null (no limits). */
export async function subscriptionFor(ctx: AppContext, orgId: string): Promise<Subscription | null> {
  if (!saasOn(ctx)) return null;
  const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return org ? subscriptionOf(org) : null;
}

/** Writes allowed while the company is read-only (trial over, payment missing): sign-in, own account, choosing a package. */
export const LOCKED_WRITE_PREFIXES = ["/api/auth/", "/api/me/", "/api/subscription", "/api/billing/", "/api/dashboard"];

export function lockedMessage(sub: Subscription) {
  if (sub.status === "trialing" || sub.status === "expired") return "Die Testphase ist abgelaufen. Unter Einstellungen → Abo wählst du ein Paket, danach geht es sofort weiter. Deine Daten bleiben erhalten.";
  if (sub.status === "past_due") return "Die letzte Zahlung ist offen. Unter Einstellungen → Abo kannst du die Zahlungsdaten aktualisieren.";
  return "Das Abo ist beendet. Unter Einstellungen → Abo kannst du es wieder aufnehmen; deine Daten bleiben erhalten.";
}

export function assertWritable(sub: Subscription | null | undefined) {
  if (sub && !canWrite(sub)) throw new HttpError(402, lockedMessage(sub));
}

/** Throws 402 when the package does not include the feature. */
export function requireFeature(user: SessionUser, feature: Feature) {
  const sub = user.subscription;
  if (!sub || hasFeature(sub, feature)) return;
  const from = PLANS.find((p) => p.features.includes(feature))!;
  throw new HttpError(402, `${FEATURE_LABEL[feature]} ist im Paket ${planById(sub.plan).name} nicht enthalten, erst ab ${from.name}. Wechseln unter Einstellungen → Abo.`);
}

/** Active people that count against the package (portal and auditor accounts are free). */
export async function seatsUsed(ctx: AppContext, orgId: string) {
  const [{ n }] = await ctx.db
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.organizationId, orgId), eq(users.active, true), notInArray(users.role, ["customer", "auditor"])));
  return n;
}

/** Throws 402 when `adding` more people would exceed the package. */
export async function assertSeats(ctx: AppContext, orgId: string, adding = 1) {
  const sub = await subscriptionFor(ctx, orgId);
  if (!sub) return;
  const plan = planById(sub.plan);
  const used = await seatsUsed(ctx, orgId);
  if (used + adding > plan.maxUsers) {
    const next = PLANS.find((p) => p.maxUsers >= used + adding);
    throw new HttpError(402, `Das Paket ${plan.name} umfasst ${plan.maxUsers} Personen, aktiv sind ${used}.${next ? ` Mit ${next.name} sind bis ${next.maxUsers} möglich.` : ""} Wechseln unter Einstellungen → Abo.`);
  }
}

export { GRACE_DAYS };
