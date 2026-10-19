import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendDailyReminders } from "../src/jobs";
import { slackPayload, teamsPayload, webhookProblem } from "../src/notify/webhooks";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let cookie = "";

beforeAll(async () => {
  t = await setup();
  cookie = (await login(t.app, "lea.meier")).cookie;
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

describe("personal reminders", () => {
  it("validates webhooks and stores the own settings", async () => {
    expect(webhookProblem("slack", "https://hooks.slack.com/services/T0/B0/x")).toBeNull();
    expect(webhookProblem("slack", "https://example.com/hook")).toMatch(/hooks\.slack\.com/);
    expect(webhookProblem("teams", "https://contoso.webhook.office.com/webhookb2/abc")).toBeNull();
    expect(webhookProblem("teams", "https://prod-12.westeurope.logic.azure.com:443/workflows/x")).toBeNull();
    expect(webhookProblem("teams", "http://contoso.webhook.office.com/x")).toMatch(/https/);
    expect(teamsPayload({ title: "T", text: "x", action: { label: "Go", url: "https://a" } }).attachments[0].content.actions).toHaveLength(1);
    expect(slackPayload({ title: "T", text: "x" }).text).toContain("T – x");

    const def = await t.app.inject({ method: "GET", url: "/api/me/reminder", headers: { cookie } });
    expect(def.json()).toEqual({ channel: "off", time: "17:00", days: [1, 2, 3, 4, 5] });

    const bad = await t.app.inject({ method: "PUT", url: "/api/me/reminder", headers: { cookie }, payload: { channel: "slack", time: "16:30", days: [1, 2] } });
    expect(bad.statusCode).toBe(400);

    const ok = await t.app.inject({ method: "PUT", url: "/api/me/reminder", headers: { cookie }, payload: { channel: "slack", time: "16:30", days: [3, 1, 2], webhookUrl: "https://hooks.slack.com/services/T0/B0/x" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ channel: "slack", time: "16:30", days: [1, 2, 3], webhookUrl: "https://hooks.slack.com/services/T0/B0/x" });

    const test = await t.app.inject({ method: "POST", url: "/api/me/reminder/test", headers: { cookie } });
    expect(test.statusCode).toBe(200);
    expect(t.webhooks.outbox.at(-1)?.channel).toBe("slack");
    expect(t.webhooks.outbox.at(-1)?.msg.title).toContain("Testnachricht");
  });

  it("sends once per day at the chosen time, only on empty work days", async () => {
    t.webhooks.outbox.length = 0;
    // Lea: Slack at 16:30 on Mon–Wed. 2026-11-04 is a Wednesday in the future, so nothing is booked.
    expect(await sendDailyReminders(t.app.ctx, new Date("2026-11-04T15:00:00Z"))).toEqual([]); // 16:00 Zurich, too early
    const sent = await sendDailyReminders(t.app.ctx, new Date("2026-11-04T15:45:00Z")); // 16:45 Zurich
    expect(sent.map((s) => s.channel)).toEqual(["slack"]);
    expect(t.webhooks.outbox).toHaveLength(1);
    expect(t.webhooks.outbox[0]?.msg.title).toContain("Heute noch nichts gebucht");
    expect(await sendDailyReminders(t.app.ctx, new Date("2026-11-04T17:00:00Z"))).toEqual([]); // same day: no repeat
    expect(await sendDailyReminders(t.app.ctx, new Date("2026-11-05T17:00:00Z"))).toEqual([]); // Thursday: not chosen
    expect(await sendDailyReminders(t.app.ctx, new Date("2026-11-07T17:00:00Z"))).toEqual([]); // Saturday: no target hours

    // Mail channel: the reminder lands in the mailbox with a link to the calendar.
    await t.app.inject({ method: "PUT", url: "/api/me/reminder", headers: { cookie }, payload: { channel: "mail", time: "09:00", days: [1, 2, 3, 4, 5] } });
    t.mailer.outbox.length = 0;
    const mail = await sendDailyReminders(t.app.ctx, new Date("2026-11-10T10:00:00Z"));
    expect(mail.map((s) => s.channel)).toEqual(["mail"]);
    expect(t.mailer.outbox[0]?.to).toBe("lea.meier@beispiel.ch");
    expect(t.mailer.outbox[0]?.text).toContain("/#zeit");
  });
});
