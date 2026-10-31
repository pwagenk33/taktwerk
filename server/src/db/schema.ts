// MariaDB schema (drizzle mysql-core, compatible with MariaDB 10.6+).
// Every business table carries organization_id; all queries are scoped to the session's organization.
import {
  boolean,
  char,
  date,
  datetime,
  decimal,
  customType,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/** JSON column that also parses MariaDB's JSON (a LONGTEXT alias returned as string by the driver). */
const json = <T>(name: string) =>
  customType<{ data: T; driverData: string }>({
    dataType: () => "json",
    toDriver: (v) => JSON.stringify(v),
    fromDriver: (v) => (typeof v === "string" ? JSON.parse(v) : v) as T,
  })(name);

const id = (name = "id") => char(name, { length: 36 });
const orgId = () => id("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" });
const createdAt = () => datetime("created_at", { mode: "date" }).notNull().$defaultFn(() => new Date());
const money = (name: string) => decimal(name, { precision: 12, scale: 2, mode: "number" });

export interface Branding {
  appName: string;
  /** Primary brand color, hex. Default: Swiss red. */
  primaryColor: string;
  /** Show the Matterhorn motif on login and in the navigation. */
  showMotif: boolean;
  /** Own logo, served under /api/branding/logo (set by the upload route). */
  logo?: string;
  logoMime?: string;
}

export const DEFAULT_BRANDING: Branding = { appName: "TrackInsight", primaryColor: "#6D4CF0", showMotif: true };

export interface PostalAddress {
  name: string;
  street: string;
  zip: string;
  city: string;
  /** ISO 3166-1 alpha-2, e.g. CH. */
  country: string;
}

/** Sender data for invoices and the Swiss QR bill. */
export interface BillingSettings {
  address: PostalAddress;
  /** IBAN or QR-IBAN of the account that receives payments. */
  iban: string;
  /** e.g. CHE-123.456.789 MWST */
  vatNumber?: string;
  paymentDays: number;
  /** Text under the totals, e.g. payment terms or thanks. */
  footer?: string;
}

export interface OrgSettings {
  branding: Branding;
  /** E-mail domains whose users may sign in with Microsoft/Google without an invitation. */
  ssoAutoProvisionDomains: string[];
  /** Day of month (Zurich time, from 07:00) on which last month's customer reports are e-mailed. Default 3. */
  reportDay?: number;
  /** Target hours per week at 100 %. Default 42. */
  weeklyHours?: number;
  /** Public holidays; when missing, the default proposal for the surrounding years is used. */
  holidays?: { date: string; name: string; fraction: number }[];
  /** CHF per kilometre for category «Kilometer». Default 0.70. */
  kmRate?: number;
  /** VAT rate in percent on invoices. Default 8.1. */
  vatRate?: number;
  /** Monday e-mail to people whose previous week is short of hours. Default on. */
  hoursReminder?: boolean;
  /** E-mail on the 1st to people whose previous month is not submitted, digest to leads on the 5th. Default on. */
  closingReminder?: boolean;
  billing?: BillingSettings;
  /** Default internal cost per hour in CHF for people without an own cost rate. Default 95. */
  costRate?: number;
  /** Digests by mail: weekly to leads, monthly to management. */
  scheduledReports?: { id: string; name: string; kind: "weekly" | "monthly"; dayOfWeek?: number; dayOfMonth?: number; hour: number; recipients: string[]; enabled: boolean }[];
  /** Exchange rates, CHF per unit (EUR, USD), refreshed daily unless `fx.manual` is set. */
  fx?: { rates: { EUR?: number; USD?: number }; asOf: string; source?: string; manual?: boolean };
  /** Working-time recording: "simplified" (hours per day, Art. 73b ArGV 1, default) or "full" (come/go with breaks, Art. 73 ArGV 1). */
  timeModel?: "simplified" | "full";
  /** New SaaS companies see the setup wizard until it is finished or skipped. */
  onboarding?: "open" | "done";
  /** Wage type numbers of the payroll system per item of the payroll export. */
  payrollCodes?: Partial<Record<string, string>>;
  /** On the 1st, draft last month's invoice for every customer with a retainer project (default off). */
  autoRetainerInvoices?: boolean;
  /** Company sign-in (SAML 2.0, e.g. Microsoft Entra ID, Okta, Google Workspace) and user provisioning via SCIM 2.0. */
  sso?: SsoSettings;
  /** Booking from chat: Slack signing secret and Teams outgoing-webhook secret (both never sent to the browser). */
  chat?: { slackSigningSecret?: string; teamsSecret?: string };
}

