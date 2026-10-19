// Resource planning: people × coming weeks with capacity, planned and booked hours; projects × weeks against the
// remaining budget; bottlenecks are listed on top so a lead sees them weeks before they happen.
import { useMemo, useState } from "react";
import { allocationsOf, capacityPlan, fmt1, fmtDate, planningWeeks, weekLabel, weekRange, type Bottleneck, type LoadStatus, type PlanCell } from "@taktwerk/domain";
import { useStore } from "../store";
import { Icon } from "../ui/components";
import { Select } from "../ui/Select";

const WEEKS = 12;
const STATUS_TITLE: Record<LoadStatus, string> = { idle: "Noch Luft", ok: "Gut ausgelastet", tight: "Knapp", over: "Überplant", none: "Keine Kapazität" };

const h = (v: number) => fmt1(v).replace(/[.,]0$/, "");

function BottleneckStrip({ items, onPick }: { items: Bottleneck[]; onPick: (b: Bottleneck) => void }) {
  if (items.length === 0) return <p className="plan-calm">Keine Engpässe in den nächsten {WEEKS} Wochen.</p>;
  return (
    <div className="plan-warnings" id="plan-warnings">
      {items.slice(0, 8).map((b) => (
        <button key={`${b.kind}-${b.id}-${b.week}`} className={`plan-warning ${b.inWeeks !== null && b.inWeeks <= 4 ? "soon" : ""}`} onClick={() => onPick(b)}>
          <strong>{b.kind === "person" ? `${weekLabel(b.week!)} · ${b.name}` : b.name}</strong>
          <span>
            {b.kind === "person"
              ? `${h(b.planned)} h geplant bei ${h(b.limit)} h Kapazität (+${h(b.planned - b.limit)} h)`
              : `${h(b.planned)} h geplant, Restbudget reicht für ${h(b.limit)} h`}
          </span>
          <small>{b.inWeeks === null ? "Projekt überplant" : b.inWeeks === 0 ? "diese Woche" : b.inWeeks === 1 ? "nächste Woche" : `in ${b.inWeeks} Wochen`}</small>
        </button>
      ))}
    </div>
  );
}

function CellBar({ c }: { c: PlanCell }) {
  const pct = c.capacity > 0 ? Math.min(100, (c.planned / c.capacity) * 100) : c.planned > 0 ? 100 : 0;
  return (
    <span className={`plan-cell ${c.status}`} title={`${STATUS_TITLE[c.status]} · ${h(c.planned)} h geplant, ${h(c.capacity)} h Kapazität${c.booked ? `, ${h(c.booked)} h gebucht` : ""}`}>
      <span className="plan-nums"><b>{h(c.planned)}</b><small>/{h(c.capacity)}</small></span>
      <span className="plan-bar"><span style={{ width: `${pct}%` }} /></span>
    </span>
  );
}

