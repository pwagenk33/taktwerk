import { countsExpense, currencyOf, monthOf, toChf, type ProjectReport } from "./calc";
import type { Currency, Dataset, ProjectKind } from "./types";

/** Revenue, internal cost and margin of one project or customer, everything in CHF. */
export interface ProfitRow {
  id: string;
  name: string;
  customerId: string;
  customerName: string;
  kind: ProjectKind;
  currency: Currency;
  hours: number;
  /** Billable value: T&M hours × rate, fixed price, or retainer months × contingent. */
  revenue: number;
  /** Hours × cost rate of the person plus all approved expenses. */
  cost: number;
  margin: number;
  /** margin / revenue, null without revenue. */
  marginPct: number | null;
  /** Effective revenue per booked hour. */
  revenuePerHour: number | null;
  /** True when at least one person has no cost rate and the default was used. */
  estimated: boolean;
}

export interface Profitability {
  projects: ProfitRow[];
  customers: ProfitRow[];
  total: Pick<ProfitRow, "hours" | "revenue" | "cost" | "margin" | "marginPct" | "estimated">;
  /** Months with any booking, for the period label. */
  from: string | null;
  /** Hours and cost on customers without a rate (internal work); kept out of the margin. */
  internal: { hours: number; cost: number };
}

export const DEFAULT_COST_RATE = 95;

/**
 * Profitability per project and customer: what the work is worth to the customer versus what it costs internally.
 * `from` limits the bookings to a month (YYYY-MM) and later; without it the whole history counts.
 */
export function profitability(data: Dataset, reports: ProjectReport[], from?: string): Profitability {
  const defaultCost = data.rates?.costRate ?? DEFAULT_COST_RATE;
  const costOf = new Map(data.employees.map((e) => [e.id, e.costRate]));
  const subToProject = new Map(data.subProjects.map((s) => [s.id, s.projectId]));
  const entries = data.timeEntries.filter((e) => !from || monthOf(e.date) >= from);
  const expenses = data.expenses.filter((x) => (x.status ?? "approved") === "approved" && (!from || monthOf(x.date) >= from));
  let first: string | null = null;
  for (const e of entries) if (!first || e.date < first) first = e.date;

  const isInternal = (r: ProjectReport) => r.customer.rates.length === 0 || r.customer.rates.every((x) => x.hourlyRate === 0);
  const internal = { hours: 0, cost: 0 };
  for (const r of reports.filter(isInternal)) {
    const own = entries.filter((e) => subToProject.get(e.subProjectId) === r.project.id);
    internal.hours += own.reduce((s, e) => s + e.hours, 0);
    internal.cost += own.reduce((s, e) => s + e.hours * (costOf.get(e.employeeId) ?? defaultCost), 0) + expenses.filter((x) => subToProject.get(x.subProjectId) === r.project.id).reduce((s, x) => s + x.amount, 0);
  }
  const projects: ProfitRow[] = reports.filter((r) => !isInternal(r)).map((r) => {
    const own = entries.filter((e) => subToProject.get(e.subProjectId) === r.project.id);
    const ownX = expenses.filter((x) => subToProject.get(x.subProjectId) === r.project.id);
    const currency = currencyOf(r.customer);
    const hours = own.reduce((s, e) => s + e.hours, 0);
    let estimated = false;
    const cost =
      own.reduce((s, e) => {
        const rate = costOf.get(e.employeeId);
        if (rate === undefined) estimated = true;
        return s + e.hours * (rate ?? defaultCost);
      }, 0) + ownX.reduce((s, x) => s + x.amount, 0);
    const billedTime = own.filter((e) => e.billable).reduce((s, e) => s + e.hours * e.hourlyRate, 0);
    const billedX = ownX.filter(countsExpense).reduce((s, x) => s + x.amount, 0);
    let revenue: number;
    if (r.kind === "fixed") {
      // Fixed price: the price is earned once, measured against the whole project (a period filter still shows cost only).
      revenue = from ? 0 : toChf(r.project.budget, currency, data.fx) + billedX;
    } else if (r.kind === "retainer" && r.project.retainerHours) {
      const months = new Set(own.map((e) => monthOf(e.date)));
      const rate = r.customer.rates.length ? [...r.customer.rates].sort((a, b) => a.validFrom.localeCompare(b.validFrom)).at(-1)!.hourlyRate : 0;
      revenue = toChf(months.size * r.project.retainerHours * rate, currency, data.fx) + billedX;
    } else {
      revenue = toChf(billedTime, currency, data.fx) + billedX;
    }
    const margin = revenue - cost;
    return {
      id: r.project.id,
      name: r.project.name,
      customerId: r.customer.id,
      customerName: r.customer.name,
      kind: r.kind,
      currency,
      hours,
      revenue,
      cost,
      margin,
      marginPct: revenue > 0 ? margin / revenue : null,
      revenuePerHour: hours > 0 ? revenue / hours : null,
      estimated,
    };
  });

  const byCustomer = new Map<string, ProfitRow>();
  for (const p of projects) {
    const c = byCustomer.get(p.customerId) ?? { ...p, id: p.customerId, name: p.customerName, kind: "tm" as ProjectKind, hours: 0, revenue: 0, cost: 0, margin: 0, marginPct: null, revenuePerHour: null, estimated: false };
    c.hours += p.hours;
    c.revenue += p.revenue;
    c.cost += p.cost;
    c.margin += p.margin;
    c.estimated ||= p.estimated;
    byCustomer.set(p.customerId, c);
  }
  const customers = [...byCustomer.values()].map((c) => ({ ...c, marginPct: c.revenue > 0 ? c.margin / c.revenue : null, revenuePerHour: c.hours > 0 ? c.revenue / c.hours : null }));
  const total = projects.reduce(
    (t, p) => ({ hours: t.hours + p.hours, revenue: t.revenue + p.revenue, cost: t.cost + p.cost, margin: t.margin + p.margin, marginPct: null as number | null, estimated: t.estimated || p.estimated }),
    { hours: 0, revenue: 0, cost: 0, margin: 0, marginPct: null as number | null, estimated: false },
  );
  total.marginPct = total.revenue > 0 ? total.margin / total.revenue : null;
  return { projects: projects.sort((a, b) => b.margin - a.margin), customers: customers.sort((a, b) => b.margin - a.margin), total, from: first ? monthOf(first) : null, internal };
}
