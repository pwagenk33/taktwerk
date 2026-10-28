import { describe, expect, it } from "vitest";
import { canWrite, hasFeature, mrrOf, planById, planForUsers, priceOf, trialDaysLeft } from "../plans";

const now = new Date("2026-11-01T12:00:00Z");
const days = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

describe("packages", () => {
  it("prices, yearly discount and MRR", () => {
    expect(priceOf(planById("team"), "year")).toBe(2900);
    expect(mrrOf(planById("team"), "year")).toBe(241.67);
    expect(mrrOf(planById("start"), "month")).toBe(79);
    expect([1, 10, 11, 50, 51, 500].map((n) => planForUsers(n).id)).toEqual(["start", "start", "team", "team", "business", "business"]);
  });

  it("features by package; no subscription means self-hosted with everything", () => {
    expect(hasFeature({ plan: "start", status: "active", interval: "month" }, "planning")).toBe(false);
    expect(hasFeature({ plan: "team", status: "active", interval: "month" }, "planning")).toBe(true);
    expect(hasFeature({ plan: "team", status: "active", interval: "month" }, "auditor")).toBe(false);
    expect(hasFeature(null, "auditor")).toBe(true);
  });

  it("read-only only after the grace period", () => {
    const trial = { plan: "team" as const, status: "trialing" as const, interval: "month" as const };
    expect(trialDaysLeft({ ...trial, trialEndsAt: days(5) }, now)).toBe(5);
    expect(canWrite({ ...trial, trialEndsAt: days(-3) }, now)).toBe(true);
    expect(canWrite({ ...trial, trialEndsAt: days(-8) }, now)).toBe(false);
    expect(canWrite({ ...trial, status: "past_due", currentPeriodEnd: days(-2) }, now)).toBe(true);
    expect(canWrite({ ...trial, status: "canceled" }, now)).toBe(false);
    expect(canWrite({ ...trial, status: "active" }, now)).toBe(true);
  });
});
