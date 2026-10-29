import { describe, expect, it } from "vitest";
import { billableSeats, canWrite, hasFeature, mrrOf, planById, priceOf, trialDaysLeft } from "../plans";

const now = new Date("2026-11-01T12:00:00Z");
const days = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

describe("packages", () => {
  it("prices, yearly discount and MRR", () => {
    // CHF per person and month, a year costs ten months, at least three people.
    expect(priceOf(planById("team"), "month", 12)).toBe(180);
    expect(priceOf(planById("team"), "year", 12)).toBe(1800);
    expect(mrrOf(planById("team"), "year", 12)).toBe(150);
    expect(mrrOf(planById("start"), "month", 1)).toBe(27);
    expect([0, 1, 3, 4, 50].map(billableSeats)).toEqual([3, 3, 3, 4, 50]);
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
