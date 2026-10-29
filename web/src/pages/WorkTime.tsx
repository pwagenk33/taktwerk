import { Fragment, useMemo, useState } from "react";
import {
  ABSENCE_TYPES,
  NEEDS_APPROVAL,
  WorkCalendar,
  absenceDays,
  addDays,
  fmt1,
  fmtDate,
  fmtMonthLong,
  isWeekday,
  monthOf,
  vacationSummary,
  workBalance,
  workloadOf,
  type Absence,
  type AbsenceType,
  type Employee,
} from "@taktwerk/domain";
import { useStore } from "../store";
import { Icon } from "../ui/components";
import { Select } from "../ui/Select";
import { Field, FieldRow, FormDialog } from "../ui/Dialog";

const STATUS: Record<Absence["status"], { label: string; cls: string }> = {
  requested: { label: "Beantragt", cls: "risk" },
  approved: { label: "Bewilligt", cls: "ok" },
  rejected: { label: "Abgelehnt", cls: "neutral" },
};

/** Absence type → CSS class for calendar cells and legend. */
export const TYPE_CLASS: Record<AbsenceType, string> = {
  Ferien: "abs-vac",
  Krankheit: "abs-sick",
  Unfall: "abs-sick",
  "Militär/Zivildienst": "abs-mil",
  Weiterbildung: "abs-edu",
  Kompensation: "abs-comp",
  Sonstiges: "abs-other",
};

export const signedH = (v: number) => `${v > 0.005 ? "+" : v < -0.005 ? "−" : ""}${fmt1(Math.abs(v))} h`;
const days = (n: number) => `${fmt1(n).replace(/[.,]0$/, "")} ${n === 1 ? "Tag" : "Tage"}`;
const rangeLabel = (a: Pick<Absence, "startDate" | "endDate" | "halfDay">) =>
  `${a.startDate === a.endDate ? fmtDate(a.startDate) : `${fmtDate(a.startDate)} – ${fmtDate(a.endDate)}`}${a.halfDay ? " · halbe Tage" : ""}`;

function useRun() {
  const { notify } = useStore();
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      setError("");
      notify(msg);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  return { error, run };
}

// ---------- own figures ----------

export function WorkTiles({ employee }: { employee: Employee }) {
  const { data } = useStore();
  const balance = workBalance(data, employee.id);
  const vac = vacationSummary(data, employee.id);
  const month = balance.months.find((m) => m.month === monthOf(data.today));
  // Monday of the current week up to today.
  const cal = new WorkCalendar(data, employee);
  const monday = addDays(data.today, -((new Date(`${data.today}T00:00:00Z`).getUTCDay() + 6) % 7));
  let weekDue = 0;
  let weekWorked = 0;
  for (let d = monday; d <= data.today; d = addDays(d, 1)) {
    weekDue += cal.target(d) - cal.credit(d);
    weekWorked += cal.workedOn(d);
  }
  return (
    <div className="tiles">
      <div className="card tile">
        <span className="label">Überzeit-Saldo</span>
        <span className={`value num ${balance.balance < 0 ? "neg" : ""}`}>{signedH(balance.balance)}</span>
        <span className="delta">seit {fmtDate(balance.from)}{balance.carry ? `, inkl. Übertrag ${signedH(balance.carry)}` : ""}</span>
      </div>
      <div className="card tile">
        <span className="label">Ferien {vac.year} übrig</span>
        <span className="value num">{days(vac.remaining)}</span>
        <span className="delta">{fmt1(vac.taken)} bezogen · {fmt1(vac.planned)} geplant{vac.requested ? ` · ${fmt1(vac.requested)} beantragt` : ""}</span>
      </div>
      <div className="card tile">
        <span className="label">{fmtMonthLong(monthOf(data.today))}</span>
        <span className="value num">{fmt1(month?.worked ?? 0)} / {fmt1((month?.target ?? 0) - (month?.absence ?? 0))} h</span>
        <span className="delta">Ist / Soll bis heute · {signedH(month?.balance ?? 0)}</span>
      </div>
      <div className="card tile">
        <span className="label">Diese Woche</span>
        <span className="value num">{fmt1(weekWorked)} / {fmt1(weekDue)} h</span>
        <span className="delta">Pensum {workloadOf(employee)} % · {fmt1((workModelHours(data) * workloadOf(employee)) / 100)} h pro Woche</span>
      </div>
    </div>
  );
}

