import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let anna: string;
let marco: string;
const SLACK = "8f742231b10e8888abcd99yyyzzz85a5".replace(/[^0-9a-f]/g, "0");
const TEAMS = Buffer.from("teams-outgoing-webhook-secret-123").toString("base64");

beforeAll(async () => {
  t = await setup();
  anna = (await login(t.app, "anna.keller")).cookie;
  marco = (await login(t.app, "marco.brunner")).cookie;
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

function slack(path: string, text: string, opts: { secret?: string; user?: string } = {}) {
  const body = new URLSearchParams({ team_id: "T1", user_id: opts.user ?? "U42", command: "/zeit", text }).toString();
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", opts.secret ?? SLACK).update(`v0:${ts}:${body}`).digest("hex")}`;
  return t.app.inject({ method: "POST", url: path, payload: body, headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": sig } });
}
function teams(path: string, text: string, secret = TEAMS) {
  const body = JSON.stringify({ type: "message", text: `<at>TrackInsight</at> ${text}`, from: { id: "29:abc", aadObjectId: "aad-marco", name: "Marco" } });
  const sig = createHmac("sha256", Buffer.from(secret, "base64")).update(body, "utf8").digest("base64");
  return t.app.inject({ method: "POST", url: path, payload: body, headers: { "content-type": "application/json", authorization: `HMAC ${sig}` } });
}

describe("booking from Slack and Teams", () => {
  it("links the chat account once, then books, lists and refuses unsigned calls", async () => {
    const cfg = await t.app.inject({ method: "PUT", url: "/api/chat", payload: { slackSigningSecret: SLACK, teamsSecret: TEAMS }, headers: { cookie: anna } });
    expect(cfg.statusCode).toBe(200);
    const { slack: s, teams: m } = cfg.json() as { slack: { url: string }; teams: { url: string } };
    const slackPath = new URL(s.url).pathname;
    const teamsPath = new URL(m.url).pathname;
    // Secrets never reach the browser through the settings.
    expect(JSON.stringify((await t.app.inject({ method: "GET", url: "/api/settings", headers: { cookie: marco } })).json())).not.toContain(SLACK);

    expect((await slack(slackPath, "heute", { secret: "0".repeat(32) })).statusCode).toBe(401);

    // Not linked yet: the answer carries a link that opens the app.
    const first = (await slack(slackPath, "2h irgendwas")).json() as { text: string };
    const token = /#chat-verbinden\/([\w.-]+)/.exec(first.text)![1]!;
    expect((await t.app.inject({ method: "POST", url: "/api/chat/link", payload: { token }, headers: { cookie: marco } })).json()).toEqual({ ok: true, provider: "slack" });

    // Pick a real target from the example data.
    const [rows] = (await t.pool.query(
      "select c.name c, p.name p, s.name s from sub_projects s join projects p on p.id = s.project_id join customers c on c.id = p.customer_id where p.closed_on is null order by c.name, p.name, s.name limit 1",
    )) as unknown as [{ c: string; p: string; s: string }[]];
    const target = rows[0]!;
    const words = `${target.c.split(" ")[0]} ${target.p.split(" ")[0]} ${target.s.split(" ")[0]}`;
    const booked = (await slack(slackPath, `1:30 ${words} Chat-Test gebucht`)).json() as { text: string };
    expect(booked.text).toMatch(/^Gebucht: 1[.,]5 h/);
    expect(booked.text).toContain("Chat-Test gebucht");

    const today = (await slack(slackPath, "heute")).json() as { text: string };
    expect(today.text).toContain("Chat-Test gebucht");
    expect(((await slack(slackPath, "2h zzzzqqq Text")).json() as { text: string }).text).toMatch(/Kein passendes Projekt/);

    // Teams: same flow with the HMAC header.
    expect((await teams(teamsPath, "heute", Buffer.from("wrong-secret-wrong-secret").toString("base64"))).statusCode).toBe(401);
    const tFirst = (await teams(teamsPath, "heute")).json() as { type: string; text: string };
    expect(tFirst.type).toBe("message");
    const tToken = /#chat-verbinden\/([\w.-]+)/.exec(tFirst.text)![1]!;
    await t.app.inject({ method: "POST", url: "/api/chat/link", payload: { token: tToken }, headers: { cookie: marco } });
    const week = (await teams(teamsPath, "woche")).json() as { text: string };
    expect(week.text).toMatch(/Diese Woche/);

    // A forged link token is refused.
    expect((await t.app.inject({ method: "POST", url: "/api/chat/link", payload: { token: `${token.split(".")[0]}.xxx` }, headers: { cookie: marco } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: "GET", url: "/api/chat", headers: { cookie: anna } })).json().linked).toBe(2);
  });
});
