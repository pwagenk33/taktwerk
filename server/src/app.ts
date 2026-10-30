import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { and, eq, gt, inArray } from "drizzle-orm";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { sha256 } from "./auth/crypto";
import { INTERNAL_HEADER, INTERNAL_TOKEN, authenticateApiKey, bearerKey } from "./apikeys";
import type { Config } from "./config";
import type { Db } from "./db/client";
import { organizations, projects, sessions, teams, users } from "./db/schema";
import type { Subscription } from "@taktwerk/domain";
import { LOCKED_WRITE_PREFIXES, assertWritable, saasOn, subscriptionOf } from "./saas";
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
import { contactRoutes, serveWebsite } from "./routes/website";
import { jiraRoutes } from "./routes/jira";
import { calendarRoutes } from "./routes/calendar";
import { bexioRoutes } from "./routes/bexio";
import { v1Routes } from "./routes/v1";
import { importRoutes } from "./routes/import";
import { securityRoutes } from "./routes/security";
import { privacyRoutes } from "./routes/privacy";
import { subscriptionRoutes } from "./routes/subscription";
import { presenceRoutes } from "./routes/presence";
import { tr } from "@taktwerk/domain";
import { currentLocale, requestLocale, withLocale } from "./i18n";

/** auditor (Treuhand/Revision) reads everything of the organization and changes nothing. */
export type Role = "admin" | "consultant" | "employee" | "auditor" | "customer";

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
  /** Hash of the current session token (for the session overview). */
  sessionId?: string;
  /** Chosen language (de, fr, en); null = browser language. */
  locale?: string | null;
  /** Projects this person leads (employees only; admins and consultants lead everything). */
  leadsProjects?: string[];
  /** Teams this person leads (employees only). */
  leadsTeams?: string[];
  /** SaaS mode: package and status of the company (absent on self-hosted installations). */
  subscription?: Subscription;
  /** Set when the request came with an API key instead of a session. */
  apiKey?: { id: string; scope: "read" | "write" };
}

/** Admins and consultants: full read and write access to the organization. */
export const isLead = (u: SessionUser) => u.role === "admin" || u.role === "consultant";
/** Sees the whole organization (leads and the read-only auditor role). */
export const seesAll = (u: SessionUser) => isLead(u) || u.role === "auditor";
/** Leads a project: organization leads, or an employee set as project lead. */
export const leadsProject = (u: SessionUser, projectId: string) => isLead(u) || (u.leadsProjects ?? []).includes(projectId);
/** Manages people: organization leads, or an employee who leads at least one team. */
export const managesPeople = (u: SessionUser) => isLead(u) || (u.leadsTeams ?? []).length > 0;

/**
 * Ids of the people whose bookings, absences and closings the actor may see and handle:
 * null = everyone of the organization; otherwise the actor plus the members of the teams they lead.
 */
export async function managedUserIds(ctx: AppContext, actor: SessionUser): Promise<Set<string> | null> {
  if (seesAll(actor)) return null;
  const ids = new Set([actor.id]);
  if (actor.leadsTeams?.length) {
    const rows = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.organizationId, actor.organizationId), inArray(users.teamId, actor.leadsTeams)));
    for (const r of rows) ids.add(r.id);
  }
  return ids;
}

/** Whether the actor may act for this person (self, organization lead, or lead of the person's team). */
export async function managesUser(ctx: AppContext, actor: SessionUser, userId: string): Promise<boolean> {
  if (userId === actor.id || isLead(actor)) return true;
  const ids = await managedUserIds(ctx, actor);
  return ids === null || ids.has(userId);
}

export async function assertManages(ctx: AppContext, actor: SessionUser, userId: string) {
  if (actor.role === "auditor" || !(await managesUser(ctx, actor, userId))) throw new HttpError(403, tr("Dafür fehlt dir die Berechtigung."));
}

/** Portal accounts only reach the portal, auth and branding routes. */
const PORTAL_PREFIXES = ["/api/portal", "/api/auth/", "/api/branding", "/api/health", "/api/me/security", "/api/me/sessions", "/api/me/totp", "/api/me/passkeys"];

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
  if (!req.user) throw new HttpError(401, tr("Bitte melde dich an."));
  return req.user;
}

/**
 * Requires one of the roles. The read-only auditor passes wherever a consultant would (its writes are refused
 * globally in the preHandler), so every lead report is visible to the Treuhand.
 */
export function requireRole(req: FastifyRequest, ...roles: Role[]): SessionUser {
  const user = requireUser(req);
  const ok = roles.includes(user.role) || (user.role === "auditor" && roles.includes("consultant"));
  if (!ok) throw new HttpError(403, tr("Dafür fehlt dir die Berechtigung."));
  return user;
}

/** Writes the read-only auditor may still do: sign in/out and manage the own account. */
const AUDITOR_WRITE_PREFIXES = ["/api/auth/", "/api/me/", "/api/dashboard"];

/**
 * The organization a request belongs to, by host name: an organization with this `domain`, else the only organization
 * of the installation, else null (several organizations, neutral host: branding falls back to the default).
 */
