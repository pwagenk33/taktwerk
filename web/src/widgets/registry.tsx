import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { addMonths, currencyOf, fmt1, fmtCHF, fmtDate, fmtDay, fmtH, fmtMonth, monthOf, toChf, upcomingAbsences, utilization, vacationSummary, workBalance } from "@taktwerk/domain";
import { useEffect, useState } from "react";
import { api, type Invoice } from "../api";
import type { TimeEntry } from "@taktwerk/domain";
import { useStore, useThemeColors } from "../store";
import { BulletBars, BurnUpChart, ChartTip, HBar, StatusPill, VelocityChart, reportToBullet } from "../ui/components";
import { Select } from "../ui/Select";
import { tr } from "../i18n";

export type WidgetConfig = Record<string, string>;

export interface WidgetProps {
  config: WidgetConfig;
  setConfig: (c: WidgetConfig) => void;
}

export interface WidgetDef {
  title: string;
  description: string;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  /** Shows budgets and forecasts; only admins and consultants may add it. */
  restricted?: boolean;
  /** Optional control rendered in the widget header. */
  HeaderControl?: (p: WidgetProps) => JSX.Element;
  Body: (p: WidgetProps) => JSX.Element;
  scroll?: boolean;
}

// ---------- shared selectors ----------

function useScopedEntries(): TimeEntry[] {
  const { data, role, currentUserId } = useStore();
  return role === "employee" ? data.timeEntries.filter((e) => e.employeeId === currentUserId) : data.timeEntries;
}

/** Compares the running month with the same days of the previous month. */
function useMonthCompare(value: (entries: TimeEntry[]) => number) {
  const { data } = useStore();
  const entries = useScopedEntries();
  const month = monthOf(data.today);
  const prev = addMonths(month, -1);
  const day = data.today.slice(8);
  const now = value(entries.filter((e) => monthOf(e.date) === month));
  const before = value(entries.filter((e) => monthOf(e.date) === prev && e.date.slice(8) <= day));
  return { now, delta: before ? (now - before) / before : 0 };
}

const sumHours = (es: TimeEntry[]) => es.reduce((s, e) => s + e.hours, 0);
const sumBillable = (es: TimeEntry[]) => es.filter((e) => e.billable).reduce((s, e) => s + e.hours * e.hourlyRate, 0);

function Delta({ delta, suffix }: { delta: number; suffix: string }) {
  const up = delta >= 0;
  return (
    <span className="delta">
      <span className={up ? "pos" : "neg"}>{up ? "▲" : "▼"} {fmt1(Math.abs(delta * 100))} %</span> {suffix}
    </span>
  );
}

// ---------- widgets ----------

function KpiHours() {
  const { now, delta } = useMonthCompare(sumHours);
  return (
    <div className="kpi">
      <span className="value num">{fmtH(now)}</span>
      <Delta delta={delta} suffix={tr("ggü. Vormonat (gleiche Tage)")} />
    </div>
  );
}

function KpiBillable() {
  const { now, delta } = useMonthCompare(sumBillable);
  return (
    <div className="kpi">
      <span className="value num">{fmtCHF(now)}</span>
      <Delta delta={delta} suffix={tr("ggü. Vormonat (gleiche Tage)")} />
    </div>
  );
}

function KpiVelocity() {
  const { factor, velocity } = useStore();
  if (!factor) return <div className="kpi muted">{tr("Noch keine erledigten Story Points.")}</div>;
  const idx = velocity.findIndex((m) => m.month === factor.asOf);
  const earlier = velocity[Math.max(0, idx - 6)]?.smoothed ?? factor.current;
  return (
    <div className="kpi">
      <span className="value num">{fmt1(factor.current)}{" "}{tr("h/SP")}</span>
      <span className="delta">
        {tr("vor 6 Monaten {0} h/SP · Band {1}–", fmt1(earlier), fmt1(factor.low))}{fmt1(factor.high)}
      </span>
    </div>
  );
}

