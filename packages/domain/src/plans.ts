/**
 * Subscription packages (SaaS mode), priced per active person and month, at least MIN_SEATS people.
 * Prices are in CHF excl. VAT; a yearly subscription costs ten monthly prices (two months free).
 * Self-hosted installations run without packages and limits.
 */
export type PlanId = "start" | "team" | "business";
export type Feature = "planning" | "portal" | "forecast" | "auditor" | "customDomain" | "prioritySupport";
export type BillingInterval = "month" | "year";
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "expired";

export interface Plan {
  id: PlanId;
  name: string;
  /** Who the package is for, one line on the price table. */
  tagline: string;
  /** CHF per person and month, billed monthly. */
  perUser: number;
  features: Feature[];
  /** What the package adds over the smaller one, for the price table. */
  highlights: string[];
}

export const TRIAL_DAYS = 30;
/** Days after a failed payment or the end of the trial during which the company keeps working normally. */
export const GRACE_DAYS = 7;

export const FEATURE_LABEL: Record<Feature, string> = {
  planning: "Ressourcenplanung",
  portal: "Kundenportal",
  forecast: "JIRA-Forecast und Velocity",
  auditor: "Treuhand-Zugang (nur lesen)",
  customDomain: "Eigene Domain",
  prioritySupport: "Prioritäts-Support",
};

export const PLANS: Plan[] = [
  { id: "start", name: "Start", tagline: "Zeiterfassung für kleine Teams", perUser: 9, features: [], highlights: ["Zeiterfassung und Arbeitszeit", "Absenzen und Spesen", "Kundenreports und QR-Rechnung"] },
  { id: "team", name: "Team", tagline: "Für Agenturen und IT-Dienstleister", perUser: 15, features: ["planning", "portal", "forecast"], highlights: ["Alles aus Start", "JIRA-Forecast und Velocity", "Ressourcenplanung", "Kundenportal"] },
  { id: "business", name: "Business", tagline: "Für grössere Firmen und Treuhand", perUser: 22, features: ["planning", "portal", "forecast", "auditor", "customDomain", "prioritySupport"], highlights: ["Alles aus Team", "Treuhand-Zugang", "Eigene Domain", "Prioritäts-Support"] },
];

export const planById = (id: PlanId | string | null | undefined) => PLANS.find((p) => p.id === id) ?? PLANS[1]!;
/** Every subscription pays for at least this many people. */
export const MIN_SEATS = 3;
/** People that are billed: the active ones, at least MIN_SEATS. */
export const billableSeats = (active: number) => Math.max(MIN_SEATS, Math.ceil(active || 0));
/** Price of one person for one billing period (a year is ten months). */
export const perUserPrice = (plan: Plan, interval: BillingInterval) => (interval === "year" ? plan.perUser * 10 : plan.perUser);
/** Price for the whole company and one billing period. */
export const priceOf = (plan: Plan, interval: BillingInterval, activePeople: number) => perUserPrice(plan, interval) * billableSeats(activePeople);
/** Monthly recurring revenue of one subscription in CHF (yearly price spread over twelve months). */
export const mrrOf = (plan: Plan, interval: BillingInterval, activePeople: number) => Math.round((priceOf(plan, interval, activePeople) / (interval === "year" ? 12 : 1)) * 100) / 100;

export interface Subscription {
  plan: PlanId;
  status: SubscriptionStatus;
  interval: BillingInterval;
  trialEndsAt?: string | null; // ISO date-time
  currentPeriodEnd?: string | null;
  /** Payment through Stripe (card) or by invoice set up by the operator. */
  billing?: "stripe" | "invoice";
}

/** Whether the company may still change data. Trial and payment problems get GRACE_DAYS before read-only. */
export function canWrite(sub: Subscription, now = new Date()): boolean {
  const grace = GRACE_DAYS * 86_400_000;
  if (sub.status === "active") return true;
  if (sub.status === "trialing") return !sub.trialEndsAt || new Date(sub.trialEndsAt).getTime() + grace > now.getTime();
  if (sub.status === "past_due") return !sub.currentPeriodEnd || new Date(sub.currentPeriodEnd).getTime() + grace > now.getTime();
  return false;
}

/** Full days left in the trial (0 on the last day, negative afterwards). */
export function trialDaysLeft(sub: Subscription, now = new Date()): number | null {
  if (sub.status !== "trialing" || !sub.trialEndsAt) return null;
  return Math.ceil((new Date(sub.trialEndsAt).getTime() - now.getTime()) / 86_400_000);
}

export const hasFeature = (sub: Subscription | null | undefined, f: Feature) => !sub || planById(sub.plan).features.includes(f);
