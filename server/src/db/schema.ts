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

export const DEFAULT_BRANDING: Branding = { appName: "TrackInsight", primaryColor: "#D52B1E", showMotif: true };

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
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("org_slug_uq").on(t.slug), uniqueIndex("org_domain_uq").on(t.domain)],
);

export const teams = mysqlTable("teams", {
  id: id().primaryKey(),
  organizationId: orgId(),
  name: varchar("name", { length: 120 }).notNull(),
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
    role: mysqlEnum("role", ["admin", "consultant", "employee", "customer"]).notNull().default("employee"),
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
    lastLoginAt: datetime("last_login_at", { mode: "date" }),
    reminder: json<ReminderSettings>("reminder"),
    /** Internal cost per hour in CHF; null = organization default. */
    costRate: decimal("cost_rate", { precision: 7, scale: 2, mode: "number" }),
    /** Operator of the installation: may create and manage organizations. */
    platformAdmin: boolean("platform_admin").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_username_uq").on(t.username), uniqueIndex("users_email_uq").on(t.email)],
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
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const passwordTokens = mysqlTable("password_tokens", {
  id: char("id", { length: 64 }).primaryKey(), // SHA-256 of the token in the e-mail link
  userId: id("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  purpose: mysqlEnum("purpose", ["invite", "reset"]).notNull(),
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
  /** Contract type: time & material, fixed price or monthly retainer. */
  kind: mysqlEnum("kind", ["tm", "fixed", "retainer"]).notNull().default("tm"),
  /** Retainer: hours included per month. */
  retainerHours: decimal("retainer_hours", { precision: 6, scale: 1, mode: "number" }),
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
    createdAt: createdAt(),
  },
  (t) => [index("te_org_date_idx").on(t.organizationId, t.date), index("te_sub_idx").on(t.subProjectId), index("te_issue_idx").on(t.jiraIssueKey)],
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
  (t) => [index("ex_org_date_idx").on(t.organizationId, t.date), index("ex_status_idx").on(t.organizationId, t.status)],
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
  unit: "h" | "km" | "Stk.";
  unitPrice: number;
  amount: number;
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
    snapshot: json<{ sender: BillingSettings; recipient: PostalAddress; customerName: string; appName: string; primaryColor: string; currency?: "CHF" | "EUR" | "USD" }>("snapshot").notNull(),
    sentAt: datetime("sent_at", { mode: "date" }),
    paidAt: datetime("paid_at", { mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("inv_number_uq").on(t.organizationId, t.number), index("inv_customer_idx").on(t.customerId)],
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
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.key] }), index("ji_sub_idx").on(t.subProjectId)],
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
    entity: mysqlEnum("entity", ["time_entry", "expense", "month", "absence", "work_model"]).notNull(),
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
