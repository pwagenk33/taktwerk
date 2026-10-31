// SaaS subscription: choose and change a package, pay by card (Stripe Checkout and Billing Portal) or by invoice,
// cancel at the end of the period. Stripe reports payments and changes through the webhook /api/billing/webhook.
import { PLANS, billableSeats, fmtDate, planById, priceOf, type BillingInterval, type PlanId } from "@taktwerk/domain";
import { and, eq, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, appOrigin, requireRole, type AppContext } from "../app";
import { DEFAULT_BRANDING, organizations, users } from "../db/schema";
import { actionMail } from "../mail/mailer";
import { saasOn, seatsUsed, subscriptionOf } from "../saas";
import { stripe, stripeOn, stripePrices, verifyStripeSignature } from "../stripe";
import { tr } from "@taktwerk/domain";
import { withLocale } from "../i18n";

type OrgRow = typeof organizations.$inferSelect;

/** End of a billing period that starts at `from`. */
export function periodEnd(from: Date, interval: BillingInterval) {
  const d = new Date(from);
  if (interval === "year") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

const chf = (n: number) => `CHF ${n.toLocaleString("de-CH").replace(/'/g, "’")}`;
export const intervalLabel = (i: BillingInterval) => (i === "year" ? tr("jährlich") : tr("monatlich"));

type MailContent = () => { subject: string; lines: string[]; action?: { label: string; path: string } };

/** Notice to the operator (OPERATOR_EMAIL), always in German; never fails the request. */
export async function notifyOperator(ctx: AppContext, content: MailContent) {
  if (!ctx.config.OPERATOR_EMAIL) return;
  const mail = withLocale("de", () => {
    const { subject, lines } = content();
    return actionMail(DEFAULT_BRANDING, { to: ctx.config.OPERATOR_EMAIL!, subject, greeting: tr("Hallo"), lines, footer: tr("Diese Meldung geht an OPERATOR_EMAIL.") });
  });
  await ctx.mailer.send(mail).catch(() => {});
}

/** Mail to every active admin of a company, each in their own language. */
export async function mailAdmins(ctx: AppContext, org: OrgRow, content: MailContent) {
  const admins = await ctx.db.select().from(users).where(and(eq(users.organizationId, org.id), eq(users.role, "admin"), eq(users.active, true)));
  const branding = org.settings.branding ?? DEFAULT_BRANDING;
  for (const a of admins)
    await ctx.mailer.send(
      withLocale(a.locale, () => {
        const { subject, lines, action } = content();
        return actionMail(branding, {
          to: a.email,
          subject,
          greeting: tr("Hallo {0}", a.name),
          lines,
          ...(action ? { action: action.label, url: `${appOrigin(ctx.config, org)}${action.path}` } : {}),
          footer: tr("Du erhältst diese E-Mail als Admin deiner Firma."),
        });
      }),
    );
}

export async function subscriptionRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const prices = () => stripePrices(ctx);

  const adminOrg = async (req: Parameters<typeof requireRole>[0]) => {
    const admin = requireRole(req, "admin");
    if (!saasOn(ctx)) throw new HttpError(404, tr("Diese Installation läuft ohne Abo."));
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, admin.organizationId)).limit(1);
    if (!org) throw new HttpError(404, tr("Firma nicht gefunden."));
    return { admin, org };
  };
  const view = async (org: OrgRow) => ({
    subscription: subscriptionOf(org),
    canceledAt: org.canceledAt?.toISOString() ?? null,
    seats: await seatsUsed(ctx, org.id),
    payment: stripeOn(ctx) ? ("stripe" as const) : ("invoice" as const),
    cardOnFile: !!org.stripeCustomerId,
    plans: PLANS,
  });
  const choice = z.object({ plan: z.enum(["start", "team", "business"]), interval: z.enum(["month", "year"]) });

  app.get("/api/subscription", async (req) => view((await adminOrg(req)).org));

  /** Choose or change the package. Card: Stripe Checkout (or a direct change of a running subscription). Invoice: active at once. */
  app.post("/api/subscription/checkout", async (req) => {
    const { admin, org } = await adminOrg(req);
    const body = choice.parse(req.body);
    const plan = planById(body.plan);
    const seats = billableSeats(await seatsUsed(ctx, org.id));
    const price = tr("{0} {1} für {2} Personen", chf(priceOf(plan, body.interval, seats)), intervalLabel(body.interval), seats);

    if (!stripeOn(ctx)) {
      const now = new Date();
      const keepPeriod = org.subStatus === "active" && org.billingMode === "invoice" && org.billingInterval === body.interval && org.currentPeriodEnd && org.currentPeriodEnd > now;
      await ctx.db
        .update(organizations)
        .set({ plan: body.plan, billingInterval: body.interval, subStatus: "active", billingMode: "invoice", trialEndsAt: null, canceledAt: null, currentPeriodEnd: keepPeriod ? org.currentPeriodEnd : periodEnd(now, body.interval) })
        .where(eq(organizations.id, org.id));
      const address = org.settings.billing?.address;
      await notifyOperator(ctx, () => ({ subject: tr("Rechnung stellen: {0}, {1}", org.name, plan.name), lines: [
        tr("{0} ({1}) hat für {2} das Paket {3} gewählt: {4}, zahlbar auf Rechnung.", admin.name, admin.email, org.name, plan.name, price),
        address ? `Rechnungsadresse: ${[address.name, address.street, `${address.zip} ${address.city}`].filter(Boolean).join(", ")}` : tr("Rechnungsadresse: noch nicht erfasst (Einstellungen → Rechnung)."),
      ] }));
      await mailAdmins(ctx, org, () => ({ subject: tr("Abo {0} ist aktiv", plan.name), lines: [tr("Danke! {0} nutzt jetzt das Paket {1} ({2}, zzgl. MWST). Die Rechnung folgt per E-Mail.", org.name, plan.name, price)] }));
      const [after] = await ctx.db.select().from(organizations).where(eq(organizations.id, org.id)).limit(1);
      return { ...(await view(after!)), done: true };
    }

    const priceId = prices().priceFor(body.plan, body.interval);
    if (!priceId) throw new HttpError(500, tr("Für {0} {1} ist kein Stripe-Preis hinterlegt (STRIPE_PRICES).", plan.name, intervalLabel(body.interval)));

    // A running card subscription is switched directly; Stripe prorates the difference.
    if (org.stripeSubscriptionId && (org.subStatus === "active" || org.subStatus === "past_due")) {
      const sub = await stripe(ctx, "GET", `/subscriptions/${org.stripeSubscriptionId}`);
      const item = sub.items?.data?.[0]?.id;
      if (!item) throw new HttpError(502, tr("Das Abo beim Zahlungsanbieter konnte nicht gelesen werden."));
      await stripe(ctx, "POST", `/subscriptions/${org.stripeSubscriptionId}`, { items: [{ id: item, price: priceId, quantity: seats }], proration_behavior: "create_prorations", cancel_at_period_end: false });
      await ctx.db.update(organizations).set({ plan: body.plan, billingInterval: body.interval, canceledAt: null }).where(eq(organizations.id, org.id));
      const [after] = await ctx.db.select().from(organizations).where(eq(organizations.id, org.id)).limit(1);
      return { ...(await view(after!)), done: true };
    }

    const origin = appOrigin(ctx.config, org);
    const session = await stripe(ctx, "POST", "/checkout/sessions", {
      mode: "subscription",
      line_items: [{ price: priceId, quantity: seats }],
      client_reference_id: org.id,
      ...(org.stripeCustomerId ? { customer: org.stripeCustomerId } : { customer_email: admin.email }),
      subscription_data: { metadata: { organizationId: org.id } },
      metadata: { organizationId: org.id, plan: body.plan, interval: body.interval },
      automatic_tax: { enabled: false },
      billing_address_collection: "required",
      locale: "de",
      success_url: `${origin}/einstellungen?abo=ok`,
      cancel_url: `${origin}/einstellungen?abo=abgebrochen`,
    });
    return { url: session.url as string };
  });

  /** Stripe's own page for card, invoices and receipts. */
  app.post("/api/subscription/portal", async (req) => {
    const { org } = await adminOrg(req);
    if (!org.stripeCustomerId) throw new HttpError(400, tr("Es sind noch keine Zahlungsdaten hinterlegt."));
    const session = await stripe(ctx, "POST", "/billing_portal/sessions", { customer: org.stripeCustomerId, return_url: `${appOrigin(ctx.config, org)}/einstellungen` });
    return { url: session.url as string };
  });

  /** Ends the subscription at the end of the paid period; until then everything keeps working. */
  app.post("/api/subscription/cancel", async (req) => {
    const { admin, org } = await adminOrg(req);
    if (org.subStatus !== "active" && org.subStatus !== "past_due") throw new HttpError(400, tr("Es läuft kein Abo, das gekündigt werden könnte."));
    if (org.billingMode === "stripe" && org.stripeSubscriptionId) await stripe(ctx, "POST", `/subscriptions/${org.stripeSubscriptionId}`, { cancel_at_period_end: true });
    await ctx.db.update(organizations).set({ canceledAt: new Date() }).where(eq(organizations.id, org.id));
    const until = org.currentPeriodEnd ? fmtDate(org.currentPeriodEnd.toISOString().slice(0, 10)) : tr("zum Ende der Periode");
    await notifyOperator(ctx, () => ({ subject: tr("Kündigung: {0}", org.name), lines: [tr("{0} hat das Abo von {1} ({2}) gekündigt, gültig bis {3}.", admin.name, org.name, planById(org.plan).name, until)] }));
    await mailAdmins(ctx, org, () => ({ subject: tr("Abo gekündigt"), lines: [tr("Das Abo von {0} endet am {1}. Bis dahin funktioniert alles wie gewohnt; danach bleiben die Daten lesbar und exportierbar.", org.name, until), tr("Falls das ein Versehen war: unter Einstellungen → Abo lässt sich die Kündigung zurücknehmen.")] }));
    const [after] = await ctx.db.select().from(organizations).where(eq(organizations.id, org.id)).limit(1);
    return view(after!);
  });

  app.post("/api/subscription/resume", async (req) => {
    const { org } = await adminOrg(req);
    if (!org.canceledAt || org.subStatus !== "active") throw new HttpError(400, tr("Es gibt keine Kündigung zum Zurücknehmen."));
    if (org.billingMode === "stripe" && org.stripeSubscriptionId) await stripe(ctx, "POST", `/subscriptions/${org.stripeSubscriptionId}`, { cancel_at_period_end: false });
    await ctx.db.update(organizations).set({ canceledAt: null }).where(eq(organizations.id, org.id));
    await notifyOperator(ctx, () => ({ subject: tr("Kündigung zurückgenommen: {0}", org.name), lines: [tr("{0} bleibt beim Paket {1}.", org.name, planById(org.plan).name)] }));
    const [after] = await ctx.db.select().from(organizations).where(eq(organizations.id, org.id)).limit(1);
    return view(after!);
  });

  // Stripe webhook: needs the raw body for the signature, hence its own parser in a separate scope.
  await app.register(async (hook) => {
    hook.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    hook.post("/api/billing/webhook", async (req, reply) => {
      const secret = ctx.config.STRIPE_WEBHOOK_SECRET;
      const raw = String(req.body ?? "");
      if (!secret || !verifyStripeSignature(raw, req.headers["stripe-signature"] as string | undefined, secret)) throw new HttpError(400, tr("Ungültige Signatur."));
      const event = JSON.parse(raw) as { type: string; data: { object: Record<string, any> } };
      await handleStripeEvent(ctx, event);
      return reply.send({ received: true });
    });
  });
}

