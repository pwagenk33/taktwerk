import type { Dataset, Holiday, PostalAddress, ProjectReport, Role } from "@taktwerk/domain";

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

export const DEFAULT_BRANDING: Branding = { appName: "TrackInsight", primaryColor: "#D52B1E", showMotif: true };

export interface Me {
  id: string;
  name: string;
  username: string;
  email: string;
  role: Role;
  /** Portal accounts: the customer they belong to. */
  customerId?: string | null;
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
  reportDay?: number;
  weeklyHours?: number;
  holidays?: Holiday[];
  kmRate?: number;
  vatRate?: number;
  hoursReminder?: boolean;
  closingReminder?: boolean;
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
  unit: "h" | "km" | "Stk.";
  unitPrice: number;
  amount: number;
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
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Fehler ${res.status}`);
  return data as T;
}

/** Multipart upload of one file under the field «file». */
export async function upload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch(path, { method: "POST", credentials: "same-origin", body: form });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Fehler ${res.status}`);
  return data as T;
}

export const loadDataset = () => api<Dataset>("/api/dataset");

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
