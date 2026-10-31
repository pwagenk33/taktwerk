import type { BillingInterval, Dataset, Holiday, Plan, PlanId, PostalAddress, ProjectReport, Role, Subscription, SubscriptionStatus } from "@taktwerk/domain";
import { unpack, type Packed } from "@taktwerk/domain";
import { intlLocale, tr } from "./i18n";

/** Demo mode runs entirely in the browser with example data (shareable prototype build). */
export const DEMO = import.meta.env.VITE_DEMO === "1" || import.meta.env.MODE === "single";

export interface Branding {
  appName: string;
  primaryColor: string;
  showMotif: boolean;
  /** Own logo: a URL on the server, or a data URL in demo mode. */
  logo?: string;
  logoMime?: string;
}

export const DEFAULT_BRANDING: Branding = { appName: "TrackInsight", primaryColor: "#6D4CF0", showMotif: true };

export interface Me {
  id: string;
  name: string;
  username: string;
  email: string;
  role: Role;
  /** Portal accounts: the customer they belong to. */
  customerId?: string | null;
  /** Operator of the installation: may manage the companies on it. */
  platformAdmin?: boolean;
  /** Language chosen in the profile; null until chosen. */
  locale?: "de" | "fr" | "en" | "it" | null;
  /** Employees: projects and teams they lead. */
  leadsProjects?: string[];
  leadsTeams?: string[];
  /** SaaS: package and state of the company's subscription (absent on self-hosted installations). */
  subscription?: Subscription;
}

/** The company's subscription as the admin sees it (Settings → Abo). */
export interface SubscriptionInfo {
  subscription: Subscription;
  canceledAt: string | null;
  seats: number;
  payment: "stripe" | "invoice";
  cardOnFile: boolean;
  plans: Plan[];
}

/** A company on this installation (operator view). */
export interface PlatformOrg {
  id: string;
  name: string;
  slug: string | null;
  domain: string | null;
  active: boolean;
  appName: string;
  users: number;
  createdAt: string;
  origin?: string;
  plan?: PlanId;
  status?: SubscriptionStatus;
  interval?: BillingInterval;
  billing?: "stripe" | "invoice";
  /** Active people that are billed. */
  seats?: number;
  trialEndsAt?: string | null;
  currentPeriodEnd?: string | null;
  canceledAt?: string | null;
  mrr?: number;
}

export interface PlatformSummary {
  mrr: number;
  active: number;
  trialing: number;
  pastDue: number;
  ended: number;
}

/** A customer's portal account (role "customer"), managed on the customer page. */
export interface PortalAccount {
  id: string;
  name: string;
  email: string;
  username: string;
  active: boolean;
  lastLoginAt: string | null;
  hasPassword: boolean;
}

export type PortalInvoiceStatus = "sent" | "paid";
export interface PortalOverview {
  customer: { id: string; name: string; currency: "CHF" | "EUR" | "USD" };
  orgName: string;
  today: string;
  projects: ProjectReport[];
  months: { month: string; label: string; hours: number; amount: number }[];
  invoices: { id: string; number: string; month: string; issueDate: string; dueDate: string; status: PortalInvoiceStatus; net: number; gross: number }[];
}

export interface Providers {
  password: boolean;
  microsoft: boolean;
  google: boolean;
  /** Companies may register themselves (REGISTRATION_OPEN). */
  registration?: boolean;
  /** SaaS: registration starts a trial of a package. */
  saas?: boolean;
}

export interface BillingSettings {
  address: PostalAddress;
  iban: string;
  vatNumber?: string;
  paymentDays: number;
  footer?: string;
}

