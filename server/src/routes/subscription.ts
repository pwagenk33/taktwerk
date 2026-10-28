// SaaS subscription: choose and change a package, pay by card (Stripe Checkout and Billing Portal) or by invoice,
// cancel at the end of the period. Stripe reports payments and changes through the webhook /api/billing/webhook.
import { PLANS, fmtDate, planById, priceOf, type BillingInterval, type PlanId } from "@taktwerk/domain";
import { and, eq, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, appOrigin, requireRole, type AppContext } from "../app";
import { DEFAULT_BRANDING, organizations, users } from "../db/schema";
import { actionMail } from "../mail/mailer";
import { saasOn, seatsUsed, subscriptionOf } from "../saas";
import { stripe, stripeOn, stripePrices, verifyStripeSignature } from "../stripe";

type OrgRow = typeof organizations.$inferSelect;

/** End of a billing period that starts at `from`. */
export function periodEnd(from: Date, interval: BillingInterval) {
  const d = new Date(from);
  if (interval === "year") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

const chf = (n: number) => `CHF ${n.toLocaleString("de-CH")}`;
export const intervalLabel = (i: BillingInterval) => (i === "year" ? "jährlich" : "monatlich");

/** Notice to the operator (OPERATOR_EMAIL); never fails the request. */
export async function notifyOperator(ctx: AppContext, subject: string, lines: string[]) {
  if (!ctx.config.OPERATOR_EMAIL) return;
  await ctx.mailer
    .send(actionMail(DEFAULT_BRANDING, { to: ctx.config.OPERATOR_EMAIL, subject, greeting: "Hallo", lines, footer: "Diese Meldung geht an OPERATOR_EMAIL." }))
    .catch(() => {});
}

/** Mail to every active admin of a company. */
export async function mailAdmins(ctx: AppContext, org: OrgRow, subject: string, lines: string[], action?: { label: string; path: string }) {
  const admins = await ctx.db.select().from(users).where(and(eq(users.organizationId, org.id), eq(users.role, "admin"), eq(users.active, true)));
  const branding = org.settings.branding ?? DEFAULT_BRANDING;
  for (const a of admins)
    await ctx.mailer.send(
      actionMail(branding, {
        to: a.email,
        subject,
        greeting: `Hallo ${a.name}`,
        lines,
        ...(action ? { action: action.label, url: `${appOrigin(ctx.config, org)}${action.path}` } : {}),
        footer: "Du erhältst diese E-Mail als Admin deiner Firma.",
      }),
    );
}

export async function subscriptionRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const prices = () => stripePrices(ctx);

  const adminOrg = async (req: Parameters<typeof requireRole>[0]) => {
    const admin = requireRole(req, "admin");
    if (!saasOn(ctx)) throw new HttpError(404, "Diese Installation läuft ohne Abo.");
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, admin.organizationId)).limit(1);
    if (!org) throw new HttpError(404, "Firma nicht gefunden.");
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
  const assertFits = async (org: OrgRow, plan: PlanId) => {
    const used = await seatsUsed(ctx, org.id);
    const p = planById(plan);
    if (used > p.maxUsers) throw new HttpError(400, `Aktiv sind ${used} Personen, das Paket ${p.name} umfasst ${p.maxUsers}. Bitte zuerst Personen deaktivieren oder ein grösseres Paket wählen.`);
  };

  app.get("/api/subscription", async (req) => view((await adminOrg(req)).org));

  /** Choose or change the package. Card: Stripe Checkout (or a direct change of a running subscription). Invoice: active at once. */
  app.post("/api/subscription/checkout", async (req) => {
    const { admin, org } = await adminOrg(req);
    const body = choice.parse(req.body);
    await assertFits(org, body.plan);
    const plan = planById(body.plan);
    const price = `${chf(priceOf(plan, body.interval))} ${intervalLabel(body.interval)}`;

    if (!stripeOn(ctx)) {
      const now = new Date();
      const keepPeriod = org.subStatus === "active" && org.billingMode === "invoice" && org.billingInterval === body.interval && org.currentPeriodEnd && org.currentPeriodEnd > now;
      await ctx.db
        .update(organizations)
        .set({ plan: body.plan, billingInterval: body.interval, subStatus: "active", billingMode: "invoice", trialEndsAt: null, canceledAt: null, currentPeriodEnd: keepPeriod ? org.currentPeriodEnd : periodEnd(now, body.interval) })
        .where(eq(organizations.id, org.id));
      const address = org.settings.billing?.address;
      await notifyOperator(ctx, `Rechnung stellen: ${org.name}, ${plan.name}`, [
        `${admin.name} (${admin.email}) hat für ${org.name} das Paket ${plan.name} gewählt: ${price}, zahlbar auf Rechnung.`,
        address ? `Rechnungsadresse: ${[address.name, address.street, `${address.zip} ${address.city}`].filter(Boolean).join(", ")}` : "Rechnungsadresse: noch nicht erfasst (Einstellungen → Rechnung).",
      ]);
      await mailAdmins(ctx, org, `Abo ${plan.name} ist aktiv`, [`Danke! ${org.name} nutzt jetzt das Paket ${plan.name} (${price}, zzgl. MWST). Die Rechnung folgt per E-Mail.`]);
      const [after] = await ctx.db.select().from(organizations).where(eq(organizations.id, org.id)).limit(1);
      return { ...(await view(after!)), done: true };
    }

    const priceId = prices().priceFor(body.plan, body.interval);
    if (!priceId) throw new HttpError(500, `Für ${plan.name} ${intervalLabel(body.interval)} ist kein Stripe-Preis hinterlegt (STRIPE_PRICES).`);

    // A running card subscription is switched directly; Stripe prorates the difference.
    if (org.stripeSubscriptionId && (org.subStatus === "active" || org.subStatus === "past_due")) {
      const sub = await stripe(ctx, "GET", `/subscriptions/${org.stripeSubscriptionId}`);
      const item = sub.items?.data?.[0]?.id;
      if (!item) throw new HttpError(502, "Das Abo beim Zahlungsanbieter konnte nicht gelesen werden.");
      await stripe(ctx, "POST", `/subscriptions/${org.stripeSubscriptionId}`, { items: [{ id: item, price: priceId }], proration_behavior: "create_prorations", cancel_at_period_end: false });
      await ctx.db.update(organizations).set({ plan: body.plan, billingInterval: body.interval, canceledAt: null }).where(eq(organizations.id, org.id));
      const [after] = await ctx.db.select().from(organizations).where(eq(organizations.id, org.id)).limit(1);
      return { ...(await view(after!)), done: true };
    }

    const origin = appOrigin(ctx.config, org);
    const session = await stripe(ctx, "POST", "/checkout/sessions", {
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
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
    if (!org.stripeCustomerId) throw new HttpError(400, "Es sind noch keine Zahlungsdaten hinterlegt.");
    const session = await stripe(ctx, "POST", "/billing_portal/sessions", { customer: org.stripeCustomerId, return_url: `${appOrigin(ctx.config, org)}/einstellungen` });
    return { url: session.url as string };
  });

  /** Ends the subscription at the end of the paid period; until then everything keeps working. */
  app.post("/api/subscription/cancel", async (req) => {
    const { admin, org } = await adminOrg(req);
    if (org.subStatus !== "active" && org.subStatus !== "past_due") throw new HttpError(400, "Es läuft kein Abo, das gekündigt werden könnte.");
    if (org.billingMode === "stripe" && org.stripeSubscriptionId) await stripe(ctx, "POST", `/subscriptions/${org.stripeSubscriptionId}`, { cancel_at_period_end: true });
    await ctx.db.update(organizations).set({ canceledAt: new Date() }).where(eq(organizations.id, org.id));
    const until = org.currentPeriodEnd ? fmtDate(org.currentPeriodEnd.toISOString().slice(0, 10)) : "zum Ende der Periode";
    await notifyOperator(ctx, `Kündigung: ${org.name}`, [`${admin.name} hat das Abo von ${org.name} (${planById(org.plan).name}) gekündigt, gültig bis ${until}.`]);
    await mailAdmins(ctx, org, "Abo gekündigt", [`Das Abo von ${org.name} endet am ${until}. Bis dahin funktioniert alles wie gewohnt; danach bleiben die Daten lesbar und exportierbar.`, "Falls das ein Versehen war: unter Einstellungen → Abo lässt sich die Kündigung zurücknehmen."]);
    const [after] = await ctx.db.select().from(organizations).where(eq(organizations.id, org.id)).limit(1);
    return view(after!);
  });

  app.post("/api/subscription/resume", async (req) => {
    const { org } = await adminOrg(req);
    if (!org.canceledAt || org.subStatus !== "active") throw new HttpError(400, "Es gibt keine Kündigung zum Zurücknehmen.");
    if (org.billingMode === "stripe" && org.stripeSubscriptionId) await stripe(ctx, "POST", `/subscriptions/${org.stripeSubscriptionId}`, { cancel_at_period_end: false });
    await ctx.db.update(organizations).set({ canceledAt: null }).where(eq(organizations.id, org.id));
    await notifyOperator(ctx, `Kündigung zurückgenommen: ${org.name}`, [`${org.name} bleibt beim Paket ${planById(org.plan).name}.`]);
    const [after] = await ctx.db.select().from(organizations).where(eq(organizations.id, org.id)).limit(1);
    return view(after!);
  });

  // Stripe webhook: needs the raw body for the signature, hence its own parser in a separate scope.
  await app.register(async (hook) => {
    hook.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    hook.post("/api/billing/webhook", async (req, reply) => {
      const secret = ctx.config.STRIPE_WEBHOOK_SECRET;
      const raw = String(req.body ?? "");
      if (!secret || !verifyStripeSignature(raw, req.headers["stripe-signature"] as string | undefined, secret)) throw new HttpError(400, "Ungültige Signatur.");
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
    await notifyOperator(ctx, `Neues Abo: ${org.name}`, [`${org.name} zahlt jetzt per Karte: ${planById(plan).name}, ${intervalLabel(interval)}.`]);
    await mailAdmins(ctx, org, `Abo ${planById(plan).name} ist aktiv`, [`Danke! ${org.name} nutzt jetzt das Paket ${planById(plan).name}. Quittungen und Zahlungsdaten findest du unter Einstellungen → Abo.`]);
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
      await mailAdmins(ctx, org, "Abo beendet", [`Das Abo von ${org.name} ist beendet. Die Daten bleiben lesbar und exportierbar; unter Einstellungen → Abo kannst du jederzeit wieder einsteigen.`], { label: "Abo ansehen", path: "/einstellungen" });
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
      org,
      "Zahlung fehlgeschlagen",
      [`Die letzte Zahlung für ${org.name} hat nicht geklappt. Bitte die Kartendaten prüfen; alles läuft noch eine Woche normal weiter.`],
      { label: "Zahlungsdaten prüfen", path: "/einstellungen" },
    );
  }
}