export async function organizationForHost(db: Db, host: string | undefined, baseDomain?: string) {
  const h = (host ?? "").split(":")[0]!.toLowerCase();
  if (h) {
    const [byDomain] = await db.select().from(organizations).where(eq(organizations.domain, h)).limit(1);
    if (byDomain) return byDomain;
    // SaaS: <slug>.<base domain>
    const base = baseDomain?.toLowerCase();
    if (base && h.endsWith(`.${base}`)) {
      const slug = h.slice(0, -base.length - 1);
      if (!slug.includes(".")) {
        const [bySlug] = await db.select().from(organizations).where(eq(organizations.slug, slug)).limit(1);
        return bySlug ?? null;
      }
    }
    if (base && (h === base || h === `www.${base}`)) return null;
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
export function appOrigin(config: Config, org?: { domain?: string | null; slug?: string | null } | null) {
  const base = new URL(config.APP_URL);
  if (org?.domain) return `${base.protocol}//${org.domain}`;
  if (config.SAAS_BASE_DOMAIN && org?.slug) return `${base.protocol}//${org.slug}.${config.SAAS_BASE_DOMAIN}`;
  return base.origin;
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

  // Language of answers (error messages, generated files): the one the app sends, else the browser's.
  app.addHook("onRequest", (req, _reply, done) => withLocale(requestLocale(req.headers["accept-language"]), done));

  const mainOrigin = new URL(ctx.config.APP_URL).origin;

  // The public website on the base domain answers before sessions and tenants are looked at.
  serveWebsite(app, ctx);

  // CSRF: state-changing API calls must come from our own origin (cookies are SameSite=Lax as second layer).
  // With several organizations on their own domains, the request's own host is an accepted origin too.
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/api/") || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const origin = req.headers.origin;
    if (!origin) return;
    const originHost = (() => { try { return new URL(origin).host; } catch { return ""; } })();
    if (origin !== mainOrigin && originHost !== req.headers.host) throw new HttpError(403, tr("Ungültige Herkunft der Anfrage."));
  });

  app.addHook("preHandler", async (req) => {
    // API keys: only on the public API, or on internal routes reached from it.
    const key = bearerKey(req);
    if (key && (req.url.startsWith("/api/v1/") || req.headers[INTERNAL_HEADER] === INTERNAL_TOKEN)) return authenticateApiKey(ctx, req, key);
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const sid = sha256(token);
    const [row] = await ctx.db
      .select({ user: users, lastSeenAt: sessions.lastSeenAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, sid), gt(sessions.expiresAt, new Date()), eq(users.active, true)))
      .limit(1);
    if (row) {
      const u = row.user;
      req.user = { id: u.id, organizationId: u.organizationId, name: u.name, username: u.username, email: u.email, role: u.role, customerId: u.customerId, platformAdmin: u.platformAdmin, sessionId: sid, locale: u.locale };
      // Until someone picks a language, e-mails follow the language their app runs in.
      if (!u.locale && req.headers["accept-language"]) await ctx.db.update(users).set({ locale: currentLocale() }).where(eq(users.id, u.id));
      if (u.role === "employee") {
        const [led, teamRows] = await Promise.all([
          ctx.db.select({ id: projects.id }).from(projects).where(and(eq(projects.organizationId, u.organizationId), eq(projects.leadUserId, u.id))),
          ctx.db.select({ id: teams.id }).from(teams).where(and(eq(teams.organizationId, u.organizationId), eq(teams.leadUserId, u.id))),
        ]);
        req.user.leadsProjects = led.map((p) => p.id);
        req.user.leadsTeams = teamRows.map((t) => t.id);
      }
      const writing = req.url.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method);
      if (saasOn(ctx)) {
        const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, u.organizationId)).limit(1);
        if (org) req.user.subscription = subscriptionOf(org);
        if (writing && !LOCKED_WRITE_PREFIXES.some((p) => req.url.startsWith(p))) assertWritable(req.user.subscription);
      }
      if (u.role === "auditor" && req.url.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method) && !AUDITOR_WRITE_PREFIXES.some((p) => req.url.startsWith(p)))
        throw new HttpError(403, tr("Dein Zugang ist nur lesend (Treuhand)."));
      if (!row.lastSeenAt || Date.now() - row.lastSeenAt.getTime() > 5 * 60_000) await ctx.db.update(sessions).set({ lastSeenAt: new Date(), ip: req.ip }).where(eq(sessions.id, sid));
      if (u.role === "customer" && req.url.startsWith("/api/") && !PORTAL_PREFIXES.some((p) => req.url.startsWith(p))) throw new HttpError(403, tr("Dieser Bereich ist für das Kundenportal nicht zugänglich."));
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply: FastifyReply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
    if (err.name === "ZodError") return reply.status(400).send({ error: tr("Eingaben sind unvollständig oder ungültig."), details: JSON.parse(err.message) });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.status(500).send({ error: tr("Interner Fehler. Bitte später erneut versuchen.") });
  });

  // Large API answers (the dataset) are gzip-compressed when the client accepts it; behind Caddy this
  // happens there already, the local Docker setup has no proxy.
  app.addHook("onSend", async (req, reply, payload) => {
    if (typeof payload !== "string" || payload.length < 32_768 || !req.url.startsWith("/api/") || reply.getHeader("content-encoding")) return payload;
    if (!/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) return payload;
    reply.header("content-encoding", "gzip").header("vary", "accept-encoding");
    reply.removeHeader("content-length");
    return gzipSync(payload, { level: 6 });
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
  await app.register(securityRoutes);
  await app.register(privacyRoutes);
  await app.register(presenceRoutes);
  await app.register(subscriptionRoutes);
  await app.register(contactRoutes);
  await app.register(jiraRoutes);
  await app.register(calendarRoutes);
  await app.register(bexioRoutes);
  await app.register(v1Routes);
  await app.register(importRoutes);

  // Production: serve the built web app with SPA fallback.
  const webDist = ctx.config.WEB_DIST ? resolve(ctx.config.WEB_DIST) : null;
  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.status(404).send({ error: tr("Nicht gefunden.") });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
