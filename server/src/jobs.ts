import { WorkCalendar, addMonths, fmt1, billableSeats, canWrite, fmtCHF, fmtDate, fmtMonthLong, planById, priceOf, projectReports, trialDaysLeft } from "@taktwerk/domain";
import { deliverDue, emit, purgeDeliveries } from "./events";
import { createInvoice } from "./reports/invoice";
import { and, eq, gte, inArray, isNull, ne, notInArray, or } from "drizzle-orm";
import { HttpError, type AppContext } from "./app";
import { purgeExpired } from "./routes/privacy";
import { budgetAlerts, customers, invoices, jobRuns, projects, monthClosings, organizations, users, type OrgSettings, type ReminderSettings } from "./db/schema";
import type { ChatMessage } from "./notify/webhooks";
import { actionMail } from "./mail/mailer";
import { sendCustomerReport } from "./reports/export";
import { refreshFxRates } from "./fx";
import { digestMail } from "./reports/digest";
import { loadDataset } from "./routes/data";
import { intervalLabel, mailAdmins, notifyOperator, periodEnd } from "./routes/subscription";
import { syncAllJira } from "./jira";
import { saasOn, seatsUsed, subscriptionOf } from "./saas";
import { tr } from "@taktwerk/domain";
import { trn, withLocale } from "./i18n";
import { recordHeartbeat } from "./routes/status";

const THRESHOLDS = ["80", "95", "100"] as const;
type Threshold = (typeof THRESHOLDS)[number];

/** Local date and hour in Zurich. */
function zurich(now: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return { month: `${p.year}-${p.month}`, day: Number(p.day), hour: Number(p.hour) };
}

/** Marks a job as done for a period. Returns false if it already ran (another instance won the race). */
async function claim(ctx: AppContext, job: string, period: string) {
  const res = await ctx.db.insert(jobRuns).ignore().values({ job, period, ranAt: new Date() });
  return res[0].affectedRows === 1;
}

/**
 * From `reportDay` (default 3rd) 07:00 Zurich time, send last month's report to every customer with recipients.
 * Each customer is sent once per month; a failed send is retried on the next run.
 */
export async function sendMonthlyReports(ctx: AppContext, now = new Date()) {
  const z = zurich(now);
  const sent: { customerId: string; month: string; to: string[] }[] = [];
  for (const org of await ctx.db.select().from(organizations)) {
    const reportDay = org.settings.reportDay ?? 3;
    if (z.day < reportDay || (z.day === reportDay && z.hour < 7)) continue;
    const month = addMonths(z.month, -1);
    for (const c of await ctx.db.select().from(customers).where(eq(customers.organizationId, org.id))) {
      if (c.reportRecipients.length === 0) continue;
      const job = `monthly-report:${c.id}`;
      if (!(await claim(ctx, job, month))) continue;
      try {
        const to = await sendCustomerReport(ctx, org.id, c.id, month);
        sent.push({ customerId: c.id, month, to });
      } catch (err) {
        await ctx.db.delete(jobRuns).where(and(eq(jobRuns.job, job), eq(jobRuns.period, month)));
        throw err;
      }
    }
  }
  return sent;
}

/**
 * Subscription-style billing for retainers: on the 1st from 06:00 Zurich time, a draft invoice for last month for
 * every customer with a retainer project, if the organization switched it on and no invoice for that month exists.
 * The draft also contains that customer's other billable hours and expenses; someone checks and sends it.
 */
