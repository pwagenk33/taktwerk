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
  SMTP_FROM: z.string().default("Taktwerk <no-reply@localhost>"),

  MICROSOFT_CLIENT_ID: optional,
  MICROSOFT_CLIENT_SECRET: optional,
  /** "common", "organizations" or a tenant id to restrict sign-in to one Entra ID tenant. */
  MICROSOFT_TENANT: z.string().default("organizations"),
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,

  /** Directory with the built web app; served by the API server in production. */
  WEB_DIST: optional,
  /** Where uploaded files (receipts) are stored. */
  DATA_DIR: z.string().default("./data"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return schema.parse(env);
}
