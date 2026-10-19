import { useState } from "react";
import { addMonths, fmt1, fmtCHF2, fmtDate, fmtMonthLong, monthOf, workBalance } from "@taktwerk/domain";
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

export function Closing() {
  const { data, closings, closeMonth, role, currentUserId, notify } = useStore();
  const current = monthOf(data.today);
  const months = [0, 1, 2, 3, 4, 5].map((n) => addMonths(current, -n));
  const [month, setMonth] = useState(addMonths(current, -1));
  const [error, setError] = useState("");
  const lead = role !== "employee";

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

  const people = data.employees;
  const counts = { open: 0, submitted: 0, approved: 0 };
  for (const p of people) counts[statusOf(p.id, month)]++;

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

      {lead && <OpenExpenses />}

      {lead && (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="card-head" style={{ paddingBottom: 8, flexWrap: "wrap", gap: 12 }}>
            <h2>Team · {fmtMonthLong(month)}</h2>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <span className="muted" style={{ fontSize: "0.8rem" }}>
                {counts.approved} freigegeben · {counts.submitted} eingereicht · {counts.open} offen
              </span>
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
                      <td>{p.name}</td>
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
