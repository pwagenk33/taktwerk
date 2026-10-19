import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireUser } from "../app";
import { organizations, users, type ReminderSettings } from "../db/schema";
import { reminderMessage, sendReminderTo } from "../jobs";
import { webhookProblem } from "../notify/webhooks";

export const DEFAULT_REMINDER: ReminderSettings = { channel: "off", time: "17:00", days: [1, 2, 3, 4, 5] };

const body = z.object({
  channel: z.enum(["off", "mail", "teams", "slack"]),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Uhrzeit als HH:MM"),
  days: z.array(z.number().int().min(1).max(7)).max(7),
  webhookUrl: z.string().trim().max(1000).optional(),
});

/** Personal «nothing booked today» reminder: everyone manages their own channel, time and days. */
export async function reminderRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.get("/api/me/reminder", async (req) => {
    const user = requireUser(req);
    const [row] = await ctx.db.select({ reminder: users.reminder }).from(users).where(eq(users.id, user.id));
    return row?.reminder ?? DEFAULT_REMINDER;
  });

  app.put("/api/me/reminder", async (req) => {
    const user = requireUser(req);
    const r = body.parse(req.body);
    if ((r.channel === "teams" || r.channel === "slack") && !r.webhookUrl) throw new HttpError(400, "Für Teams oder Slack brauchst du die Webhook-URL deines Kanals.");
    if ((r.channel === "teams" || r.channel === "slack") && r.webhookUrl) {
      const problem = webhookProblem(r.channel, r.webhookUrl);
      if (problem) throw new HttpError(400, problem);
    }
    const reminder: ReminderSettings = { channel: r.channel, time: r.time, days: [...new Set(r.days)].sort(), webhookUrl: r.webhookUrl || undefined };
    await ctx.db.update(users).set({ reminder }).where(eq(users.id, user.id));
    return reminder;
  });

  /** Sends the reminder now, so the person can check that the channel works. */
  app.post("/api/me/reminder/test", async (req) => {
    const user = requireUser(req);
    const [row] = await ctx.db.select().from(users).where(eq(users.id, user.id));
    if (!row?.reminder || row.reminder.channel === "off") throw new HttpError(400, "Zuerst einen Kanal wählen und speichern.");
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, user.organizationId)).limit(1);
    if (!org) throw new HttpError(404, "Nicht gefunden.");
    await sendReminderTo(ctx, org.settings, row, reminderMessage(org.settings, row, 0, ctx.config.APP_URL, true));
    return { ok: true, channel: row.reminder.channel };
  });
}
