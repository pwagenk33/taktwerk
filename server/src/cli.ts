// Usage:
//   tsx src/cli.ts migrate
//   tsx src/cli.ts seed [password]              example data, all sample users get the password
//   tsx src/cli.ts init "<Firma>" "<Name>" <email> <username>   empty installation, invitation link for the admin
import { randomBytes } from "node:crypto";
import { loadConfig } from "./config";
import { createDb, runMigrations } from "./db/client";
import { organizations } from "./db/schema";
import { createOrganization, seedSample } from "./seed";
import { createMailer, actionMail } from "./mail/mailer";
import { DEFAULT_BRANDING } from "./db/schema";
import { createPasswordToken, passwordLink } from "./routes/auth";

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);
const [cmd, ...args] = process.argv.slice(2);

try {
  await runMigrations(db);
  if (cmd === "migrate") {
    console.log("Migrationen ausgeführt.");
  } else if (cmd === "seed" || cmd === "init") {
    const existing = await db.select().from(organizations).limit(1);
    if (existing.length) throw new Error("Die Datenbank enthält bereits eine Organisation. Abbruch, damit nichts überschrieben wird.");
    if (cmd === "seed") {
      const password = args[0] ?? randomBytes(9).toString("base64url");
      const { usernames } = await seedSample(db, password);
      console.log(`Beispieldaten geladen. Benutzer: ${usernames.join(", ")}\nPasswort für alle: ${password}`);
    } else {
      const [orgName, name, email, username] = args;
      if (!orgName || !name || !email || !username) throw new Error('Aufruf: init "<Firma>" "<Name>" <email> <username>');
      const { userId } = await createOrganization(db, { orgName, name, email: email.toLowerCase(), username });
      const ctx = { config, db, mailer: createMailer(config) };
      const link = passwordLink(ctx, await createPasswordToken(ctx, userId, "invite"));
      await ctx.mailer.send(actionMail(DEFAULT_BRANDING, { to: email, subject: "Dein Admin-Zugang", greeting: `Hallo ${name}`, lines: [`Die Installation für ${orgName} ist bereit.`], action: "Passwort festlegen", url: link, footer: "Der Link ist sieben Tage gültig." }));
      console.log(`Organisation angelegt. Einladungslink für ${username}: ${link}`);
    }
  } else {
    console.log("Befehle: migrate | seed [passwort] | init <Firma> <Name> <email> <username>");
    process.exitCode = 1;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
