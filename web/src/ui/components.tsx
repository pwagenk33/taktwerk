import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  burnUp,
  fmt1,
  fmtCHF,
  fmtMoney,
  fmtKCHF,
  fmtMonth,
  fmtMonthLong,
  type BudgetStatus,
  type Currency,
  type ProjectReport,
  type VelocityMonth,
} from "@taktwerk/domain";
import { useStore, useThemeColors } from "../store";

const STATUS_LABEL: Record<BudgetStatus, string> = { ok: "Im Plan", risk: "Knapp", over: "Überschreitung" };

export function StatusPill({ status }: { status: BudgetStatus }) {
  return <span className={`pill ${status}`}>{STATUS_LABEL[status]}</span>;
}

export function Money({ v, signed, currency }: { v: number; signed?: boolean; currency?: Currency }) {
  const cls = signed ? (v < 0 ? "neg" : "pos") : "";
  return <span className={`num ${cls}`}>{signed && v > 0 ? "+" : ""}{currency && currency !== "CHF" ? fmtMoney(v, currency) : fmtCHF(v)}</span>;
}

// ---------- bullet bars: actual cost, forecast extension, optimistic/pessimistic range, budget marker ----------

export interface BulletItem {
  id: string;
  name: string;
  caption: string;
  budget: number;
  actual: number;
  forecast: number;
  low: number;
  high: number;
  status: BudgetStatus;
}

