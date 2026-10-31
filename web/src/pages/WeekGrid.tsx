// Week grid: the whole week in one table. Rows are sub-project + activity, columns the days; typing a number
// books, changes or (with 0) deletes. A cell with several bookings is only shown, they are edited in the calendar.
import { WorkCalendar, addDays, fmt1, fmtDay, isoWeekKey, parseHours, rateOn, type TimeEntry } from "@taktwerk/domain";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadLocal, saveLocal, useStore } from "../store";
import { Select } from "../ui/Select";
import { tr } from "../i18n";
import { useLabels } from "./TimeTracking";

interface Row { subProjectId: string; reason: string; jiraIssueKey?: string }
const rowKey = (r: Row) => `${r.subProjectId}|${r.reason}|${r.jiraIssueKey ?? ""}`;

function mondayOf(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}

/** A typed cell: empty is 0, otherwise the import's rules (1.5, 1,5, 1:30, 90 min); null outside 0–24 h. */
function cellHours(input: string): number | null {
  if (!input.trim()) return 0;
  const h = parseHours(input);
  return h !== null && h >= 0 && h <= 24 ? Math.round(h * 100) / 100 : null;
}

const fmtCell = (h: number) => (h ? fmt1(h).replace(/[.,]0$/, "") : "");

export function WeekGrid() {
  const { data, currentUserId, addTimeEntry, updateTimeEntry, deleteTimeEntry, lockOf, notify, loadFrom } = useStore();
  const labels = useLabels();
  const [monday, setMonday] = useState(() => mondayOf(data.today));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  const week = isoWeekKey(monday);
  const [extra, setExtra] = useState<Row[]>(() => loadLocal<Row[]>(`rt.grid.${currentUserId}.${week}`, []));
  useEffect(() => setExtra(loadLocal<Row[]>(`rt.grid.${currentUserId}.${week}`, [])), [week, currentUserId]);
  const saveExtra = (rows: Row[]) => { setExtra(rows); saveLocal(`rt.grid.${currentUserId}.${week}`, rows); };
  useEffect(() => { if (data.detailFrom && monday < data.detailFrom) void loadFrom(monday); }, [monday]); // eslint-disable-line react-hooks/exhaustive-deps

  const mine = useMemo(() => data.timeEntries.filter((e) => e.employeeId === currentUserId && !e.summary && e.date >= days[0]! && e.date <= days[6]!), [data.timeEntries, currentUserId, days]);
  const rows = useMemo(() => {
    const out = new Map<string, Row>();
    for (const e of [...mine].sort((a, b) => labels.short(a.subProjectId).localeCompare(labels.short(b.subProjectId)))) {
      const r = { subProjectId: e.subProjectId, reason: e.reason, jiraIssueKey: e.jiraIssueKey };
      out.set(rowKey(r), r);
    }
    for (const r of extra) if (!out.has(rowKey(r))) out.set(rowKey(r), r);
    return [...out.values()];
  }, [mine, extra]); // eslint-disable-line react-hooks/exhaustive-deps
  const cellEntries = (r: Row, d: string) => mine.filter((e) => e.date === d && rowKey({ subProjectId: e.subProjectId, reason: e.reason, jiraIssueKey: e.jiraIssueKey }) === rowKey(r));
  const sum = (list: TimeEntry[]) => list.reduce((s, e) => s + e.hours, 0);

  const me = data.employees.find((e) => e.id === currentUserId);
  const cal = useMemo(() => (me ? new WorkCalendar(data, me) : null), [data, me]);
  const target = (d: string) => (cal ? Math.max(0, cal.target(d) - cal.credit(d)) : 0);

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const commit = async (r: Row, d: string) => {
    const key = `${rowKey(r)}|${d}`;
    const text = draft[key];
    if (text === undefined) return;
    const list = cellEntries(r, d);
    const h = cellHours(text);
    if (h === null) return setError(tr("«{0}» ist keine Dauer. Erlaubt sind z. B. 1.5, 1,5, 1:30 oder 90m.", text));
    setDraft(({ [key]: _, ...rest }) => rest);
    if (h === sum(list)) return;
    setBusy(key);
    setError("");
    try {
      if (list.length === 1 && h === 0) await deleteTimeEntry(list[0]!.id);
      else if (list.length === 1) await updateTimeEntry(list[0]!.id, { hours: h });
      else if (list.length === 0 && h > 0) {
        const customer = labels.customerOf(r.subProjectId);
        const rate = customer ? rateOn(customer, d) : 0;
        await addTimeEntry({ employeeId: currentUserId, subProjectId: r.subProjectId, date: d, hours: h, reason: r.reason, billable: rate > 0, hourlyRate: rate, jiraIssueKey: r.jiraIssueKey });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Arrow keys and Enter move between cells like in a spreadsheet.
  const tableRef = useRef<HTMLTableElement>(null);
  const move = (from: HTMLInputElement, dr: number, dc: number) => {
    const [ri, ci] = [Number(from.dataset.r), Number(from.dataset.c)];
    const next = tableRef.current?.querySelector<HTMLInputElement>(`input[data-r="${ri + dr}"][data-c="${ci + dc}"]`);
    if (next) { next.focus(); next.select(); }
  };

  // Add a row: sub-project and activity; it stays in this week until hours are booked on it.
  const [subId, setSubId] = useState("");
  const [reason, setReason] = useState("");
  const subOptions = useMemo(() => data.subProjects.map((s) => ({ value: s.id, label: labels.long(s.id) })).sort((a, b) => a.label.localeCompare(b.label)), [data.subProjects]); // eslint-disable-line react-hooks/exhaustive-deps
  const addRow = () => {
    if (!subId) return setError(tr("Bitte ein Subprojekt wählen."));
    if (!reason.trim()) return setError(tr("Bitte einen Grund angeben, er erscheint im Kundenreport."));
    const r = { subProjectId: subId, reason: reason.trim() };
    if (rows.some((x) => rowKey(x) === rowKey(r))) return setError(tr("Diese Zeile gibt es schon."));
    saveExtra([...extra, r]);
    setReason("");
    setError("");
  };
  const lastWeekRows = () => {
    const from = addDays(days[0]!, -7);
    const to = addDays(days[0]!, -1);
    const prev = data.timeEntries.filter((e) => e.employeeId === currentUserId && !e.summary && e.date >= from && e.date <= to);
    const add = new Map<string, Row>();
    for (const e of prev) {
      const r = { subProjectId: e.subProjectId, reason: e.reason, jiraIssueKey: e.jiraIssueKey };
      if (!rows.some((x) => rowKey(x) === rowKey(r))) add.set(rowKey(r), r);
    }
    saveExtra([...extra, ...add.values()]);
    notify(add.size ? tr("{0} Zeilen aus der Vorwoche übernommen, ohne Stunden", add.size) : tr("Die Vorwoche hat keine weiteren Zeilen."));
  };
  const removeRow = (r: Row) => saveExtra(extra.filter((x) => rowKey(x) !== rowKey(r)));

  const dayTotal = (d: string) => sum(mine.filter((e) => e.date === d));
  const weekTotal = sum(mine);
  const weekTarget = days.reduce((s, d) => s + target(d), 0);
  const weekend = (i: number) => i >= 5;

  return (
    <section className="card grid-card" id="week-grid">
      <div className="card-head">
        <div className="grid-nav">
          <button className="btn small ghost" aria-label={tr("Vorherige Woche")} onClick={() => setMonday(addDays(monday, -7))}>←</button>
          <h2>{tr("KW {0}", Number(week.slice(6)))}{" "}<span className="muted" style={{ fontWeight: 400 }}>{fmtDay(days[0]!)}{" – "}{fmtDay(days[6]!)}</span></h2>
          <button className="btn small ghost" aria-label={tr("Nächste Woche")} onClick={() => setMonday(addDays(monday, 7))}>→</button>
          {monday !== mondayOf(data.today) && <button className="btn small ghost" onClick={() => setMonday(mondayOf(data.today))}>{tr("Heute")}</button>}
        </div>
        <button id="grid-lastweek" className="btn small" onClick={lastWeekRows}>{tr("Zeilen der Vorwoche")}</button>
      </div>
      <div className="table-wrap">
        <table className="week-grid" ref={tableRef}>
          <thead>
            <tr>
              <th className="g-row">{tr("Subprojekt und Tätigkeit")}</th>
              {days.map((d, i) => <th key={d} className={`g-day ${weekend(i) ? "we" : ""} ${d === data.today ? "today" : ""}`}>{fmtDay(d)}</th>)}
              <th className="g-sum">{tr("Total")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={9} className="muted g-empty">{tr("Noch keine Buchungen in dieser Woche. Zeile unten hinzufügen oder die Zeilen der Vorwoche übernehmen.")}</td></tr>
            )}
            {rows.map((r, ri) => {
              const rowSum = sum(days.flatMap((d) => cellEntries(r, d)));
              const removable = rowSum === 0 && extra.some((x) => rowKey(x) === rowKey(r));
              return (
                <tr key={rowKey(r)}>
                  <td className="g-row">
                    <div className="g-label" title={labels.long(r.subProjectId)}>{labels.short(r.subProjectId)}</div>
                    <div className="g-reason muted">{r.reason}</div>
                    {removable && <button className="g-remove" aria-label={tr("Zeile entfernen")} title={tr("Zeile entfernen")} onClick={() => removeRow(r)}>×</button>}
                  </td>
                  {days.map((d, ci) => {
                    const key = `${rowKey(r)}|${d}`;
                    const list = cellEntries(r, d);
                    const lock = lockOf(currentUserId, d);
                    const many = list.length > 1;
                    return (
                      <td key={d} className={`g-cell ${weekend(ci) ? "we" : ""} ${busy === key ? "busy" : ""}`}>
                        <input
                          data-r={ri}
                          data-c={ci}
                          className="num"
                          inputMode="decimal"
                          aria-label={`${labels.short(r.subProjectId)}, ${fmtDay(d)}`}
                          value={draft[key] ?? fmtCell(sum(list))}
                          disabled={!!lock || many}
                          title={lock ?? (many ? tr("{0} Buchungen, im Kalender bearbeiten", list.length) : undefined)}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                          onBlur={() => void commit(r, d)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); move(e.currentTarget, 1, 0); }
                            else if (e.key === "ArrowUp") { e.preventDefault(); move(e.currentTarget, -1, 0); }
                            else if (e.key === "Escape") setDraft(({ [key]: _, ...rest }) => rest);
                          }}
                        />
                      </td>
                    );
                  })}
                  <td className="g-sum num">{fmtCell(rowSum)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th className="g-row">{tr("Total")}<div className="muted g-reason">{tr("Soll")}</div></th>
              {days.map((d, i) => {
                const t = target(d);
                const total = dayTotal(d);
                return (
                  <td key={d} className={`g-total num ${weekend(i) ? "we" : ""} ${t > 0 && total >= t - 0.01 ? "ok" : ""}`}>
                    <strong>{fmtCell(total) || "–"}</strong>
                    <div className="muted">{t ? fmtCell(t) : ""}</div>
                  </td>
                );
              })}
              <td className="g-sum num"><strong>{fmt1(weekTotal)}</strong><div className="muted">{fmt1(weekTarget)}</div></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="grid-add card-pad">
        <div className="grid-add-sub"><Select id="grid-sub" value={subId} onChange={setSubId} options={subOptions} placeholder={tr("Subprojekt wählen")} ariaLabel={tr("Subprojekt")} /></div>
        <input id="grid-reason" className="input" placeholder={tr("Tätigkeit, z. B. Konzept überarbeitet")} value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addRow()} aria-label={tr("Tätigkeit")} />
        <button id="grid-add" className="btn" onClick={addRow}>{tr("+ Zeile")}</button>
      </div>
      {error && <p className="error card-pad" style={{ paddingTop: 0 }}>{error}</p>}
      <p className="muted card-pad grid-hint">{tr("Zahl eingeben bucht, 0 löscht. Erlaubt sind 1.5, 1,5, 1:30 oder 90m. Enter und Pfeiltasten springen zur nächsten Zeile.")}</p>
    </section>
  );
}
