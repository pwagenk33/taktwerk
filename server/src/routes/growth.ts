// Recommendations between companies (?ref=CODE: one free month for each paying company brought in, 30 more trial
// days for the new one) and reseller partners (?partner=CODE: longer trial, commission on their customers' revenue).
import { REFERRAL_TRIAL_BONUS_DAYS, TRIAL_DAYS, mrrOf, planById, tr } from "@taktwerk/domain";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError, appOrigin, requireRole, requireUser, type AppContext } from "../app";
import { organizations, partners } from "../db/schema";
import { saasOn, seatsUsed } from "../saas";

type OrgRow = typeof organizations.$inferSelect;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE = z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,40}$/);

const paying = (o: OrgRow) => o.active && (o.subStatus === "active" || o.subStatus === "past_due");

/** What a registration code gives: a company's referral or a partner. Unknown or inactive codes give nothing. */
export async function resolveSignupCode(ctx: AppContext, code: string | undefined | null) {
  const c = code?.trim().toUpperCase();
  if (!c || !/^[A-Z0-9-]{3,40}$/.test(c)) return null;
  const [p] = await ctx.db.select().from(partners).where(and(eq(partners.code, c), eq(partners.active, true))).limit(1);
  if (p) return { kind: "partner" as const, id: p.id, name: p.name, trialDays: p.trialDays };
  const [o] = await ctx.db.select().from(organizations).where(and(eq(organizations.referralCode, c), eq(organizations.active, true))).limit(1);
  if (o) return { kind: "referral" as const, id: o.id, name: o.name, trialDays: TRIAL_DAYS + REFERRAL_TRIAL_BONUS_DAYS };
  return null;
}

async function ensureReferralCode(ctx: AppContext, org: OrgRow) {
  if (org.referralCode) return org.referralCode;
  for (let i = 0; i < 8; i++) {
    const code = Array.from(randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    try {
      await ctx.db.update(organizations).set({ referralCode: code }).where(and(eq(organizations.id, org.id), sql`${organizations.referralCode} is null`));
      const [again] = await ctx.db.select({ c: organizations.referralCode }).from(organizations).where(eq(organizations.id, org.id)).limit(1);
      if (again?.c) return again.c;
    } catch {
      // code taken by another company: try the next one
    }
  }
  throw new HttpError(500, tr("Kein Empfehlungscode frei. Bitte erneut versuchen."));
}

export async function growthRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const requirePlatformAdmin = (req: Parameters<typeof requireUser>[0]) => {
    const u = requireUser(req);
    if (!u.platformAdmin) throw new HttpError(403, tr("Nur der Betreiber der Installation darf Firmen verwalten."));
    return u;
  };

  /** Registration page: shows who recommended and how long the trial is. */
  app.get("/api/orgs/register/code", async (req) => {
    const hit = await resolveSignupCode(ctx, (req.query as { code?: string }).code);
    if (!hit) throw new HttpError(404, tr("Dieser Code ist nicht gültig."));
    return { kind: hit.kind, name: hit.name, trialDays: hit.trialDays };
  });

  /** Settings → Abo: the company's own recommendation link and what it brought. */
  app.get("/api/referral", async (req) => {
    const user = requireRole(req, "admin");
    if (!saasOn(ctx)) throw new HttpError(404, tr("Empfehlungen gibt es nur im SaaS-Betrieb."));
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, user.organizationId)).limit(1);
    const code = await ensureReferralCode(ctx, org!);
    const referred = await ctx.db.select().from(organizations).where(eq(organizations.referredByOrgId, org!.id)).orderBy(organizations.createdAt);
    const earned = referred.filter(paying).length;
    return {
      code,
      link: `${appOrigin(ctx.config)}/registrieren?ref=${code}`,
      bonusDays: REFERRAL_TRIAL_BONUS_DAYS,
      referred: referred.map((o) => ({ name: o.name, since: o.createdAt, paying: paying(o) })),
      earned,
      used: org!.freeMonthsUsed,
      open: Math.max(0, earned - org!.freeMonthsUsed),
    };
  });

  // ---------- operator: partners and credits ----------

  app.get("/api/platform/partners", async (req) => {
    requirePlatformAdmin(req);
    const rows = await ctx.db.select().from(partners).orderBy(partners.name);
    const orgs = await ctx.db.select().from(organizations).where(sql`${organizations.partnerId} is not null`);
    const out = [];
    for (const p of rows) {
      const mine = orgs.filter((o) => o.partnerId === p.id);
      let mrr = 0;
      for (const o of mine.filter(paying)) mrr += mrrOf(planById(o.plan), o.billingInterval, await seatsUsed(ctx, o.id));
      mrr = Math.round(mrr * 100) / 100;
      out.push({ ...p, companies: mine.length, paying: mine.filter(paying).length, mrr, commission: Math.round(mrr * p.commissionPercent) / 100, orgs: mine.map((o) => ({ id: o.id, name: o.name, status: o.subStatus })) });
    }
    return out;
  });

  const partnerBody = z.object({
    code: CODE,
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().toLowerCase().email(),
    commissionPercent: z.number().int().min(0).max(50),
    trialDays: z.number().int().min(TRIAL_DAYS).max(120),
    active: z.boolean().default(true),
  });

  app.post("/api/platform/partners", async (req, reply) => {
    requirePlatformAdmin(req);
    const body = partnerBody.parse(req.body);
    if (await resolveSignupCode(ctx, body.code)) throw new HttpError(409, tr("Dieser Code ist schon vergeben."));
    const id = randomUUID();
    await ctx.db.insert(partners).values({ id, ...body });
    return reply.code(201).send({ id });
  });

  app.patch("/api/platform/partners/:id", async (req) => {
    requirePlatformAdmin(req);
    const body = partnerBody.partial().omit({ code: true }).parse(req.body);
    await ctx.db.update(partners).set(body).where(eq(partners.id, (req.params as { id: string }).id));
    return { ok: true };
  });

  /** The operator has credited one free month on this company's invoice (or Stripe balance). */
  app.post("/api/platform/orgs/:id/free-month", async (req) => {
    requirePlatformAdmin(req);
    const id = (req.params as { id: string }).id;
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
    if (!org) throw new HttpError(404, tr("Firma nicht gefunden."));
    const [{ n }] = (await ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(organizations)
      .where(and(eq(organizations.referredByOrgId, id), eq(organizations.active, true), sql`${organizations.subStatus} in ('active', 'past_due')`))) as [{ n: number }];
    if (Number(n) <= org.freeMonthsUsed) throw new HttpError(409, tr("Keine offenen Gratismonate."));
    await ctx.db.update(organizations).set({ freeMonthsUsed: org.freeMonthsUsed + 1 }).where(eq(organizations.id, id));
    return { ok: true, used: org.freeMonthsUsed + 1 };
  });
}