export function BulletBars({ items, onSelect }: { items: BulletItem[]; onSelect?: (id: string) => void }) {
  const max = Math.max(1, ...items.flatMap((i) => [i.budget, i.high, i.forecast])) * 1.04;
  const pct = (v: number) => `${(v / max) * 100}%`;
  return (
    <>
      <div className="bullets">
        {items.map((i) => (
          <div
            className="bullet-row"
            key={i.id}
            onClick={onSelect ? () => onSelect(i.id) : undefined}
            style={onSelect ? { cursor: "pointer" } : undefined}
            title={`${i.name}\nBudget ${fmtCHF(i.budget)}\nVerbraucht ${fmtCHF(i.actual)}\nForecast ${fmtCHF(i.forecast)} (${fmtCHF(i.low)} – ${fmtCHF(i.high)})`}
          >
            <div className="bullet-name">
              <strong>{i.name}</strong>
              <small>{i.caption}</small>
            </div>
            <div>
              <div className="bullet-track">
                <div className="bullet-actual" style={{ width: pct(i.actual) }} />
                <div className="bullet-forecast" style={{ left: pct(i.actual), width: pct(Math.max(0, i.forecast - i.actual)) }} />
                <div className="bullet-range" style={{ left: pct(i.low), width: pct(Math.max(0, i.high - i.low)) }} />
                <div className="bullet-budget" style={{ left: pct(i.budget) }} />
              </div>
              <div className="bullet-meta num">
                <span>{fmtKCHF(i.actual)} / {fmtKCHF(i.budget)} CHF</span>
                <StatusPill status={i.status} />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="bullet-legend">
        <span><i className="sw" style={{ background: "var(--series-1)" }} />Verbraucht</span>
        <span><i className="sw" style={{ background: "var(--series-1-soft)" }} />Restaufwand (Forecast)</span>
        <span><i className="sw line" style={{ background: "var(--ink-2)" }} />Bandbreite</span>
        <span><i className="sw" style={{ background: "var(--ink)", width: 2 }} />Budget</span>
      </div>
    </>
  );
}

export function reportToBullet(r: ProjectReport): BulletItem {
  return {
    id: r.project.id,
    name: r.project.name,
    caption: r.customer.name,
    budget: r.budget,
    actual: r.actualCost,
    forecast: r.forecastCost,
    low: r.forecastLow,
    high: r.forecastHigh,
    status: r.status,
  };
}

// ---------- tooltip ----------

interface TipRow {
  name?: string | number;
  value?: number | string | (number | string)[];
  color?: string;
  dataKey?: string | number;
}

export function ChartTip({
  active,
  payload,
  label,
  format,
  title,
}: {
  active?: boolean;
  payload?: TipRow[];
  label?: string;
  format: (v: number) => string;
  title?: (l: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      <div className="t">{title ? title(String(label)) : label}</div>
      {payload
        .filter((p) => typeof p.value === "number")
        .map((p) => (
          <div className="row" key={String(p.dataKey)}>
            <span><i className="sw" style={{ background: p.color }} />{p.name}</span>
            <strong>{format(p.value as number)}</strong>
          </div>
        ))}
    </div>
  );
}

// ---------- velocity chart ----------

export function VelocityChart({ months, height = "100%" }: { months: VelocityMonth[]; height?: number | string }) {
  const c = useThemeColors();
  const { velocitySettings } = useStore();
  const rows = months.map((m) => ({ ...m, label: m.month }));
  const smoothName = velocitySettings.method === "rolling" ? `Gleitend (${velocitySettings.window} Mt.)` : `EWMA (${velocitySettings.window} Mt.)`;
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div className="chart-legend">
        <span><i className="sw" style={{ background: c.s1soft }} />h/SP im Monat</span>
        <span><i className="sw line" style={{ background: c.s1 }} />{smoothName}</span>
      </div>
      <div style={{ flex: 1, minHeight: 160 }}>
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart data={rows} margin={{ top: 12, right: 18, bottom: 4, left: -8 }}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="label" tickFormatter={fmtMonth} tick={{ fill: c.muted, fontSize: 11 }} axisLine={{ stroke: c.axis }} tickLine={false} />
            <YAxis tick={{ fill: c.muted, fontSize: 11 }} axisLine={false} tickLine={false} domain={[0, "auto"]} unit=" h" width={52} />
            <Tooltip
              cursor={{ fill: c.grid, opacity: 0.5 }}
              content={<ChartTip format={(v) => `${fmt1(v)} h/SP`} title={(l) => `${fmtMonthLong(l)}${l === months.at(-1)?.month ? " (laufend)" : ""}`} />}
            />
            <Bar dataKey="hoursPerSp" name="h/SP im Monat" fill={c.s1soft} radius={[4, 4, 0, 0]} maxBarSize={28} />
            <Line dataKey="smoothed" name={smoothName} stroke={c.s1} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: c.surface, strokeWidth: 2 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------- burn-up chart ----------

export function BurnUpChart({ report }: { report: ProjectReport }) {
  const c = useThemeColors();
  const { data } = useStore();
  const rows = burnUp(data, report);
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div className="chart-legend">
        <span><i className="sw line" style={{ background: c.s1 }} />Kosten kumuliert</span>
        <span><i className="sw line" style={{ background: c.s2 }} />Forecast</span>
        <span><i className="sw line" style={{ background: c.ink }} />Budget {fmtCHF(report.budget)}</span>
      </div>
      <div style={{ flex: 1, minHeight: 160 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 12, right: 18, bottom: 4, left: -4 }}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="month" tickFormatter={fmtMonth} tick={{ fill: c.muted, fontSize: 11 }} axisLine={{ stroke: c.axis }} tickLine={false} />
            <YAxis tickFormatter={fmtKCHF} tick={{ fill: c.muted, fontSize: 11 }} axisLine={false} tickLine={false} width={48} domain={[0, (max: number) => Math.max(max, report.budget) * 1.05]} />
            <Tooltip content={<ChartTip format={fmtCHF} title={fmtMonthLong} />} />
            <Area dataKey="actual" name="Kosten kumuliert" stroke={c.s1} strokeWidth={2} fill={c.s1} fillOpacity={0.1} connectNulls={false} dot={false} />
            <Line dataKey="forecast" name="Forecast" stroke={c.s2} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls={false} />
            <Line dataKey="budget" name="Budget" stroke={c.ink} strokeWidth={1.5} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------- simple horizontal bars ----------

export function HBar({ rows, format, color }: { rows: { name: string; value: number }[]; format: (v: number) => string; color?: string }) {
  const c = useThemeColors();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 56, bottom: 8, left: 8 }}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="name" tick={{ fill: c.ink2, fontSize: 12 }} axisLine={false} tickLine={false} width={130} />
        <Tooltip cursor={{ fill: c.grid, opacity: 0.4 }} content={<ChartTip format={format} />} />
        <Bar
          dataKey="value"
          name="Wert"
          fill={color ?? c.s1}
          radius={[0, 4, 4, 0]}
          maxBarSize={22}
          label={{ position: "right", fill: c.ink2, fontSize: 11, formatter: (v: number) => format(v) }}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---------- icons ----------

const P = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
export const Icon = {
  dashboard: () => <svg viewBox="0 0 24 24" {...P}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>,
  clock: () => <svg viewBox="0 0 24 24" {...P}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>,
  folder: () => <svg viewBox="0 0 24 24" {...P}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>,
  report: () => <svg viewBox="0 0 24 24" {...P}><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 17v-3M13 17v-5M16 17v-2" /></svg>,
  camera: () => <svg viewBox="0 0 24 24" {...P}><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>,
  velocity: () => <svg viewBox="0 0 24 24" {...P}><path d="M4 18a8 8 0 1 1 16 0" /><path d="M12 18l4-6" /></svg>,
  settings: () => <svg viewBox="0 0 24 24" {...P}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>,
  grip: () => <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" /><circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" /><circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" /></svg>,
  balance: () => <svg viewBox="0 0 24 24" {...P}><path d="M12 3v18M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0zM8 21h8" /></svg>,
  check: () => <svg viewBox="0 0 24 24" {...P}><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4M8.5 15l2.5 2.5 4.5-5" /></svg>,
  edit: () => <svg viewBox="0 0 24 24" width="15" height="15" {...P}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg>,
  trash: () => <svg viewBox="0 0 24 24" width="15" height="15" {...P}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>,
  lock: () => <svg viewBox="0 0 24 24" width="14" height="14" {...P}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>,
  download: () => <svg viewBox="0 0 24 24" width="15" height="15" {...P}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>,
  mail: () => <svg viewBox="0 0 24 24" width="15" height="15" {...P}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></svg>,
  close: () => <svg viewBox="0 0 24 24" width="14" height="14" {...P}><path d="M6 6l12 12M18 6L6 18" /></svg>,
  search: () => <svg viewBox="0 0 24 24" width="15" height="15" {...P}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></svg>,
  sun: () => <svg viewBox="0 0 24 24" width="15" height="15" {...P}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>,
  moon: () => <svg viewBox="0 0 24 24" width="15" height="15" {...P}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>,
  monitor: () => <svg viewBox="0 0 24 24" width="15" height="15" {...P}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>,
  logout: () => <svg viewBox="0 0 24 24" width="15" height="15" {...P}><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l5 4-5 4M20 12H9" /></svg>,
  key: () => <svg viewBox="0 0 24 24" width="15" height="15" {...P}><circle cx="8" cy="14" r="4" /><path d="M11 11l9-9M16 6l3 3M13 9l3 3" /></svg>,
  shield: () => <svg viewBox="0 0 24 24" width="15" height="15" {...P}><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /><path d="M9 12l2 2 4-4" /></svg>,
  plan: () => <svg viewBox="0 0 24 24" {...P}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10M15 10v10M6 15h1M12 14h1M18 16h1" /></svg>,
  users: () => <svg viewBox="0 0 24 24" width="15" height="15" {...P}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4.5-6.2" /></svg>,
  back: () => <svg viewBox="0 0 24 24" width="15" height="15" {...P}><path d="M15 5l-7 7 7 7" /></svg>,
};
