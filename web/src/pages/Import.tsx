// Settings → Import: bookings from Clockodo, Toggl, Harvest or an Excel table, in three steps with a preview.
import { useEffect, useMemo, useState } from "react";
import { IMPORT_FIELDS, IMPORT_SOURCES, detectSource, fmt1, fmtDate, guessMapping, importPlan, parseCsv, personKey, toRows, type ImportField, type ImportMapping, type ImportSource } from "@taktwerk/domain";
import { api, type UserRow } from "../api";
import { useStore } from "../store";
import { Select } from "../ui/Select";
import { tr, trn } from "../i18n";

interface Batch { id: string; source: string; fileName: string; entries: number; hours: number; createdAt: string; undoneAt: string | null }
interface Result { entries: number; hours: number; customers: number; projects: number; subProjects: number; skippedPeople: number; skippedClosed: number }

const SKIP = "__skip";
const toBase64 = async (f: File) => {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export function ImportTab() {
  const { data, mode, notify, reload } = useStore();
  const [source, setSource] = useState<ImportSource>("toggl");
  const [file, setFile] = useState<{ name: string; table: string[][] } | null>(null);
  const [mapping, setMapping] = useState<ImportMapping>({});
  const [people, setPeople] = useState<Record<string, string>>({});
  const [rate, setRate] = useState("150");
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  const loadBatches = () => (mode === "api" ? api<Batch[]>("/api/import").then(setBatches).catch(() => undefined) : Promise.resolve());
  useEffect(() => {
    if (mode !== "api") return;
    api<UserRow[]>("/api/users").then(setUsers).catch(() => setUsers([]));
    void loadBatches();
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const staff = useMemo(
    () => (users ?? data.employees.map((e) => ({ id: e.id, name: e.name, email: "", role: e.role, active: true }))).filter((u) => u.role !== "customer" && u.active),
    [users, data.employees],
  );
  const header = file?.table[0] ?? [];
  const parsed = useMemo(() => (file ? toRows(header, file.table.slice(1), mapping) : null), [file, mapping]); // eslint-disable-line react-hooks/exhaustive-deps
  const plan = useMemo(
    () => (parsed ? importPlan(parsed.rows, { customers: data.customers, projects: data.projects.map((p) => ({ name: p.name, customer: data.customers.find((c) => c.id === p.customerId)?.name ?? "" })) }) : null),
    [parsed, data.customers, data.projects],
  );

  // Match the people in the file to staff by e-mail, then by name.
  useEffect(() => {
    if (!plan) return;
    const next: Record<string, string> = {};
    for (const p of plan.people) {
      const hit = staff.find((u) => (p.email && u.email && u.email.toLowerCase() === p.email.toLowerCase()) || u.name.toLowerCase() === p.name.toLowerCase());
      next[p.key] = people[p.key] ?? hit?.id ?? SKIP;
    }
    setPeople(next);
  }, [plan?.people.length, staff.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async (f: File) => {
    setError("");
    setResult(null);
    try {
      let table: string[][];
      if (/\.xlsx$/i.test(f.name)) {
        if (mode !== "api") throw new Error(tr("Excel-Dateien liest erst die installierte Version. Im Prototyp bitte als CSV exportieren."));
        if (f.size > 10 * 1024 * 1024) throw new Error(tr("Die Datei ist grösser als 10 MB. Bitte in mehreren Teilen importieren."));
        table = (await api<{ rows: string[][] }>("/api/import/xlsx", { body: { data: await toBase64(f) } })).rows;
      } else {
        const buf = await f.arrayBuffer();
        // Exports from older Excel versions are Windows-1252, not UTF-8.
        let text = new TextDecoder("utf-8").decode(buf);
        if (text.includes("\uFFFD")) text = new TextDecoder("windows-1252").decode(buf);
        table = parseCsv(text);
      }
      if (table.length < 2) throw new Error(tr("Die Datei enthält keine Buchungen."));
      setFile({ name: f.name, table });
      setSource(detectSource(table[0]!));
      setMapping(guessMapping(table[0]!));
      setPeople({});
    } catch (e) {
      setFile(null);
      setError((e as Error).message);
    }
  };

  const assigned = parsed ? parsed.rows.filter((r) => (people[personKey(r)] ?? SKIP) !== SKIP) : [];
  const missing = IMPORT_FIELDS.filter((f) => f.required && mapping[f.id] === undefined && !(f.id === "person" && header.some((h) => h.toLowerCase() === "first name")));
  const hasDuration = mapping.hours !== undefined || (mapping.start !== undefined && mapping.end !== undefined);

  const run = async () => {
    if (!parsed || !file) return;
    setBusy(true);
    setError("");
    try {
      const res = await api<Result>("/api/import", {
        body: { source, fileName: file.name, rate: Number(rate) || 0, people: Object.fromEntries(Object.entries(people).filter(([, v]) => v !== SKIP)), rows: parsed.rows },
      });
      setResult(res);
      setFile(null);
      notify(tr("{0} Buchungen importiert", res.entries));
      await Promise.all([reload(), loadBatches()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const undo = async (b: Batch) => {
    if (!confirm(tr("Import «{0}» mit {1} Buchungen rückgängig machen? Kunden und Projekte, die der Import angelegt hat, werden mit entfernt, sofern niemand darauf gebucht hat.", b.fileName, b.entries))) return;
    try {
      await api(`/api/import/${b.id}`, { method: "DELETE" });
      notify(tr("Import rückgängig gemacht"));
      await Promise.all([reload(), loadBatches()]);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const src = IMPORT_SOURCES.find((s) => s.id === source)!;
  return (
    <div className="stack import">
      <section className="card card-pad stack">
        <div>
          <h3>{tr("Buchungen übernehmen")}</h3>
          <p className="explain">{tr("Aus Clockodo, Toggl Track, Harvest oder einer Excel-Tabelle. Kunden, Projekte und Tätigkeiten, die es hier noch nicht gibt, legt der Import an. Abgeschlossene Monate bleiben unberührt, und jeder Import lässt sich als Ganzes rückgängig machen.")}</p>
        </div>
        <ol className="import-steps">
          <li className={file ? "done" : "on"}><span>1</span>{tr("Datei wählen")}</li>
          <li className={file ? "on" : ""}><span>2</span>{tr("Spalten prüfen")}</li>
          <li className={file && hasDuration && !missing.length ? "on" : ""}><span>3</span>{tr("Personen zuordnen")}</li>
        </ol>
        <div className="import-sources" role="radiogroup" aria-label={tr("Herkunft")}>
          {IMPORT_SOURCES.map((s) => (
            <button key={s.id} role="radio" aria-checked={source === s.id} className={source === s.id ? "on" : ""} onClick={() => setSource(s.id)}>{tr(s.label)}</button>
          ))}
        </div>
        <p className="muted" style={{ fontSize: "0.86rem" }}>{tr(src.hint)}</p>
        <label className="import-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void pick(f); }}>
          <input id="imp-file" type="file" accept=".csv,.txt,.xlsx,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void pick(f); }} />
          <strong>{file ? file.name : tr("CSV- oder Excel-Datei hierher ziehen")}</strong>
          <span className="muted">{file ? tr("{0} Zeilen · erkannt als {1}", file.table.length - 1, IMPORT_SOURCES.find((s) => s.id === detectSource(header))!.label) : tr("oder klicken, um sie auszuwählen")}</span>
        </label>
        {error && <p className="error">{error}</p>}
        {result && (
          <p className="notice" id="imp-result">
            <strong>{trn(result.entries, "{0} Buchung", "{0} Buchungen")}{" "}{tr("mit {0} h importiert.", fmt1(result.hours))}</strong>{" "}{tr("Neu: {0}, {1}, {2}.", trn(result.customers, "{0} Kunde", "{0} Kunden"), trn(result.projects, "{0} Projekt", "{0} Projekte"), trn(result.subProjects, "{0} Tätigkeit", "{0} Tätigkeiten"))}
            {result.skippedPeople > 0 && tr(" {0} ohne zugeordnete Person übersprungen.", trn(result.skippedPeople, "{0} Zeile", "{0} Zeilen"))}
            {result.skippedClosed > 0 && tr(" {0} in abgeschlossenen Monaten übersprungen.", trn(result.skippedClosed, "{0} Zeile", "{0} Zeilen"))}
          </p>
        )}
      </section>

      {file && parsed && (
        <section className="card card-pad stack" id="imp-columns">
          <div>
            <h3>{tr("Spalten prüfen")}</h3>
            <p className="explain">{tr("So haben wir die Spalten Ihrer Datei zugeordnet. Pflichtfelder sind mit * markiert; für die Dauer reicht auch Beginn und Ende.")}</p>
          </div>
          <div className="import-map">
            {IMPORT_FIELDS.map((f) => (
              <label key={f.id} className="field">
                <span>{tr(f.label)}{f.required && <span className="req"> *</span>}</span>
                <Select small value={mapping[f.id] === undefined ? "" : String(mapping[f.id])} placeholder={tr("Nicht vorhanden")} onChange={(v) => setMapping({ ...mapping, [f.id as ImportField]: v === "" ? undefined : Number(v) })} options={[{ value: "", label: tr("Nicht vorhanden") }, ...header.map((h, i) => ({ value: String(i), label: h || tr("Spalte {0}", i + 1) }))]} />
              </label>
            ))}
          </div>
          {(missing.length > 0 || !hasDuration) && <p className="error">{tr("Es fehlt noch:")}{" "}{[...missing.map((f) => f.label), ...(hasDuration ? [] : [tr("Dauer oder Beginn und Ende")])].join(", ")}.</p>}
          {parsed.rows.length > 0 && (
            <div className="table-wrap">
              <table className="data" style={{ fontSize: "0.84rem" }}>
                <thead><tr><th>{tr("Datum")}</th><th>{tr("Person")}</th><th>{tr("Kunde")}</th><th>{tr("Projekt")}</th><th>{tr("Tätigkeit")}</th><th>{tr("Beschreibung")}</th><th className="r">{tr("Stunden")}</th></tr></thead>
                <tbody>
                  {parsed.rows.slice(0, 5).map((r) => (
                    <tr key={r.line}><td className="num">{fmtDate(r.date)}</td><td>{r.person}</td><td>{r.customer}</td><td>{r.project}</td><td>{r.task}</td><td className="muted">{r.reason}</td><td className="r num">{fmt1(r.hours)}{!r.billable && <div className="muted" style={{ fontSize: "0.74rem" }}>{tr("nicht verrechenbar")}</div>}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {parsed.problems.length > 0 && (
            <details className="import-problems">
              <summary>{parsed.problems.length === 1 ? tr("1 Zeile lässt sich nicht lesen und wird ausgelassen") : tr("{0} Zeilen lassen sich nicht lesen und werden ausgelassen", parsed.problems.length)}</summary>
              <ul>{parsed.problems.slice(0, 50).map((p) => <li key={p.line}>{tr("Zeile {0}:", p.line)}{" "}{p.message}</li>)}</ul>
            </details>
          )}
        </section>
      )}

      {file && plan && plan.entries > 0 && !missing.length && hasDuration && (
        <section className="card card-pad stack" id="imp-people">
          <div>
            <h3>{tr("Personen zuordnen und importieren")}</h3>
            <p className="explain">{trn(plan.entries, "{0} Buchung", "{0} Buchungen")}{" "}{tr("mit {0} h vom {1} bis {2}. Wählen Sie, wem die Stunden gehören. Wer fehlt, laden Sie zuerst unter «Benutzer» ein.", fmt1(plan.hours), fmtDate(plan.from), fmtDate(plan.to))}</p>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{tr("In der Datei")}</th><th className="r">{tr("Stunden")}</th><th>{tr("Wird gebucht auf")}</th></tr></thead>
              <tbody>
                {plan.people.map((p) => (
                  <tr key={p.key}>
                    <td>{p.name}{p.email && <div className="muted" style={{ fontSize: "0.8rem" }}>{p.email}</div>}</td>
                    <td className="r num">{fmt1(p.hours)}</td>
                    <td><Select small ariaLabel={tr("Person für {0}", p.name)} value={people[p.key] ?? SKIP} onChange={(v) => setPeople({ ...people, [p.key]: v })} options={[{ value: SKIP, label: tr("Nicht importieren") }, ...staff.map((u) => ({ value: u.id, label: u.name }))]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(plan.newCustomers.length > 0 || plan.newProjects.length > 0) && (
            <div className="import-new">
              <p><strong>{tr("Neu angelegt werden:")}</strong> {trn(plan.newCustomers.length, "{0} Kunde", "{0} Kunden")}{plan.newCustomers.length ? ` (${plan.newCustomers.slice(0, 6).join(", ")}${plan.newCustomers.length > 6 ? " …" : ""})` : ""}{" "}{tr("und {0}. Budgets setzen Sie danach beim Projekt.", trn(plan.newProjects.length, "{0} Projekt", "{0} Projekte"))}</p>
              {plan.newCustomers.length > 0 && (
                <label className="field" style={{ maxWidth: 260 }}>
                  <span>{tr("Stundensatz für neue Kunden (CHF)")}</span>
                  <input id="imp-rate" className="input num" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
                </label>
              )}
            </div>
          )}
          <div className="toolbar">
            <button id="imp-run" className="btn primary" disabled={busy || assigned.length === 0 || mode !== "api"} onClick={() => void run()}>
              {busy ? tr("Importiere …") : trn(assigned.length, "{0} Buchung importieren", "{0} Buchungen importieren")}
            </button>
            <button className="btn ghost" onClick={() => setFile(null)}>{tr("Abbrechen")}</button>
            {mode !== "api" && <span className="muted" style={{ fontSize: "0.84rem" }}>{tr("Im Prototyp nur Vorschau; importiert wird in der installierten Version.")}</span>}
          </div>
        </section>
      )}

      {batches.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>{tr("Bisherige Importe")}</h3></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{tr("Datei")}</th><th>{tr("Herkunft")}</th><th>{tr("Datum")}</th><th className="r">{tr("Buchungen")}</th><th className="r">{tr("Stunden")}</th><th /></tr></thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id} className={b.undoneAt ? "muted" : ""}>
                    <td>{b.fileName}</td>
                    <td>{tr(IMPORT_SOURCES.find((s) => s.id === b.source)?.label ?? b.source)}</td>
                    <td className="num">{fmtDate(b.createdAt.slice(0, 10))}</td>
                    <td className="r num">{b.entries}</td>
                    <td className="r num">{fmt1(Number(b.hours))}</td>
                    <td className="r">{b.undoneAt ? <span className="pill neutral">{tr("Rückgängig gemacht")}</span> : <button className="btn small ghost" onClick={() => void undo(b)}>{tr("Rückgängig")}</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
