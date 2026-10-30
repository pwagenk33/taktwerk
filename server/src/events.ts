// Outgoing webhooks: changes (from the audit trail and invoices) are queued per subscribed endpoint and
// delivered as signed HTTPS POSTs with retries. Chat messages to Teams/Slack live in notify/webhooks.ts.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import type { AppContext } from "./app";
import { webhookDeliveries, webhookEndpoints } from "./db/schema";
import { tr } from "@taktwerk/domain";

export const EVENT_TYPES = [
  "time_entry.created", "time_entry.updated", "time_entry.deleted",
  "expense.created", "expense.updated", "expense.deleted", "expense.submitted", "expense.approved", "expense.rejected",
  "absence.created", "absence.approved", "absence.rejected", "absence.deleted",
  "month.submitted", "month.approved", "month.reopened",
  "invoice.created", "invoice.sent", "invoice.paid", "invoice.cancelled",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

const PAST: Record<string, string> = { create: "created", update: "updated", delete: "deleted", submit: "submitted", approve: "approved", reject: "rejected", reopen: "reopened" };
/** Audit entries that are events; work model changes and imports are not. */
export function eventOfAudit(entity: string, action: string): EventType | null {
  const t = `${entity}.${PAST[action] ?? action}`;
  return (EVENT_TYPES as readonly string[]).includes(t) ? (t as EventType) : null;
}

/** Waits before attempt 2, 3, …; after the last one the delivery is given up. */
const RETRY_MINUTES = [1, 5, 30, 120, 360, 720, 1440];
const DISABLE_AFTER = 50;

export const newSecret = () => `whsec_${randomBytes(24).toString("base64url")}`;

/** Header value: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">. */
export function signature(secret: string, body: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

const blocked = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["::ffff:0:0", 96]] as const) blocked.addSubnet(net, bits, "ipv6");
const privateAddress = (ip: string) => blocked.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");

/** Only public HTTPS addresses, so a webhook cannot reach the server's own network. */
export function endpointProblem(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return tr("Die Webhook-URL ist ungültig."); }
  if (u.protocol !== "https:") return tr("Die Webhook-URL muss mit https:// beginnen.");
  if (u.username || u.password) return tr("Die Webhook-URL darf keine Zugangsdaten enthalten.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || (isIP(host) && privateAddress(host))) return tr("Die Webhook-URL muss eine öffentliche Adresse sein.");
  return null;
}

async function resolvesPublic(url: string) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  return addrs.length > 0 && addrs.every((a) => !privateAddress(a.address));
}

/** Queues the event for every active endpoint of the company that subscribed to it. */
export async function emit(ctx: AppContext, orgId: string, type: EventType, data: Record<string, unknown>) {
  const endpoints = await ctx.db.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.organizationId, orgId), eq(webhookEndpoints.active, true)));
  const targets = endpoints.filter((e) => e.events.includes("*") || e.events.includes(type));
  if (!targets.length) return;
  const now = new Date();
  const payload = { id: randomUUID(), type, createdAt: now.toISOString(), data };
  await ctx.db.insert(webhookDeliveries).values(targets.map((e) => ({ id: randomUUID(), organizationId: orgId, endpointId: e.id, event: type, payload, nextAttemptAt: now })));
  // Deliver right away in the running server; the job picks up whatever fails.
  if (ctx.config.NODE_ENV !== "test") setImmediate(() => void deliverDue(ctx).catch(() => {}));
}

export async function sendOnce(ctx: AppContext, endpoint: typeof webhookEndpoints.$inferSelect, deliveryId: string, event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  if (ctx.config.NODE_ENV !== "test" && !(await resolvesPublic(endpoint.url))) return { status: 0, error: tr("Die Adresse zeigt auf ein internes Netz.") };
  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", "user-agent": "TrackInsight-Webhooks/1", "trackinsight-event": event, "trackinsight-delivery": deliveryId, "trackinsight-signature": signature(endpoint.secret, body) },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? { status: res.status, error: null } : { status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { status: 0, error: (err as Error).message.slice(0, 400) };
  }
}

let delivering = false;
/** Sends due deliveries (oldest first, at most 200 per run) and schedules retries. */
export async function deliverDue(ctx: AppContext, now = new Date()) {
  if (delivering) return 0;
  delivering = true;
  try {
    const due = await ctx.db
      .select({ d: webhookDeliveries, e: webhookEndpoints })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .where(and(isNull(webhookDeliveries.deliveredAt), isNull(webhookDeliveries.failedAt), lte(webhookDeliveries.nextAttemptAt, now), eq(webhookEndpoints.active, true)))
      .orderBy(asc(webhookDeliveries.createdAt))
      .limit(200);
    for (const { d, e } of due) {
      const r = await sendOnce(ctx, e, d.id, d.event, d.payload);
      const attempts = d.attempts + 1;
      if (!r.error) {
        await ctx.db.update(webhookDeliveries).set({ attempts, deliveredAt: new Date(), lastStatus: r.status, lastError: null }).where(eq(webhookDeliveries.id, d.id));
        await ctx.db.update(webhookEndpoints).set({ failures: 0, lastStatus: r.status, lastDeliveryAt: new Date() }).where(eq(webhookEndpoints.id, e.id));
        continue;
      }
      const wait = RETRY_MINUTES[attempts - 1];
      await ctx.db
        .update(webhookDeliveries)
        .set({ attempts, lastStatus: r.status || null, lastError: r.error, ...(wait === undefined ? { failedAt: new Date() } : { nextAttemptAt: new Date(now.getTime() + wait * 60_000) }) })
        .where(eq(webhookDeliveries.id, d.id));
      const failures = e.failures + 1;
      await ctx.db.update(webhookEndpoints).set({ failures, lastStatus: r.status || null, lastDeliveryAt: new Date(), ...(failures >= DISABLE_AFTER ? { active: false } : {}) }).where(eq(webhookEndpoints.id, e.id));
      e.failures = failures;
    }
    return due.length;
  } finally {
    delivering = false;
  }
}

/** Deliveries older than 30 days are removed. */
export async function purgeDeliveries(ctx: AppContext, now = new Date()) {
  await ctx.db.delete(webhookDeliveries).where(lte(webhookDeliveries.createdAt, new Date(now.getTime() - 30 * 86400_000)));
}
