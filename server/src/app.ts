import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { and, eq, gt } from "drizzle-orm";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { sha256 } from "./auth/crypto";
import type { Config } from "./config";
import type { Db } from "./db/client";
import { organizations, sessions, users } from "./db/schema";
import type { Mailer } from "./mail/mailer";
import type { WebhookSender } from "./notify/webhooks";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { billingRoutes } from "./routes/billing";
import { dataRoutes } from "./routes/data";
import { brandingRoutes } from "./routes/branding";
import { commentRoutes } from "./routes/comments";
import { weekRoutes } from "./routes/weeks";
import { reminderRoutes } from "./routes/reminders";
import { exportRoutes } from "./routes/export";
import { expenseRoutes } from "./routes/expenses";
import { invoiceRoutes } from "./routes/invoices";
import { worktimeRoutes } from "./routes/worktime";
import { planningRoutes } from "./routes/planning";
import { portalRoutes } from "./routes/portal";
import { platformRoutes } from "./routes/platform";
import { statusRoutes } from "./routes/status";

export type Role = "admin" | "consultant" | "employee" | "customer";

export interface SessionUser {
  id: string;
  organizationId: string;
  name: string;
  username: string;
  email: string;
  role: Role;
  /** Set for portal accounts (role "customer"). */
  customerId?: string | null;
  /** Operator of the installation (may manage organizations). */
  platformAdmin?: boolean;
}

/** Portal accounts only reach the portal, auth and branding routes. */
const PORTAL_PREFIXES = ["/api/portal", "/api/auth/", "/api/branding", "/api/health"];

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
  interface FastifyInstance {
    ctx: AppContext;
  }
}

export interface AppContext {
  config: Config;
  db: Db;
  mailer: Mailer;
  webhooks: WebhookSender;
}

export const SESSION_COOKIE = "tw_session";

export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new HttpError(401, "Bitte melde dich an.");
  return req.user;
}

export function requireRole(req: FastifyRequest, ...roles: Role[]): SessionUser {
  const user = requireUser(req);
  if (!roles.includes(user.role)) throw new HttpError(403, "Dafür fehlt dir die Berechtigung.");
  return user;
}

/**
 * The organization a request belongs to, by host name: an organization with this `domain`, else the only organization
 * of the installation, else null (several organizations, neutral host: branding falls back to the default).
 */
export async function organizationForHost(db: Db, host: string | undefined) {
  const h = (host ?? "").split(":")[0]!.toLowerCase();
  if (h) {
    const [byDomain] = await db.select().from(organizations).where(eq(organizations.domain, h)).limit(1);
    if (byDomain) return byDomain;
  }
  const rows = await db.select().from(organizations).limit(2);
  return rows.length === 1 ? rows[0]! : null;
}

/** @deprecated kept for the CLI; routes use organizationForHost. */
export async function defaultOrganization(db: Db) {
  const [org] = await db.select().from(organizations).limit(1);
  return org ?? null;
}

/** Public origin for links in e-mails: the organization's own domain when set, otherwise APP_URL. */
export function appOrigin(config: Config, org?: { domain?: string | null } | null) {
  const base = new URL(config.APP_URL);
  return org?.domain ? `${base.protocol}//${org.domain}` : base.origin;
}

export async function buildApp(ctx: AppContext) {
  const app = Fastify({
    logger: ctx.config.NODE_ENV === "test" ? false : { level: "info" },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });
  app.decorate("ctx", ctx);
  app.decorateRequest("user", null);
  await app.register(cookie);

  const mainOrigin = new URL(ctx.config.APP_URL).origin;

  // CSRF: state-changing API calls must come from our own origin (cookies are SameSite=Lax as second layer).
  // With several organizations on their own domains, the request's own host is an accepted origin too.
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/api/") || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const origin = req.headers.origin;
    if (!origin) return;
    const originHost = (() => { try { return new URL(origin).host; } catch { return ""; } })();
    if (origin !== mainOrigin && originHost !== req.headers.host) throw new HttpError(403, "Ungültige Herkunft der Anfrage.");
  });

  app.addHook("preHandler", async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const [row] = await ctx.db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date()), eq(users.active, true)))
      .limit(1);
    if (row) {
      const u = row.user;
      req.user = { id: u.id, organizationId: u.organizationId, name: u.name, username: u.username, email: u.email, role: u.role, customerId: u.customerId, platformAdmin: u.platformAdmin };
      if (u.role === "customer" && req.url.startsWith("/api/") && !PORTAL_PREFIXES.some((p) => req.url.startsWith(p))) throw new HttpError(403, "Dieser Bereich ist für das Kundenportal nicht zugänglich.");
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply: FastifyReply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
    if (err.name === "ZodError") return reply.status(400).send({ error: "Eingaben sind unvollständig oder ungültig.", details: JSON.parse(err.message) });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.status(500).send({ error: "Interner Fehler. Bitte später erneut versuchen." });
  });

  app.get("/api/health", async () => ({ ok: true }));
  await app.register(statusRoutes);
  await app.register(authRoutes);
  await app.register(dataRoutes);
  await app.register(adminRoutes);
  await app.register(billingRoutes);
  await app.register(worktimeRoutes);
  await app.register(expenseRoutes);
  await app.register(brandingRoutes);
  await app.register(commentRoutes);
  await app.register(weekRoutes);
  await app.register(reminderRoutes);
  await app.register(exportRoutes);
  await app.register(invoiceRoutes);
  await app.register(planningRoutes);
  await app.register(portalRoutes);
  await app.register(platformRoutes);

  // Production: serve the built web app with SPA fallback.
  const webDist = ctx.config.WEB_DIST ? resolve(ctx.config.WEB_DIST) : null;
  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "Nicht gefunden." });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
