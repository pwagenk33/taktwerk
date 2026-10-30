
import { tr } from "@taktwerk/domain";

/** Posts chat messages to Microsoft Teams and Slack incoming webhooks. */
export interface ChatMessage {
  title: string;
  text: string;
  action?: { label: string; url: string };
}

export interface WebhookSender {
  post(channel: "teams" | "slack", url: string, msg: ChatMessage): Promise<void>;
  /** Messages posted so far; only kept by the in-memory sender (tests, development). */
  readonly outbox: { channel: string; url: string; msg: ChatMessage }[];
}

/** Payload for a Teams workflow / incoming webhook: an Adaptive Card, which both the new Workflows and the legacy connector accept. */
export function teamsPayload(msg: ChatMessage) {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: msg.title, weight: "Bolder", size: "Medium", wrap: true },
            { type: "TextBlock", text: msg.text, wrap: true },
          ],
          actions: msg.action ? [{ type: "Action.OpenUrl", title: msg.action.label, url: msg.action.url }] : [],
        },
      },
    ],
  };
}

/** Payload for a Slack incoming webhook: plain-text fallback plus Block Kit with a button. */
export function slackPayload(msg: ChatMessage) {
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: `*${msg.title}*\n${msg.text}` } }];
  if (msg.action) blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: msg.action.label }, url: msg.action.url }] });
  return { text: `${msg.title} – ${msg.text}${msg.action ? ` ${msg.action.url}` : ""}`, blocks };
}

/** Only https webhooks of the two services are accepted, so a typo cannot send data elsewhere. */
export function webhookProblem(channel: "teams" | "slack", url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return tr("Die Webhook-URL ist ungültig.");
  }
  if (u.protocol !== "https:") return tr("Die Webhook-URL muss mit https:// beginnen.");
  const host = u.hostname.toLowerCase();
  if (channel === "slack" && host !== "hooks.slack.com") return tr("Slack-Webhooks beginnen mit https://hooks.slack.com/…");
  if (channel === "teams" && !/(\.|^)(webhook\.office\.com|logic\.azure\.com|powerplatform\.com)$/.test(host)) {
    return tr("Teams-Webhooks liegen auf webhook.office.com oder logic.azure.com (Workflows).");
  }
  return null;
}

/** Real sender when `live` is true, otherwise messages are logged and kept in memory. */
export function createWebhookSender(live: boolean, log: (msg: string) => void = console.log): WebhookSender {
  const outbox: WebhookSender["outbox"] = [];
  return {
    outbox,
    async post(channel, url, msg) {
      if (!live) {
        outbox.push({ channel, url, msg });
        log(`[${channel}] ${msg.title}: ${msg.text}`);
        return;
      }
      const body = channel === "teams" ? teamsPayload(msg) : slackPayload(msg);
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(tr("{0} hat die Nachricht abgelehnt (HTTP {1}).", channel === "teams" ? "Teams" : "Slack", res.status));
    },
  };
}