function KpiRisk() {
  const { reports } = useStore();
  const subs = reports.flatMap((r) => r.subs);
  const over = subs.filter((s) => s.status === "over").length;
  const risk = subs.filter((s) => s.status === "risk").length;
  return (
    <div className="kpi">
      <span className="value num">
        {over + risk} <span style={{ fontSize: "1rem", fontWeight: 500 }} className="ink2">{tr("von {0} Subprojekten", subs.length)}</span>
      </span>
      <span className="delta" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <span className="pill over">{over}{" "}{tr("Überschreitung")}</span>
        <span className="pill risk">{risk}{" "}{tr("Knapp")}</span>
      </span>
    </div>
  );
}

function BudgetOverview() {
  const { reports } = useStore();
  return <BulletBars items={reports.map(reportToBullet)} onSelect={() => (location.hash = "reports")} />;
}

function VelocityTrend() {
  const { velocity } = useStore();
  return <VelocityChart months={velocity} />;
}

function ProjectSelect({ config, setConfig }: WidgetProps) {
  const { data } = useStore();
  return (
    <Select small ariaLabel={tr("Projekt")} value={config.projectId ?? data.projects[0]?.id ?? ""} onChange={(v) => setConfig({ ...config, projectId: v })} options={data.projects.map((p) => ({ value: p.id, label: p.name }))} />
  );
}

function BurnUp({ config }: WidgetProps) {
  const { reports } = useStore();
  const r = reports.find((x) => x.project.id === config.projectId) ?? reports[0];
  if (!r) return <div className="kpi muted">{tr("Kein Projekt vorhanden.")}</div>;
  return <BurnUpChart report={r} />;
}

function HoursByCustomer() {
  const { data } = useStore();
  const entries = useScopedEntries();
  const month = monthOf(data.today);
  const subToCustomer = new Map(
    data.subProjects.map((s) => [s.id, data.projects.find((p) => p.id === s.projectId)!.customerId]),
  );
  const rows = data.customers
    .map((c) => ({
      name: c.name,
      value: entries.filter((e) => monthOf(e.date) === month && subToCustomer.get(e.subProjectId) === c.id).reduce((s, e) => s + e.hours, 0),
    }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  return <HBar rows={rows} format={(v) => fmtH(v)} />;
}

function isoWeekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const wd = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - wd);
  return d.toISOString().slice(0, 10);
}