export async function draftRetainerInvoices(ctx: AppContext, now = new Date()) {
  const z = zurich(now);
  if (z.day === 1 && z.hour < 6) return [];
  const month = addMonths(z.month, -1);
  const today = `${z.month}-${String(z.day).padStart(2, "0")}`;
  const created: { customerId: string; number: string }[] = [];
  for (const org of await ctx.db.select().from(organizations)) {
    if (!org.settings.autoRetainerInvoices || !org.active) continue;
    const retainerCustomers = await ctx.db.selectDistinct({ id: projects.customerId }).from(projects).where(and(eq(projects.organizationId, org.id), eq(projects.kind, "retainer"), or(isNull(projects.closedOn), gte(projects.closedOn, `${month}-01`))));
    for (const { id: customerId } of retainerCustomers) {
      const [existing] = await ctx.db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.customerId, customerId), eq(invoices.month, month), ne(invoices.status, "cancelled"))).limit(1);
      if (existing || !(await claim(ctx, `retainer-invoice:${customerId}`, month))) continue;
      try {
        const inv = await createInvoice(ctx, org.id, customerId, month, today);
        await emit(ctx, org.id, "invoice.created", { id: inv.id, number: inv.number, customerId, month, net: inv.net, gross: inv.gross, auto: true });
        created.push({ customerId, number: inv.number });
      } catch (err) {
        // Missing address or IBAN: nothing to retry until someone fixes it; the draft can still be made by hand.
        if (!(err instanceof HttpError)) {
          await ctx.db.delete(jobRuns).where(and(eq(jobRuns.job, `retainer-invoice:${customerId}`), eq(jobRuns.period, month)));
          throw err;
        }
      }
    }
  }
  return created;
}

/**
 * E-mails admins and consultants when a project's or sub-project's forecast reaches 80, 95 or 100 % of its budget.
 * Each threshold is reported once per project/sub-project.
 */
export async function checkBudgetAlerts(ctx: AppContext) {
  const alerts: { targetId: string; name: string; threshold: Threshold; forecast: number; budget: number }[] = [];
  for (const org of await ctx.db.select().from(organizations)) {
    const data = await loadDataset(ctx, { id: "", organizationId: org.id, name: "", username: "", email: "", role: "admin" });
    const reports = projectReports(data, { method: "rolling", window: 3 });
    const targets = reports.filter((p) => !p.project.closedOn).flatMap((p) => [
      { id: p.project.id, name: `${p.customer.name} · ${p.project.name}`, budget: p.budget, forecast: p.forecastCost },
      ...p.subs.map((s) => ({ id: s.subProject.id, name: `${p.customer.name} · ${p.project.name} · ${s.subProject.name}`, budget: s.budget, forecast: s.forecastCost })),
    ]);
    const known = await ctx.db.select().from(budgetAlerts).where(eq(budgetAlerts.organizationId, org.id));
    const fresh: typeof alerts = [];
    for (const t of targets) {
      if (t.budget <= 0) continue;
      const reached = THRESHOLDS.filter((th) => t.forecast >= (t.budget * Number(th)) / 100);
      const missing = reached.filter((th) => !known.some((k) => k.targetId === t.id && k.threshold === th));
      if (missing.length === 0) continue;
      await ctx.db.insert(budgetAlerts).ignore().values(missing.map((threshold) => ({ organizationId: org.id, targetId: t.id, threshold, sentAt: new Date() })));
      // One line per target, with the highest newly reached threshold.
      fresh.push({ targetId: t.id, name: t.name, threshold: missing.at(-1)!, forecast: t.forecast, budget: t.budget });
    }
    if (fresh.length === 0) continue;
    alerts.push(...fresh);

    const leads = await ctx.db
      .select()
      .from(users)
      .where(and(eq(users.organizationId, org.id), eq(users.active, true), inArray(users.role, ["admin", "consultant"])));
    for (const lead of leads) {
      await ctx.mailer.send(
        withLocale(lead.locale, () => actionMail(org.settings.branding, {
          to: lead.email,
          subject: trn(fresh.length, "{1}: Budget-Alarm ({0} Eintrag)", "{1}: Budget-Alarm ({0} Einträge)", org.settings.branding.appName),
          greeting: tr("Hallo {0}", lead.name.split(" ")[0]),
          lines: [
            tr("Der Forecast hat bei folgenden Projekten eine Budgetschwelle erreicht:"),
            ...fresh.map((a) => tr("{0}: Forecast {1} von {2} Budget ({3} %, Schwelle {4} %).", a.name, fmtCHF(a.forecast), fmtCHF(a.budget), Math.round((a.forecast / a.budget) * 100), a.threshold)),
          ],
          action: tr("Reports öffnen"),
          url: new URL("/", ctx.config.APP_URL).toString(),
          footer: tr("Du erhältst diese E-Mail einmal pro Schwelle (80, 95 und 100 %) und Projekt."),
        })),
      );
    }
  }
  return alerts;
}

