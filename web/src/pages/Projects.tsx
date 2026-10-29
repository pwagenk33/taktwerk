import { Fragment, useEffect, useMemo, useState } from "react";
import { PROJECT_KINDS, currencyOf, fmt1, fmtCHF, fmtDate, fmtMoney, fmtMonth, fmtNum, rateOn, scenario, scenarioBand, type BudgetStatus, type Currency, type Customer, type Project, type ProjectKind, type ProjectReport, type SubProject } from "@taktwerk/domain";
import { CustomerDialog, PortalInviteDialog, ProjectDialog, SubProjectDialog } from "./EditDialogs";
import { useStore } from "../store";
import type { PortalAccount } from "../api";
import { BurnUpChart, Icon, Money, StatusPill } from "../ui/components";

/** Who leads the project, shown under the project head. Changed in the project's edit popup. */
function ProjectLead({ project }: { project: Project }) {
  const { data } = useStore();
  const lead = data.employees.find((e) => e.id === project.leadUserId);
  return lead ? <p className="muted" style={{ fontSize: "0.82rem", margin: "6px 0 0" }}>Projektleitung {lead.name}</p> : null;
}

const kindLabel = (k: ProjectKind | undefined) => PROJECT_KINDS.find((x) => x.id === (k ?? "tm"))!.label;

/** Name, budget and Jira key of a project or sub-project; «Bearbeiten» opens the popup for leads. */
function ItemHead({ item, kind, currency = "CHF" }: { item: Project | SubProject; kind: "project" | "sub"; currency?: Currency }) {
  const { scope } = useStore();
  const projectId = kind === "project" ? item.id : (item as SubProject).projectId;
  const jiraKey = kind === "project" ? (item as Project).jiraProjectKey : (item as SubProject).jiraEpicKey;
  const project = kind === "project" ? (item as Project) : null;
  const [edit, setEdit] = useState(false);
  return (
    <div className="tree-row" style={{ gap: 10, flexWrap: "wrap" }}>
      <div>
        {kind === "project" ? <h2 style={{ margin: 0 }}>{item.name}</h2> : <strong>{item.name}</strong>} {jiraKey && <span className="pill neutral mono">{jiraKey}</span>}
        {project && <span className="pill neutral" style={{ marginLeft: 6 }}>{kindLabel(project.kind)}{project.kind === "retainer" && project.retainerHours ? ` · ${fmtNum(project.retainerHours)} h/Monat` : ""}</span>}
        <div className="muted num" style={{ fontSize: "0.82rem" }}>{project?.kind === "fixed" ? "Fixpreis" : "Budget"} {fmtMoney(item.budget, currency)}</div>
      </div>
      {scope.leadsProject(projectId) && !scope.readOnly && <button className="btn small" onClick={(e) => { e.stopPropagation(); setEdit(true); }}>Bearbeiten</button>}
      {edit && (project
        ? <ProjectDialog project={project} customerId={project.customerId} onClose={() => setEdit(false)} />
        : <SubProjectDialog sub={item as SubProject} projectId={projectId} onClose={() => setEdit(false)} />)}
    </div>
  );
}