function HoursByWeek() {
  const { data } = useStore();
  const c = useThemeColors();
  const entries = useScopedEntries();
  const colors = [c.s1, c.s2, c.s3, c.s4];
  const custOfSub = new Map(data.subProjects.map((s) => [s.id, data.projects.find((p) => p.id === s.projectId)!.customerId]));
  const weeks: string[] = [];
  const start = new Date(`${isoWeekStart(data.today)}T00:00:00Z`);
  for (let i = 7; i >= 0; i--) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() - i * 7);
    weeks.push(d.toISOString().slice(0, 10));
  }
  const rows = weeks.map((w) => {
    const row: Record<string, number | string> = { week: w };
    for (const cust of data.customers) row[cust.id] = 0;
    for (const e of entries) if (isoWeekStart(e.date) === w) row[custOfSub.get(e.subProjectId)!] = (row[custOfSub.get(e.subProjectId)!] as number) + e.hours;
    return row;
  });
  const kw = (w: string) => {
    const d = new Date(`${w}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 3);
    const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    return `KW ${1 + Math.round(((d.getTime() - firstThu.getTime()) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7)}`;
  };
  const shown = data.customers.slice(0, 4);
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div className="chart-legend">
        {shown.map((cust, i) => (
          <span key={cust.id}><i className="sw" style={{ background: colors[i] }} />{cust.name}</span>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 140 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 12, right: 16, bottom: 4, left: -12 }}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="week" tickFormatter={kw} tick={{ fill: c.muted, fontSize: 11 }} axisLine={{ stroke: c.axis }} tickLine={false} />
            <YAxis tick={{ fill: c.muted, fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
            <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} content={<ChartTip format={fmtH} title={(w) => tr("{0} · ab {1}", kw(w), fmtDay(w))} />} />
            {shown.map((cust, i) => (
              <Bar key={cust.id} dataKey={cust.id} name={cust.name} stackId="a" fill={colors[i]} stroke={c.surface} strokeWidth={1}
                radius={i === shown.length - 1 ? [4, 4, 0, 0] : undefined} maxBarSize={36} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function RecentEntries() {
  const { data } = useStore();
  const entries = useScopedEntries();
  const emp = new Map(data.employees.map((e) => [e.id, e]));
  const sub = new Map(data.subProjects.map((s) => [s.id, s]));
  const proj = new Map(data.projects.map((p) => [p.id, p]));
  const recent = entries.filter((e) => !e.summary).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)).slice(0, 12);
  return (
    <div>
      {recent.map((e) => {
        const s = sub.get(e.subProjectId)!;
        return (
          <div className="entry" key={e.id}>
            <span className="who" title={emp.get(e.employeeId)?.name}>{emp.get(e.employeeId)?.initials}</span>
            <div className="what">
              <div>{e.reason}</div>
              <div className="meta">{proj.get(s.projectId)?.name} · {s.name} · {fmtDay(e.date)}</div>
            </div>
            <strong className="num">{fmt1(e.hours)}{" "}{tr("h")}</strong>
          </div>
        );
      })}
    </div>
  );
}

function TeamLoad() {
  const { data, role, currentUserId } = useStore();
  const month = monthOf(data.today);
  const people = role === "employee" ? data.employees.filter((e) => e.id === currentUserId) : data.employees;
  const rows = people
    .map((p) => ({
      name: p.name,
      value: data.timeEntries.filter((e) => e.employeeId === p.id && monthOf(e.date) === month).reduce((s, e) => s + e.hours, 0),
    }))
    .sort((a, b) => b.value - a.value);
  return <HBar rows={rows} format={(v) => fmtH(v)} color={useThemeColors().s3} />;
}

function SubStatus() {
  const { reports } = useStore();
  const subs = reports
    .flatMap((r) => r.subs.map((s) => ({ ...s, project: r.project.name })))
    .sort((a, b) => a.variance - b.variance);
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr><th>{tr("Subprojekt")}</th><th className="r">{tr("Abweichung")}</th><th>{tr("Status")}</th></tr>
        </thead>
        <tbody>
          {subs.map((s) => (
            <tr key={s.subProject.id}>
              <td><div>{s.subProject.name}</div><div className="muted" style={{ fontSize: "0.76rem" }}>{s.project}</div></td>
              <td className={`r ${s.variance < 0 ? "neg" : ""}`}>{s.variance > 0 ? "+" : ""}{fmtCHF(s.variance)}</td>
              <td><StatusPill status={s.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KpiOvertime() {
  const { data, currentUserId } = useStore();
  if (!data.employees.some((e) => e.id === currentUserId)) return <div className="kpi muted">{tr("Kein Arbeitsmodell hinterlegt.")}</div>;
  const b = workBalance(data, currentUserId);
  const month = b.months.at(-1);
  return (
    <div className="kpi">
      <span className={`value num ${b.balance < 0 ? "neg" : ""}`}>{b.balance >= 0 ? "+" : "−"}{fmtH(Math.abs(b.balance))}</span>
      <span className="delta">{tr("Diesen Monat")}{" "}{month && month.balance >= 0 ? "+" : "−"}{fmtH(Math.abs(month?.balance ?? 0))}</span>
    </div>
  );
}

function KpiVacation() {
  const { data, currentUserId } = useStore();
  if (!data.employees.some((e) => e.id === currentUserId)) return <div className="kpi muted">{tr("Kein Arbeitsmodell hinterlegt.")}</div>;
  const v = vacationSummary(data, currentUserId);
  return (
    <div className="kpi">
      <span className="value num">{fmt1(v.remaining)}{" "}{tr("Tage")}</span>
      <span className="delta">{fmt1(v.taken)}{" "}{tr("bezogen · {0} geplant von", fmt1(v.planned))}{" "}{fmt1(v.entitlement + v.carry)}</span>
    </div>
  );
}

function Utilization() {
  const { data, role, currentUserId } = useStore();
  const month = monthOf(data.today);
  const people = role === "employee" ? data.employees.filter((e) => e.id === currentUserId) : data.employees;
  const rows = utilization(data, month, people).filter((u) => u.due > 0).sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0));
  const total = rows.reduce((t, u) => ({ due: t.due + u.due, billable: t.billable + u.billable }), { due: 0, billable: 0 });
  return (
    <div className="util">
      <div className="util-head"><strong className="num">{total.due ? Math.round((total.billable / total.due) * 100) : 0} %</strong><span className="muted">{tr("verrechenbar von der Sollzeit ·")}{" "}{fmtMonth(month)}</span></div>
      {rows.map((u) => {
        const pct = Math.min(100, Math.round((u.utilization ?? 0) * 100));
        const cls = pct >= 70 ? "ok" : pct >= 50 ? "risk" : "over";
        return (
          <div className="util-row" key={u.employeeId} title={tr("{0} h verrechenbar von {1} h Soll · {2} h gebucht", fmt1(u.billable), fmt1(u.due), fmt1(u.worked))}>
            <span className="util-name">{u.name}</span>
            <span className="util-bar"><span className={`util-fill ${cls}`} style={{ width: `${pct}%` }} /></span>
            <span className="num util-pct">{pct} %</span>
          </div>
        );
      })}
    </div>
  );
}

function OpenInvoices() {
  const { data, mode } = useStore();
  const [list, setList] = useState<Invoice[] | null>(null);
  useEffect(() => {
    if (mode !== "api") return;
    api<{ invoices: Invoice[] }>("/api/invoices").then((r) => setList(r.invoices)).catch(() => setList([]));
  }, [mode]);
  if (mode !== "api") return <p className="muted" style={{ padding: "0 16px" }}>{tr("Im Prototyp gibt es keine Rechnungen. In der installierten Version stehen hier die versandten, noch offenen Rechnungen mit Fälligkeit.")}</p>;
  const open = (list ?? []).filter((i) => i.status === "sent").sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const sum = open.reduce((s, i) => s + i.gross, 0);
  const overdue = open.filter((i) => i.dueDate < data.today);
  return (
    <div>
      <div className="util-head" style={{ padding: "0 16px 8px" }}><strong className="num">{fmtCHF(sum)}</strong><span className="muted">{open.length}{" "}{tr("offen")}{overdue.length ? tr(" · {0} überfällig", overdue.length) : ""}</span></div>
      {open.slice(0, 8).map((i) => (
        <div className="entry" key={i.id}>
          <div className="what">
            <div>{data.customers.find((c) => c.id === i.customerId)?.name ?? "–"} · {i.number}</div>
            <div className={`meta ${i.dueDate < data.today ? "neg" : ""}`}>{i.dueDate < data.today ? tr("überfällig seit") : tr("fällig am")} {fmtDate(i.dueDate)}</div>
          </div>
          <strong className="num">{fmtCHF(i.gross)}</strong>
        </div>
      ))}
      {list && open.length === 0 && <p className="muted" style={{ padding: "0 16px" }}>{tr("Keine offenen Rechnungen.")}</p>}
    </div>
  );
}

function VacationPlan() {
  const { data } = useStore();
  const rows = upcomingAbsences(data, 8).slice(0, 14);
  if (rows.length === 0) return <p className="muted" style={{ padding: "0 16px" }}>{tr("Keine Absenzen in den nächsten acht Wochen.")}</p>;
  return (
    <div>
      {rows.map((a) => (
        <div className="entry" key={a.id}>
          <span className="who">{data.employees.find((e) => e.id === a.employeeId)?.initials}</span>
          <div className="what">
            <div>{a.name} · {tr(a.type)}{a.status === "requested" ? tr(" (beantragt)") : ""}</div>
            <div className="meta">{a.startDate === a.endDate ? fmtDay(a.startDate) : `${fmtDay(a.startDate)} – ${fmtDay(a.endDate)}`}{a.halfDay ? tr(" · halbe Tage") : ""}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function TopCustomers() {
  const { data } = useStore();
  const from = addMonths(monthOf(data.today), -11);
  const subToCustomer = new Map(data.subProjects.map((s) => [s.id, data.projects.find((p) => p.id === s.projectId)?.customerId ?? ""]));
  const sums = new Map<string, number>();
  for (const e of data.timeEntries) {
    if (!e.billable || monthOf(e.date) < from) continue;
    const cid = subToCustomer.get(e.subProjectId) ?? "";
    const c = data.customers.find((x) => x.id === cid);
    sums.set(cid, (sums.get(cid) ?? 0) + toChf(e.hours * e.hourlyRate, currencyOf(c), data.fx));
  }
  const rows = [...sums.entries()].map(([cid, value]) => ({ name: data.customers.find((c) => c.id === cid)?.name ?? "–", value })).filter((r) => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 8);
  return <HBar rows={rows} format={(v) => fmtCHF(v)} color={useThemeColors().s1} />;
}

export const WIDGETS: Record<string, WidgetDef> = {
  "kpi-overtime": { title: tr("Mein Überzeit-Saldo"), description: tr("Ist minus Soll seit Erfassungsbeginn"), w: 3, h: 3, minW: 2, minH: 3, Body: KpiOvertime },
  "kpi-vacation": { title: tr("Meine Ferien übrig"), description: tr("Ferientage im laufenden Jahr"), w: 3, h: 3, minW: 2, minH: 3, Body: KpiVacation },
  "kpi-hours": { title: tr("Stunden diesen Monat"), description: tr("Erfasste Stunden im laufenden Monat"), w: 3, h: 3, minW: 2, minH: 3, Body: KpiHours },
  "kpi-billable": { title: tr("Verrechenbar diesen Monat"), description: tr("Stunden × Kundensatz, laufender Monat"), w: 3, h: 3, minW: 2, minH: 3, Body: KpiBillable },
  "kpi-velocity": { title: "Team-Velocity", description: tr("Aktueller Faktor Stunden pro Story Point"), w: 3, h: 3, minW: 2, minH: 3, restricted: true, Body: KpiVelocity },
  "kpi-risk": { title: "Budget-Risiken", description: tr("Subprojekte mit knappem oder überschrittenem Forecast"), w: 3, h: 3, minW: 2, minH: 3, restricted: true, Body: KpiRisk },
  "budget-overview": { title: tr("Budget & Forecast pro Projekt"), description: tr("Verbraucht, Restaufwand und Budgetlinie"), w: 7, h: 8, minW: 4, minH: 5, restricted: true, Body: BudgetOverview, scroll: true },
  "velocity-trend": { title: tr("Velocity-Verlauf (h pro SP)"), description: tr("Monatlicher Faktor und geglätteter Trend"), w: 5, h: 8, minW: 3, minH: 5, restricted: true, Body: VelocityTrend },
  burnup: { title: "Burn-up", description: tr("Kumulierte Kosten, Forecast und Budget eines Projekts"), w: 7, h: 8, minW: 4, minH: 5, restricted: true, Body: BurnUp, HeaderControl: ProjectSelect },
  "recent-entries": { title: tr("Letzte Buchungen"), description: tr("Die neuesten Zeiteinträge"), w: 5, h: 8, minW: 3, minH: 4, Body: RecentEntries, scroll: true },
  "hours-week": { title: tr("Stunden pro Woche nach Kunde"), description: tr("Gestapelt, letzte 8 Kalenderwochen"), w: 7, h: 7, minW: 4, minH: 5, Body: HoursByWeek },
  "team-load": { title: tr("Stunden pro Person (Monat)"), description: tr("Erfasste Stunden je Mitarbeitende"), w: 5, h: 7, minW: 3, minH: 4, Body: TeamLoad },
  "hours-customer": { title: tr("Stunden nach Kunde (Monat)"), description: tr("Verteilung im laufenden Monat"), w: 5, h: 6, minW: 3, minH: 4, Body: HoursByCustomer },
  utilization: { title: tr("Auslastung"), description: tr("Verrechenbare Stunden im Verhältnis zur Sollzeit, laufender Monat"), w: 5, h: 7, minW: 3, minH: 4, Body: Utilization, scroll: true },
  "open-invoices": { title: tr("Offene Rechnungen"), description: tr("Versandte Rechnungen, die noch nicht bezahlt sind"), w: 5, h: 6, minW: 3, minH: 4, restricted: true, Body: OpenInvoices, scroll: true },
  "vacation-plan": { title: tr("Ferienplan"), description: tr("Absenzen im Team in den nächsten acht Wochen"), w: 5, h: 7, minW: 3, minH: 4, Body: VacationPlan, scroll: true },
  "top-customers": { title: "Top-Kunden", description: tr("Verrechenbarer Umsatz der letzten zwölf Monate in CHF"), w: 5, h: 6, minW: 3, minH: 4, restricted: true, Body: TopCustomers },
  "sub-status": { title: tr("Subprojekte nach Abweichung"), description: tr("Sortiert nach Budget minus Forecast"), w: 5, h: 8, minW: 3, minH: 4, restricted: true, Body: SubStatus, scroll: true },
};

