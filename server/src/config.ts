import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  /** Public URL of the app, used for OAuth redirects, links in e-mails and the CSRF origin check. */
  APP_URL: z.string().url().default("http://localhost:5173"),
  DATABASE_URL: z.string().default("mysql://taktwerk:taktwerk@localhost:3306/taktwerk"),
  SESSION_DAYS: z.coerce.number().default(14),

  SMTP_HOST: optional,
  SMTP_PORT: z.coerce.number().default(587),
  /** "true" for implicit TLS (port 465); otherwise STARTTLS is used when the server offers it. */
  SMTP_SECURE: z.enum(["true", "false"]).default("false"),
  SMTP_USER: optional,
  SMTP_PASSWORD: optional,
  SMTP_FROM: z.string().default("TrackInsight <no-reply@localhost>"),

  MICROSOFT_CLIENT_ID: optional,
  MICROSOFT_CLIENT_SECRET: optional,
  /** "common", "organizations" or a tenant id to restrict sign-in to one Entra ID tenant. */
  MICROSOFT_TENANT: z.string().default("organizations"),
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,

  /** "true": companies can register themselves at /registrieren (SaaS mode). Otherwise only platform admins and the CLI create organizations. */
  REGISTRATION_OPEN: z.enum(["true", "false"]).default("false"),
  /** "true": run as SaaS with packages, trial, limits and subscription billing. Self-hosted installations leave it off. */
  SAAS: z.enum(["true", "false"]).default("false"),
  /** SaaS: every company gets <slug>.<SAAS_BASE_DOMAIN>, e.g. trackinsight.ch → beispiel.trackinsight.ch. */
  SAAS_BASE_DOMAIN: optional,
  /** Stripe secret key (sk_live_… or sk_test_…) for card payments; without it, companies are billed by invoice. */
  STRIPE_SECRET_KEY: optional,
  /** Signing secret of the Stripe webhook endpoint /api/billing/webhook (whsec_…). */
  STRIPE_WEBHOOK_SECRET: optional,
  /** Stripe price ids per package and interval: "start_month=price_…,start_year=price_…,team_month=…" (six entries). */
  STRIPE_PRICES: optional,
  /** Where the operator receives notices (new registrations, invoice requests, cancellations). */
  OPERATOR_EMAIL: optional,
  /** Directory with the built web app; served by the API server in production. */
  WEB_DIST: optional,
  /** Atlassian OAuth 2.0 (3LO) app from developer.atlassian.com: companies connect their Jira Cloud site with it. Callback: <APP_URL>/api/jira/callback */
  ATLASSIAN_CLIENT_ID: optional,
  ATLASSIAN_CLIENT_SECRET: optional,
  /** Directory with the built public website (website/dist); served on SAAS_BASE_DOMAIN and www.<base> when APP_URL runs on another host. */
  WEBSITE_DIR: optional,
  /** Where uploaded files (receipts) are stored. */
  DATA_DIR: z.string().default("./data"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return schema.parse(env);
}
