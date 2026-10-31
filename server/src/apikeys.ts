// Keys for the public API: "ti_" plus 32 random bytes. A key acts with the rights of the admin who made it,
// limited to reading when its scope is "read". Only /api/v1 accepts keys; v1 reaches internal routes
// through app.inject with a per-process marker.
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { HttpError, type AppContext } from "./app";
import { sha256 } from "./auth/crypto";
import { apiKeys, organizations, users } from "./db/schema";
import { assertWritable, requireFeature, saasOn, subscriptionOf } from "./saas";
import { tr } from "@taktwerk/domain";

export const INTERNAL_TOKEN = randomBytes(24).toString("hex");
export const INTERNAL_HEADER = "x-ti-internal";
export const newApiKey = () => `ti_${randomBytes(32).toString("base64url")}`;
export const bearerKey = (req: FastifyRequest) => /^Bearer (ti_[A-Za-z0-9_-]{20,})$/.exec(req.headers.authorization ?? "")?.[1];

/** Requests per key and minute. */
const LIMIT = 300;
const windows = new Map<string, { start: number; n: number }>();

export async function authenticateApiKey(ctx: AppContext, req: FastifyRequest, token: string) {
  const [row] = await ctx.db
    .select({ key: apiKeys, user: users })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .innerJoin(organizations, eq(organizations.id, users.organizationId))
    .where(and(eq(apiKeys.hash, sha256(token)), isNull(apiKeys.revokedAt), eq(users.active, true), eq(organizations.active, true)))
    .limit(1);
  if (!row) throw new HttpError(401, tr("Ungültiger oder widerrufener API-Schlüssel."));
  const { key, user: u } = row;
  const internal = req.headers[INTERNAL_HEADER] === INTERNAL_TOKEN;
  if (!internal) {
    const now = Date.now();
    const w = windows.get(key.id);
    if (!w || now - w.start > 60_000) windows.set(key.id, { start: now, n: 1 });
    else if (++w.n > LIMIT) throw new HttpError(429, tr("Zu viele Anfragen. Höchstens {0} pro Minute.", LIMIT));
  }
  req.user = { id: u.id, organizationId: u.organizationId, name: u.name, username: u.username, email: u.email, role: u.role, customerId: u.customerId, platformAdmin: false, locale: u.locale, apiKey: { id: key.id, scope: key.scope } };
  const writing = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (key.scope === "read" && writing) throw new HttpError(403, tr("Dieser API-Schlüssel darf nur lesen."));
  if (saasOn(ctx)) {
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, u.organizationId)).limit(1);
    if (org) req.user.subscription = subscriptionOf(org);
    requireFeature(req.user, "api");
    if (writing) assertWritable(req.user.subscription);
  }
  if (!internal && (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 5 * 60_000)) await ctx.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id));
}