const workModelHours = (data: { workModel?: { weeklyHours: number } }) => data.workModel?.weeklyHours ?? 42;

function AbsenceDialog({ onClose }: { onClose: () => void }) {
  const { data, scope, currentUserId, addAbsence, notify } = useStore();
  const lead = scope.managesPeople;
  const [employeeId, setEmployeeId] = useState(currentUserId);
  const [type, setType] = useState<AbsenceType>("Ferien");
  const [startDate, setStart] = useState(addDays(data.today, 1));
  const [endDate, setEnd] = useState(addDays(data.today, 1));
  const [halfDay, setHalfDay] = useState(false);
  const [note, setNote] = useState("");
  const count = endDate >= startDate ? absenceDays(data, { startDate, endDate, halfDay }) : 0;
  const needsApproval = !lead && NEEDS_APPROVAL.includes(type);

  const submit = async (): Promise<Record<string, string> | void> => {
    if (!startDate) return { from: "Ab wann?" };
    if (!endDate || endDate < startDate) return { to: "Das Ende liegt vor dem Beginn." };
    if (count === 0) return { to: "Im Zeitraum liegt kein Arbeitstag." };
    const status = await addAbsence({ employeeId, type, startDate, endDate, halfDay, note: note.trim() || undefined });
    notify(status === "requested" ? `${type} beantragt` : `${type} erfasst`);
    onClose();
  };

  return (
    <FormDialog
      id="absence-dialog"
      title={needsApproval ? "Absenz beantragen" : "Absenz erfassen"}
      subtitle={needsApproval ? "Ferien und Kompensation gehen zur Bewilligung an die Teamleitung. Du siehst den Stand unter «Meine Absenzen»." : "Wird sofort eingetragen und im Soll berücksichtigt."}
      submitLabel={needsApproval ? "Beantragen" : "Erfassen"}
      onClose={onClose}
      onSubmit={submit}
    >
      {lead && (
        <Field label="Person" required><Select id="a-person" value={employeeId} onChange={setEmployeeId} options={data.employees.map((e) => ({ value: e.id, label: e.name }))} /></Field>
      )}
      <Field label="Art" required hint={type === "Kompensation" ? "Wird vom Überzeit-Saldo abgezogen." : type === "Krankheit" ? "Ab dem 3. Tag braucht es meist ein Arztzeugnis." : undefined}>
        <Select id="a-type" value={type} onChange={(v) => setType(v as AbsenceType)} options={ABSENCE_TYPES.map((t) => ({ value: t, label: t }))} />
      </Field>
      <FieldRow>
        <Field label="Von" name="from" required><input id="a-from" type="date" className="input" value={startDate} onChange={(e) => { setStart(e.target.value); if (e.target.value > endDate) setEnd(e.target.value); }} /></Field>
        <Field label="Bis" name="to" required hint={count > 0 ? `${days(count)} Arbeitszeit` : "Kein Arbeitstag im Zeitraum"}><input id="a-to" type="date" className="input" value={endDate} min={startDate} onChange={(e) => setEnd(e.target.value)} /></Field>
      </FieldRow>
      <label className="check-field">
        <input id="a-half" type="checkbox" checked={halfDay} onChange={(e) => setHalfDay(e.target.checked)} />
        <span><strong>Halbe Tage</strong><br /><span className="muted">Jeder Tag im Zeitraum zählt als halber Tag.</span></span>
      </label>
      <Field label="Bemerkung"><input id="a-note" className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={type === "Krankheit" ? "Arztzeugnis ab dem 3. Tag nachreichen" : "z. B. Sommerferien"} /></Field>
    </FormDialog>
  );
}

