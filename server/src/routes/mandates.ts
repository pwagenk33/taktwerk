import { addMonths, projectReports, tr } from "@taktwerk/domain";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { HttpError, requireUser, type SessionUser } from "../app";
import { invoices, monthClosings, organizations, timeEntries, users } from "../db/schema";
import { accountsWithSameEmail } from "./auth";
import { loadDataset, todayZurich } from "./data";

/**
 * Overview across every company the signed-in person has an account in (fiduciaries, group controllers):
 * people, hours and month-end closing of last month, open invoices and budgets at risk.
 */
export async function mandateRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.get("/api/mandates", async (req) => {
    const me = requireUser(req);
    if (me.apiKey || me.role === "customer") throw new HttpError(403, tr("Dafür fehlt dir die Berechtigung."));
    const [self] = await ctx.db.select().from(users).where(eq(users.id, me.id)).limit(1);
    const others = await accountsWithSameEmail(ctx, me);
    const accounts = [{ id: me.id, organizationId: me.organizationId, role: me.role }, ...others.map((o) => ({ id: o.id, organizationId: o.organizationId, role: o.role }))];
    const month = addMonths(todayZurich().slice(0, 7), -1);
    const orgRows = await ctx.db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inArray(organizations.id, accounts.map((a) => a.organizationId)));
    const nameOf = new Map(orgRows.map((o) => [o.id, o.name]));

    const rows = [];
    for (const a of accounts) {
      const orgId = a.organizationId;
      const people = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.organizationId, orgId), eq(users.active, true), inArray(users.role, ["admin", "consultant", "employee"])));
      const [hours] = await ctx.db.select({ h: sql<string>`coalesce(sum(${timeEntries.hours}), 0)` }).from(timeEntries).where(and(eq(timeEntries.organizationId, orgId), like(timeEntries.date, `${month}-%`)));
      const approved = await ctx.db.select({ userId: monthClosings.userId }).from(monthClosings).where(and(eq(monthClosings.organizationId, orgId), eq(monthClosings.month, month), eq(monthClosings.status, "approved")));
      const open = await ctx.db.select({ gross: invoices.gross, dueDate: invoices.dueDate }).from(invoices).where(and(eq(invoices.organizationId, orgId), eq(invoices.status, "sent")));
      // Budgets only where the account may see them (leads and fiduciaries).
      let atRisk: number | null = null;
      if (a.role === "admin" || a.role === "consultant" || a.role === "auditor") {
        const [u] = await ctx.db.select().from(users).where(eq(users.id, a.id)).limit(1);
        const sessionUser: SessionUser = { id: a.id, organizationId: orgId, name: u?.name ?? "", username: u?.username ?? "", email: u?.email ?? "", role: a.role };
        const data = await loadDataset(ctx, sessionUser);
        atRisk = projectReports(data, { method: "rolling", window: 3 }).filter((r) => !r.project.closedOn && r.status !== "ok").length;
      }
      const today = todayZurich();
      rows.push({
        organizationId: orgId,
        name: nameOf.get(orgId) ?? "",
        role: a.role,
        current: a.id === me.id,
        people: people.length,
        month,
        hours: Math.round(Number(hours?.h ?? 0) * 10) / 10,
        approved: approved.filter((x) => people.some((p) => p.id === x.userId)).length,
        openInvoices: open.length,
        openAmount: Math.round(open.reduce((s, i) => s + i.gross, 0) * 100) / 100,
        overdue: open.filter((i) => i.dueDate < today).length,
        atRisk,
      });
    }
    return { email: self?.email ?? "", mandates: rows.sort((x, y) => x.name.localeCompare(y.name, "de")) };
  });
}
