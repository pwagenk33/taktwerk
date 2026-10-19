/**
 * Load test: 200 customers, 50 people, 5 years of bookings in a separate database, then timings of the
 * heavy endpoints. Run from server/:  LOAD_DATABASE_URL=mysql://… npx tsx scripts/loadtest.ts [--keep]
 * The database is wiped first; never point it at real data.
 */
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/crypto";
import { loadConfig } from "../src/config";
import { createDb, runMigrations } from "../src/db/client";
import { absences, customerRates, customers, expenses, monthClosings, organizations, projects, subProjects, teams, timeEntries, users, DEFAULT_BRANDING } from "../src/db/schema";
import { createMailer } from "../src/mail/mailer";
import { createWebhookSender } from "../src/notify/webhooks";

const URL = process.env.LOAD_DATABASE_URL ?? "mysql://taktwerk:taktwerk@localhost:3306/taktwerk_load";
if (!/load/.test(URL)) throw new Error("LOAD_DATABASE_URL muss eine Lasttest-Datenbank sein (Name enthält «load»).");
const N = { customers: 200, people: 50, years: 5, projectsPerCustomer: 2, subsPerProject: 3 };

// Small deterministic random generator so runs are comparable.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function chunked<T>(rows: T[], size: number, insert: (part: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size));
}

async function generate(db: ReturnType<typeof createDb>["db"]) {
  const [tables] = (await db.execute(sql`select table_name as t from information_schema.tables where table_schema = database()`)) as unknown as [{ t: string }[]];
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const { t } of tables) await db.execute(sql.raw(`DROP TABLE \`${t}\``));
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await runMigrations(db);

  const org = randomUUID();
  await db.insert(organizations).values({ id: org, name: "Lasttest AG", slug: "lasttest", settings: { branding: DEFAULT_BRANDING, ssoAutoProvisionDomains: [] } });
  const teamIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await db.insert(teams).values(teamIds.map((id, i) => ({ id, organizationId: org, name: `Team ${i + 1}` })));
  const hash = await hashPassword("lasttest-passwort");
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear() - N.years, today.getUTCMonth(), 1));
  const people = Array.from({ length: N.people }, (_, i) => ({
    id: randomUUID(),
    organizationId: org,
    teamId: teamIds[i % teamIds.length]!,
    username: `person${i}`,
    email: `person${i}@lasttest.example`,
    name: `Person ${String(i).padStart(2, "0")}`,
    role: (i === 0 ? "admin" : i < 5 ? "consultant" : "employee") as "admin" | "consultant" | "employee",
    passwordHash: hash,
    workload: pick([60, 80, 100, 100, 100]),
    vacationDays: 25,
    trackingStart: iso(start),
  }));
  await db.insert(users).values(people);

  const cust = Array.from({ length: N.customers }, (_, i) => ({ id: randomUUID(), organizationId: org, name: `Kunde ${String(i).padStart(3, "0")} AG` }));
  await chunked(cust, 500, (p) => db.insert(customers).values(p));
  await chunked(cust.map((c) => ({ customerId: c.id, validFrom: iso(start), hourlyRate: 140 + Math.round(rnd() * 80) })), 500, (p) => db.insert(customerRates).values(p));
  const proj = cust.flatMap((c) => Array.from({ length: N.projectsPerCustomer }, (_, j) => ({ id: randomUUID(), organizationId: org, customerId: c.id, name: `Projekt ${j + 1}`, budget: 50_000 + Math.round(rnd() * 400_000) })));
  await chunked(proj, 500, (p) => db.insert(projects).values(p));
  const subs = proj.flatMap((p) => Array.from({ length: N.subsPerProject }, (_, k) => ({ id: randomUUID(), organizationId: org, projectId: p.id, name: `Teil ${k + 1}`, budget: Math.round(p.budget / N.subsPerProject) })));
  await chunked(subs, 1000, (p) => db.insert(subProjects).values(p));

  // Each person works on a handful of sub-projects at a time, switching every quarter.
  const entries: (typeof timeEntries.$inferInsert)[] = [];
  const spent: (typeof expenses.$inferInsert)[] = [];
  const away: (typeof absences.$inferInsert)[] = [];
  const closings: (typeof monthClosings.$inferInsert)[] = [];
  for (const p of people) {
    let focus: string[] = [];
    for (let d = new Date(start); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      if (d.getUTCDate() <= 3 && d.getUTCMonth() % 3 === 0) focus = [];
      if (focus.length === 0) focus = Array.from({ length: 4 }, () => pick(subs).id);
      const date = iso(d);
      if (rnd() < 0.09) continue; // holidays, sick days
      let left = (8.4 * p.workload) / 100;
      while (left > 0.2) {
        const h = Math.min(left, [0.5, 1, 1.5, 2, 3, 4][Math.floor(rnd() * 6)]!);
        entries.push({ id: randomUUID(), organizationId: org, userId: p.id, subProjectId: pick(focus), date, hours: h, reason: pick(["Umsetzung", "Abstimmung mit Kunde", "Review", "Tests", "Konzept", "Support"]), billable: rnd() > 0.1, hourlyRate: 170 });
        left -= h;
      }
      if (rnd() < 0.04) spent.push({ id: randomUUID(), organizationId: org, userId: p.id, subProjectId: pick(focus), date, amount: Math.round(rnd() * 20000) / 100, category: pick(["Reise", "Verpflegung", "Material"]), reason: "Spesen", billable: true, status: "approved", vatRate: 8.1 });
      if (d.getUTCDate() === 1 && d < new Date(today.getTime() - 40 * 86400000)) {
        const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
        closings.push({ organizationId: org, userId: p.id, month: iso(m).slice(0, 7), status: "approved", submittedAt: d, approvedAt: d });
      }
    }
    for (let y = 0; y <= N.years; y++) {
      for (let k = 0; k < 4; k++) {
        const s = new Date(Date.UTC(start.getUTCFullYear() + y, 1 + k * 3, 3 + Math.floor(rnd() * 15)));
        if (s > today) continue;
        const e = new Date(s.getTime() + 4 * 86400000);
        away.push({ id: randomUUID(), organizationId: org, userId: p.id, type: "Ferien", startDate: iso(s), endDate: iso(e), halfDay: false, status: "approved" });
      }
    }
  }
  await chunked(entries, 2000, (p) => db.insert(timeEntries).values(p));
  await chunked(spent, 2000, (p) => db.insert(expenses).values(p));
  await chunked(away, 2000, (p) => db.insert(absences).values(p));
  await chunked(closings, 2000, (p) => db.insert(monthClosings).values(p));
  return { entries: entries.length, expenses: spent.length, absences: away.length, customers: cust.length, projects: proj.length, subProjects: subs.length, people: people.length };
}