export interface SsoSettings {
  saml?: { enabled: boolean; entryPoint: string; idpIssuer?: string; cert: string };
  /** E-mail domains that sign in through SAML; new people from these domains are created as employees on first login. */
  domains?: string[];
  /** Password sign-in only for admins (break-glass); everyone else signs in through SAML. */
  enforce?: boolean;
  /** SHA-256 of the SCIM bearer token; the token itself is shown once. */
  scimTokenHash?: string;
  scimTokenHint?: string;
  scimCreatedAt?: string;
}

export const organizations = mysqlTable(
  "organizations",
  {
    id: id().primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    /** Short technical name (a-z, 0-9, -), unique per installation; used for the default subdomain. */
    slug: varchar("slug", { length: 60 }),
    /** Own host name (e.g. zeit.firma.ch). Requests on this host show this organization's branding and only accept its users. */
    domain: varchar("domain", { length: 200 }),
    active: boolean("active").notNull().default(true),
    settings: json<OrgSettings>("settings").notNull(),
    // ---- subscription (SaaS mode only; self-hosted installations ignore these) ----
    plan: mysqlEnum("plan", ["start", "team", "business"]).notNull().default("business"),
    subStatus: mysqlEnum("sub_status", ["trialing", "active", "past_due", "canceled", "expired"]).notNull().default("active"),
    billingInterval: mysqlEnum("billing_interval", ["month", "year"]).notNull().default("month"),
    /** "stripe": card payment through Stripe; "invoice": the operator bills by invoice and sets the status by hand. */
    billingMode: mysqlEnum("billing_mode", ["stripe", "invoice"]).notNull().default("invoice"),
    trialEndsAt: datetime("trial_ends_at", { mode: "date" }),
    currentPeriodEnd: datetime("current_period_end", { mode: "date" }),
    stripeCustomerId: varchar("stripe_customer_id", { length: 64 }),
    stripeSubscriptionId: varchar("stripe_subscription_id", { length: 64 }),
    canceledAt: datetime("canceled_at", { mode: "date" }),
    // ---- growth: referrals between companies and reseller partners (Treuhand, agencies) ----
    /** Own code for recommending the product (?ref=CODE); created on first use. */
    referralCode: varchar("referral_code", { length: 20 }),
    /** Company whose link brought this one (no FK: deleting either keeps the other). */
    referredByOrgId: varchar("referred_by_org_id", { length: 36 }),
    partnerId: varchar("partner_id", { length: 36 }),
    /** Free months from referrals that the operator has already credited on an invoice. */
    freeMonthsUsed: int("free_months_used").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("org_slug_uq").on(t.slug), uniqueIndex("org_domain_uq").on(t.domain), index("org_stripe_sub_idx").on(t.stripeSubscriptionId), uniqueIndex("org_referral_uq").on(t.referralCode), index("org_referred_idx").on(t.referredByOrgId), index("org_partner_idx").on(t.partnerId)],
);

export const teams = mysqlTable("teams", {
  id: id().primaryKey(),
  organizationId: orgId(),
  name: varchar("name", { length: 120 }).notNull(),
  /** Team lead (see users.id; no FK because users references teams). */
  leadUserId: id("lead_user_id"),
});

/** Personal reminder when nothing is booked on a work day: channel, time and weekdays (1 = Monday). */
export interface ReminderSettings {
  channel: "off" | "mail" | "teams" | "slack";
  time: string; // HH:MM, Zurich time
  days: number[];
  /** Incoming-webhook URL of the person's Teams or Slack channel/DM. */
  webhookUrl?: string;
}