/** Editor for one person and week: hours per project, saved on change. */
function CellEditor({ employeeId, week, onClose }: { employeeId: string; week: string; onClose: () => void }) {
  const { data, setAllocation, notify } = useStore();
  const person = data.employees.find((e) => e.id === employeeId);
  const rows = allocationsOf(data, employeeId, week);
  const [adding, setAdding] = useState("");
  const projectName = (id: string) => {
    const p = data.projects.find((x) => x.id === id);
    const c = data.customers.find((x) => x.id === p?.customerId);
    return p ? `${p.name}${c ? ` · ${c.name}` : ""}` : "?";
  };
  const free = data.projects.filter((p) => !rows.some((a) => a.projectId === p.id)).sort((a, b) => projectName(a.id).localeCompare(projectName(b.id), "de"));
  const { from, to } = weekRange(week);
  const save = async (projectId: string, hours: number) => {
    await setAllocation(employeeId, projectId, week, hours);
    if (hours === 0) notify("Reservation entfernt");
  };
  const total = rows.reduce((s, a) => s + a.hours, 0);
  return (
    <section className="card plan-editor" id="plan-editor">
      <div className="card-head">
        <h2>{person?.name} · {weekLabel(week)} <span className="muted" style={{ fontWeight: 400 }}>({fmtDate(from).slice(0, 5)} – {fmtDate(to).slice(0, 5)})</span></h2>
        <button className="btn small ghost" onClick={onClose} aria-label="Schliessen"><Icon.close /></button>
      </div>
      <div className="card-pad plan-editor-rows">
        {rows.length === 0 && <p className="muted">Noch nichts geplant. Projekt wählen und Stunden eintragen.</p>}
        {rows.map((a) => (
          <div className="plan-editor-row" key={a.id}>
            <span>{projectName(a.projectId)}</span>
            <input id={`al-${a.projectId}`} type="number" step={0.5} min={0} max={100} defaultValue={a.hours} onBlur={(e) => { const v = Number(e.target.value); if (v !== a.hours) void save(a.projectId, v); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
            <span className="muted">h</span>
            <button className="btn small ghost" onClick={() => void save(a.projectId, 0)} title="Entfernen" aria-label="Entfernen"><Icon.trash /></button>
          </div>
        ))}
        <div className="plan-editor-add">
          <Select id="al-project" ariaLabel="Projekt hinzufügen" placeholder="Projekt hinzufügen …" value={adding} onChange={(v) => { setAdding(""); if (v) void save(v, 8).then(() => notify("8 h reserviert, Stunden anpassen")); }} options={free.map((p) => ({ value: p.id, label: projectName(p.id) }))} small />
          <span className="muted num">Total {h(total)} h</span>
        </div>
      </div>
    </section>
  );
}

export function Planning() {
  const { data, reports, role } = useStore();
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<"people" | "projects">("people");
  const [pick, setPick] = useState<{ employeeId: string; week: string } | null>(null);
  const weeks = useMemo(() => planningWeeks(data.today, WEEKS, offset), [data.today, offset]);
  const people = useMemo(() => data.employees.filter((e) => e.role !== "customer"), [data.employees]);
  const plan = useMemo(() => capacityPlan(data, weeks, reports, people), [data, weeks, reports, people]);
  const thisWeek = planningWeeks(data.today, 1)[0];
  const lead = role !== "employee";
  const head = (k: string) => {
    const { from } = weekRange(k);
    return <th key={k} className={`r ${k === thisWeek ? "wk-now" : ""}`}>{weekLabel(k)}<small>{fmtDate(from).slice(0, 5)}</small></th>;
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Ressourcenplanung</h1>
          <p className="sub">Geplante Stunden pro Person und Woche gegen die Kapazität nach Pensum, Ferien und Feiertagen.</p>
        </div>
        <div className="toolbar">
          <div className="seg" role="radiogroup" aria-label="Ansicht">
            <button id="plan-people" role="radio" aria-checked={view === "people"} className={view === "people" ? "on" : ""} onClick={() => setView("people")}>Personen</button>
            <button id="plan-projects" role="radio" aria-checked={view === "projects"} className={view === "projects" ? "on" : ""} onClick={() => setView("projects")}>Projekte</button>
          </div>
          <button className="btn small" onClick={() => setOffset((o) => o - 4)} aria-label="4 Wochen zurück">‹</button>
          <button className="btn small" onClick={() => setOffset(0)} disabled={offset === 0}>Heute</button>
          <button className="btn small" onClick={() => setOffset((o) => o + 4)} aria-label="4 Wochen vor">›</button>
        </div>
      </div>

      <BottleneckStrip items={plan.bottlenecks} onPick={(b) => { if (b.kind === "person") { setView("people"); setPick({ employeeId: b.id, week: b.week! }); } else setView("projects"); }} />

      {pick && lead && <CellEditor key={`${pick.employeeId}-${pick.week}`} employeeId={pick.employeeId} week={pick.week} onClose={() => setPick(null)} />}

      {view === "people" && (
        <section className="card">
          <div className="table-wrap">
            <table className="data plan" id="plan-grid">
              <thead><tr><th>Person</th>{weeks.map(head)}<th className="r">Total</th></tr></thead>
              <tbody>
                {plan.people.map((r) => (
                  <tr key={r.employeeId}>
                    <td>{r.name}</td>
                    {r.cells.map((c) => (
                      <td key={c.week} className={`r ${c.week === thisWeek ? "wk-now" : ""} ${pick?.employeeId === r.employeeId && pick.week === c.week ? "picked" : ""}`}>
                        {lead ? <button className="plan-cell-btn" id={`cell-${r.employeeId}-${c.week}`} onClick={() => setPick({ employeeId: r.employeeId, week: c.week })}><CellBar c={c} /></button> : <CellBar c={c} />}
                      </td>
                    ))}
                    <td className="r num"><b>{h(r.plannedTotal)}</b> <small className="muted">/ {h(r.capacityTotal)} h</small></td>
                  </tr>
                ))}
                <tr className="group">
                  <td>Team</td>
                  {plan.team.map((t) => (
                    <td key={t.week} className={`r num ${t.week === thisWeek ? "wk-now" : ""} ${t.planned > t.capacity ? "wk-missing" : ""}`}>{h(t.planned)} <small className="muted">/ {h(t.capacity)}</small></td>
                  ))}
                  <td className="r num">{h(plan.team.reduce((s, t) => s + t.planned, 0))} <small className="muted">/ {h(plan.team.reduce((s, t) => s + t.capacity, 0))} h</small></td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="plan-legend">
            <span className="plan-dot idle" /> unter 50 % <span className="plan-dot ok" /> 50–90 % <span className="plan-dot tight" /> über 90 % <span className="plan-dot over" /> überplant
            {lead && <span className="muted"> · Zelle anklicken, um Stunden pro Projekt zu reservieren</span>}
          </p>
        </section>
      )}

      {view === "projects" && (
        <section className="card">
          {plan.projects.length === 0 && <p className="muted card-pad">In diesem Zeitraum ist noch kein Projekt eingeplant.</p>}
          {plan.projects.length > 0 && (
            <div className="table-wrap">
              <table className="data plan" id="plan-projects-grid">
                <thead><tr><th>Projekt</th>{weeks.map(head)}<th className="r">Geplant</th><th className="r">Restbudget</th></tr></thead>
                <tbody>
                  {plan.projects.map((p) => (
                    <tr key={p.projectId} className={p.overPlanned ? "plan-over" : ""}>
                      <td><a href={`#projekte/p/${p.projectId}`}>{p.name}</a><div className="muted" style={{ fontSize: "0.78rem" }}>{p.customerName}</div></td>
                      {p.cells.map((c) => <td key={c.week} className={`r num ${c.week === thisWeek ? "wk-now" : ""}`}>{c.planned ? h(c.planned) : <span className="muted">–</span>}</td>)}
                      <td className="r num"><b>{h(p.plannedTotal)} h</b></td>
                      <td className="r num">{p.remainingHours === null ? <span className="muted">–</span> : <span className={p.overPlanned ? "wk-missing" : ""}>{h(p.remainingHours)} h</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="plan-legend muted">Restbudget in Stunden zum aktuellen Stundensatz; Retainer und Projekte ohne Budget zeigen keinen Wert.</p>
        </section>
      )}
    </>
  );
}
