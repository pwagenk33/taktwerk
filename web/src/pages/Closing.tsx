import { useEffect, useState } from "react";
import { PAYROLL_ITEMS, addMonths, fmt1, fmtCHF2, fmtDate, fmtMonthLong, isoWeekKey, monthOf, payrollAbacus, payrollRows, payrollTable, toCsv, weekRange, workBalance, type PayrollCodes } from "@taktwerk/domain";
import { api, type Settings as OrgSettings, type WeekOverviewRow } from "../api";
import { Field, FormDialog } from "../ui/Dialog";
import { useStore, type ClosingStatus } from "../store";
import { Icon } from "../ui/components";
import { signedH } from "./WorkTime";
import { Select } from "../ui/Select";
import { tr, trn } from "../i18n";

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
      notify(approve ? tr("Spese bewilligt") : tr("Spese abgelehnt"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div className="card-head" style={{ paddingBottom: 8 }}>
        <h2>{tr("Offene Spesen")}</h2>
        <span className="muted" style={{ fontSize: "0.8rem" }}>{open.length === 0 ? tr("Nichts zu bewilligen") : tr("{0} warten auf Bewilligung · {1}", open.length, fmtCHF2(open.reduce((s, x) => s + x.amount, 0)))}</span>
      </div>
      {open.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>{tr("Person")}</th><th>{tr("Datum")}</th><th>{tr("Spese")}</th><th>{tr("Subprojekt")}</th><th className="r">{tr("Betrag")}</th><th>{tr("Beleg")}</th><th className="r">{tr("Entscheid")}</th></tr>
            </thead>
            <tbody>
              {open.map((x) => (
                <tr key={x.id}>
                  <td>{emp.get(x.employeeId)?.name}</td>
                  <td className="num">{fmtDate(x.date)}</td>
                  <td>
                    {tr(x.category)}: {x.reason}
                    <div className="muted" style={{ fontSize: "0.76rem" }}>{x.km ? `${x.km} km · ` : ""}{x.vatRate ? tr("inkl. {0} % MwSt", fmt1(x.vatRate)) : tr("ohne MwSt")}{x.billable ? "" : tr(" · nicht verrechenbar")}</div>
                  </td>
                  <td>{label(x.subProjectId)}</td>
                  <td className="r num">{fmtCHF2(x.amount)}</td>
                  <td>
                    {x.receipt ? (
                      mode === "api"
                        ? <a className="receipt-link" href={`/api/expenses/${x.id}/receipt`} target="_blank" rel="noreferrer" title={x.receipt.name}><Icon.report />{tr("öffnen")}</a>
                        : <span className="receipt-link" title={x.receipt.name}><Icon.report />{x.receipt.name}</span>
                    ) : <span className="muted">{tr("fehlt")}</span>}
                  </td>
                  <td>
                    {rejecting === x.id ? (
                      <div className="closing-actions" style={{ flexWrap: "wrap" }}>
                        <input className="input" style={{ minWidth: 180 }} placeholder={tr("Begründung (optional)")} value={comment} autoFocus onChange={(e) => setComment(e.target.value)} />
                        <button className="btn small primary" onClick={() => decide(x.id, false)}>{tr("Ablehnen")}</button>
                        <button className="btn small ghost" onClick={() => setRejecting(null)}>{tr("Zurück")}</button>
                      </div>
                    ) : (
                      <div className="closing-actions">
                        <button className="btn small primary" onClick={() => decide(x.id, true)}>{tr("Bewilligen")}</button>
                        <button className="btn small ghost" onClick={() => { setRejecting(x.id); setComment(""); }}>{tr("Ablehnen")}</button>
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
  open: { label: tr("Offen"), cls: "neutral" },
  submitted: { label: tr("Eingereicht"), cls: "risk" },
  approved: { label: tr("Freigegeben"), cls: "ok" },
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
        <h2>{tr("Wochen im Team")}</h2>
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          {missing === 0 ? tr("Alle vergangenen Wochen sind eingereicht") : trn(missing, "{0} Woche fehlt noch", "{0} Wochen fehlen noch")}
        </span>
      </div>
      <div className="table-wrap">
        <table className="data wk">
          <thead>
            <tr>
              <th>{tr("Person")}</th>
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
                  const title = w.submitted ? tr("Eingereicht · {0} h von {1} h", fmt1(w.worked), fmt1(w.due)) : tr("Nicht eingereicht · {0} h von {1} h", fmt1(w.worked), fmt1(w.due));
                  return (
                    <td key={w.week} className={`r wk-cell wk-${kind} ${w.week === to ? "wk-now" : ""}`} title={title}>
                      {kind === "none" && "–"}
                      {kind === "ok" && "✓"}
                      {kind === "short" && <>✓ <small>{tr("−{0} h", fmt1(gap))}</small></>}
                      {kind === "missing" && <>{tr("fehlen {0} h", fmt1(gap))}</>}
                      {kind === "open" && tr("offen")}
                      {kind === "now" && <small>{fmt1(w.worked)}{" "}{tr("h")}</small>}
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
      notify(n === 0 ? tr("Nichts zum Freigeben") : trn(n, "{0} Monat freigegeben", "{0} Monate freigegeben"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remind = async (p: { id: string; name: string }) => {
    try {
      await remindClosing(month, p.id);
      notify(mode === "api" ? tr("{0} erinnert", p.name) : tr("{0} würde jetzt eine Erinnerung erhalten (Demo)", p.name));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{tr("Monatsabschluss")}</h1>
          <p className="sub">
            {tr("Mitarbeitende reichen ihren Monat ein, Consultants oder Admins geben ihn frei. Danach sind die Buchungen gesperrt und erscheinen so im Kundenreport.")}
          </p>
        </div>
      </div>
      {error && <p className="notice error" style={{ marginBottom: 12 }}>{error}</p>}

      <section className="card">
        <div className="card-head" style={{ paddingBottom: 8 }}><h2>{tr("Meine Monate")}</h2></div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>{tr("Monat")}</th><th className="r">{tr("Soll")}</th><th className="r">{tr("Ist")}</th><th className="r">{tr("Saldo")}</th><th className="r">{tr("Verrechenbar")}</th><th className="r">{tr("Spesen")}</th><th>{tr("Status")}</th><th className="r">{tr("Aktion")}</th></tr>
            </thead>
            <tbody>
              {months.map((m) => {
                const f = figures(currentUserId, m);
                const s = statusOf(currentUserId, m);
                const running = m === current;
                return (
                  <tr key={m}>
                    <td>{fmtMonthLong(m)}{running && <span className="muted">{" "}{tr("· läuft")}</span>}</td>
                    <td className="r num">{f.due === null ? "–" : `${fmt1(f.due)} h`}</td>
                    <td className="r num">{fmt1(f.hours)}{" "}{tr("h")}</td>
                    <td className={`r num ${(f.balance ?? 0) < 0 ? "neg" : ""}`}>{f.balance === null ? "–" : signedH(f.balance)}</td>
                    <td className="r num">{fmt1(f.billable)}{" "}{tr("h")}</td>
                    <td className="r num">{fmtCHF2(f.expenses)}</td>
                    <td><Status s={s} /></td>
                    <td className="r">
                      {s === "open" && (
                        <button
                          className="btn small primary"
                          disabled={running}
                          title={running ? tr("Der laufende Monat kann erst nach Monatsende eingereicht werden.") : undefined}
                          onClick={() => act("submit", m, currentUserId, tr("{0} eingereicht", fmtMonthLong(m)))}
                        >
                          {tr("Einreichen")}
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
            <h2>{tr("Team ·")}{" "}{fmtMonthLong(month)}</h2>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <span className="muted" style={{ fontSize: "0.8rem" }}>
                {counts.approved}{" "}{tr("freigegeben · {0} eingereicht · {1} offen", counts.submitted, counts.open)}
              </span>
              {counts.submitted > 0 && <button id="c-approve-all" className="btn small" onClick={approveAll}>{tr("Alle {0} eingereichten freigeben", counts.submitted)}</button>}
              <Select id="c-month" small ariaLabel={tr("Monat")} value={month} onChange={setMonth} options={months.map((m) => ({ value: m, label: fmtMonthLong(m) }))} />
            </div>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>{tr("Person")}</th><th className="r">{tr("Buchungen")}</th><th className="r">{tr("Soll")}</th><th className="r">{tr("Ist")}</th><th className="r">{tr("Saldo")}</th><th className="r">{tr("Verrechenbar")}</th><th className="r">{tr("Spesen")}</th><th>{tr("Status")}</th><th className="r">{tr("Aktion")}</th></tr>
              </thead>
              <tbody>
                {people.map((p) => {
                  const f = figures(p.id, month);
                  const s = statusOf(p.id, month);
                  return (
                    <tr key={p.id}>
                      <td>
                        {p.name}
                        {s !== "approved" && f.due !== null && f.due - f.hours > 2 && <div className="muted" style={{ fontSize: "0.74rem" }}>{tr("fehlen {0} h", fmt1(f.due - f.hours))}</div>}
                      </td>
                      <td className="r num">{f.count}</td>
                      <td className="r num">{f.due === null ? "–" : `${fmt1(f.due)} h`}</td>
                      <td className="r num">{fmt1(f.hours)}{" "}{tr("h")}</td>
                      <td className={`r num ${(f.balance ?? 0) < 0 ? "neg" : ""}`}>{f.balance === null ? "–" : signedH(f.balance)}</td>
                      <td className="r num">{fmt1(f.billable)}{" "}{tr("h")}</td>
                      <td className="r num">{fmtCHF2(f.expenses)}</td>
                      <td><Status s={s} /></td>
                      <td>
                        <div className="closing-actions">
                          {s !== "approved" && (
                            <button className="btn small primary" onClick={() => act("approve", month, p.id, tr("{0}: {1} freigegeben", p.name, fmtMonthLong(month)))}>{tr("Freigeben")}</button>
                          )}
                          {s === "submitted" && (
                            <button className="btn small ghost" onClick={() => act("reopen", month, p.id, tr("{0}: zur Korrektur zurückgegeben", p.name))}>{tr("Zurückweisen")}</button>
                          )}
                          {s === "open" && month !== current && (
                            <button className="btn small ghost" title={tr("Per E-Mail an den Monatsabschluss erinnern")} onClick={() => remind(p)}>{tr("Erinnern")}</button>
                          )}
                          {s === "approved" && role === "admin" && (
                            <button className="btn small ghost" onClick={() => act("reopen", month, p.id, tr("{0}: {1} wieder geöffnet", p.name, fmtMonthLong(month)))}>{tr("Wieder öffnen")}</button>
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

      {role === "admin" && <PayrollCard month={month} unapproved={counts.open + counts.submitted} />}
    </>
  );
}

/** Payroll file for the selected month with the company's wage type numbers. */
function PayrollCard({ month, unapproved }: { month: string; unapproved: number }) {
  const { mode, data, notify } = useStore();
  const [codes, setCodes] = useState<PayrollCodes>({});
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (mode === "api") api<OrgSettings>("/api/settings").then((s) => setCodes(s.payrollCodes ?? {})).catch(() => {});
  }, [mode]);
  const missing = data.employees.filter((e) => !e.personnelNumber).length;
  const download = (format: "csv" | "abacus" = "csv") => {
    if (mode === "api") { window.open(`/api/export/payroll?month=${month}&format=${format}`, "_blank"); return; }
    const rows = payrollRows(data, month, codes);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([format === "abacus" ? payrollAbacus(rows) : toCsv(payrollTable(rows))], { type: "text/csv;charset=utf-8" }));
    a.download = format === "abacus" ? `abacus-lohn-${month}.csv` : `lohn-${month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    notify(tr("{0} Zeilen exportiert", rows.length));
  };
  return (
    <section className="card card-pad" id="payroll" style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <h2 style={{ margin: 0 }}>{tr("Lohnexport · {0}", fmtMonthLong(month))}</h2>
      <p className="explain" style={{ margin: 0 }}>{tr("Pro Person geleistete Stunden, Soll, Überzeit, Absenztage nach Art und Spesen zur Rückerstattung, mit euren Lohnarten. Die CSV-Datei lässt sich in gängige Lohnprogramme importieren. Sie ist keine Swissdec-Übermittlung.")}</p>
      {unapproved > 0 && <p className="notice" style={{ margin: 0 }}>{trn(unapproved, "{0} Person hat diesen Monat noch nicht freigegeben. Die Zahlen können sich noch ändern.", "{0} Personen haben diesen Monat noch nicht freigegeben. Die Zahlen können sich noch ändern.")}</p>}
      {missing > 0 && <p className="muted" style={{ margin: 0, fontSize: "0.82rem" }}>{trn(missing, "{0} Person hat noch keine Personalnummer (Absenzen → Team → Arbeitsmodell).", "{0} Personen haben noch keine Personalnummer (Absenzen → Team → Arbeitsmodell).")}</p>}
      <div className="toolbar" style={{ gap: 8 }}>
        <button id="payroll-csv" className="btn primary" onClick={() => download()}>{tr("Lohnexport herunterladen")}</button>
        <button id="payroll-abacus" className="btn" onClick={() => download("abacus")} title={tr("Variable Lohndaten für den Import in Abacus Lohn: Personalnummer, Lohnart, Datum, Anzahl oder Betrag.")}>{tr("Für Abacus")}</button>
        <button id="payroll-codes" className="btn" onClick={() => setEditing(true)}>{tr("Lohnarten")}</button>
      </div>
      {editing && (
        <PayrollCodesDialog
          codes={codes}
          onClose={() => setEditing(false)}
          onSave={async (next) => {
            if (mode === "api") await api<OrgSettings>("/api/settings", { method: "PUT", body: { payrollCodes: next } });
            setCodes(next);
            notify(tr("Lohnarten gespeichert"));
          }}
        />
      )}
    </section>
  );
}

function PayrollCodesDialog({ codes, onClose, onSave }: { codes: PayrollCodes; onClose: () => void; onSave: (c: PayrollCodes) => Promise<void> }) {
  const [f, setF] = useState<Record<string, string>>(() => Object.fromEntries(PAYROLL_ITEMS.map((i) => [i.id, codes[i.id] ?? i.code])));
  return (
    <FormDialog
      id="payroll-codes-dialog"
      title={tr("Lohnarten")}
      subtitle={tr("Die Nummern der Lohnarten in eurem Lohnprogramm. Vorgeschlagen sind neutrale Nummern, bitte an euer Lohnprogramm anpassen.")}
      onClose={onClose}
      onSubmit={async () => {
        const e: Record<string, string> = {};
        for (const i of PAYROLL_ITEMS) if ((f[i.id] ?? "").trim().length > 20) e[i.id] = tr("Höchstens 20 Zeichen.");
        if (Object.keys(e).length) return e;
        await onSave(Object.fromEntries(PAYROLL_ITEMS.map((i) => [i.id, (f[i.id] ?? "").trim()])) as PayrollCodes);
        onClose();
      }}
    >
      <div className="form-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        {PAYROLL_ITEMS.map((i) => (
          <Field key={i.id} label={`${tr(i.label)} (${i.unit === "d" ? tr("Tage") : i.unit})`} name={i.id}>
            <input id={`pc-${i.id}`} className="input num" value={f[i.id] ?? ""} onChange={(ev) => setF({ ...f, [i.id]: ev.target.value })} />
          </Field>
        ))}
      </div>
    </FormDialog>
  );
}
