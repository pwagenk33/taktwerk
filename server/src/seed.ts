import { todayZurich } from "./routes/data";
import { buildDataset } from "@taktwerk/domain";
import { randomUUID } from "node:crypto";
import { hashPassword } from "./auth/crypto";
import type { Db } from "./db/client";
import {
  DEFAULT_BRANDING,
  absences,
  customerRates,
  customers,
  expenses,
  jiraIssues,
  organizations,
  projects,
  subProjects,
  teams,
  timeEntries,
  users,
} from "./db/schema";

const slug = (name: string) =>
  name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "");

/** Creates the organization and its first admin. Returns the ids. */
export async function createOrganization(db: Db, o: { orgName: string; name: string; email: string; username: string; passwordHash?: string }) {
  const orgId = randomUUID();
  const userId = randomUUID();
  await db.insert(organizations).values({ id: orgId, name: o.orgName, settings: { branding: DEFAULT_BRANDING, ssoAutoProvisionDomains: [] } });
  await db.insert(users).values({ id: userId, organizationId: orgId, name: o.name, email: o.email, username: o.username, role: "admin", passwordHash: o.passwordHash ?? null, trackingStart: todayZurich() });
  return { orgId, userId };
}

/** Loads the example dataset (4 customers, 11 months) into an empty database. Every sample user gets `password`. */
export async function seedSample(db: Db, password: string) {
  const data = buildDataset();
  const hash = await hashPassword(password);
  const map = new Map<string, string>();
  const idFor = (k: string) => map.get(k) ?? (map.set(k, randomUUID()), map.get(k)!);

  const orgId = randomUUID();
  await db.insert(organizations).values({
    id: orgId,
    name: "Beispiel AG",
    settings: {
      branding: DEFAULT_BRANDING,
      ssoAutoProvisionDomains: [],
      weeklyHours: data.workModel!.weeklyHours,
      holidays: data.workModel!.holidays,
      kmRate: data.rates!.kmRate,
      vatRate: data.rates!.vatRate,
      billing: {
        address: { name: "Beispiel AG", street: "Industriestrasse 7", zip: "6300", city: "Zug", country: "CH" },
        iban: "CH9300762011623852957",
        vatNumber: "CHE-123.456.789 MWST",
        paymentDays: 30,
        footer: "Vielen Dank für die gute Zusammenarbeit.",
      },
    },
  });
  await db.insert(teams).values(data.teams.map((t) => ({ id: idFor(t.id), organizationId: orgId, name: t.name })));
  await db.insert(users).values(
    data.employees.map((e) => ({
      id: idFor(e.id),
      organizationId: orgId,
      teamId: idFor(e.teamId),
      username: slug(e.name),
      email: `${slug(e.name)}@beispiel.ch`,
      name: e.name,
      role: e.role,
      passwordHash: hash,
      workload: e.workload,
      vacationDays: e.vacationDays,
      trackingStart: e.trackingStart,
      overtimeCarry: e.overtimeCarry,
      vacationCarry: e.vacationCarry,
    })),
  );
  await db.insert(absences).values(
    data.absences!.map((a) => ({
      id: randomUUID(), organizationId: orgId, userId: idFor(a.employeeId), type: a.type, startDate: a.startDate, endDate: a.endDate,
      halfDay: a.halfDay, note: a.note ?? null, status: a.status, decidedAt: a.status === "requested" ? null : new Date(`${a.startDate}T08:00:00Z`),
    })),
  );
  await db.insert(customers).values(data.customers.map((c) => ({ id: idFor(c.id), organizationId: orgId, name: c.name, billingAddress: c.address ?? null })));
  await db.insert(customerRates).values(data.customers.flatMap((c) => c.rates.map((r) => ({ customerId: idFor(c.id), ...r }))));
  await db.insert(projects).values(data.projects.map((p) => ({ id: idFor(p.id), organizationId: orgId, customerId: idFor(p.customerId), name: p.name, budget: p.budget, jiraProjectKey: p.jiraProjectKey })));
  await db.insert(subProjects).values(data.subProjects.map((s) => ({ id: idFor(s.id), organizationId: orgId, projectId: idFor(s.projectId), name: s.name, budget: s.budget, jiraEpicKey: s.jiraEpicKey })));
  await db.insert(jiraIssues).values(data.issues.map((i) => ({ organizationId: orgId, key: i.key, subProjectId: idFor(i.subProjectId), summary: i.summary, storyPoints: i.storyPoints, status: i.status, resolvedAt: i.resolvedAt ?? null })));
  for (let i = 0; i < data.timeEntries.length; i += 500) {
    await db.insert(timeEntries).values(
      data.timeEntries.slice(i, i + 500).map((e) => ({
        id: randomUUID(), organizationId: orgId, userId: idFor(e.employeeId), subProjectId: idFor(e.subProjectId),
        date: e.date, hours: e.hours, reason: e.reason, billable: e.billable, hourlyRate: e.hourlyRate, jiraIssueKey: e.jiraIssueKey ?? null, startTime: e.startTime ?? null,
      })),
    );
  }
  await db.insert(expenses).values(
    data.expenses.map((x) => ({
      id: randomUUID(), organizationId: orgId, userId: idFor(x.employeeId), subProjectId: idFor(x.subProjectId), date: x.date, amount: x.amount,
      category: x.category, reason: x.reason, billable: x.billable, vatRate: x.vatRate ?? 8.1, km: x.km ?? null, status: x.status ?? "approved",
      decidedBy: x.status === "requested" ? null : idFor("e1"), decidedAt: x.status === "requested" ? null : new Date(`${x.date}T16:00:00Z`),
    })),
  );
  return { orgId, usernames: data.employees.map((e) => `${slug(e.name)} (${e.role})`) };
}
