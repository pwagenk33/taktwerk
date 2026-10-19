import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { addMonths, fmt1, fmtCHF, fmtDay, fmtH, monthOf, vacationSummary, workBalance } from "@taktwerk/domain";
import type { TimeEntry } from "@taktwerk/domain";
import { useStore, useThemeColors } from "../store";
import { BulletBars, BurnUpChart, ChartTip, HBar, StatusPill, VelocityChart, reportToBullet } from "../ui/components";

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
      <Delta delta={delta} suffix="ggü. Vormonat (gleiche Tage)" />
    </div>
  );
}

function KpiBillable() {
  const { now, delta } = useMonthCompare(sumBillable);
  return (
    <div className="kpi">
      <span className="value num">{fmtCHF(now)}</span>
      <Delta delta={delta} suffix="ggü. Vormonat (gleiche Tage)" />
    </div>
  );
}

function KpiVelocity() {
  const { factor, velocity } = useStore();
  if (!factor) return <div className="kpi muted">Noch keine erledigten Story Points.</div>;
  const idx = velocity.findIndex((m) => m.month === factor.asOf);
  const earlier = velocity[Math.max(0, idx - 6)]?.smoothed ?? factor.current;
  return (
    <div className="kpi">
      <span className="value num">{fmt1(factor.current)} h/SP</span>
      <span className="delta">
        vor 6 Monaten {fmt1(earlier)} h/SP · Band {fmt1(factor.low)}–{fmt1(factor.high)}
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
        {over + risk} <span style={{ fontSize: "1rem", fontWeight: 500 }} className="ink2">von {subs.length} Subprojekten</span>
      </span>
      <span className="delta" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <span className="pill over">{over} Überschreitung</span>
        <span className="pill risk">{risk} Knapp</span>
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
    <select className="mini-select" aria-label="Projekt" value={config.projectId ?? data.projects[0]?.id} onChange={(e) => setConfig({ ...config, projectId: e.target.value })}>
      {data.projects.map((p) => (
        <option key={p.id} value={p.id}>{p.name}</option>
      ))}
    </select>
  );
}

function BurnUp({ config }: WidgetProps) {
  const { reports } = useStore();
  const r = reports.find((x) => x.project.id === config.projectId) ?? reports[0];
  if (!r) return <div className="kpi muted">Kein Projekt vorhanden.</div>;
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
            <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} content={<ChartTip format={fmtH} title={(w) => `${kw(w)} · ab ${fmtDay(w)}`} />} />
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
  const recent = [...entries].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)).slice(0, 12);
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
            <strong className="num">{fmt1(e.hours)} h</strong>
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
          <tr><th>Subprojekt</th><th className="r">Abweichung</th><th>Status</th></tr>
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
  if (!data.employees.some((e) => e.id === currentUserId)) return <div className="kpi muted">Kein Arbeitsmodell hinterlegt.</div>;
  const b = workBalance(data, currentUserId);
  const month = b.months.at(-1);
  return (
    <div className="kpi">
      <span className={`value num ${b.balance < 0 ? "neg" : ""}`}>{b.balance >= 0 ? "+" : "−"}{fmtH(Math.abs(b.balance))}</span>
      <span className="delta">Diesen Monat {month && month.balance >= 0 ? "+" : "−"}{fmtH(Math.abs(month?.balance ?? 0))}</span>
    </div>
  );
}

function KpiVacation() {
  const { data, currentUserId } = useStore();
  if (!data.employees.some((e) => e.id === currentUserId)) return <div className="kpi muted">Kein Arbeitsmodell hinterlegt.</div>;
  const v = vacationSummary(data, currentUserId);
  return (
    <div className="kpi">
      <span className="value num">{fmt1(v.remaining)} Tage</span>
      <span className="delta">{fmt1(v.taken)} bezogen · {fmt1(v.planned)} geplant von {fmt1(v.entitlement + v.carry)}</span>
    </div>
  );
}

export const WIDGETS: Record<string, WidgetDef> = {
  "kpi-overtime": { title: "Mein Überzeit-Saldo", description: "Ist minus Soll seit Erfassungsbeginn", w: 3, h: 3, minW: 2, minH: 3, Body: KpiOvertime },
  "kpi-vacation": { title: "Meine Ferien übrig", description: "Ferientage im laufenden Jahr", w: 3, h: 3, minW: 2, minH: 3, Body: KpiVacation },
  "kpi-hours": { title: "Stunden diesen Monat", description: "Erfasste Stunden im laufenden Monat", w: 3, h: 3, minW: 2, minH: 3, Body: KpiHours },
  "kpi-billable": { title: "Verrechenbar diesen Monat", description: "Stunden × Kundensatz, laufender Monat", w: 3, h: 3, minW: 2, minH: 3, Body: KpiBillable },
  "kpi-velocity": { title: "Team-Velocity", description: "Aktueller Faktor Stunden pro Story Point", w: 3, h: 3, minW: 2, minH: 3, restricted: true, Body: KpiVelocity },
  "kpi-risk": { title: "Budget-Risiken", description: "Subprojekte mit knappem oder überschrittenem Forecast", w: 3, h: 3, minW: 2, minH: 3, restricted: true, Body: KpiRisk },
  "budget-overview": { title: "Budget & Forecast pro Projekt", description: "Verbraucht, Restaufwand und Budgetlinie", w: 7, h: 8, minW: 4, minH: 5, restricted: true, Body: BudgetOverview, scroll: true },
  "velocity-trend": { title: "Velocity-Verlauf (h pro SP)", description: "Monatlicher Faktor und geglätteter Trend", w: 5, h: 8, minW: 3, minH: 5, restricted: true, Body: VelocityTrend },
  burnup: { title: "Burn-up", description: "Kumulierte Kosten, Forecast und Budget eines Projekts", w: 7, h: 8, minW: 4, minH: 5, restricted: true, Body: BurnUp, HeaderControl: ProjectSelect },
  "recent-entries": { title: "Letzte Buchungen", description: "Die neuesten Zeiteinträge", w: 5, h: 8, minW: 3, minH: 4, Body: RecentEntries, scroll: true },
  "hours-week": { title: "Stunden pro Woche nach Kunde", description: "Gestapelt, letzte 8 Kalenderwochen", w: 7, h: 7, minW: 4, minH: 5, Body: HoursByWeek },
  "team-load": { title: "Stunden pro Person (Monat)", description: "Erfasste Stunden je Mitarbeitende", w: 5, h: 7, minW: 3, minH: 4, Body: TeamLoad },
  "hours-customer": { title: "Stunden nach Kunde (Monat)", description: "Verteilung im laufenden Monat", w: 5, h: 6, minW: 3, minH: 4, Body: HoursByCustomer },
  "sub-status": { title: "Subprojekte nach Abweichung", description: "Sortiert nach Budget minus Forecast", w: 5, h: 8, minW: 3, minH: 4, restricted: true, Body: SubStatus, scroll: true },
};

