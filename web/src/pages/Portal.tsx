// Customer portal: what a customer contact sees after signing in with a portal account. Budgets, remaining budget and
// forecast per project, billable hours per month, monthly reports (PDF/Excel) and issued invoices. Read-only.
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { addMonths, currencyOf, fmt1, fmtDate, fmtMoney, fmtMonth, fmtMonthLong, fmtNum, monthOf, projectReports, type Currency, type ProjectReport } from "@taktwerk/domain";
import { api, type PortalOverview } from "../api";
import { useStore, useThemeColors } from "../store";
import { ChartTip, Icon, Money, StatusPill } from "../ui/components";
import { BrandMark } from "../ui/motif";
import { Select } from "../ui/Select";

/** Demo: the portal of «Medtech Basel AG», computed from the example data in the browser. */
function demoOverview(data: Parameters<typeof projectReports>[0], customerId: string): PortalOverview {
  const customer = data.customers.find((c) => c.id === customerId)!;
  const projects = projectReports(data, { method: "rolling", window: 3 }, customerId);
  const subIds = new Set(projects.flatMap((r) => r.subs.map((s) => s.subProject.id)));
  const cur = monthOf(data.today);
  const months = Array.from({ length: 12 }, (_, i) => addMonths(cur, i - 11)).map((month) => {
    const own = data.timeEntries.filter((e) => e.billable && subIds.has(e.subProjectId) && monthOf(e.date) === month);
    return { month, label: fmtMonth(month), hours: Math.round(own.reduce((s, e) => s + e.hours, 0) * 10) / 10, amount: Math.round(own.reduce((s, e) => s + e.hours * e.hourlyRate, 0)) };
  });
  const invoices = months
    .slice(-4, -1)
    .filter((m) => m.amount > 0)
    .map((m, i, arr) => {
      const net = m.amount;
      const issue = `${addMonths(m.month, 1)}-05`;
      return { id: `demo-${m.month}`, number: `${m.month.slice(0, 4)}-${String(40 + i).padStart(4, "0")}`, month: m.month, issueDate: issue, dueDate: `${addMonths(m.month, 2)}-04`, status: (i === arr.length - 1 ? "sent" : "paid") as "sent" | "paid", net, gross: Math.round(net * 1.081 * 20) / 20 };
    })
    .reverse();
  return { customer: { id: customer.id, name: customer.name, currency: currencyOf(customer) }, orgName: "Beispiel AG", today: data.today, projects, months, invoices };
}