async function main() {
  const config = loadConfig({ NODE_ENV: "test", APP_URL: "http://localhost", DATABASE_URL: URL });
  const { db, pool } = createDb(URL);
  const keep = process.argv.includes("--keep");
  if (keep) await runMigrations(db);
  else {
    const t0 = Date.now();
    const counts = await generate(db);
    console.log(`Daten erzeugt in ${((Date.now() - t0) / 1000).toFixed(1)} s:`, counts);
  }
  const app = await buildApp({ config, db, mailer: createMailer(config, () => {}), webhooks: createWebhookSender(false, () => {}) });
  const login = async (u: string) => {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: u, password: "lasttest-passwort" } });
    return `tw_session=${r.cookies.find((c) => c.name === "tw_session")!.value}`;
  };
  const admin = await login("person0");
  const employee = await login("person20");
  const month = new Date().toISOString().slice(0, 7);
  const checks: [string, string, string][] = [
    ["Admin", "/api/dataset", admin],
    ["Admin", "/api/dataset?all=1", admin],
    ["Mitarbeitende", "/api/dataset", employee],
    ["Admin", "/api/reports", admin],
    ["Admin", `/api/months/${month}`, admin],
    ["Admin", "/api/closings", admin],
    ["Admin", "/api/export/time-entries?format=csv&from=" + month + "-01", admin],
  ];
  console.log("\nEndpunkt                                    Rolle           Zeit ms (Median)   Grösse    gzip");
  for (const [who, url, cookie] of checks) {
    const times: number[] = [];
    let size = 0;
    let status = 0;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const r = await app.inject({ method: "GET", url, headers: { cookie, "accept-encoding": "identity" } });
      times.push(performance.now() - t0);
      size = r.rawPayload.length;
      status = r.statusCode;
    }
    times.sort((a, b) => a - b);
    const gz = await app.inject({ method: "GET", url, headers: { cookie, "accept-encoding": "gzip" } });
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;
    console.log(`${url.slice(0, 43).padEnd(44)}${who.padEnd(16)}${String(Math.round(times[1]!)).padStart(8)}${" ".repeat(11)}${mb(size).padEnd(10)}${mb(gz.rawPayload.length)}${status !== 200 ? ` (HTTP ${status})` : ""}`);
  }
  await app.close();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
