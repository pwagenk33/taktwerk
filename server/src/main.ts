import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createDb, runMigrations } from "./db/client";
import { startScheduler } from "./jobs";
import { createMailer } from "./mail/mailer";
import { createWebhookSender } from "./notify/webhooks";

const config = loadConfig();
const { db } = createDb(config.DATABASE_URL);
await runMigrations(db);
const app = await buildApp({ config, db, mailer: createMailer(config), webhooks: createWebhookSender(config.NODE_ENV === "production") });
await app.listen({ port: config.PORT, host: "0.0.0.0" });
startScheduler(app.ctx, (msg, err) => app.log.error(err, msg));