function MonthChart({ months, currency }: { months: PortalOverview["months"]; currency: Currency }) {
  const c = useThemeColors();
  return (
    <div style={{ height: 220 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={months} margin={{ top: 12, right: 12, bottom: 4, left: -8 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="label" tick={{ fill: c.muted, fontSize: 11 }} axisLine={{ stroke: c.axis }} tickLine={false} />
          <YAxis tick={{ fill: c.muted, fontSize: 11 }} axisLine={false} tickLine={false} unit=" h" width={52} />
          <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} content={<ChartTip format={(v) => `${fmt1(v)} h`} title={(l) => { const m = months.find((x) => x.label === l); return m ? `${fmtMonthLong(m.month)} · ${fmtMoney(m.amount, currency)}` : String(l); }} />} />
          <Bar dataKey="hours" name="Verrechenbare Stunden" fill={c.s1} radius={[4, 4, 0, 0]} maxBarSize={30} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

const INVOICE_STATUS = { sent: { label: "Offen", cls: "risk" }, paid: { label: "Bezahlt", cls: "ok" } } as const;

export function Portal() {
  const { data, mode, me, branding, logout } = useStore();
  const [remote, setRemote] = useState<PortalOverview | null>(null);
  const [error, setError] = useState("");
  const demoCustomer = useMemo(() => data.customers.find((c) => c.id === "c3") ?? data.customers[0], [data.customers]);
  useEffect(() => {
    if (mode !== "api") return;
    api<PortalOverview>("/api/portal").then(setRemote).catch((e: Error) => setError(e.message));
  }, [mode]);
  const o = mode === "api" ? remote : demoCustomer ? demoOverview(data, demoCustomer.id) : null;
  const [month, setMonth] = useState("");

  if (error) return <div className="center-note">{error}</div>;
  if (!o) return <div className="center-note">Lade …</div>;

  const cur = o.customer.currency;
  const m = (v: number) => fmtMoney(v, cur);
  const budget = o.projects.reduce((s, p) => s + p.budget, 0);
  const actual = o.projects.reduce((s, p) => s + p.actualCost, 0);
  const forecast = o.projects.reduce((s, p) => s + p.forecastCost, 0);
  const hours = o.projects.reduce((s, p) => s + p.hoursBooked, 0);
  const reportMonths = o.months.filter((x) => x.hours > 0).map((x) => x.month).reverse();
  const chosen = month || reportMonths[0] || "";
  const reportUrl = (format: "pdf" | "xlsx") => (mode === "api" ? `/api/portal/report?month=${chosen}&format=${format}` : undefined);
  const name = me?.name ?? "Claudia Steiner";

  return (
    <div className="portal">
      <header className="portal-top">
        <div className="brand"><BrandMark logo={branding.logo} /><span>{branding.appName}</span><span className="portal-org">· Kundenportal {o.orgName}</span></div>
        <div className="toolbar">
          <span className="muted portal-who">{name} · {o.customer.name}</span>
          <button className="btn small ghost" onClick={logout} title="Abmelden" aria-label="Abmelden"><Icon.logout /><span>Abmelden</span></button>
        </div>
      </header>
      <main className="portal-main">
        <div className="page-head">
          <div>
            <h1>{o.customer.name}</h1>
            <p className="sub">Stand {fmtDate(o.today)} · {o.projects.length} {o.projects.length === 1 ? "Projekt" : "Projekte"} · Beträge in {cur}</p>
          </div>
        </div>

        <div className="tiles" id="portal-tiles">
          <div className="card tile"><span className="label">Budget</span><span className="value num">{m(budget)}</span></div>
          <div className="card tile"><span className="label">Verbraucht</span><span className="value num">{m(actual)}</span><span className="delta num">{budget > 0 ? `${fmt1((actual / budget) * 100)} % des Budgets` : `${fmtNum(hours)} h geleistet`}</span></div>
          <div className="card tile"><span className="label">Restbudget</span><span className="value num"><Money v={budget - actual} signed={budget - actual < 0} currency={cur} /></span></div>
          <div className="card tile"><span className="label">Prognose bis Abschluss</span><span className="value num">{m(forecast)}</span><span className="delta">Abweichung <Money v={budget - forecast} signed currency={cur} /></span></div>
        </div>

        <div className="grid-2">
          <section className="card">
            <div className="card-head"><h2>Projekte</h2></div>
            <div className="portal-projects">
              {o.projects.map((p: ProjectReport) => {
                const pct = p.retainer ? (p.retainer.used / Math.max(1, p.retainer.hoursPerMonth)) * 100 : p.budget > 0 ? (p.actualCost / p.budget) * 100 : 0;
                return (
                  <div className="portal-project" key={p.project.id}>
                    <div className="portal-project-head">
                      <strong>{p.project.name}</strong>
                      <StatusPill status={p.status} />
                    </div>
                    <div className="util-bar"><span className={`util-fill ${p.status === "over" ? "over" : p.status === "risk" ? "risk" : ""}`} style={{ width: `${Math.min(100, pct)}%` }} /></div>
                    <div className="muted num" style={{ fontSize: "0.8rem" }}>
                      {p.retainer
                        ? `Kontingent ${fmtNum(p.retainer.hoursPerMonth)} h/Monat · ${fmtMonth(p.retainer.month)} ${fmt1(p.retainer.used)} h genutzt`
                        : `${m(p.actualCost)} von ${m(p.budget)} verbraucht · ${fmtNum(p.hoursBooked)} h · Prognose ${m(p.forecastCost)}${p.completionMonth ? ` · voraussichtlich fertig ${fmtMonth(p.completionMonth)}` : ""}`}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h2>Geleistete Stunden pro Monat</h2></div>
            <div className="card-pad"><MonthChart months={o.months} currency={cur} /></div>
          </section>
        </div>

        <div className="grid-2">
          <section className="card">
            <div className="card-head"><h2>Monatsreport</h2></div>
            <div className="card-pad portal-report">
              {reportMonths.length === 0 && <p className="muted">Noch kein Monat mit Leistungen.</p>}
              {reportMonths.length > 0 && (
                <>
                  <Select id="portal-month" ariaLabel="Monat" value={chosen} onChange={setMonth} options={reportMonths.map((x) => ({ value: x, label: fmtMonthLong(x) }))} />
                  <a className={`btn ${mode === "api" ? "" : "disabled"}`} id="portal-pdf" href={reportUrl("pdf")} onClick={(e) => { if (mode !== "api") { e.preventDefault(); } }} title={mode === "api" ? "" : "In der Demo nicht verfügbar"}><Icon.download />PDF</a>
                  <a className={`btn ${mode === "api" ? "" : "disabled"}`} id="portal-xlsx" href={reportUrl("xlsx")} onClick={(e) => { if (mode !== "api") { e.preventDefault(); } }} title={mode === "api" ? "" : "In der Demo nicht verfügbar"}><Icon.download />Excel</a>
                </>
              )}
              <p className="muted" style={{ fontSize: "0.82rem", margin: 0 }}>Der Report enthält Budget, Prognose und alle verrechenbaren Leistungen des Monats.</p>
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h2>Rechnungen</h2></div>
            {o.invoices.length === 0 && <p className="muted card-pad">Noch keine Rechnung gestellt.</p>}
            {o.invoices.length > 0 && (
              <div className="table-wrap">
                <table className="data" id="portal-invoices">
                  <thead><tr><th>Nummer</th><th>Monat</th><th>Fällig</th><th className="r">Betrag</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {o.invoices.map((i) => (
                      <tr key={i.id}>
                        <td className="mono">{i.number}</td>
                        <td style={{ whiteSpace: "nowrap" }}>{fmtMonth(i.month)}</td>
                        <td style={{ whiteSpace: "nowrap" }} title={`Gestellt am ${fmtDate(i.issueDate)}`}>{fmtDate(i.dueDate)}</td>
                        <td className="r num">{fmtMoney(i.gross, cur, 2)}</td>
                        <td><span className={`pill ${INVOICE_STATUS[i.status].cls}`}>{INVOICE_STATUS[i.status].label}</span></td>
                        <td className="r">{mode === "api" ? <a className="btn small ghost" href={`/api/portal/invoices/${i.id}/pdf`} target="_blank" rel="noreferrer" title="PDF öffnen"><Icon.download /></a> : <span className="muted" style={{ fontSize: "0.78rem" }}>Demo</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
        <p className="portal-foot muted">Fragen zu Ihren Projekten? Ihre Ansprechperson bei {o.orgName} hilft gern weiter.</p>
      </main>
    </div>
  );
}