const STATUS: Record<string, OrgRow["subStatus"] | undefined> = { active: "active", trialing: "active", past_due: "past_due", unpaid: "past_due", canceled: "canceled", incomplete_expired: "canceled" };

/** Applies a Stripe event to the company it belongs to. Unknown events and companies are ignored. */
export async function handleStripeEvent(ctx: AppContext, event: { type: string; data: { object: Record<string, any> } }) {
  const o = event.data.object;
  const find = async (orgId?: string | null, subId?: string | null, customer?: string | null) => {
    const conds = [orgId ? eq(organizations.id, orgId) : undefined, subId ? eq(organizations.stripeSubscriptionId, subId) : undefined, customer ? eq(organizations.stripeCustomerId, customer) : undefined].filter((c) => !!c);
    if (conds.length === 0) return null;
    const [org] = await ctx.db.select().from(organizations).where(or(...conds)).limit(1);
    return org ?? null;
  };

  if (event.type === "checkout.session.completed") {
    const org = await find(o.client_reference_id ?? o.metadata?.organizationId);
    if (!org || o.mode !== "subscription") return;
    const plan = (o.metadata?.plan as PlanId) ?? org.plan;
    const interval = (o.metadata?.interval as BillingInterval) ?? org.billingInterval;
    await ctx.db
      .update(organizations)
      .set({ plan, billingInterval: interval, subStatus: "active", billingMode: "stripe", stripeCustomerId: o.customer ?? org.stripeCustomerId, stripeSubscriptionId: o.subscription ?? org.stripeSubscriptionId, trialEndsAt: null, canceledAt: null })
      .where(eq(organizations.id, org.id));
    await notifyOperator(ctx, () => ({ subject: tr("Neues Abo: {0}", org.name), lines: [tr("{0} zahlt jetzt per Karte: {1}, {2}.", org.name, planById(plan).name, intervalLabel(interval))] }));
    await mailAdmins(ctx, org, () => ({ subject: tr("Abo {0} ist aktiv", planById(plan).name), lines: [tr("Danke! {0} nutzt jetzt das Paket {1}. Quittungen und Zahlungsdaten findest du unter Einstellungen → Abo.", org.name, planById(plan).name)] }));
    return;
  }

  if (event.type.startsWith("customer.subscription.")) {
    const org = await find(o.metadata?.organizationId, o.id, o.customer);
    if (!org) return;
    const item = o.items?.data?.[0];
    const mapped = item?.price?.id ? stripePrices(ctx).planOf(item.price.id) : null;
    const end = item?.current_period_end ?? o.current_period_end;
    const status = event.type === "customer.subscription.deleted" ? "canceled" : STATUS[o.status as string];
    await ctx.db
      .update(organizations)
      .set({
        ...(status ? { subStatus: status } : {}),
        ...(mapped ? { plan: mapped.plan, billingInterval: mapped.interval } : {}),
        ...(end ? { currentPeriodEnd: new Date(Number(end) * 1000) } : {}),
        canceledAt: o.cancel_at_period_end ? (org.canceledAt ?? new Date()) : status === "canceled" ? (org.canceledAt ?? new Date()) : null,
        stripeSubscriptionId: o.id,
        stripeCustomerId: o.customer ?? org.stripeCustomerId,
        billingMode: "stripe",
      })
      .where(eq(organizations.id, org.id));
    if (status === "canceled" && org.subStatus !== "canceled")
      await mailAdmins(ctx, org, () => ({ subject: tr("Abo beendet"), lines: [tr("Das Abo von {0} ist beendet. Die Daten bleiben lesbar und exportierbar; unter Einstellungen → Abo kannst du jederzeit wieder einsteigen.", org.name)], action: { label: tr("Abo ansehen"), path: "/einstellungen" } }));
    return;
  }

  if (event.type === "invoice.payment_failed" || event.type === "invoice.paid") {
    const subId = o.subscription ?? o.parent?.subscription_details?.subscription;
    const org = await find(null, subId, o.customer);
    if (!org) return;
    if (event.type === "invoice.paid") {
      if (org.subStatus === "past_due") await ctx.db.update(organizations).set({ subStatus: "active" }).where(eq(organizations.id, org.id));
      return;
    }
    await ctx.db.update(organizations).set({ subStatus: "past_due" }).where(eq(organizations.id, org.id));
    await mailAdmins(
      ctx,
      org, () => ({ subject: tr("Zahlung fehlgeschlagen"), lines: [tr("Die letzte Zahlung für {0} hat nicht geklappt. Bitte die Kartendaten prüfen; alles läuft noch eine Woche normal weiter.", org.name)], action: { label: tr("Zahlungsdaten prüfen"), path: "/einstellungen" } }));
  }
}