export interface Settings {
  name: string;
  branding: Branding;
  ssoAutoProvisionDomains: string[];
  payrollCodes?: Record<string, string>;
  reportDay?: number;
  autoRetainerInvoices?: boolean;
  weeklyHours?: number;
  holidays?: Holiday[];
  kmRate?: number;
  vatRate?: number;
  hoursReminder?: boolean;
  closingReminder?: boolean;
  timeModel?: "simplified" | "full";
  /** New companies: «open» shows the setup wizard to admins until they finish or skip it. */
  onboarding?: "open" | "done";
  billing?: BillingSettings;
  costRate?: number;
  fx?: { rates: { EUR?: number; USD?: number }; asOf: string; source?: string; manual?: boolean };
  scheduledReports?: ScheduledReport[];
}

export interface ScheduledReport {
  id: string;
  name: string;
  kind: "weekly" | "monthly";
  dayOfWeek?: number;
  dayOfMonth?: number;
  hour: number;
  recipients: string[];
  enabled: boolean;
}

export type InvoiceStatus = "draft" | "sent" | "paid" | "cancelled";
export interface InvoicePosition {
  text: string;
  detail?: string;
  quantity: number;
  unit: "h" | "km" | "Stk." | "%";
  unitPrice: number;
  amount: number;
  projectId?: string;
  share?: number;
}
export interface Invoice {
  id: string;
  number: string;
  customerId: string;
  month: string;
  issueDate: string;
  dueDate: string;
  status: InvoiceStatus;
  net: number;
  vat: number;
  vatRate: number;
  gross: number;
  positions: number;
  sentAt: string | null;
  paidAt: string | null;
  bexioId?: string | null;
}

export interface UserRow {
  id: string;
  name: string;
  username: string;
  email: string;
  role: Role;
  active: boolean;
  hasPassword: boolean;
  lastLoginAt: string | null;
  costRate?: number | null;
  teamId?: string | null;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers: init.body === undefined ? { "accept-language": intlLocale } : { "content-type": "application/json", "accept-language": intlLocale },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ? tr(data.error) : tr("Fehler {0}", res.status));
  return data as T;
}

/** Multipart upload of one file under the field «file». */
export async function upload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch(path, { method: "POST", credentials: "same-origin", body: form, headers: { "accept-language": intlLocale } });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ? tr(data.error) : tr("Fehler {0}", res.status));
  return data as T;
}

/**
 * The server sends single bookings of the last months and older ones as monthly totals. When someone browses
 * further back, `loadOlder` moves the start and every later reload keeps it.
 */
let datasetFrom: string | null = null;
export async function loadDataset(): Promise<Dataset> {
  const raw = await api<Dataset & { packed?: Record<"timeEntries" | "expenses" | "absences" | "workPeriods", Packed> }>(`/api/dataset?packed=1${datasetFrom ? `&from=${datasetFrom}` : ""}`);
  const { packed, ...data } = raw;
  if (!packed) return data;
  return { ...data, timeEntries: unpack(packed.timeEntries), expenses: unpack(packed.expenses), absences: unpack(packed.absences), workPeriods: unpack(packed.workPeriods) };
}
export async function loadOlder(from: string) {
  if (datasetFrom && datasetFrom <= from) return null;
  datasetFrom = from;
  return loadDataset();
}

export function applyBranding(b: Branding) {
  document.documentElement.style.setProperty("--brand", b.primaryColor);
  document.title = b.appName;
}

/** One comment or question on a booking. */
export interface EntryComment {
  id: string;
  kind: "comment" | "question";
  text: string;
  authorId: string | null;
  authorName: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** An unanswered question on a booking, as listed for the viewer. */
export interface OpenQuestion {
  entryId: string;
  ownerId: string;
  date: string;
  reason: string;
  text: string;
  askedBy: string | null;
  createdAt: string;
}


/** One submitted week of a person. */
export interface WeekSubmission {
  userId: string;
  week: string;
  hours: number;
  submittedAt: string;
}

/** Leads' team overview: per person and week, hours due and worked plus whether the week was submitted. */
export interface WeekOverviewRow {
  userId: string;
  name: string;
  weeks: { week: string; due: number; worked: number; submitted: boolean; submittedAt: string | null }[];
}
