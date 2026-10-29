import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { organizations } from "../src/db/schema";
import { signStripePayload, verifyStripeSignature } from "../src/stripe";
import { PASSWORD, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
const HOST = "beispiel.trackinsight.test";
const SECRET = "whsec_test";
const calls: { url: string; body: string }[] = [];

beforeAll(async () => {
  t = await setup({
    SAAS: "true",
    SAAS_BASE_DOMAIN: "trackinsight.test",
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_PRICES: "start_month=price_sm,start_year=price_sy,team_month=price_tm,team_year=price_ty,business_month=price_bm,business_year=price_by",
  });
  vi.stubGlobal("fetch", async (url: string, init: { body?: string }) => {
    calls.push({ url, body: init.body ?? "" });
    const json = url.includes("/checkout/sessions")
      ? { id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" }
      : url.includes("/billing_portal/sessions")
        ? { url: "https://billing.stripe.com/p/1" }
        : url.includes("/subscriptions/sub_1")
          ? { id: "sub_1", items: { data: [{ id: "si_1", price: { id: "price_tm" } }] } }
          : {};
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await t.app.close();
  await t.pool.end();
});

const anna = async () => {
  const res = await t.app.inject({ method: "POST", url: "/api/auth/login", headers: { host: HOST }, payload: { username: "anna.keller", password: PASSWORD } });
  return `tw_session=${res.cookies.find((c) => c.name === "tw_session")!.value}`;
};
const post = (url: string, cookie: string, payload: object = {}) => t.app.inject({ method: "POST", url, headers: { host: HOST, cookie }, payload });
const webhook = (event: object, sign = true) => {
  const raw = JSON.stringify(event);
  return t.app.inject({ method: "POST", url: "/api/billing/webhook", headers: { "content-type": "application/json", "stripe-signature": sign ? signStripePayload(raw, SECRET) : "t=1,v1=00" }, payload: raw });
};
const org = async () => (await t.db.select().from(organizations).where(eq(organizations.slug, "beispiel")))[0]!;

describe("card payment through Stripe", () => {
  it("checks webhook signatures", () => {
    const raw = '{"a":1}';
    expect(verifyStripeSignature(raw, signStripePayload(raw, SECRET), SECRET)).toBe(true);
    expect(verifyStripeSignature(raw, signStripePayload(raw, "other"), SECRET)).toBe(false);
    expect(verifyStripeSignature(raw, signStripePayload(raw, SECRET, 1_000), SECRET)).toBe(false); // too old
  });

  it("checkout, webhook activation, plan change, failed payment and cancellation", async () => {
    await t.db.update(organizations).set({ subStatus: "trialing", plan: "team", trialEndsAt: new Date(Date.now() + 5 * 86_400_000) }).where(eq(organizations.slug, "beispiel"));
    const cookie = await anna();
    const checkout = await post("/api/subscription/checkout", cookie, { plan: "team", interval: "month" });
    expect(checkout.json()).toEqual({ url: "https://checkout.stripe.com/c/cs_1" });
    const sent = new URLSearchParams(calls.at(-1)!.body);
    expect(sent.get("line_items[0][price]")).toBe("price_tm");
    // Per person: the sample company has 7 people.
    expect(sent.get("line_items[0][quantity]")).toBe("7");
    expect(sent.get("success_url")).toBe(`https://${HOST}/einstellungen?abo=ok`);
    const orgId = (await org()).id;
    expect(sent.get("client_reference_id")).toBe(orgId);

    expect((await webhook({ type: "checkout.session.completed", data: { object: {} } }, false)).statusCode).toBe(400);
    const done = await webhook({ type: "checkout.session.completed", data: { object: { mode: "subscription", client_reference_id: orgId, customer: "cus_1", subscription: "sub_1", metadata: { plan: "team", interval: "month" } } } });
    expect(done.statusCode).toBe(200);
    expect(await org()).toMatchObject({ subStatus: "active", billingMode: "stripe", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", trialEndsAt: null });

    // Stripe reports the period; then the admin switches to Business directly.
    await webhook({ type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: "active", items: { data: [{ price: { id: "price_tm" }, current_period_end: 1_800_000_000 }] } } } });
    expect((await org()).currentPeriodEnd!.getTime()).toBe(1_800_000_000_000);
    const change = await post("/api/subscription/checkout", cookie, { plan: "business", interval: "year" });
    expect(change.json().subscription).toMatchObject({ plan: "business", interval: "year" });
    expect(new URLSearchParams(calls.at(-1)!.body).get("items[0][price]")).toBe("price_by");

    // A new person raises the quantity of the running subscription.
    expect((await post("/api/users", cookie, { name: "Neu Person", email: "neu.person@beispiel.ch", username: "neu.person", role: "employee" })).statusCode).toBe(201);
    const seat = new URLSearchParams(calls.at(-1)!.body);
    expect(calls.at(-1)!.url).toBe("https://api.stripe.com/v1/subscriptions/sub_1");
    expect([seat.get("items[0][id]"), seat.get("items[0][quantity]"), seat.get("proration_behavior")]).toEqual(["si_1", "8", "create_prorations"]);

    expect((await post("/api/subscription/portal", cookie)).json().url).toBe("https://billing.stripe.com/p/1");

    await webhook({ type: "invoice.payment_failed", data: { object: { customer: "cus_1", subscription: "sub_1" } } });
    expect((await org()).subStatus).toBe("past_due");
    expect(t.mailer.outbox.some((m) => m.subject === "Zahlung fehlgeschlagen")).toBe(true);
    await webhook({ type: "invoice.paid", data: { object: { customer: "cus_1", subscription: "sub_1" } } });
    expect((await org()).subStatus).toBe("active");

    const cancel = await post("/api/subscription/cancel", cookie);
    expect(cancel.json().canceledAt).toBeTruthy();
    expect(new URLSearchParams(calls.at(-1)!.body).get("cancel_at_period_end")).toBe("true");
    await webhook({ type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_1", status: "canceled" } } });
    expect((await org()).subStatus).toBe("canceled");
    expect((await post("/api/customers", cookie, { name: "Nach Ende AG" })).statusCode).toBe(402);
  });
});