function MyAbsences({ employee }: { employee: Employee }) {
  const { data, scope, deleteAbsence, lockOf } = useStore();
  const { error, run } = useRun();
  const [confirm, setConfirm] = useState<string | null>(null);
  const year = data.today.slice(0, 4);
  const rows = (data.absences ?? [])
    .filter((a) => a.employeeId === employee.id && a.endDate >= `${year}-01-01`)
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
  const canDelete = (a: Absence) => !lockOf(a.employeeId, a.startDate) && (scope.lead || a.status !== "approved");

  return (
    <section className="card" style={{ display: "flex", flexDirection: "column" }}>
      <div className="card-head" style={{ paddingBottom: 8 }}><h2>Meine Absenzen {year}</h2></div>
      {rows.length === 0 && <p className="card-pad muted">Noch keine Absenzen in diesem Jahr.</p>}
      <ul className="abs-list">
        {rows.map((a) => (
          <li key={a.id}>
            <span className={`abs-dot ${TYPE_CLASS[a.type]}`} aria-hidden />
            <div className="what">
              <div><strong>{a.type}</strong> · {rangeLabel(a)}</div>
              <div className="meta">{days(absenceDays(data, a))}{a.note ? ` · ${a.note}` : ""}</div>
            </div>
            <span className={`pill ${STATUS[a.status].cls}`}>{STATUS[a.status].label}</span>
            <div className="entry-actions">
              {confirm === a.id ? (
                <>
                  <button className="btn small primary" onClick={() => run(() => deleteAbsence(a.id), a.status === "requested" ? "Antrag zurückgezogen" : "Absenz gelöscht").then(() => setConfirm(null))}>
                    {a.status === "requested" ? "Zurückziehen" : "Löschen"}
                  </button>
                  <button className="btn small ghost" onClick={() => setConfirm(null)}>Nein</button>
                </>
              ) : canDelete(a) ? (
                <button className="icon-btn" title={a.status === "requested" ? "Antrag zurückziehen" : "Löschen"} aria-label="Löschen" onClick={() => setConfirm(a.id)}><Icon.trash /></button>
              ) : (
                <span className="lock" title={a.status === "approved" && !scope.lead ? "Bewilligt. Für Änderungen bitte an die Teamleitung wenden." : "Monat abgeschlossen"}><Icon.lock /></span>
              )}
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="error" style={{ padding: "0 16px 12px" }}>{error}</p>}
    </section>
  );
}

function Requests() {
  const { data, decideAbsence } = useStore();
  const { error, run } = useRun();
  const pending = (data.absences ?? []).filter((a) => a.status === "requested").sort((a, b) => a.startDate.localeCompare(b.startDate));
  const name = (id: string) => data.employees.find((e) => e.id === id)?.name ?? "–";
  return (
    <section className="card">
      <div className="card-head" style={{ paddingBottom: 8 }}><h2>Offene Anträge</h2><span className="pill neutral">{pending.length}</span></div>
      {pending.length === 0 && <p className="card-pad muted">Keine offenen Anträge.</p>}
      <ul className="abs-list">
        {pending.map((a) => {
          const vac = a.type === "Ferien" ? vacationSummary(data, a.employeeId, Number(a.startDate.slice(0, 4))) : null;
          return (
            <li key={a.id}>
              <span className={`abs-dot ${TYPE_CLASS[a.type]}`} aria-hidden />
              <div className="what">
                <div><strong>{name(a.employeeId)}</strong> · {a.type} · {rangeLabel(a)}</div>
                <div className="meta">
                  {days(absenceDays(data, a))}
                  {vac ? ` · danach ${days(vac.remaining - absenceDays(data, a))} Ferien übrig` : ""}
                  {a.note ? ` · ${a.note}` : ""}
                </div>
              </div>
              <div className="closing-actions">
                <button className="btn small primary" onClick={() => run(() => decideAbsence(a.id, true), `${name(a.employeeId)}: ${a.type} bewilligt`)}>Bewilligen</button>
                <button className="btn small ghost" onClick={() => run(() => decideAbsence(a.id, false), `${name(a.employeeId)}: ${a.type} abgelehnt`)}>Ablehnen</button>
              </div>
            </li>
          );
        })}
      </ul>
      {error && <p className="error" style={{ padding: "0 16px 12px" }}>{error}</p>}
    </section>
  );
}

function WorkModelDialog({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  const { updateWorkModel, notify } = useStore();
  const [f, setF] = useState({
    workload: String(employee.workload ?? 100),
    vacationDays: String(employee.vacationDays ?? 25),
    trackingStart: employee.trackingStart ?? "",
    overtimeCarry: String(employee.overtimeCarry ?? 0),
    vacationCarry: String(employee.vacationCarry ?? 0),
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const n = (v: string) => (v.trim() === "" ? NaN : Number(v));
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!(n(f.workload) >= 1 && n(f.workload) <= 100)) e.workload = "Zwischen 1 und 100 %.";
    if (!(n(f.vacationDays) >= 0 && n(f.vacationDays) <= 60)) e.vacationDays = "Zwischen 0 und 60 Tagen.";
    if (Number.isNaN(n(f.overtimeCarry))) e.overtimeCarry = "Eine Zahl, auch negativ.";
    if (Number.isNaN(n(f.vacationCarry))) e.vacationCarry = "Eine Zahl, auch negativ.";
    if (Object.keys(e).length) return e;
    await updateWorkModel(employee.id, { workload: n(f.workload), vacationDays: n(f.vacationDays), trackingStart: f.trackingStart || undefined, overtimeCarry: n(f.overtimeCarry), vacationCarry: n(f.vacationCarry) });
    notify(`Arbeitsmodell von ${employee.name} gespeichert`);
    onClose();
  };
  return (
    <FormDialog id="workmodel-dialog" title={`Arbeitsmodell von ${employee.name}`} subtitle="Pensum und Ferienanspruch bestimmen Soll und Saldo. Überträge gelten für Stände vor dem Start der Erfassung." onClose={onClose} onSubmit={submit}>
      <FieldRow>
        <Field label="Pensum (%)" name="workload" required><input id="wm-load" className="input num" inputMode="numeric" value={f.workload} onChange={set("workload")} /></Field>
        <Field label="Ferientage pro Jahr" name="vacationDays" required hint="Bei 100 % Pensum; wird anteilig gerechnet."><input id="wm-vac" className="input num" inputMode="decimal" value={f.vacationDays} onChange={set("vacationDays")} /></Field>
      </FieldRow>
      <Field label="Erfassung ab" hint="Leer heisst ab Eintritt. Davor zählt kein Soll."><input id="wm-start" className="input" type="date" value={f.trackingStart} onChange={set("trackingStart")} /></Field>
      <FieldRow>
        <Field label="Übertrag Überzeit (h)" name="overtimeCarry" required><input id="wm-ot" className="input num" inputMode="decimal" value={f.overtimeCarry} onChange={set("overtimeCarry")} /></Field>
        <Field label="Übertrag Ferien (Tage)" name="vacationCarry" required><input id="wm-vc" className="input num" inputMode="decimal" value={f.vacationCarry} onChange={set("vacationCarry")} /></Field>
      </FieldRow>
    </FormDialog>
  );
}

function TeamTable() {
  const { data, role } = useStore();
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <section className="card">
      <div className="card-head" style={{ paddingBottom: 8 }}><h2>Team</h2></div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th>Person</th><th className="r">Pensum</th><th className="r">Überzeit-Saldo</th><th className="r">Ferien übrig</th><th className="r">Beantragt</th>{role === "admin" && <th className="r">Arbeitsmodell</th>}</tr>
          </thead>
          <tbody>
            {data.employees.map((e) => {
              const b = workBalance(data, e.id);
              const v = vacationSummary(data, e.id);
              return (
                <Fragment key={e.id}>
                  <tr>
                    <td>{e.name}</td>
                    <td className="r num">{workloadOf(e)} %</td>
                    <td className={`r num ${b.balance < 0 ? "neg" : ""}`}>{signedH(b.balance)}</td>
                    <td className="r num">{days(v.remaining)}</td>
                    <td className="r num">{v.requested ? days(v.requested) : "–"}</td>
                    {role === "admin" && (
                      <td className="r"><button className="btn small ghost" onClick={() => setEditing(e.id)}>Bearbeiten</button></td>
                    )}
                  </tr>
                  {editing === e.id && <WorkModelDialog employee={e} onClose={() => setEditing(null)} />}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Who is away in the next four weeks (working days only). */
function TeamCalendar() {
  const { data } = useStore();
  const monday = addDays(data.today, -((new Date(`${data.today}T00:00:00Z`).getUTCDay() + 6) % 7));
  const dates = useMemo(() => {
    const out: string[] = [];
    for (let d = monday; out.length < 20; d = addDays(d, 1)) if (isWeekday(d)) out.push(d);
    return out;
  }, [monday]);
  const holidays = new Map((data.workModel?.holidays ?? []).map((h) => [h.date, h]));
  const visible = (data.absences ?? []).filter((a) => a.status !== "rejected");
  const used = new Set(visible.map((a) => a.type));

  return (
    <section className="card">
      <div className="card-head" style={{ paddingBottom: 8, flexWrap: "wrap", gap: 8 }}>
        <h2>Abwesenheiten · nächste 4 Wochen</h2>
        <div className="abs-legend">
          {ABSENCE_TYPES.filter((t) => used.has(t)).map((t) => <span key={t}><span className={`abs-dot ${TYPE_CLASS[t]}`} />{t}</span>)}
          <span><span className="abs-dot abs-req" />beantragt</span>
          <span><span className="abs-dot abs-holiday" />Feiertag</span>
        </div>
      </div>
      <div className="table-wrap">
        <table className="cal">
          <thead>
            <tr>
              <th />
              {dates.map((d) => (
                <th key={d} className={d === data.today ? "today" : ""} title={holidays.get(d)?.name}>
                  <span>{["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"][new Date(`${d}T00:00:00Z`).getUTCDay()]}</span>
                  {d.slice(8, 10)}.{d.slice(5, 7)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.employees.map((e) => (
              <tr key={e.id}>
                <th scope="row">{e.name}</th>
                {dates.map((d) => {
                  const h = holidays.get(d);
                  const a = visible.find((x) => x.employeeId === e.id && x.startDate <= d && x.endDate >= d);
                  const cls = [a ? TYPE_CLASS[a.type] : "", a?.status === "requested" ? "abs-req" : "", a?.halfDay ? "half" : "", h && !a ? "abs-holiday" : ""].join(" ").trim();
                  const title = [h?.name, a ? `${a.type}${a.status === "requested" ? " (beantragt)" : ""}${a.halfDay ? ", halber Tag" : ""}` : ""].filter(Boolean).join(" · ");
                  return <td key={d} className={cls} title={title || undefined} />;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function WorkTime() {
  const { data, currentUserId, scope } = useStore();
  const me = data.employees.find((e) => e.id === currentUserId);
  const lead = scope.managesPeople;
  const [adding, setAdding] = useState(false);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Ferien & Absenzen</h1>
          <p className="sub">Ferien beantragen, Krankheit und andere Absenzen erfassen. Überzeit-Saldo, Soll und Ist stehen im Kalender der Zeiterfassung und im Monatsabschluss.</p>
        </div>
        {!scope.readOnly && <button id="a-add" className="btn primary" onClick={() => setAdding(true)}>+ Absenz</button>}
      </div>
      {adding && <AbsenceDialog onClose={() => setAdding(false)} />}
      {me && <MyAbsences employee={me} />}
      {lead && (
        <>
          <Requests />
          <TeamCalendar />
          <TeamTable />
        </>
      )}
    </>
  );
}
