// Booking from Slack (slash command /zeit) and Microsoft Teams (outgoing webhook, @TrackInsight).
// Both requests are signed with a secret the company admin stores under Settings → Chat; the person's chat
// account is linked once through a link that opens the app.
import { addDays, fmt1, matchChatTarget, mondayOf, parseChatCommand, tr, type ChatTarget } from "@taktwerk/domain";
import { and, asc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { HttpError, SESSION_COOKIE, appOrigin, requireRole, requireUser, type AppContext } from "../app";
import { newToken, sha256 } from "../auth/crypto";
import { chatLinks, customers, organizations, projects, sessions, subProjects, timeEntries, users } from "../db/schema";
import { withLocale } from "../i18n";
import { todayZurich } from "./data";

type Provider = "slack" | "teams";
type OrgRow = typeof organizations.$inferSelect;

const secretOf = (org: OrgRow, p: Provider) => (p === "slack" ? org.settings.chat?.slackSigningSecret : org.settings.chat?.teamsSecret);

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Slack: v0=HMAC-SHA256(signing secret, "v0:<timestamp>:<body>"), timestamp at most 5 minutes old. */
export function slackSignatureOk(secret: string, raw: string, ts: string | undefined, sig: string | undefined, now = Date.now()) {
  if (!ts || !sig || Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const mine = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex")}`;
  return safeEqual(mine, sig);
}
/** Teams outgoing webhook: "HMAC <base64 HMAC-SHA256 of the body, keyed with the base64-decoded secret>". */
export function teamsSignatureOk(secret: string, raw: string, header: string | undefined) {
  if (!header?.startsWith("HMAC ")) return false;
  const mine = createHmac("sha256", Buffer.from(secret, "base64")).update(raw, "utf8").digest("base64");
  return safeEqual(mine, header.slice(5).trim());
}

/** Stateless link token: provider, company, chat account and expiry, signed with the company's chat secret. */
function linkToken(org: OrgRow, p: Provider, externalId: string) {
  const payload = Buffer.from(JSON.stringify({ p, o: org.id, x: externalId, e: Date.now() + 30 * 60_000 })).toString("base64url");
  const sig = createHmac("sha256", `link:${secretOf(org, p)}`).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function readLinkToken(token: string) {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { p: Provider; o: string; x: string; e: number };
    return { data, payload, sig };
  } catch {
    return null;
  }
}

async function bookingTargets(ctx: AppContext, orgId: string, date: string): Promise<ChatTarget[]> {
  const rows = await ctx.db
    .select({ id: subProjects.id, sub: subProjects.name, project: projects.name, customer: customers.name })
    .from(subProjects)
    .innerJoin(projects, eq(projects.id, subProjects.projectId))
    .innerJoin(customers, eq(customers.id, projects.customerId))
    .where(and(eq(subProjects.organizationId, orgId), or(isNull(projects.closedOn), gte(projects.closedOn, date))))
    .orderBy(asc(customers.name), asc(projects.name), asc(subProjects.name));
  return rows.map((r) => ({ subProjectId: r.id, label: `${r.customer} · ${r.project} · ${r.sub}` }));
}

const helpText = () =>
  [
    tr("So buchst du aus dem Chat:"),
    tr("• «2h Muster Website Startseite überarbeitet»: Dauer, Projekt (Anfang des Namens genügt), Text"),
    tr("• «gestern 1:30 Muster Shop Fehler behoben»: für gestern"),
    tr("• «heute» oder «woche»: deine Stunden"),
    tr("• «verbinden»: Chat-Konto mit TrackInsight verknüpfen"),
  ].join("\n");

export async function chatRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  /** Runs an app route as the linked person with a one-minute session, so every rule of the app applies. */
  const asUser = async (userId: string, locale: string | null, method: "POST", url: string, payload: object) => {
    const token = newToken();
    await ctx.db.insert(sessions).values({ id: sha256(token), userId, expiresAt: new Date(Date.now() + 60_000), userAgent: "chat", ip: null, lastSeenAt: new Date() });
    try {
      return await app.inject({ method, url, payload, headers: { cookie: `${SESSION_COOKIE}=${token}`, "accept-language": locale ?? "de" } });
    } finally {
      await ctx.db.delete(sessions).where(eq(sessions.id, sha256(token)));
    }
  };

  /** The answer to one chat message, in the person's language. */
  const answer = async (org: OrgRow, provider: Provider, externalId: string, text: string): Promise<string> => {
    const cmd = parseChatCommand(text);
    const [link] = await ctx.db
      .select({ user: users })
      .from(chatLinks)
      .innerJoin(users, eq(users.id, chatLinks.userId))
      .where(and(eq(chatLinks.organizationId, org.id), eq(chatLinks.provider, provider), eq(chatLinks.externalId, externalId)))
      .limit(1);
    const connectLine = () => tr("Verbinde zuerst dein Konto (Link 30 Minuten gültig): {0}", `${appOrigin(ctx.config, org)}/#chat-verbinden/${linkToken(org, provider, externalId)}`);
    if (!link || !link.user.active) return cmd.kind === "help" ? `${helpText()}\n\n${connectLine()}` : connectLine();
    const user = link.user;
    return withLocale(user.locale, async () => {
      if (cmd.kind === "link") return tr("Dein Chat-Konto ist bereits mit {0} verbunden.", user.name);
      if (cmd.kind === "help" || cmd.kind === "unknown") return (cmd.kind === "unknown" ? `${tr("Das habe ich nicht verstanden.")}\n` : "") + helpText();
      const today = todayZurich();
      if (cmd.kind === "today" || cmd.kind === "week") {
        const from = cmd.kind === "today" ? today : mondayOf(today);
        const rows = await ctx.db
          .select({ date: timeEntries.date, hours: timeEntries.hours, reason: timeEntries.reason, sub: subProjects.name, project: projects.name })
          .from(timeEntries)
          .innerJoin(subProjects, eq(subProjects.id, timeEntries.subProjectId))
          .innerJoin(projects, eq(projects.id, subProjects.projectId))
          .where(and(eq(timeEntries.userId, user.id), gte(timeEntries.date, from), lte(timeEntries.date, today)))
          .orderBy(asc(timeEntries.date));
        const total = rows.reduce((s, r) => s + r.hours, 0);
        if (cmd.kind === "today") {
          if (!rows.length) return tr("Heute ist noch nichts gebucht.");
          return [tr("Heute {0} h:", fmt1(total)), ...rows.map((r) => `• ${fmt1(r.hours)} h ${r.project} · ${r.sub}: ${r.reason}`)].join("\n");
        }
        const byDay = new Map<string, number>();
        for (const r of rows) byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.hours);
        return [tr("Diese Woche {0} h:", fmt1(total)), ...[...byDay].map(([d, h]) => `• ${d}: ${fmt1(h)} h`)].join("\n");
      }
      // Booking
      const date = cmd.daysAgo ? addDays(today, -cmd.daysAgo) : today;
      const targets = await bookingTargets(ctx, org.id, date);
      const m = matchChatTarget(cmd.words, targets);
      if (m.kind === "none") return tr("Kein passendes Projekt gefunden. Schreib den Anfang von Kunde, Projekt oder Teilprojekt nach der Dauer, z. B. «2h Muster Website Text».");
      if (m.kind === "ambiguous") return [tr("Mehrere Projekte passen, bitte genauer:"), ...m.options.map((o) => `• ${o.label}`)].join("\n");
      const reason = m.reason || tr("Über {0} gebucht", provider === "slack" ? "Slack" : "Teams");
      const res = await asUser(user.id, user.locale, "POST", "/api/time-entries", { subProjectId: m.target.subProjectId, date, hours: cmd.hours, reason });
      if (res.statusCode !== 201) return tr("Nicht gebucht: {0}", (res.json() as { error?: string }).error ?? res.statusMessage);
      return tr("Gebucht: {0} h am {1} auf {2} («{3}»).", fmt1(cmd.hours), date, m.target.label, reason);
    });
  };

  const orgFor = async (id: string, p: Provider) => {
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
    return org && org.active && secretOf(org, p) ? org : null;
  };

  // Signed webhooks need the raw body, so this child scope takes every body as text.
  await app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));

    hooks.post("/api/chat/slack/:orgId", async (req, reply) => {
      const org = await orgFor((req.params as { orgId: string }).orgId, "slack");
      const raw = typeof req.body === "string" ? req.body : "";
      if (!org || !slackSignatureOk(secretOf(org, "slack")!, raw, req.headers["x-slack-request-timestamp"] as string | undefined, req.headers["x-slack-signature"] as string | undefined))
        return reply.code(401).send({ error: "invalid signature" });
      const form = new URLSearchParams(raw);
      const externalId = `${form.get("team_id") ?? ""}:${form.get("user_id") ?? ""}`;
      const text = await answer(org, "slack", externalId, form.get("text") ?? "");
      return { response_type: "ephemeral", text };
    });

    hooks.post("/api/chat/teams/:orgId", async (req, reply) => {
      const org = await orgFor((req.params as { orgId: string }).orgId, "teams");
      const raw = typeof req.body === "string" ? req.body : "";
      if (!org || !teamsSignatureOk(secretOf(org, "teams")!, raw, req.headers.authorization)) return reply.code(401).send({ error: "invalid signature" });
      let activity: { text?: string; from?: { id?: string; aadObjectId?: string } };
      try {
        activity = JSON.parse(raw);
      } catch {
        return reply.code(400).send({ error: "invalid json" });
      }
      const externalId = activity.from?.aadObjectId || activity.from?.id || "";
      if (!externalId) return reply.code(400).send({ error: "sender missing" });
      return { type: "message", text: (await answer(org, "teams", externalId, activity.text ?? "")).replace(/\n/g, "<br>") };
    });
  });

  /** Opened from the link in the chat while signed in to the app. */
  app.post("/api/chat/link", async (req) => {
    const user = requireUser(req);
    const { token } = z.object({ token: z.string().max(2000) }).parse(req.body);
    const parsed = readLinkToken(token);
    if (!parsed || parsed.data.e < Date.now()) throw new HttpError(400, tr("Der Link ist abgelaufen. Schreib im Chat «verbinden» für einen neuen."));
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, parsed.data.o)).limit(1);
    const secret = org ? secretOf(org, parsed.data.p) : undefined;
    const expect = secret ? createHmac("sha256", `link:${secret}`).update(parsed.payload).digest("base64url") : "";
    if (!org || !secret || !safeEqual(expect, parsed.sig)) throw new HttpError(400, tr("Der Link ist ungültig."));
    if (org.id !== user.organizationId) throw new HttpError(403, tr("Der Link gehört zu einer anderen Firma. Bitte dort anmelden."));
    await ctx.db.delete(chatLinks).where(and(eq(chatLinks.organizationId, org.id), eq(chatLinks.provider, parsed.data.p), eq(chatLinks.externalId, parsed.data.x)));
    await ctx.db.insert(chatLinks).values({ id: randomUUID(), organizationId: org.id, provider: parsed.data.p, externalId: parsed.data.x, userId: user.id });
    return { ok: true, provider: parsed.data.p };
  });

  // ---------- admin ----------

  const view = async (org: OrgRow) => {
    const base = appOrigin(ctx.config, org);
    const [{ n }] = (await ctx.db.select({ n: sql<number>`count(*)` }).from(chatLinks).where(eq(chatLinks.organizationId, org.id))) as [{ n: number }];
    return {
      slack: { configured: !!org.settings.chat?.slackSigningSecret, url: `${base}/api/chat/slack/${org.id}` },
      teams: { configured: !!org.settings.chat?.teamsSecret, url: `${base}/api/chat/teams/${org.id}` },
      linked: Number(n),
    };
  };

  app.get("/api/chat", async (req) => {
    const user = requireRole(req, "admin");
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, user.organizationId)).limit(1);
    return view(org!);
  });

  app.put("/api/chat", async (req) => {
    const user = requireRole(req, "admin");
    const body = z
      .object({
        slackSigningSecret: z.string().trim().regex(/^([0-9a-f]{32})?$/, tr("Das Slack Signing Secret besteht aus 32 Zeichen 0-9 und a-f.")).optional(),
        teamsSecret: z.string().trim().regex(/^([A-Za-z0-9+/=]{20,200})?$/, tr("Das Teams-Sicherheitstoken ist ungültig (Base64).")).optional(),
      })
      .parse(req.body);
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, user.organizationId)).limit(1);
    const chat = { ...org!.settings.chat };
    if (body.slackSigningSecret !== undefined) chat.slackSigningSecret = body.slackSigningSecret || undefined;
    if (body.teamsSecret !== undefined) chat.teamsSecret = body.teamsSecret || undefined;
    const settings = { ...org!.settings, chat };
    await ctx.db.update(organizations).set({ settings }).where(eq(organizations.id, org!.id));
    return view({ ...org!, settings });
  });
}
