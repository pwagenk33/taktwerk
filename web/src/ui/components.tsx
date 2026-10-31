import { fmtCHF, fmtMoney, fmtKCHF, type BudgetStatus, type Currency, type ProjectReport } from "@taktwerk/domain";
import { tr } from "../i18n";

const STATUS_LABEL: Record<BudgetStatus, string> = { ok: tr("Im Plan"), risk: tr("Knapp"), over: tr("Überschreitung") };

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
            title={tr("{0}\nBudget {1}\nVerbraucht {2}\nForecast {3} ({4} – {5})", i.name, fmtCHF(i.budget), fmtCHF(i.actual), fmtCHF(i.forecast), fmtCHF(i.low), fmtCHF(i.high))}
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
                <span>{fmtKCHF(i.actual)}{" "}{tr("/ {0} CHF", fmtKCHF(i.budget))}</span>
                <StatusPill status={i.status} />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="bullet-legend">
        <span><i className="sw" style={{ background: "var(--series-1)" }} />{tr("Verbraucht")}</span>
        <span><i className="sw" style={{ background: "var(--series-1-soft)" }} />{tr("Restaufwand (Forecast)")}</span>
        <span><i className="sw line" style={{ background: "var(--ink-2)" }} />{tr("Bandbreite")}</span>
        <span><i className="sw" style={{ background: "var(--ink)", width: 2 }} />{tr("Budget")}</span>
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

// ---------- icons ----------

const P = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
export const Icon = {
  dashboard: () => <svg viewBox="0 0 24 24" {...P}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>,
  inbox: () => <svg viewBox="0 0 24 24" {...P}><path d="M3 13l2.5-8h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M3 13h5l1.5 2.5h5L16 13h5" /></svg>,
  play: () => <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.14" /><path d="M10 8.5v7l5.5-3.5z" fill="currentColor" /></svg>,
  approve: () => <svg viewBox="0 0 24 24" {...P}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>,
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