/** What-if on one project: the velocity band plus sliders for velocity, rate, scope, budget and team size. */
function ScenarioCard({ report, currency }: { report: ProjectReport; currency: Currency }) {
  const { data, factor } = useStore();
  const [f, setF] = useState<number | null>(null);
  const [rate, setRate] = useState(100);
  const [sp, setSp] = useState(0);
  const [budget, setBudget] = useState(0);
  const [cap, setCap] = useState(100);
  const m = (v: number) => fmtMoney(v, currency);
  const band = useMemo(() => scenarioBand(data, report, factor), [data, report, factor]);
  const current = factor?.current ?? 0;
  const mine = useMemo(() => scenario(data, report, factor, { factor: f ?? current, rateFactor: rate / 100, spDelta: sp, budgetDelta: budget, capacityFactor: cap / 100 }, "Dein Szenario"), [data, report, factor, f, current, rate, sp, budget, cap]);
  if (!factor || report.spOpen === 0) return null;
  const lo = Math.max(0.5, Math.floor(factor.low * 0.6 * 2) / 2);
  const hi = Math.ceil(factor.high * 1.4 * 2) / 2;
  const reset = () => { setF(null); setRate(100); setSp(0); setBudget(0); setCap(100); };
  const changed = f !== null || rate !== 100 || sp !== 0 || budget !== 0 || cap !== 100;
  const rows = [...band, mine];
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div className="card-head" style={{ paddingBottom: 8, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2>Forecast-Szenarien</h2>
          <span className="muted" style={{ fontSize: "0.8rem" }}>Velocity-Band aus den letzten {factor ? "Monaten" : ""} und ein Was-wäre-wenn für Nachträge</span>
        </div>
        {changed && <button className="btn small ghost" onClick={reset}>Zurücksetzen</button>}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Szenario</th><th className="r">h/SP</th><th className="r">Restaufwand</th><th className="r">Forecast</th><th className="r">Budget</th><th className="r">Abweichung</th><th>Fertig ca.</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className={r.label === "Dein Szenario" ? "group" : ""}>
                <td>{r.label}</td>
                <td className="r num">{fmt1(r.factor)}</td>
                <td className="r num">{fmtNum(r.remainingHours)} h</td>
                <td className="r num">{m(r.forecastCost)}</td>
                <td className="r num">{m(r.budget)}</td>
                <td className="r"><Money v={r.variance} signed currency={currency} /></td>
                <td>{r.completionMonth ? fmtMonth(r.completionMonth) : "offen"}</td>
                <td><StatusPill status={r.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="scenario-knobs">
        <label className="knob"><span>Velocity <strong className="num">{fmt1(f ?? current)} h/SP</strong></span><input id="sc-factor" type="range" min={lo} max={hi} step={0.1} value={f ?? current} onChange={(e) => setF(Number(e.target.value))} /><small>Band {fmt1(factor.low)} – {fmt1(factor.high)}</small></label>
        <label className="knob"><span>Stundensatz <strong className="num">{rate} %</strong></span><input id="sc-rate" type="range" min={70} max={130} step={5} value={rate} onChange={(e) => setRate(Number(e.target.value))} /><small>{m(rateOn(report.customer, data.today) * rate / 100)}/h für den Rest</small></label>
        <label className="knob"><span>Umfang <strong className="num">{sp >= 0 ? "+" : ""}{sp} SP</strong></span><input id="sc-scope" type="range" min={-Math.min(50, report.spOpen)} max={100} step={5} value={sp} onChange={(e) => setSp(Number(e.target.value))} /><small>{fmtNum(report.spOpen + sp)} SP offen</small></label>
        <label className="knob"><span>Budget <strong className="num">{budget >= 0 ? "+" : ""}{m(budget)}</strong></span><input id="sc-budget" type="range" min={-Math.round(report.budget / 2 / 1000) * 1000} max={Math.max(10000, Math.round(report.budget / 2 / 1000) * 1000)} step={1000} value={budget} onChange={(e) => setBudget(Number(e.target.value))} /><small>Nachtrag oder Kürzung</small></label>
        <label className="knob"><span>Team <strong className="num">{cap} %</strong></span><input id="sc-cap" type="range" min={50} max={200} step={10} value={cap} onChange={(e) => setCap(Number(e.target.value))} /><small>Kapazität für den Fertigstellungstermin</small></label>
      </div>
    </section>
  );
}

/** One project: figures, sub-projects with their JIRA issues, budgets editable. */
function ProjectDetail({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const { data, reports } = useStore();
  const [open, setOpen] = useState<string | null>(null);
  const project = data.projects.find((p) => p.id === projectId)!;
  const customer = data.customers.find((c) => c.id === project.customerId);
  const r = reports.find((x) => x.project.id === projectId);
  const subs = data.subProjects.filter((s) => s.projectId === projectId);
  const subReport = new Map((r?.subs ?? []).map((s) => [s.subProject.id, s]));
  const hoursByIssue = new Map<string, number>();
  for (const e of data.timeEntries) if (e.jiraIssueKey) hoursByIssue.set(e.jiraIssueKey, (hoursByIssue.get(e.jiraIssueKey) ?? 0) + e.hours);
  const allocated = subs.reduce((s, x) => s + x.budget, 0);
  const cur = currencyOf(customer);
  const m = (v: number) => fmtMoney(v, cur);

  return (
    <>
      <div className="page-head">
        <div>
          <button className="btn small ghost back-btn" onClick={onBack}><Icon.back />{customer?.name ?? "Kunden"}</button>
          <h1 style={{ marginTop: 8 }}>{project.name}</h1>
          <p className="sub">{customer?.name} · {m(customer ? rateOn(customer, data.today) : 0)}/h · {kindLabel(project.kind)}</p>
        </div>
        {r && <StatusPill status={r.status} />}
      </div>
      <section className="card card-pad" style={{ marginBottom: 16 }}>
        <ItemHead item={project} kind="project" currency={cur} />
        <p className="muted num" style={{ fontSize: "0.82rem", margin: "8px 0 0" }}>Auf Subprojekte verteilt {m(allocated)} · Reserve <Money v={project.budget - allocated} signed={project.budget - allocated < 0} currency={cur} /></p>
        <ProjectLead project={project} />
      </section>
      {r?.retainer && (
        <div className="tiles">
          <div className="card tile"><span className="label">Kontingent {fmtMonth(r.retainer.month)}</span><span className="value num">{fmt1(r.retainer.used)} / {fmtNum(r.retainer.hoursPerMonth)} h</span><span className="delta num">{fmt1((r.retainer.used / Math.max(1, r.retainer.hoursPerMonth)) * 100)} % genutzt</span></div>
          <div className="card tile"><span className="label">Schnitt letzte 3 Monate</span><span className="value num">{fmt1(r.retainer.avg3)} h</span><span className="delta">{r.retainer.avg3 > r.retainer.hoursPerMonth ? "über dem Kontingent" : "innerhalb des Kontingents"}</span></div>
          <div className="card tile"><span className="label">Monatsbetrag</span><span className="value num">{m(r.retainer.hoursPerMonth * (customer ? rateOn(customer, data.today) : 0))}</span><span className="delta">{fmtNum(r.retainer.hoursPerMonth)} h × {m(customer ? rateOn(customer, data.today) : 0)}</span></div>
          <div className="card tile"><span className="label">Offen</span><span className="value num">{fmtNum(r.spOpen)} SP</span><span className="delta">{fmtNum(r.remainingHours)} h Restaufwand</span></div>
        </div>
      )}
      {r && !r.retainer && (
        <div className="tiles">
          <div className="card tile"><span className="label">{r.kind === "fixed" ? "Fixpreis" : "Budget"}</span><span className="value num">{m(r.budget)}</span></div>
          <div className="card tile"><span className="label">{r.kind === "fixed" ? "Aufwand zum Kundensatz" : "Verbraucht"}</span><span className="value num">{m(r.actualCost)}</span><span className="delta num">{fmt1((r.actualCost / Math.max(1, r.budget)) * 100)} % {r.kind === "fixed" ? "des Fixpreises" : "des Budgets"}</span></div>
          <div className="card tile"><span className="label">Forecast</span><span className="value num">{m(r.forecastCost)}</span><span className="delta">Abweichung <Money v={r.variance} signed currency={cur} /></span></div>
          <div className="card tile"><span className="label">Offen</span><span className="value num">{fmtNum(r.spOpen)} SP</span><span className="delta">{fmtNum(r.remainingHours)} h Restaufwand · fertig ca. {r.completionMonth ? fmtMonth(r.completionMonth) : "offen"}</span></div>
        </div>
      )}
      <section className="card">
        <div className="card-head" style={{ paddingBottom: 8 }}><h2>Subprojekte</h2><span className="muted" style={{ fontSize: "0.8rem" }}>Zeile anklicken für die JIRA-Tickets</span></div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Subprojekt</th><th className="r">Budget</th><th className="r">Verbraucht</th><th className="r">Verbleibend</th><th className="r">Offene SP</th><th className="r">Forecast</th><th>Status</th></tr>
            </thead>
            <tbody>
              {subs.map((s) => {
                const sr = subReport.get(s.id);
                const issues = data.issues.filter((i) => i.subProjectId === s.id);
                const isOpen = open === s.id;
                return (
                  <Fragment key={s.id}>
                    <tr className="group clickable" onClick={() => setOpen(isOpen ? null : s.id)}>
                      <td><span className={`caret ${isOpen ? "open" : ""}`}>▸</span>{s.name} {s.jiraEpicKey && <span className="mono muted">{s.jiraEpicKey}</span>}</td>
                      <td className="r num">{m(s.budget)}</td>
                      <td className="r num">{sr ? m(sr.actualCost) : "–"}</td>
                      <td className="r num">{sr ? <Money v={sr.remainingBudget} signed={sr.remainingBudget < 0} currency={cur} /> : "–"}</td>
                      <td className="r num">{sr ? fmtNum(sr.spOpen) : "–"}</td>
                      <td className="r num">{sr ? m(sr.forecastCost) : "–"}</td>
                      <td>{sr && <StatusPill status={sr.status} />}</td>
                    </tr>
                    {isOpen && (
                      <tr className="child">
                        <td colSpan={7} style={{ padding: "10px 16px 14px 28px" }}>
                          <div style={{ marginBottom: 10 }}>
                            <ItemHead item={s} kind="sub" currency={cur} />
                          </div>
                          {issues.length === 0 ? (
                            <p className="muted" style={{ margin: 0 }}>Keine JIRA-Tickets verknüpft{s.jiraEpicKey ? "" : " (kein Epic hinterlegt)"}.</p>
                          ) : (
                            <table className="data" style={{ fontSize: "0.84rem" }}>
                              <thead><tr><th>Ticket</th><th>Titel</th><th className="r">SP</th><th>Status</th><th className="r">Gebucht</th><th>Erledigt</th></tr></thead>
                              <tbody>
                                {[...issues].sort((a, b) => (a.status === b.status ? a.key.localeCompare(b.key) : a.status === "Done" ? 1 : b.status === "Done" ? -1 : a.status === "In Progress" ? -1 : 1)).map((i) => (
                                  <tr key={i.key}>
                                    <td className="mono">{i.key}</td>
                                    <td>{i.summary}</td>
                                    <td className="r num">{i.storyPoints}</td>
                                    <td><span className={`pill ${i.status === "Done" ? "ok" : i.status === "In Progress" ? "risk" : "neutral"}`}>{i.status === "Done" ? "Erledigt" : i.status === "In Progress" ? "In Arbeit" : "Offen"}</span></td>
                                    <td className="r num">{hoursByIssue.get(i.key) ? `${fmt1(hoursByIssue.get(i.key)!)} h` : "–"}</td>
                                    <td className="num">{i.resolvedAt ? i.resolvedAt.split("-").reverse().join(".") : ""}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      {r && !r.retainer && <ScenarioCard report={r} currency={cur} />}
      {r && (
        <section className="card" style={{ display: "flex", flexDirection: "column", minHeight: 320, marginTop: 16 }}>
          <div className="card-head"><h2>Burn-up</h2></div>
          <BurnUpChart report={r} />
        </section>
      )}
    </>
  );
}

type Draft = { kind: "customer" } | { kind: "project"; customerId: string } | { kind: "sub"; projectId: string } | null;

/** The popup for whatever «+ Kunde», «+ Projekt» or «+ Subprojekt» asked for. */
function NewItemDialog({ draft, onClose }: { draft: NonNullable<Draft>; onClose: () => void }) {
  if (draft.kind === "customer") return <CustomerDialog onClose={onClose} />;
  if (draft.kind === "project") return <ProjectDialog customerId={draft.customerId} onClose={onClose} />;
  return <SubProjectDialog projectId={draft.projectId} onClose={onClose} />;
}

const RANK: Record<BudgetStatus, number> = { ok: 0, risk: 1, over: 2 };
const worst = (a: BudgetStatus, b: BudgetStatus) => (RANK[a] >= RANK[b] ? a : b);
const PAGE = 50;

/** Searchable customer list: one row per customer with budget, spend, forecast and the worst project status. */
function CustomerList({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, reports } = useStore();
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [draft, setDraft] = useState<Draft>(null);
  const rows = useMemo(() => {
    const byCustomer = new Map<string, typeof reports>();
    for (const r of reports) {
      const list = byCustomer.get(r.project.customerId) ?? [];
      list.push(r);
      byCustomer.set(r.project.customerId, list);
    }
    return [...data.customers]
      .sort((a, b) => a.name.localeCompare(b.name, "de"))
      .map((c) => {
        const projects = data.projects.filter((p) => p.customerId === c.id);
        const rs = byCustomer.get(c.id) ?? [];
        const budget = projects.reduce((s, p) => s + p.budget, 0);
        const actual = rs.reduce((s, r) => s + r.actualCost, 0);
        const forecast = rs.reduce((s, r) => s + r.forecastCost, 0);
        const status = rs.reduce<BudgetStatus>((s, r) => worst(s, r.status), "ok");
        const haystack = [c.name, ...projects.map((p) => `${p.name} ${p.jiraProjectKey ?? ""}`)].join(" ").toLowerCase();
        return { c, projects, budget, actual, forecast, status, haystack };
      });
  }, [data, reports]);
  const needle = q.trim().toLowerCase();
  const hits = needle ? rows.filter((r) => r.haystack.includes(needle)) : rows;
  const shown = hits.slice(0, limit);
  const attention = rows.filter((r) => r.status !== "ok").length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Kunden & Projekte</h1>
          <p className="sub">{rows.length} Kunden · {data.projects.length} Projekte{attention > 0 ? ` · ${attention} mit knappem oder überschrittenem Budget` : ""}</p>
        </div>
        <button className="btn primary" onClick={() => setDraft({ kind: "customer" })}>+ Kunde</button>
      </div>
      {draft && <NewItemDialog key={JSON.stringify(draft)} draft={draft} onClose={() => setDraft(null)} />}
      <section className="card">
        <div className="card-head" style={{ paddingBottom: 10, flexWrap: "wrap" }}>
          <div className="search">
            <span className="pick-icon"><Icon.search /></span>
            <input id="cust-search" className="input" placeholder="Kunde, Projekt oder JIRA-Schlüssel suchen …" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} />
          </div>
          <span className="muted" style={{ fontSize: "0.82rem" }}>{needle ? `${hits.length} von ${rows.length} Kunden` : "Zeile anklicken für Projekte und Budgets"}</span>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Kunde</th><th className="r">Stundensatz</th><th className="r">Budget</th><th className="r">Verbraucht</th><th>Auslastung</th><th className="r">Forecast</th><th>Status</th></tr>
            </thead>
            <tbody>
              {shown.map(({ c, projects, budget, actual, forecast, status }) => {
                const share = budget > 0 ? Math.min(1, actual / budget) : 0;
                return (
                  <tr key={c.id} className="clickable cust" onClick={() => onOpen(c.id)}>
                    <td>
                      <div className="cust-name">{c.name}</div>
                      <div className="cust-sub">{projects.length === 0 ? "Noch kein Projekt" : projects.length === 1 ? projects[0].name : `${projects.length} Projekte · ${projects.map((p) => p.name).slice(0, 3).join(", ")}${projects.length > 3 ? " …" : ""}`}</div>
                    </td>
                    <td className="r num">{fmtCHF(rateOn(c, data.today))}/h</td>
                    <td className="r num">{budget > 0 ? fmtCHF(budget) : "–"}</td>
                    <td className="r num">{projects.length ? fmtCHF(actual) : "–"}</td>
                    <td>{budget > 0 && <div className={`bar ${status}`} title={`${fmt1(share * 100)} % des Budgets verbraucht`}><span style={{ width: `${share * 100}%` }} /></div>}</td>
                    <td className="r num">{projects.length ? fmtCHF(forecast) : "–"}</td>
                    <td>{projects.length > 0 && budget > 0 && <StatusPill status={status} />}</td>
                  </tr>
                );
              })}
              {shown.length === 0 && <tr><td colSpan={7} className="muted">Kein Kunde passt zu «{q}».</td></tr>}
            </tbody>
          </table>
        </div>
        {hits.length > limit && (
          <div className="card-pad" style={{ paddingTop: 10, textAlign: "center" }}>
            <button className="btn small" onClick={() => setLimit(limit + PAGE)}>Weitere {Math.min(PAGE, hits.length - limit)} Kunden anzeigen</button>
          </div>
        )}
      </section>
    </>
  );
}

/** One customer: rate, figures and the project tree with sub-projects. */
function CustomerDetail({ customer, onBack, onOpenProject }: { customer: Customer; onBack: () => void; onOpenProject: (id: string) => void }) {
  const { data, reports, scope } = useStore();
  const cur = currencyOf(customer);
  const m = (v: number) => fmtMoney(v, cur);
  const [draft, setDraft] = useState<Draft>(null);
  const [editing, setEditing] = useState(false);
  const projects = data.projects.filter((p) => p.customerId === customer.id);
  const projReport = new Map(reports.map((r) => [r.project.id, r]));
  const subReport = new Map(reports.flatMap((r) => r.subs.map((s) => [s.subProject.id, s] as const)));
  const history = [...customer.rates].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  const rs = projects.map((p) => projReport.get(p.id)).filter((r): r is NonNullable<typeof r> => !!r);
  const budget = projects.reduce((s, p) => s + p.budget, 0);
  const actual = rs.reduce((s, r) => s + r.actualCost, 0);
  const forecast = rs.reduce((s, r) => s + r.forecastCost, 0);
  const hours = data.timeEntries.filter((e) => data.subProjects.some((sp) => sp.id === e.subProjectId && projects.some((p) => p.id === sp.projectId))).reduce((s, e) => s + e.hours, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <button className="btn small ghost back-btn" onClick={onBack}><Icon.back />Alle Kunden</button>
          <h1 style={{ marginTop: 8 }}>{customer.name}</h1>
          <p className="sub">
            {m(rateOn(customer, data.today))}/h
            {history.length > 1 && ` · seit ${history.at(-1)!.validFrom.split("-").reverse().join(".")}, vorher ${m(history.at(-2)!.hourlyRate)}/h`}
            {" · "}{projects.length} {projects.length === 1 ? "Projekt" : "Projekte"}
            {cur !== "CHF" && data.fx?.rates[cur] && ` · 1 ${cur} = ${fmt1(data.fx.rates[cur]! * 100) === "100.0" ? "1.00" : data.fx.rates[cur]!.toFixed(4)} CHF`}
          </p>
        </div>
        <div className="toolbar">
          {scope.lead && !scope.readOnly && <button className="btn" id="c-edit" onClick={() => setEditing(true)}>Bearbeiten</button>}
          <button className="btn primary" onClick={() => setDraft({ kind: "project", customerId: customer.id })}>+ Projekt</button>
        </div>
      </div>
      {draft && <NewItemDialog key={JSON.stringify(draft)} draft={draft} onClose={() => setDraft(null)} />}
      {editing && <CustomerDialog customer={customer} onClose={() => setEditing(false)} />}
      <div className="tiles">
        <div className="card tile"><span className="label">Budget</span><span className="value num">{m(budget)}</span></div>
        <div className="card tile"><span className="label">Verbraucht</span><span className="value num">{m(actual)}</span><span className="delta num">{budget > 0 ? `${fmt1((actual / budget) * 100)} % des Budgets` : `${fmt1(hours)} h gebucht`}</span></div>
        <div className="card tile"><span className="label">Forecast</span><span className="value num">{m(forecast)}</span><span className="delta">Abweichung <Money v={budget - forecast} signed currency={cur} /></span></div>
        <div className="card tile"><span className="label">Gebucht</span><span className="value num">{fmt1(hours)} h</span><span className="delta">über alle Projekte</span></div>
      </div>
      <section className="card">
        {projects.length === 0 && <p className="muted card-pad">Noch kein Projekt. Mit «+ Projekt» anlegen.</p>}
        {projects.map((p) => {
          const r = projReport.get(p.id);
          const subs = data.subProjects.filter((s) => s.projectId === p.id);
          const allocated = subs.reduce((s, x) => s + x.budget, 0);
          return (
            <div className="tree-customer" key={p.id}>
              <div className="tree-row">
                <div>
                  <button className="link-btn" onClick={() => onOpenProject(p.id)}><h2 style={{ margin: 0, color: "inherit" }}>{p.name}</h2></button> {p.jiraProjectKey && <span className="pill neutral mono">{p.jiraProjectKey}</span>} {(p.kind ?? "tm") !== "tm" && <span className="pill neutral">{kindLabel(p.kind)}</span>}
                  <div className="muted num" style={{ fontSize: "0.8rem" }}>
                    {r?.retainer
                      ? `Kontingent ${fmtNum(r.retainer.hoursPerMonth)} h/Monat · ${fmtMonth(r.retainer.month)} ${fmt1(r.retainer.used)} h genutzt · Schnitt ${fmt1(r.retainer.avg3)} h`
                      : `${p.kind === "fixed" ? "Fixpreis" : "Budget"} ${m(p.budget)} · davon verteilt ${m(allocated)} · Reserve ${m(p.budget - allocated)}`}
                    {r && !r.retainer && ` · verbraucht ${m(r.actualCost)} · Forecast ${m(r.forecastCost)}`}
                  </div>
                </div>
                <div className="toolbar">
                  {r && <StatusPill status={r.status} />}
                  <button className="btn small ghost" onClick={() => setDraft({ kind: "sub", projectId: p.id })}>+ Subprojekt</button>
                  <button className="btn small" onClick={() => onOpenProject(p.id)}>Öffnen</button>
                </div>
              </div>
              <div className="tree-project">
                {subs.map((s) => {
                  const sr = subReport.get(s.id);
                  return (
                    <div className="tree-sub clickable" key={s.id} onClick={() => onOpenProject(p.id)}>
                      <span>{s.name} {s.jiraEpicKey && <span className="mono muted">{s.jiraEpicKey}</span>}</span>
                      <span className="num">
                        {m(s.budget)}{sr ? ` · ${m(sr.actualCost)} verbraucht · ${sr.spOpen} SP offen` : ""}
                      </span>
                    </div>
                  );
                })}
                {subs.length === 0 && <span className="muted" style={{ fontSize: "0.85rem" }}>Noch kein Subprojekt.</span>}
              </div>
            </div>
          );
        })}
      </section>
      {scope.lead && <PortalAccess customer={customer} />}
    </>
  );
}

/** Portal accounts of a customer: who can sign in to the customer portal, invite and revoke. */
function PortalAccess({ customer }: { customer: Customer }) {
  const customerId = customer.id;
  const { portalAccounts, revokePortal, notify } = useStore();
  const [accounts, setAccounts] = useState<PortalAccount[] | null>(null);
  const [open, setOpen] = useState(false);
  const reload = () => portalAccounts(customerId).then(setAccounts).catch(() => setAccounts([]));
  useEffect(() => { void reload(); }, [customerId]); // eslint-disable-line react-hooks/exhaustive-deps
  const revoke = async (a: PortalAccount) => {
    if (!confirm(`Zugang von ${a.name} zum Kundenportal entziehen?`)) return;
    await revokePortal(customerId, a.id);
    notify("Zugang entzogen");
    await reload();
  };
  return (
    <section className="card" style={{ marginTop: 16 }} id="portal-access">
      <div className="card-head">
        <h2><Icon.users /> Kundenportal</h2>
        <button className="btn small" id="portal-invite" onClick={() => setOpen(true)}>+ Zugang</button>
      </div>
      <div className="card-pad" style={{ paddingTop: 10 }}>
        {open && <PortalInviteDialog customer={customer} onClose={() => setOpen(false)} onInvited={() => void reload()} />}
        {accounts === null && <p className="muted">Lade …</p>}
        {accounts?.length === 0 && !open && <p className="muted" style={{ margin: 0 }}>Noch niemand hat Zugang zum Portal. Mit «+ Zugang» eine Kontaktperson einladen.</p>}
        {accounts && accounts.length > 0 && (
          <ul className="portal-list">
            {accounts.map((a) => (
              <li key={a.id}>
                <span className="who small">{a.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("")}</span>
                <span><strong>{a.name}</strong><br /><span className="muted" style={{ fontSize: "0.8rem" }}>{a.email}{a.hasPassword ? (a.lastLoginAt ? ` · zuletzt ${fmtDate(a.lastLoginAt.slice(0, 10))}` : " · noch nie angemeldet") : " · Einladung offen"}</span></span>
                <button className="btn small ghost" onClick={() => void revoke(a)} title="Zugang entziehen" aria-label="Zugang entziehen"><Icon.trash /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** "#projekte/c/<id>" opens a customer, "#projekte/p/<id>" a project (used by the command palette). */
function viewFromHash(): View {
  const [, kind, id] = location.hash.replace("#", "").split("/");
  if (kind === "c" && id) return { kind: "customer", id };
  if (kind === "p" && id) return { kind: "project", id };
  return { kind: "list" };
}

type View = { kind: "list" } | { kind: "customer"; id: string } | { kind: "project"; id: string; from?: string };

export function Projects() {
  const { data } = useStore();
  const [view, setView] = useState<View>(() => viewFromHash());
  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (view.kind === "project" && data.projects.some((p) => p.id === view.id)) {
    return <ProjectDetail projectId={view.id} onBack={() => setView(view.from ? { kind: "customer", id: view.from } : { kind: "list" })} />;
  }
  const customer = view.kind === "customer" ? data.customers.find((c) => c.id === view.id) : undefined;
  if (customer) return <CustomerDetail customer={customer} onBack={() => setView({ kind: "list" })} onOpenProject={(id) => setView({ kind: "project", id, from: customer.id })} />;
  return <CustomerList onOpen={(id) => setView({ kind: "customer", id })} />;
}
