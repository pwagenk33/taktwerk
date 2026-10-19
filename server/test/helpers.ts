import { sql } from "drizzle-orm";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createDb, runMigrations } from "../src/db/client";
import { createMailer } from "../src/mail/mailer";
import { createWebhookSender } from "../src/notify/webhooks";
import { seedSample } from "../src/seed";

export const PASSWORD = "test-passwort-123";
export const TEST_DB = process.env.TEST_DATABASE_URL ?? "mysql://taktwerk:taktwerk@localhost:3306/taktwerk_test";

/** Fresh schema + example data in the test database, and an app instance with an in-memory mailer. */
export async function setup(env: Record<string, string> = {}) {
  const config = loadConfig({ NODE_ENV: "test", APP_URL: "https://zeit.example.ch", DATABASE_URL: TEST_DB, ...env });
  const { db, pool } = createDb(config.DATABASE_URL);
  const [tables] = (await db.execute(sql`select table_name as t from information_schema.tables where table_schema = database()`)) as unknown as [{ t: string }[]];
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const { t } of tables) await db.execute(sql.raw(`DROP TABLE \`${t}\``));
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await runMigrations(db);
  await seedSample(db, PASSWORD);
  const mailer = createMailer(config, () => {});
  const webhooks = createWebhookSender(false, () => {});
  const app = await buildApp({ config, db, mailer, webhooks });
  return { app, db, pool, mailer, webhooks, config };
}

export async function login(app: Awaited<ReturnType<typeof setup>>["app"], username: string, password = PASSWORD) {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  const cookie = res.cookies.find((c) => c.name === "tw_session");
  return { res, cookie: cookie ? `tw_session=${cookie.value}` : "" };
}