/** ISO week key (e.g. 2026-W42) and the Monday/Sunday of the week before `date`. */
function previousWeek(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const thu = new Date(monday);
  thu.setUTCDate(monday.getUTCDate() + 3);
  const yearStart = new Date(Date.UTC(thu.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thu.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { key: `${thu.getUTCFullYear()}-W${String(week).padStart(2, "0")}`, from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
}

/**
 * Monday from 09:00 Zurich: people whose previous week is more than two hours short of target get one reminder.
 * Only for organizations with the reminder on (default) and only once per person and week.
 */
export async function sendHoursReminders(ctx: AppContext, now = new Date()) {
  const z = zurich(now);
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(now);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  // Monday after 09:00, or any later weekday (catches a server that was down on Monday).
  if (weekday === 0 || weekday === 6 || (weekday === 1 && z.hour < 9)) return [];
  const week = previousWeek(today);
  const sent: { userId: string; missing: number }[] = [];
  for (const org of await ctx.db.select().from(organizations)) {
    if (org.settings.hoursReminder === false) continue;
    const data = await loadDataset(ctx, { id: "", organizationId: org.id, name: "", username: "", email: "", role: "admin" });
    const people = await ctx.db.select().from(users).where(and(eq(users.organizationId, org.id), eq(users.active, true), notInArray(users.role, ["customer", "auditor"])));
    for (const u of people) {
      const emp = data.employees.find((e) => e.id === u.id);
      if (!emp || (emp.trackingStart ?? "") > week.to) continue;
      const cal = new WorkCalendar(data, emp);
      let due = 0;
      let worked = 0;
      for (let d = week.from; d <= week.to; d = addDaysIso(d, 1)) {
        due += cal.target(d) - cal.credit(d);
        worked += cal.workedOn(d);
      }
      const missing = due - worked;
      if (missing <= 2) continue;
      if (!(await claim(ctx, `hours-reminder:${u.id}`, week.key))) continue;
      await ctx.mailer.send(
        withLocale(u.locale, () => actionMail(org.settings.branding, {
          to: u.email,
          subject: tr("{0}: {1} Stunden fehlen für letzte Woche", org.settings.branding.appName, missing.toFixed(1).replace(".", ",")),
          greeting: tr("Hallo {0}", u.name.split(" ")[0]),
          lines: [
            tr("Für die Woche vom {0} bis {1} sind {2} von {3} Stunden erfasst.", fmtDate(week.from), fmtDate(week.to), worked.toFixed(1).replace(".", ","), due.toFixed(1).replace(".", ",")),
            tr("Bitte trage die fehlenden Stunden nach, damit Kundenreports und dein Überzeit-Saldo stimmen. Am schnellsten geht es im Wochenraster."),
          ],
          action: tr("Wochenraster öffnen"),
          url: new URL("/#zeit", ctx.config.APP_URL).toString(),
          footer: tr("Du erhältst diese Erinnerung jeweils montags, wenn mehr als zwei Stunden fehlen. Admins können sie unter Einstellungen → Arbeitszeit ausschalten."),
        })),
      );
      sent.push({ userId: u.id, missing });
    }
  }
  return sent;
}

/** The mail asking one person to submit a month; also sent on demand by leads from the closing page. */
export function closingReminderMail(settings: OrgSettings, user: { name: string; email: string; locale?: string | null }, month: string, appUrl: string) {
  return withLocale(user.locale, () => actionMail(settings.branding, {
    to: user.email,
    subject: tr("{0}: Bitte {1} einreichen", settings.branding.appName, fmtMonthLong(month)),
    greeting: tr("Hallo {0}", user.name.split(" ")[0]),
    lines: [
      tr("Dein Monat {0} ist noch nicht eingereicht. Bitte prüfe deine Buchungen und reiche den Monat ein, damit er freigegeben und abgerechnet werden kann.", fmtMonthLong(month)),
      tr("Fehlt noch etwas, trage es vorher nach. Nach dem Einreichen sind die Buchungen gesperrt."),
    ],
    action: tr("Monat einreichen"),
    url: new URL("/#abschluss", appUrl).toString(),
    footer: tr("Admins können diese Erinnerung unter Einstellungen → Arbeitszeit ausschalten."),
  }));
}

/**
 * Month closing reminders. From the 1st 09:00 Zurich: everyone whose previous month is still open gets one mail.
 * From the 5th 09:00: admins and consultants get one digest listing who has not submitted and what waits for approval.
 */
export async function sendClosingReminders(ctx: AppContext, now = new Date()) {
  const z = zurich(now);
  if (z.day === 1 && z.hour < 9) return [];
  const month = addMonths(z.month, -1);
  const sent: { kind: "person" | "digest"; to: string; month: string }[] = [];
  for (const org of await ctx.db.select().from(organizations)) {
    if (org.settings.closingReminder === false) continue;
    const people = await ctx.db.select().from(users).where(and(eq(users.organizationId, org.id), eq(users.active, true), notInArray(users.role, ["customer", "auditor"])));
    const rows = await ctx.db.select().from(monthClosings).where(and(eq(monthClosings.organizationId, org.id), eq(monthClosings.month, month)));
    const data = await loadDataset(ctx, { id: "", organizationId: org.id, name: "", username: "", email: "", role: "admin" });
    const status = (id: string) => rows.find((r) => r.userId === id)?.status ?? "open";
    const relevant = people.filter((u) => {
      const emp = data.employees.find((e) => e.id === u.id);
      return emp && (emp.trackingStart ?? "") <= `${month}-31`;
    });
    for (const u of relevant) {
      if (status(u.id) !== "open") continue;
      if (!(await claim(ctx, `closing-reminder:${u.id}`, month))) continue;
      await ctx.mailer.send(closingReminderMail(org.settings, u, month, ctx.config.APP_URL));
      sent.push({ kind: "person", to: u.email, month });
    }
    if (z.day < 5 || (z.day === 5 && z.hour < 9)) continue;
    const open = relevant.filter((u) => status(u.id) === "open");
    const submitted = relevant.filter((u) => status(u.id) === "submitted");
    if (open.length + submitted.length === 0) continue;
    if (!(await claim(ctx, `closing-digest:${org.id}`, month))) continue;
    for (const lead of people.filter((u) => u.role === "admin" || u.role === "consultant")) {
      await ctx.mailer.send(
        withLocale(lead.locale, () => actionMail(org.settings.branding, {
          to: lead.email,
          subject: tr("{0}: Monatsabschluss {1}, {2} offen, {3} zur Freigabe", org.settings.branding.appName, fmtMonthLong(month), open.length, submitted.length),
          greeting: tr("Hallo {0}", lead.name.split(" ")[0]),
          lines: [
            open.length ? tr("Noch nicht eingereicht: {0}.", open.map((u) => u.name).join(", ")) : tr("Alle haben eingereicht."),
            submitted.length ? tr("Warten auf deine Freigabe: {0}.", submitted.map((u) => u.name).join(", ")) : tr("Nichts wartet auf Freigabe."),
          ],
          action: tr("Monatsabschluss öffnen"),
          url: new URL("/#abschluss", ctx.config.APP_URL).toString(),
          footer: tr("Diese Übersicht kommt einmal pro Monat ab dem 5. Admins können sie unter Einstellungen → Arbeitszeit ausschalten."),
        })),
      );
      sent.push({ kind: "digest", to: lead.email, month });
    }
  }
  return sent;
}

const addDaysIso = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

type ReminderUser = { id: string; name: string; email: string; reminder: ReminderSettings | null; locale?: string | null };

/** Zurich date (YYYY-MM-DD), ISO weekday (1 = Monday) and HH:MM of an instant. */
function zurichClock(now: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, weekday: new Date(`${date}T00:00:00Z`).getUTCDay() || 7, time: `${p.hour}:${p.minute}` };
}

/** The text of the personal reminder; `test` marks a message sent on request from the profile page. */
export function reminderMessage(settings: OrgSettings, user: { name: string; locale?: string | null }, worked: number, appUrl: string, test = false): ChatMessage {
  return withLocale(user.locale, () => reminderText(settings, user, worked, appUrl, test));
}
function reminderText(settings: OrgSettings, user: { name: string }, worked: number, appUrl: string, test: boolean): ChatMessage {
  const first = user.name.split(" ")[0];
  const url = new URL("/#zeit", appUrl).toString();
  if (test) return { title: tr("{0}: Testnachricht", settings.branding.appName), text: tr("Hallo {0}, so sieht deine Erinnerung aus. Sie kommt nur an Tagen, an denen bis zur gewählten Uhrzeit nichts gebucht ist.", first), action: { label: tr("Zeit erfassen"), url } };
  return {
    title: tr("{0}: Heute noch nichts gebucht", settings.branding.appName),
    text: worked > 0 ? tr("Hallo {0}, heute sind erst {1} Stunden erfasst. Kurz nachtragen, solange es frisch ist?", first, fmt1(worked)) : tr("Hallo {0}, für heute ist noch keine Zeit erfasst. Kurz nachtragen, solange es frisch ist?", first),
    action: { label: tr("Zeit erfassen"), url },
  };
}

/** Delivers one reminder over the channel the person chose. */
export async function sendReminderTo(ctx: AppContext, settings: OrgSettings, user: ReminderUser, msg: ChatMessage) {
  const r = user.reminder;
  if (!r || r.channel === "off") return;
  if (r.channel === "mail") {
    await ctx.mailer.send(
      withLocale(user.locale, () => actionMail(settings.branding, {
        to: user.email,
        subject: msg.title,
        greeting: msg.text.split(", ")[0] ?? tr("Hallo"),
        lines: [msg.text.slice(msg.text.indexOf(", ") + 2)],
        action: msg.action?.label,
        url: msg.action?.url,
        footer: tr("Uhrzeit, Tage und Kanal dieser Erinnerung änderst du in deinem Profil."),
      })),
    );
    return;
  }
  if (!r.webhookUrl) return;
  await ctx.webhooks.post(r.channel, r.webhookUrl, msg);
}

/**
 * Personal reminder: at the person's chosen time on their chosen weekdays, when it is a work day for them
 * (target hours, not absent) and nothing is booked yet. Once per person and day; late server starts still catch up the same day.
 */
export async function sendDailyReminders(ctx: AppContext, now = new Date()) {
  const z = zurichClock(now);
  const sent: { userId: string; channel: string }[] = [];
  for (const org of await ctx.db.select().from(organizations)) {
    const people = await ctx.db.select().from(users).where(and(eq(users.organizationId, org.id), eq(users.active, true), notInArray(users.role, ["customer", "auditor"])));
    const due = people.filter((u) => u.reminder && u.reminder.channel !== "off" && u.reminder.days.includes(z.weekday) && u.reminder.time <= z.time);
    if (due.length === 0) continue;
    const data = await loadDataset(ctx, { id: "", organizationId: org.id, name: "", username: "", email: "", role: "admin" });
    for (const u of due) {
      const emp = data.employees.find((e) => e.id === u.id);
      if (!emp) continue;
      const cal = new WorkCalendar(data, emp);
      if (cal.target(z.date) - cal.credit(z.date) <= 0) continue;
      const worked = cal.workedOn(z.date);
      if (worked > 0) continue;
      if (!(await claim(ctx, `daily-reminder:${u.id}`, z.date))) continue;
      try {
        await sendReminderTo(ctx, org.settings, u, reminderMessage(org.settings, u, worked, ctx.config.APP_URL));
        sent.push({ userId: u.id, channel: u.reminder!.channel });
      } catch (err) {
        await ctx.db.delete(jobRuns).where(and(eq(jobRuns.job, `daily-reminder:${u.id}`), eq(jobRuns.period, z.date)));
        throw err;
      }
    }
  }
  return sent;
}

/** Sends every enabled scheduled report whose day and hour have come, once per period (ISO week or month). */
export async function sendScheduledReports(ctx: AppContext, now = new Date()) {
  const z = zurichClock(now);
  const sent: { id: string; period: string; to: string[] }[] = [];
  for (const org of await ctx.db.select().from(organizations)) {
    for (const r of org.settings.scheduledReports ?? []) {
      if (!r.enabled || r.recipients.length === 0) continue;
      const dueDay = r.kind === "weekly" ? z.weekday === (r.dayOfWeek ?? 1) : Number(z.date.slice(8, 10)) === (r.dayOfMonth ?? 1);
      if (!dueDay || Number(z.time.slice(0, 2)) < r.hour) continue;
      // Language of the first recipient who has an account here; German otherwise.
      const [reader] = await ctx.db.select({ locale: users.locale }).from(users).where(and(eq(users.organizationId, org.id), inArray(users.email, r.recipients))).limit(1);
      const { mail, period } = await withLocale(reader?.locale, () => digestMail(ctx, org.id, org.settings, r, z.date));
      const job = `scheduled-report:${r.id}`;
      if (!(await claim(ctx, job, period))) continue;
      try {
        await ctx.mailer.send({ ...mail, to: r.recipients.join(", ") });
        sent.push({ id: r.id, period, to: r.recipients });
      } catch (err) {
        await ctx.db.delete(jobRuns).where(and(eq(jobRuns.job, job), eq(jobRuns.period, period)));
        throw err;
      }
    }
  }
  return sent;
}

/**
 * SaaS: trial reminders (7 days and 1 day before the end), read-only notice after the grace week, and for companies
 * paying by invoice the renewal (operator gets an «invoice due» notice) or the end of a cancelled subscription.
 * Card subscriptions are driven by Stripe's webhook.
 */
export async function runSubscriptionJobs(ctx: AppContext, now = new Date()) {
  if (!saasOn(ctx)) return [];
  const done: string[] = [];
  for (const org of await ctx.db.select().from(organizations).where(eq(organizations.active, true))) {
    const sub = subscriptionOf(org);
    if (sub.status === "trialing" && org.trialEndsAt) {
      const left = trialDaysLeft(sub, now)!;
      const end = fmtDate(org.trialEndsAt.toISOString().slice(0, 10));
      if ((left === 7 || left === 1) && (await claim(ctx, `trial-reminder:${org.id}`, String(left)))) {
        await mailAdmins(ctx, org, () => ({ subject: left === 1 ? tr("Die Testphase endet morgen") : tr("Noch eine Woche Testphase"), lines: [
          tr("Die kostenlose Testphase von {0} endet am {1}.", org.name, end),
          tr("Wähle unter Einstellungen → Abo ein Paket, dann geht es ohne Unterbruch weiter. Alle erfassten Daten bleiben erhalten."),
        ], action: { label: tr("Paket wählen"), path: "/einstellungen" } }));
        done.push(`reminder:${org.slug}:${left}`);
      }
      if (!canWrite(sub, now) && (await claim(ctx, `trial-expired:${org.id}`, org.trialEndsAt.toISOString().slice(0, 10)))) {
        await ctx.db.update(organizations).set({ subStatus: "expired" }).where(eq(organizations.id, org.id));
        await mailAdmins(ctx, org, () => ({ subject: tr("Testphase abgelaufen"), lines: [
          tr("Die Testphase von {0} ist vorbei, die Daten sind jetzt nur noch lesbar.", org.name),
          tr("Sobald du unter Einstellungen → Abo ein Paket wählst, kannst du sofort weiterarbeiten."),
        ], action: { label: tr("Paket wählen"), path: "/einstellungen" } }));
        await notifyOperator(ctx, () => ({ subject: tr("Testphase abgelaufen: {0}", org.name), lines: [tr("{0} ({1}) hat nach der Testphase kein Paket gewählt.", org.name, org.slug)] }));
        done.push(`expired:${org.slug}`);
      }
    }
    if (org.billingMode === "invoice" && org.subStatus === "active" && org.currentPeriodEnd && org.currentPeriodEnd <= now) {
      const period = org.currentPeriodEnd.toISOString().slice(0, 10);
      if (!(await claim(ctx, `invoice-period:${org.id}`, period))) continue;
      if (org.canceledAt) {
        await ctx.db.update(organizations).set({ subStatus: "canceled" }).where(eq(organizations.id, org.id));
        await mailAdmins(ctx, org, () => ({ subject: tr("Abo beendet"), lines: [tr("Das Abo von {0} ist wie gekündigt beendet. Die Daten bleiben lesbar und exportierbar.", org.name)] }));
        done.push(`canceled:${org.slug}`);
      } else {
        const next = periodEnd(org.currentPeriodEnd, org.billingInterval);
        await ctx.db.update(organizations).set({ currentPeriodEnd: next }).where(eq(organizations.id, org.id));
        const plan = planById(org.plan);
        const seats = billableSeats(await seatsUsed(ctx, org.id));
        await notifyOperator(ctx, () => ({ subject: tr("Rechnung stellen: {0}, {1}", org.name, plan.name), lines: [
          tr("Neue Periode für {0}: {1}, {2}, {3} Personen, CHF {4} zzgl. MWST.", org.name, plan.name, intervalLabel(org.billingInterval), seats, priceOf(plan, org.billingInterval, seats)),
          tr("Periode {0} bis {1}.", fmtDate(period), fmtDate(next.toISOString().slice(0, 10))),
        ] }));
        done.push(`renewed:${org.slug}`);
      }
    }
  }
  return done;
}

export async function runJobs(ctx: AppContext, now = new Date(), log: (msg: string, err?: unknown) => void = console.error) {
  for (const [name, job] of [
    ["Monatsreport", () => sendMonthlyReports(ctx, now)],
    ["Budget-Alarm", () => checkBudgetAlerts(ctx)],
    ["Retainer-Rechnungen", () => draftRetainerInvoices(ctx, now)],
    ["Stunden-Erinnerung", () => sendHoursReminders(ctx, now)],
    ["Abschluss-Erinnerung", () => sendClosingReminders(ctx, now)],
    ["Tages-Erinnerung", () => sendDailyReminders(ctx, now)],
    ["Wechselkurse", () => refreshFxRates(ctx)],
    ["Geplante Berichte", () => sendScheduledReports(ctx, now)],
    ["Aufräumen", () => purgeExpired(ctx, now)],
    ["Abo", () => runSubscriptionJobs(ctx, now)],
    ["Jira-Abgleich", () => syncAllJira(ctx, now, log)],
    ["Webhooks aufräumen", () => purgeDeliveries(ctx, now)],
  ] as const) {
    try {
      await job();
    } catch (err) {
      log(`[jobs] ${name} fehlgeschlagen`, err);
    }
  }
}

/** Runs the scheduled jobs every 15 minutes (first run one minute after start). */
export function startScheduler(ctx: AppContext, log?: (msg: string, err?: unknown) => void) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runJobs(ctx, new Date(), log);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 60_000);
  const every = setInterval(tick, 15 * 60_000);
  // Webhook retries need a shorter beat than the other jobs.
  const hooks = setInterval(() => {
    void deliverDue(ctx).catch((err) => log?.("[jobs] Webhooks fehlgeschlagen", err));
    void recordHeartbeat(ctx).catch((err) => log?.("[jobs] Status-Herzschlag fehlgeschlagen", err));
  }, 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(every);
    clearInterval(hooks);
  };
}