export const users = mysqlTable(
  "users",
  {
    id: id().primaryKey(),
    organizationId: orgId(),
    teamId: id("team_id").references(() => teams.id, { onDelete: "set null" }),
    username: varchar("username", { length: 80 }).notNull(),
    email: varchar("email", { length: 254 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    role: mysqlEnum("role", ["admin", "consultant", "employee", "auditor", "customer"]).notNull().default("employee"),
    /** Portal accounts (role "customer") belong to one customer and only see that customer's data. */
    customerId: id("customer_id").references(() => customers.id, { onDelete: "cascade" }),
    /** scrypt hash; null for SSO-only accounts and invited users who have not set a password yet. */
    passwordHash: varchar("password_hash", { length: 255 }),
    active: boolean("active").notNull().default(true),
    /** Work model: Pensum in percent, vacation days per year, first tracked day and carry-overs. */
    workload: int("workload").notNull().default(100),
    vacationDays: decimal("vacation_days", { precision: 4, scale: 1, mode: "number" }).notNull().default(25),
    trackingStart: date("tracking_start", { mode: "string" }),
    overtimeCarry: decimal("overtime_carry", { precision: 7, scale: 2, mode: "number" }).notNull().default(0),
    vacationCarry: decimal("vacation_carry", { precision: 4, scale: 1, mode: "number" }).notNull().default(0),
    personnelNumber: varchar("personnel_number", { length: 20 }),
    lastLoginAt: datetime("last_login_at", { mode: "date" }),
    reminder: json<ReminderSettings>("reminder"),
    /** Internal cost per hour in CHF; null = organization default. */
    costRate: decimal("cost_rate", { precision: 7, scale: 2, mode: "number" }),
    /** Operator of the installation: may create and manage organizations. */
    platformAdmin: boolean("platform_admin").notNull().default(false),
    /** Second factor: TOTP secret (base32) once enabled, plus hashed one-time recovery codes. */
    totpSecret: varchar("totp_secret", { length: 64 }),
    totpEnabledAt: datetime("totp_enabled_at", { mode: "date" }),
    recoveryCodes: json<string[]>("recovery_codes"),
    /** Language of the app and of e-mails to this person (de, fr, en); null = browser language, e-mails German. */
    locale: varchar("locale", { length: 2 }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_username_uq").on(t.username), uniqueIndex("users_org_email_uq").on(t.organizationId, t.email), index("users_email_idx").on(t.email)],
);

export const oauthAccounts = mysqlTable(
  "oauth_accounts",
  {
    provider: mysqlEnum("provider", ["microsoft", "google"]).notNull(),
    providerUserId: varchar("provider_user_id", { length: 191 }).notNull(),
    userId: id("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerUserId] }), index("oauth_user_idx").on(t.userId)],
);

export const sessions = mysqlTable(
  "sessions",
  {
    /** SHA-256 of the cookie token; the token itself is never stored. */
    id: char("id", { length: 64 }).primaryKey(),
    userId: id("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: datetime("expires_at", { mode: "date" }).notNull(),
    /** For the session overview: browser/device, IP and last activity (updated at most every few minutes). */
    userAgent: varchar("user_agent", { length: 255 }),
    ip: varchar("ip", { length: 45 }),
    lastSeenAt: datetime("last_seen_at", { mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const passwordTokens = mysqlTable("password_tokens", {
  id: char("id", { length: 64 }).primaryKey(), // SHA-256 of the token in the e-mail link
  userId: id("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  purpose: mysqlEnum("purpose", ["invite", "reset", "2fa", "handoff"]).notNull(),
  expiresAt: datetime("expires_at", { mode: "date" }).notNull(),
  usedAt: datetime("used_at", { mode: "date" }),
  createdAt: createdAt(),
});

export const customers = mysqlTable("customers", {
  id: id().primaryKey(),
  organizationId: orgId(),
  name: varchar("name", { length: 200 }).notNull(),
  /** Currency of rates, budgets and invoices. */
  currency: mysqlEnum("currency", ["CHF", "EUR", "USD"]).notNull().default("CHF"),
  /** E-mail addresses that receive the monthly report; empty = no automatic dispatch. */
  reportRecipients: json<string[]>("report_recipients").notNull().$defaultFn(() => []),
  /** Postal address printed on invoices and in the QR bill. */
  billingAddress: json<PostalAddress>("billing_address"),
  /** Language of reports, invoices, portal e-mails for this customer (de, fr, en). */
  locale: varchar("locale", { length: 2 }).notNull().default("de"),
  createdAt: createdAt(),
});

export const customerRates = mysqlTable(
  "customer_rates",
  {
    customerId: id("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    hourlyRate: money("hourly_rate").notNull(),
  },
  (t) => [primaryKey({ columns: [t.customerId, t.validFrom] })],
);

export const projects = mysqlTable("projects", {
  id: id().primaryKey(),
  organizationId: orgId(),
  customerId: id("customer_id").notNull().references(() => customers.id, { onDelete: "restrict" }),
  name: varchar("name", { length: 200 }).notNull(),
  budget: money("budget").notNull().default(0),
  jiraProjectKey: varchar("jira_project_key", { length: 20 }),
  /** Project lead (an employee who manages this project). */
  leadUserId: id("lead_user_id").references(() => users.id, { onDelete: "set null" }),
  /** Contract type: time & material, fixed price or monthly retainer. */
  kind: mysqlEnum("kind", ["tm", "fixed", "retainer"]).notNull().default("tm"),
  /** Retainer: hours included per month. */
  retainerHours: decimal("retainer_hours", { precision: 6, scale: 1, mode: "number" }),
  /** Last day of work: no bookings after it, retainers stop billing after its month, hidden from pickers. */
  closedOn: date("closed_on", { mode: "string" }),
  createdAt: createdAt(),
});

export const subProjects = mysqlTable("sub_projects", {
  id: id().primaryKey(),
  organizationId: orgId(),
  projectId: id("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
  name: varchar("name", { length: 200 }).notNull(),
  budget: money("budget").notNull().default(0),
  jiraEpicKey: varchar("jira_epic_key", { length: 40 }),
  createdAt: createdAt(),
});

export const timeEntries = mysqlTable(
  "time_entries",
  {
    id: id().primaryKey(),
    organizationId: orgId(),
    userId: id("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    subProjectId: id("sub_project_id").notNull().references(() => subProjects.id, { onDelete: "restrict" }),
    date: date("date", { mode: "string" }).notNull(),
    hours: decimal("hours", { precision: 5, scale: 2, mode: "number" }).notNull(),
    reason: varchar("reason", { length: 1000 }).notNull(),
    billable: boolean("billable").notNull().default(true),
    /** Customer rate on `date`, frozen at booking time. */
    hourlyRate: money("hourly_rate").notNull(),
    jiraIssueKey: varchar("jira_issue_key", { length: 40 }),
    /** HH:MM when the booking was placed in the calendar; null for bookings without a time of day. */
    startTime: varchar("start_time", { length: 5 }),
    /** Set when the booking came from an import (Clockodo, Toggl, Harvest, Excel); the import can be undone as a whole. */
    importBatchId: id("import_batch_id"),
    createdAt: createdAt(),
  },
  (t) => [index("te_import_idx").on(t.importBatchId), index("te_org_date_idx").on(t.organizationId, t.date), index("te_user_date_idx").on(t.userId, t.date), index("te_sub_idx").on(t.subProjectId), index("te_issue_idx").on(t.jiraIssueKey)],
);

export const expenses = mysqlTable(
  "expenses",
  {
    id: id().primaryKey(),
    organizationId: orgId(),
    userId: id("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    subProjectId: id("sub_project_id").notNull().references(() => subProjects.id, { onDelete: "restrict" }),
    date: date("date", { mode: "string" }).notNull(),
    amount: money("amount").notNull(),
    category: mysqlEnum("category", ["Reise", "Kilometer", "Unterkunft", "Verpflegung", "Material", "Lizenzen", "Sonstiges"]).notNull(),
    reason: varchar("reason", { length: 1000 }).notNull(),
    billable: boolean("billable").notNull().default(true),
    /** Employees' expenses wait for approval by a consultant or admin; only approved ones are billed. */
    status: mysqlEnum("status", ["requested", "approved", "rejected"]).notNull().default("approved"),
    decidedBy: id("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: datetime("decided_at", { mode: "date" }),
    /** VAT rate in percent contained in the gross amount. */
    vatRate: decimal("vat_rate", { precision: 4, scale: 1, mode: "number" }).notNull().default(8.1),
    km: decimal("km", { precision: 7, scale: 1, mode: "number" }),
    /** Receipt stored under DATA_DIR/receipts/<expense id>. */
    receiptName: varchar("receipt_name", { length: 255 }),
    receiptMime: varchar("receipt_mime", { length: 100 }),
    receiptSize: int("receipt_size"),
    createdAt: createdAt(),
  },
  (t) => [index("ex_org_date_idx").on(t.organizationId, t.date), index("ex_user_date_idx").on(t.userId, t.date), index("ex_status_idx").on(t.organizationId, t.status)],
);

export const absences = mysqlTable(
  "absences",
  {
    id: id().primaryKey(),
    organizationId: orgId(),
    userId: id("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    type: mysqlEnum("type", ["Ferien", "Krankheit", "Unfall", "Militär/Zivildienst", "Weiterbildung", "Kompensation", "Sonstiges"]).notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    halfDay: boolean("half_day").notNull().default(false),
    note: varchar("note", { length: 500 }),
    status: mysqlEnum("status", ["requested", "approved", "rejected"]).notNull(),
    decidedBy: id("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: datetime("decided_at", { mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [index("abs_org_start_idx").on(t.organizationId, t.startDate), index("abs_user_idx").on(t.userId)],
);

export interface InvoicePosition {
  text: string;
  detail?: string;
  quantity: number;
  unit: "h" | "km" | "Stk." | "%";
  unitPrice: number;
  amount: number;
  /** Fixed-price instalment: the project and the share of its price (in %) this line bills. */
  projectId?: string;
  share?: number;
}

export const invoices = mysqlTable(
  "invoices",
  {
    id: id().primaryKey(),
    organizationId: orgId(),
    customerId: id("customer_id").notNull().references(() => customers.id, { onDelete: "restrict" }),
    /** Running number per organization, e.g. 2026-0007; also the QR bill reference. */
    number: varchar("number", { length: 20 }).notNull(),
    /** Period billed (YYYY-MM). */
    month: char("month", { length: 7 }).notNull(),
    issueDate: date("issue_date", { mode: "string" }).notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    status: mysqlEnum("status", ["draft", "sent", "paid", "cancelled"]).notNull().default("draft"),
    positions: json<InvoicePosition[]>("positions").notNull(),
    net: money("net").notNull(),
    vatRate: decimal("vat_rate", { precision: 4, scale: 1, mode: "number" }).notNull(),
    vat: money("vat").notNull(),
    gross: money("gross").notNull(),
    /** Snapshot of sender, recipient and texts at creation, so the PDF stays stable. */
    snapshot: json<{ sender: BillingSettings; recipient: PostalAddress; customerName: string; appName: string; primaryColor: string; currency?: "CHF" | "EUR" | "USD"; locale?: string }>("snapshot").notNull(),
    sentAt: datetime("sent_at", { mode: "date" }),
    paidAt: datetime("paid_at", { mode: "date" }),
    /** Id of the invoice in bexio once it was transferred. */
    bexioId: varchar("bexio_id", { length: 20 }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("inv_number_uq").on(t.organizationId, t.number), index("inv_customer_idx").on(t.customerId)],
);

export interface QuotePosition {
  /** Becomes the sub-project's name when the quote is accepted. */
  name: string;
  note?: string;
  hours: number;
  rate: number;
  amount: number;
}

/** Quotes (Offerten) per customer; accepting one creates the project with a sub-project per position. */
export const quotes = mysqlTable(
  "quotes",
  {
    id: id().primaryKey(),
    organizationId: orgId(),
    customerId: id("customer_id").notNull().references(() => customers.id, { onDelete: "restrict" }),
    /** Running number per organization, e.g. O-2026-0003. */
    number: varchar("number", { length: 20 }).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    intro: text("intro"),
    kind: mysqlEnum("kind", ["tm", "fixed", "retainer"]).notNull().default("tm"),
    retainerHours: decimal("retainer_hours", { precision: 6, scale: 1, mode: "number" }),
    validUntil: date("valid_until", { mode: "string" }).notNull(),
    status: mysqlEnum("status", ["draft", "sent", "accepted", "declined"]).notNull().default("draft"),
    positions: json<QuotePosition[]>("positions").notNull(),
    net: money("net").notNull(),
    /** Project created on acceptance. */
    projectId: id("project_id"),
    decidedAt: datetime("decided_at", { mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("quote_number_uq").on(t.organizationId, t.number), index("quote_customer_idx").on(t.customerId)],
);

/** Mirror of JIRA issues, filled by the JIRA sync (milestone 2) or the seed. */
export const jiraIssues = mysqlTable(
  "jira_issues",
  {
    organizationId: orgId(),
    key: varchar("issue_key", { length: 40 }).notNull(),
    subProjectId: id("sub_project_id").notNull().references(() => subProjects.id, { onDelete: "cascade" }),
    summary: varchar("summary", { length: 500 }).notNull(),
    storyPoints: decimal("story_points", { precision: 6, scale: 1, mode: "number" }).notNull().default(0),
    status: mysqlEnum("status", ["To Do", "In Progress", "Done"]).notNull(),
    resolvedAt: date("resolved_at", { mode: "string" }),
    issueType: varchar("issue_type", { length: 60 }),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.key] }), index("ji_sub_idx").on(t.subProjectId)],
);

/**
 * Connection of a company to its Jira Cloud site (Atlassian OAuth 2.0, 3LO). One site per company.
 * The refresh token is only usable together with ATLASSIAN_CLIENT_SECRET, which lives in the environment, not here.
 */
export const jiraConnections = mysqlTable("jira_connections", {
  organizationId: id("organization_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  cloudId: varchar("cloud_id", { length: 64 }).notNull(),
  siteUrl: varchar("site_url", { length: 255 }).notNull(),
  siteName: varchar("site_name", { length: 255 }).notNull(),
  accessToken: varchar("access_token", { length: 4096 }).notNull(),
  refreshToken: varchar("refresh_token", { length: 4096 }),
  expiresAt: datetime("expires_at", { mode: "date" }).notNull(),
  /** Custom field ids that hold story points («Story Points», «Story point estimate»), found at connect time. */
  storyPointFields: json<string[]>("story_point_fields").notNull(),
  connectedBy: id("connected_by").references(() => users.id, { onDelete: "set null" }),
  lastSyncAt: datetime("last_sync_at", { mode: "date" }),
  lastResult: json<{ ok: boolean; message: string; issues?: number; projects?: number }>("last_result"),
  /** Scopes Atlassian granted; connections made before worklogs existed have none stored and may only read. */
  scopes: json<string[]>("scopes"),
  /** Bookings on Jira issues from this date on are written back as worklogs; null = off. */
  worklogsSince: date("worklogs_since", { mode: "string" }),
  lastWorklogResult: json<{ ok: boolean; message: string; at: string }>("last_worklog_result"),
  createdAt: createdAt(),
});

/**
 * Worklogs TrackInsight wrote to Jira, one per booking. No foreign key on the booking: when a booking is
 * deleted, the row stays until its worklog has been removed in Jira too.
 */
export const jiraWorklogs = mysqlTable(
  "jira_worklogs",
  {
    timeEntryId: id("time_entry_id").primaryKey(),
    organizationId: orgId(),
    issueKey: varchar("issue_key", { length: 40 }).notNull(),
    worklogId: varchar("worklog_id", { length: 40 }).notNull(),
    /** Hash of what was sent (issue, time, duration, text); a different hash means the worklog needs an update. */
    hash: char("hash", { length: 40 }).notNull(),
    syncedAt: datetime("synced_at", { mode: "date" }).notNull(),
  },
  (t) => [index("jw_org_idx").on(t.organizationId)],
);

export const dashboards = mysqlTable("dashboards", {
  userId: id("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  layout: json<unknown>("layout").notNull(),
});

/** Monthly closing per person: submitted by the person, approved by a consultant/admin. Approved months are locked. */
export const monthClosings = mysqlTable(
  "month_closings",
  {
    organizationId: orgId(),
    userId: id("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    month: char("month", { length: 7 }).notNull(), // YYYY-MM
    status: mysqlEnum("status", ["submitted", "approved"]).notNull(),
    submittedAt: datetime("submitted_at", { mode: "date" }).notNull(),
    approvedBy: id("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: datetime("approved_at", { mode: "date" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.month] }), index("mc_org_month_idx").on(t.organizationId, t.month)],
);

/** Who changed which booking or closing, with the values before and after. */
export const auditLog = mysqlTable(
  "audit_log",
  {
    id: id().primaryKey(),
    organizationId: orgId(),
    actorId: id("actor_id").references(() => users.id, { onDelete: "set null" }),
    entity: mysqlEnum("entity", ["time_entry", "expense", "month", "absence", "work_model", "import"]).notNull(),
    entityId: varchar("entity_id", { length: 64 }).notNull(),
    action: mysqlEnum("action", ["create", "update", "delete", "submit", "approve", "reopen", "reject"]).notNull(),
    before: json<unknown>("before_data"),
    after: json<unknown>("after_data"),
    // Millisecond precision keeps the order of changes made within the same second.
    createdAt: datetime("created_at", { mode: "date", fsp: 3 }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("audit_entity_idx").on(t.entity, t.entityId), index("audit_org_idx").on(t.organizationId, t.createdAt)],
);

/** Budget alerts already sent, so each threshold is mailed once per project or sub-project. */
export const budgetAlerts = mysqlTable(
  "budget_alerts",
  {
    organizationId: orgId(),
    targetId: id("target_id").notNull(),
    threshold: mysqlEnum("threshold", ["80", "95", "100"]).notNull(),
    sentAt: datetime("sent_at", { mode: "date" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.targetId, t.threshold] })],
);

/** Idempotency for scheduled jobs (e.g. monthly report per customer and month). */
export const jobRuns = mysqlTable(
  "job_runs",
  {
    job: varchar("job", { length: 120 }).notNull(),
    period: varchar("period", { length: 20 }).notNull(),
    ranAt: datetime("ran_at", { mode: "date" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.job, t.period] })],
);

/** Comments on a booking. A lead's «question» stays open until the booking's owner answers. */
export const entryComments = mysqlTable(
  "entry_comments",
  {
    id: id().primaryKey(),
    organizationId: orgId(),
    entryId: id("entry_id").notNull().references(() => timeEntries.id, { onDelete: "cascade" }),
    authorId: id("author_id").references(() => users.id, { onDelete: "set null" }),
    kind: mysqlEnum("kind", ["comment", "question"]).notNull().default("comment"),
    text: varchar("text", { length: 1000 }).notNull(),
    resolvedAt: datetime("resolved_at", { mode: "date" }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("ec_entry_idx").on(t.entryId), index("ec_org_open_idx").on(t.organizationId, t.kind, t.resolvedAt)],
);

/** A person's statement that a week is complete. Informational for leads; locking stays with the month closing. */
export const weekSubmissions = mysqlTable(
  "week_submissions",
  {
    organizationId: orgId(),
    userId: id("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    week: char("week", { length: 8 }).notNull(), // YYYY-Www
    hours: decimal("hours", { precision: 6, scale: 2, mode: "number" }).notNull(),
    submittedAt: datetime("submitted_at", { mode: "date" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.week] }), index("ws_org_week_idx").on(t.organizationId, t.week)],
);


/** Resource planning: hours a person is reserved for a project in an ISO week. */
export const allocations = mysqlTable(
  "allocations",
  {
    id: id().primaryKey(),
    organizationId: orgId(),
    userId: id("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    projectId: id("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    week: char("week", { length: 8 }).notNull(), // YYYY-Www
    hours: decimal("hours", { precision: 5, scale: 1, mode: "number" }).notNull(),
    note: varchar("note", { length: 200 }),
    updatedAt: datetime("updated_at", { mode: "date" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("alloc_uq").on(t.userId, t.projectId, t.week), index("alloc_org_week_idx").on(t.organizationId, t.week)],
);

/** Passkeys (WebAuthn credentials): passwordless sign-in or second factor. */
export const passkeys = mysqlTable(
  "passkeys",
  {
    /** Credential id, base64url. */
    id: varchar("id", { length: 512 }).primaryKey(),
    userId: id("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    publicKey: varchar("public_key", { length: 1024 }).notNull(), // base64url
    counter: int("counter").notNull().default(0),
    transports: json<string[]>("transports"),
    name: varchar("name", { length: 80 }).notNull(),
    backedUp: boolean("backed_up").notNull().default(false),
    lastUsedAt: datetime("last_used_at", { mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [index("passkeys_user_idx").on(t.userId)],
);

/** Come/go recording (time model «full»): one row per stretch of work or break; `end` is null while running. */
export const workPeriods = mysqlTable(
  "work_periods",
  {
    id: id().primaryKey(),
    organizationId: orgId(),
    userId: id("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    date: varchar("date", { length: 10 }).notNull(),
    kind: mysqlEnum("kind", ["work", "break"]).notNull().default("work"),
    start: varchar("start", { length: 5 }).notNull(),
    end: varchar("end", { length: 5 }),
    createdAt: createdAt(),
  },
  (t) => [index("period_user_date_idx").on(t.userId, t.date), index("period_org_date_idx").on(t.organizationId, t.date)],
);

/**
 * One import of bookings from another tool. `created` lists the customers, projects and sub-projects the import added,
 * so undoing it removes them again when nothing else uses them.
 */
export const importBatches = mysqlTable("import_batches", {
  id: id().primaryKey(),
  organizationId: orgId(),
  source: varchar("source", { length: 20 }).notNull(),
  fileName: varchar("file_name", { length: 255 }).notNull(),
  entries: int("entries").notNull(),
  hours: decimal("hours", { precision: 10, scale: 2, mode: "number" }).notNull(),
  created: json<{ customers: string[]; projects: string[]; subProjects: string[] }>("created").notNull(),
  createdBy: id("created_by").references(() => users.id, { onDelete: "set null" }),
  undoneAt: datetime("undone_at", { mode: "date" }),
  createdAt: createdAt(),
});

/**
 * A person's Outlook (Microsoft 365) or Google calendar, read for booking suggestions. One calendar per person.
 * Read-only scopes; the refresh token is only usable together with the client secret from the environment.
 */
export const calendarConnections = mysqlTable("calendar_connections", {
  userId: id("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  organizationId: orgId(),
  provider: mysqlEnum("provider", ["microsoft", "google"]).notNull(),
  account: varchar("account", { length: 255 }),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  expiresAt: datetime("expires_at", { mode: "date" }).notNull(),
  createdAt: createdAt(),
});

/** Connection of a company to its bexio account (OAuth 2.0); invoices can be transferred there as drafts. */
export const bexioConnections = mysqlTable("bexio_connections", {
  organizationId: id("organization_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  expiresAt: datetime("expires_at", { mode: "date" }).notNull(),
  /** bexio user the invoices and contacts are created for. */
  bexioUserId: int("bexio_user_id").notNull(),
  account: varchar("account", { length: 255 }),
  /** bexio contact id per TrackInsight customer id, filled when an invoice is transferred. */
  contacts: json<Record<string, number>>("contacts").notNull(),
  connectedBy: id("connected_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

/** Keys for the public API (/api/v1). Only the SHA-256 of the key is stored; a key acts with the rights of the admin who made it. */
export const apiKeys = mysqlTable(
  "api_keys",
  {
    id: id().primaryKey(),
    organizationId: orgId(),
    name: varchar("name", { length: 80 }).notNull(),
    /** First characters of the key, so people can tell keys apart. */
    prefix: varchar("prefix", { length: 16 }).notNull(),
    hash: char("hash", { length: 64 }).notNull(),
    scope: mysqlEnum("scope", ["read", "write"]).notNull(),
    userId: id("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    lastUsedAt: datetime("last_used_at", { mode: "date" }),
    revokedAt: datetime("revoked_at", { mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("api_key_hash_uq").on(t.hash), index("api_key_org_idx").on(t.organizationId)],
);

/** Endpoints that receive events (bookings, absences, expenses, months, invoices) as signed HTTPS POSTs. */
export const webhookEndpoints = mysqlTable(
  "webhook_endpoints",
  {
    id: id().primaryKey(),
    organizationId: orgId(),
    url: varchar("url", { length: 500 }).notNull(),
    description: varchar("description", { length: 120 }),
    /** Event types, or ["*"] for all. */
    events: json<string[]>("events").notNull(),
    /** Signing secret (HMAC-SHA256); shown to the admin once at creation and on request. */
    secret: varchar("secret", { length: 80 }).notNull(),
    active: boolean("active").notNull().default(true),
    /** Failed deliveries in a row; the endpoint is switched off at 50. */
    failures: int("failures").notNull().default(0),
    lastStatus: int("last_status"),
    lastDeliveryAt: datetime("last_delivery_at", { mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [index("wh_org_idx").on(t.organizationId)],
);

export const webhookDeliveries = mysqlTable(
  "webhook_deliveries",
  {
    id: id().primaryKey(),
    organizationId: orgId(),
    endpointId: id("endpoint_id").notNull().references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    event: varchar("event", { length: 60 }).notNull(),
    payload: json<unknown>("payload").notNull(),
    attempts: int("attempts").notNull().default(0),
    nextAttemptAt: datetime("next_attempt_at", { mode: "date" }).notNull(),
    deliveredAt: datetime("delivered_at", { mode: "date" }),
    /** Given up after the last retry. */
    failedAt: datetime("failed_at", { mode: "date" }),
    lastStatus: int("last_status"),
    lastError: varchar("last_error", { length: 500 }),
    createdAt: createdAt(),
  },
  (t) => [index("whd_due_idx").on(t.deliveredAt, t.failedAt, t.nextAttemptAt), index("whd_endpoint_idx").on(t.endpointId, t.createdAt)],
);

/** A Slack or Teams account linked to a person, so chat messages book in their name. */
export const chatLinks = mysqlTable(
  "chat_links",
  {
    id: id().primaryKey(),
    organizationId: orgId(),
    provider: mysqlEnum("provider", ["slack", "teams"]).notNull(),
    externalId: varchar("external_id", { length: 120 }).notNull(),
    userId: id("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("chat_links_uq").on(t.organizationId, t.provider, t.externalId)],
);

/** Reseller partner (fiduciary, agency): companies registering with the code get a longer trial, the partner a commission. */
export const partners = mysqlTable(
  "partners",
  {
    id: id().primaryKey(),
    code: varchar("code", { length: 40 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    email: varchar("email", { length: 254 }).notNull(),
    /** Share of the monthly revenue of referred, paying companies, in percent. */
    commissionPercent: int("commission_percent").notNull().default(20),
    trialDays: int("trial_days").notNull().default(60),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("partners_code_uq").on(t.code)],
);

/** Status page: one row per day with the minutes the installation answered (heartbeat every minute). */
export const statusDays = mysqlTable("status_days", {
  day: date("day", { mode: "string" }).primaryKey(),
  okMinutes: int("ok_minutes").notNull().default(0),
  badMinutes: int("bad_minutes").notNull().default(0),
  /** First heartbeat of the day (Zurich time); before it on the first day there was no installation yet. */
  firstAt: datetime("first_at", { mode: "date" }).notNull(),
  lastAt: datetime("last_at", { mode: "date" }).notNull(),
});

export interface IncidentUpdate {
  at: string;
  status: "investigating" | "identified" | "monitoring" | "resolved" | "scheduled" | "in_progress" | "completed";
  text: string;
}

/** Disruptions and planned maintenance the operator posts on the public status page. */
export const incidents = mysqlTable(
  "incidents",
  {
    id: id().primaryKey(),
    title: varchar("title", { length: 200 }).notNull(),
    impact: mysqlEnum("impact", ["minor", "major", "maintenance"]).notNull(),
    status: mysqlEnum("status", ["investigating", "identified", "monitoring", "resolved", "scheduled", "in_progress", "completed"]).notNull(),
    startsAt: datetime("starts_at", { mode: "date" }).notNull(),
    endsAt: datetime("ends_at", { mode: "date" }),
    updates: json<IncidentUpdate[]>("updates").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("incidents_start_idx").on(t.startsAt)],
);
