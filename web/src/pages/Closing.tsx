import { useEffect, useState } from "react";
import { addMonths, fmt1, fmtCHF2, fmtDate, fmtMonthLong, isoWeekKey, monthOf, weekRange, workBalance } from "@taktwerk/domain";
import type { WeekOverviewRow } from "../api";
import { useStore, type ClosingStatus } from "../store";
import { Icon } from "../ui/components";
import { signedH } from "./WorkTime";
import { Select } from "../ui/Select";

/** Expenses of employees waiting for a lead's decision. */
function OpenExpenses() {
  const { data, decideExpense, notify, mode } = useStore();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const open = data.expenses.filter((x) => x.status === "requested").sort((a, b) => a.date.localeCompare(b.date));
  const emp = new Map(data.employees.map((e) => [e.id, e]));
  const sub = new Map(data.subProjects.map((s) => [s.id, s]));
  const proj = new Map(data.projects.map((p) => [p.id, p]));
  const cust = new Map(data.customers.map((c) => [c.id, c]));
  const label = (subId: string) => {
    const s = sub.get(subId);
    const p = s && proj.get(s.projectId);
    return p ? `${cust.get(p.customerId)?.name} · ${s.name}` : "–";
  };
  const decide = async (id: string, approve: boolean) => {
    try {
      await decideExpense(id, approve, approve ? undefined : comment.trim());
      setError("");
      setRejecting(null);
      setComment("");
      notify(approve ? "Spese bewilligt" : "Spese abgelehnt");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div className="card-head" style={{ paddingBottom: 8 }}>
        <h2>Offene Spesen</h2>
        <span className="muted" style={{ fontSize: "0.8rem" }}>{open.length === 0 ? "Nichts zu bewilligen" : `${open.length} warten auf Bewilligung · ${fmtCHF2(open.reduce((s, x) => s + x.amount, 0))}`}</span>
      </div>
      {open.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Person</th><th>Datum</th><th>Spese</th><th>Subprojekt</th><th className="r">Betrag</th><th>Beleg</th><th className="r">Entscheid</th></tr>
            </thead>
            <tbody>
              {open.map((x) => (
                <tr key={x.id}>
                  <td>{emp.get(x.employeeId)?.name}</td>
                  <td className="num">{fmtDate(x.date)}</td>
                  <td>
                    {x.category}: {x.reason}
                    <div className="muted" style={{ fontSize: "0.76rem" }}>{x.km ? `${x.km} km · ` : ""}{x.vatRate ? `inkl. ${fmt1(x.vatRate)} % MwSt` : "ohne MwSt"}{x.billable ? "" : " · nicht verrechenbar"}</div>
                  </td>
                  <td>{label(x.subProjectId)}</td>
                  <td className="r num">{fmtCHF2(x.amount)}</td>
                  <td>
                    {x.receipt ? (
                      mode === "api"
                        ? <a className="receipt-link" href={`/api/expenses/${x.id}/receipt`} target="_blank" rel="noreferrer" title={x.receipt.name}><Icon.report />öffnen</a>
                        : <span className="receipt-link" title={x.receipt.name}><Icon.report />{x.receipt.name}</span>
                    ) : <span className="muted">fehlt</span>}
                  </td>
                  <td>
                    {rejecting === x.id ? (
                      <div className="closing-actions" style={{ flexWrap: "wrap" }}>
                        <input className="input" style={{ minWidth: 180 }} placeholder="Begründung (optional)" value={comment} autoFocus onChange={(e) => setComment(e.target.value)} />
                        <button className="btn small primary" onClick={() => decide(x.id, false)}>Ablehnen</button>
                        <button className="btn small ghost" onClick={() => setRejecting(null)}>Zurück</button>
                      </div>
                    ) : (
                      <div className="closing-actions">
                        <button className="btn small primary" onClick={() => decide(x.id, true)}>Bewilligen</button>
                        <button className="btn small ghost" onClick={() => { setRejecting(x.id); setComment(""); }}>Ablehnen</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && <p className="error card-pad" style={{ paddingTop: 0 }}>{error}</p>}
    </section>
  );
}

const STATUS: Record<ClosingStatus, { label: string; cls: string }> = {
  open: { label: "Offen", cls: "neutral" },
  submitted: { label: "Eingereicht", cls: "risk" },
  approved: { label: "Freigegeben", cls: "ok" },
};

function Status({ s }: { s: ClosingStatus }) {
  return <span className={`pill ${STATUS[s].cls}`}>{STATUS[s].label}</span>;
}

/** Leads: who has submitted which of the last weeks, and where hours are missing. */
function TeamWeeks() {
  const { data, weekOverview, weeks } = useStore();
  const [rows, setRows] = useState<WeekOverviewRow[] | null>(null);
  const to = isoWeekKey(data.today);
  const fromDate = new Date(data.today);
  fromDate.setDate(fromDate.getDate() - 7 * 5);
  const from = isoWeekKey(fromDate.toISOString().slice(0, 10));
  useEffect(() => {
    weekOverview(from, to).then(setRows).catch(() => setRows([]));
  }, [from, to, weeks]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows || rows.length === 0) return null;
  const keys = rows[0].weeks.map((w) => w.week);
  const label = (k: string) => {
    const { from: f } = weekRange(k);
    return `KW ${Number(k.split("-W")[1])} · ${fmtDate(f).slice(0, 5)}`;
  };
  const missing = rows.reduce((n, r) => n + r.weeks.filter((w) => w.week !== to && !w.submitted && w.due > 0).length, 0);
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div className="card-head" style={{ paddingBottom: 8, flexWrap: "wrap", gap: 12 }}>
        <h2>Wochen im Team</h2>
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          {missing === 0 ? "Alle vergangenen Wochen sind eingereicht" : `${missing} ${missing === 1 ? "Woche fehlt" : "Wochen fehlen"} noch`}
        </span>
      </div>
      <div className="table-wrap">
        <table className="data wk">
          <thead>
            <tr>
              <th>Person</th>
              {keys.map((k) => <th key={k} className={`r ${k === to ? "wk-now" : ""}`}>{label(k)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.userId}>
                <td>{r.name}</td>
                {r.weeks.map((w) => {
                  const gap = Math.round((w.due - w.worked) * 10) / 10;
                  const kind = w.due <= 0 && w.worked === 0 ? "none" : w.submitted ? (gap > 1 ? "short" : "ok") : w.week === to ? "now" : gap > 1 ? "missing" : "open";
                  const title = w.submitted ? `Eingereicht · ${fmt1(w.worked)} h von ${fmt1(w.due)} h` : `Nicht eingereicht · ${fmt1(w.worked)} h von ${fmt1(w.due)} h`;
                  return (
                    <td key={w.week} className={`r wk-cell wk-${kind} ${w.week === to ? "wk-now" : ""}`} title={title}>
                      {kind === "none" && "–"}
                      {kind === "ok" && "✓"}
                      {kind === "short" && <>✓ <small>−{fmt1(gap)} h</small></>}
                      {kind === "missing" && <>fehlen {fmt1(gap)} h</>}
                      {kind === "open" && "offen"}
                      {kind === "now" && <small>{fmt1(w.worked)} h</small>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Closing() {
  const { data, closings, closeMonth, approveSubmitted, remindClosing, role, currentUserId, notify, mode, scope } = useStore();
  const current = monthOf(data.today);
  const months = [0, 1, 2, 3, 4, 5].map((n) => addMonths(current, -n));
  const [month, setMonth] = useState(addMonths(current, -1));
  const [error, setError] = useState("");
  const lead = scope.managesPeople;

  const statusOf = (userId: string, m: string): ClosingStatus => closings.find((c) => c.userId === userId && c.month === m)?.status ?? "open";
  const balances = new Map(data.employees.filter((e) => e.workload !== undefined || e.id === currentUserId).map((e) => [e.id, workBalance(data, e.id)]));
  const figures = (userId: string, m: string) => {
    const wb = balances.get(userId)?.months.find((x) => x.month === m);
    const entries = data.timeEntries.filter((e) => e.employeeId === userId && e.date.startsWith(m));
    return {
      hours: entries.reduce((s, e) => s + e.hours, 0),
      billable: entries.filter((e) => e.billable).reduce((s, e) => s + e.hours, 0),
      expenses: data.expenses.filter((x) => x.employeeId === userId && x.date.startsWith(m) && (x.status ?? "approved") !== "rejected").reduce((s, x) => s + x.amount, 0),
      count: entries.length,
      due: wb ? wb.target - wb.absence : null,
      balance: wb ? wb.balance : null,
    };
  };
  const act = async (action: "submit" | "approve" | "reopen", m: string, userId: string, msg: string) => {
    try {
      await closeMonth(action, m, userId);
      setError("");
      notify(msg);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const ORDER: Record<ClosingStatus, number> = { submitted: 0, open: 1, approved: 2 };
  const people = [...data.employees].sort((a, b) => ORDER[statusOf(a.id, month)] - ORDER[statusOf(b.id, month)] || a.name.localeCompare(b.name));
  const counts = { open: 0, submitted: 0, approved: 0 };
  for (const p of people) counts[statusOf(p.id, month)]++;
  const approveAll = async () => {
    try {
      const n = await approveSubmitted(month);
      notify(n === 0 ? "Nichts zum Freigeben" : `${n} ${n === 1 ? "Monat" : "Monate"} freigegeben`);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remind = async (p: { id: string; name: string }) => {
    try {
      await remindClosing(month, p.id);
      notify(mode === "api" ? `${p.name} erinnert` : `${p.name} würde jetzt eine Erinnerung erhalten (Demo)`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Monatsabschluss</h1>
          <p className="sub">
            Mitarbeitende reichen ihren Monat ein, Consultants oder Admins geben ihn frei. Danach sind die Buchungen gesperrt und erscheinen so im Kundenreport.
          </p>
        </div>
      </div>
      {error && <p className="notice error" style={{ marginBottom: 12 }}>{error}</p>}

      <section className="card">
        <div className="card-head" style={{ paddingBottom: 8 }}><h2>Meine Monate</h2></div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Monat</th><th className="r">Soll</th><th className="r">Ist</th><th className="r">Saldo</th><th className="r">Verrechenbar</th><th className="r">Spesen</th><th>Status</th><th className="r">Aktion</th></tr>
            </thead>
            <tbody>
              {months.map((m) => {
                const f = figures(currentUserId, m);
                const s = statusOf(currentUserId, m);
                const running = m === current;
                return (
                  <tr key={m}>
                    <td>{fmtMonthLong(m)}{running && <span className="muted"> · läuft</span>}</td>
                    <td className="r num">{f.due === null ? "–" : `${fmt1(f.due)} h`}</td>
                    <td className="r num">{fmt1(f.hours)} h</td>
                    <td className={`r num ${(f.balance ?? 0) < 0 ? "neg" : ""}`}>{f.balance === null ? "–" : signedH(f.balance)}</td>
                    <td className="r num">{fmt1(f.billable)} h</td>
                    <td className="r num">{fmtCHF2(f.expenses)}</td>
                    <td><Status s={s} /></td>
                    <td className="r">
                      {s === "open" && (
                        <button
                          className="btn small primary"
                          disabled={running}
                          title={running ? "Der laufende Monat kann erst nach Monatsende eingereicht werden." : undefined}
                          onClick={() => act("submit", m, currentUserId, `${fmtMonthLong(m)} eingereicht`)}
                        >
                          Einreichen
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {lead && <TeamWeeks />}

      {lead && <OpenExpenses />}

      {lead && (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="card-head" style={{ paddingBottom: 8, flexWrap: "wrap", gap: 12 }}>
            <h2>Team · {fmtMonthLong(month)}</h2>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <span className="muted" style={{ fontSize: "0.8rem" }}>
                {counts.approved} freigegeben · {counts.submitted} eingereicht · {counts.open} offen
              </span>
              {counts.submitted > 0 && <button id="c-approve-all" className="btn small" onClick={approveAll}>Alle {counts.submitted} eingereichten freigeben</button>}
              <Select id="c-month" small ariaLabel="Monat" value={month} onChange={setMonth} options={months.map((m) => ({ value: m, label: fmtMonthLong(m) }))} />
            </div>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Person</th><th className="r">Buchungen</th><th className="r">Soll</th><th className="r">Ist</th><th className="r">Saldo</th><th className="r">Verrechenbar</th><th className="r">Spesen</th><th>Status</th><th className="r">Aktion</th></tr>
              </thead>
              <tbody>
                {people.map((p) => {
                  const f = figures(p.id, month);
                  const s = statusOf(p.id, month);
                  return (
                    <tr key={p.id}>
                      <td>
                        {p.name}
                        {s !== "approved" && f.due !== null && f.due - f.hours > 2 && <div className="muted" style={{ fontSize: "0.74rem" }}>fehlen {fmt1(f.due - f.hours)} h</div>}
                      </td>
                      <td className="r num">{f.count}</td>
                      <td className="r num">{f.due === null ? "–" : `${fmt1(f.due)} h`}</td>
                      <td className="r num">{fmt1(f.hours)} h</td>
                      <td className={`r num ${(f.balance ?? 0) < 0 ? "neg" : ""}`}>{f.balance === null ? "–" : signedH(f.balance)}</td>
                      <td className="r num">{fmt1(f.billable)} h</td>
                      <td className="r num">{fmtCHF2(f.expenses)}</td>
                      <td><Status s={s} /></td>
                      <td>
                        <div className="closing-actions">
                          {s !== "approved" && (
                            <button className="btn small primary" onClick={() => act("approve", month, p.id, `${p.name}: ${fmtMonthLong(month)} freigegeben`)}>Freigeben</button>
                          )}
                          {s === "submitted" && (
                            <button className="btn small ghost" onClick={() => act("reopen", month, p.id, `${p.name}: zur Korrektur zurückgegeben`)}>Zurückweisen</button>
                          )}
                          {s === "open" && month !== current && (
                            <button className="btn small ghost" title="Per E-Mail an den Monatsabschluss erinnern" onClick={() => remind(p)}>Erinnern</button>
                          )}
                          {s === "approved" && role === "admin" && (
                            <button className="btn small ghost" onClick={() => act("reopen", month, p.id, `${p.name}: ${fmtMonthLong(month)} wieder geöffnet`)}>Wieder öffnen</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
