// Charts (recharts). Kept apart from ui/components so pages without charts don't download the chart library.
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
import { burnUp, fmt1, fmtCHF, fmtKCHF, fmtMonth, fmtMonthLong, type ProjectReport, type VelocityMonth } from "@taktwerk/domain";
import { useStore, useThemeColors } from "../store";
import { tr } from "../i18n";

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
  const smoothName = velocitySettings.method === "rolling" ? tr("Gleitend ({0} Mt.)", velocitySettings.window) : tr("EWMA ({0} Mt.)", velocitySettings.window);
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div className="chart-legend">
        <span><i className="sw" style={{ background: c.s1soft }} />{tr("h/SP im Monat")}</span>
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
              content={<ChartTip format={(v) => `${fmt1(v)} h/SP`} title={(l) => `${fmtMonthLong(l)}${l === months.at(-1)?.month ? tr(" (laufend)") : ""}`} />}
            />
            <Bar dataKey="hoursPerSp" name={tr("h/SP im Monat")} fill={c.s1soft} radius={[4, 4, 0, 0]} maxBarSize={28} />
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
        <span><i className="sw line" style={{ background: c.s1 }} />{tr("Kosten kumuliert")}</span>
        <span><i className="sw line" style={{ background: c.s2 }} />{tr("Forecast")}</span>
        <span><i className="sw line" style={{ background: c.ink }} />{tr("Budget")}{" "}{fmtCHF(report.budget)}</span>
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
