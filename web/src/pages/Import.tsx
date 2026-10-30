// Settings → Import: bookings from Clockodo, Toggl, Harvest or an Excel table, in three steps with a preview.
import { useEffect, useMemo, useState } from "react";
import { IMPORT_FIELDS, IMPORT_SOURCES, detectSource, fmt1, fmtDate, guessMapping, importPlan, parseCsv, personKey, toRows, type ImportField, type ImportMapping, type ImportSource } from "@taktwerk/domain";
import { api, type UserRow } from "../api";
import { useStore } from "../store";
import { Select } from "../ui/Select";

interface Batch { id: string; source: string; fileName: string; entries: number; hours: number; createdAt: string; undoneAt: string | null }
interface Result { entries: number; hours: number; customers: number; projects: number; subProjects: number; skippedPeople: number; skippedClosed: number }

const SKIP = "__skip";
const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
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
        if (mode !== "api") throw new Error("Excel-Dateien liest erst die installierte Version. Im Prototyp bitte als CSV exportieren.");
        if (f.size > 10 * 1024 * 1024) throw new Error("Die Datei ist grösser als 10 MB. Bitte in mehreren Teilen importieren.");
        table = (await api<{ rows: string[][] }>("/api/import/xlsx", { body: { data: await toBase64(f) } })).rows;
      } else {
        const buf = await f.arrayBuffer();
        // Exports from older Excel versions are Windows-1252, not UTF-8.
        let text = new TextDecoder("utf-8").decode(buf);
        if (text.includes("�")) text = new TextDecoder("windows-1252").decode(buf);
        table = parseCsv(text);
      }
      if (table.length < 2) throw new Error("Die Datei enthält keine Buchungen.");
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
      notify(`${res.entries} Buchungen importiert`);
      await Promise.all([reload(), loadBatches()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const undo = async (b: Batch) => {
    if (!confirm(`Import «${b.fileName}» mit ${b.entries} Buchungen rückgängig machen? Kunden und Projekte, die der Import angelegt hat, werden mit entfernt, sofern niemand darauf gebucht hat.`)) return;
    try {
      await api(`/api/import/${b.id}`, { method: "DELETE" });
      notify("Import rückgängig gemacht");
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
          <h3>Buchungen übernehmen</h3>
          <p className="explain">Aus Clockodo, Toggl Track, Harvest oder einer Excel-Tabelle. Kunden, Projekte und Tätigkeiten, die es hier noch nicht gibt, legt der Import an. Abgeschlossene Monate bleiben unberührt, und jeder Import lässt sich als Ganzes rückgängig machen.</p>
        </div>
        <ol className="import-steps">
          <li className={file ? "done" : "on"}><span>1</span>Datei wählen</li>
          <li className={file ? "on" : ""}><span>2</span>Spalten prüfen</li>
          <li className={file && hasDuration && !missing.length ? "on" : ""}><span>3</span>Personen zuordnen</li>
        </ol>
        <div className="import-sources" role="radiogroup" aria-label="Herkunft">
          {IMPORT_SOURCES.map((s) => (
            <button key={s.id} role="radio" aria-checked={source === s.id} className={source === s.id ? "on" : ""} onClick={() => setSource(s.id)}>{s.label}</button>
          ))}
        </div>
        <p className="muted" style={{ fontSize: "0.86rem" }}>{src.hint}</p>
        <label className="import-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void pick(f); }}>
          <input id="imp-file" type="file" accept=".csv,.txt,.xlsx,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void pick(f); }} />
          <strong>{file ? file.name : "CSV- oder Excel-Datei hierher ziehen"}</strong>
          <span className="muted">{file ? `${file.table.length - 1} Zeilen · erkannt als ${IMPORT_SOURCES.find((s) => s.id === detectSource(header))!.label}` : "oder klicken, um sie auszuwählen"}</span>
        </label>
        {error && <p className="error">{error}</p>}
        {result && (
          <p className="notice" id="imp-result">
            <strong>{n(result.entries, "Buchung", "Buchungen")} mit {fmt1(result.hours)} h importiert.</strong> Neu: {n(result.customers, "Kunde", "Kunden")}, {n(result.projects, "Projekt", "Projekte")}, {n(result.subProjects, "Tätigkeit", "Tätigkeiten")}.
            {result.skippedPeople > 0 && ` ${n(result.skippedPeople, "Zeile", "Zeilen")} ohne zugeordnete Person übersprungen.`}
            {result.skippedClosed > 0 && ` ${n(result.skippedClosed, "Zeile", "Zeilen")} in abgeschlossenen Monaten übersprungen.`}
          </p>
        )}
      </section>

      {file && parsed && (
        <section className="card card-pad stack" id="imp-columns">
          <div>
            <h3>Spalten prüfen</h3>
            <p className="explain">So haben wir die Spalten Ihrer Datei zugeordnet. Pflichtfelder sind mit * markiert; für die Dauer reicht auch Beginn und Ende.</p>
          </div>
          <div className="import-map">
            {IMPORT_FIELDS.map((f) => (
              <label key={f.id} className="field">
                <span>{f.label}{f.required && <span className="req"> *</span>}</span>
                <Select small value={mapping[f.id] === undefined ? "" : String(mapping[f.id])} placeholder="Nicht vorhanden" onChange={(v) => setMapping({ ...mapping, [f.id as ImportField]: v === "" ? undefined : Number(v) })} options={[{ value: "", label: "Nicht vorhanden" }, ...header.map((h, i) => ({ value: String(i), label: h || `Spalte ${i + 1}` }))]} />
              </label>
            ))}
          </div>
          {(missing.length > 0 || !hasDuration) && <p className="error">Es fehlt noch: {[...missing.map((f) => f.label), ...(hasDuration ? [] : ["Dauer oder Beginn und Ende"])].join(", ")}.</p>}
          {parsed.rows.length > 0 && (
            <div className="table-wrap">
              <table className="data" style={{ fontSize: "0.84rem" }}>
                <thead><tr><th>Datum</th><th>Person</th><th>Kunde</th><th>Projekt</th><th>Tätigkeit</th><th>Beschreibung</th><th className="r">Stunden</th></tr></thead>
                <tbody>
                  {parsed.rows.slice(0, 5).map((r) => (
                    <tr key={r.line}><td className="num">{fmtDate(r.date)}</td><td>{r.person}</td><td>{r.customer}</td><td>{r.project}</td><td>{r.task}</td><td className="muted">{r.reason}</td><td className="r num">{fmt1(r.hours)}{!r.billable && <div className="muted" style={{ fontSize: "0.74rem" }}>nicht verrechenbar</div>}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {parsed.problems.length > 0 && (
            <details className="import-problems">
              <summary>{parsed.problems.length === 1 ? "1 Zeile lässt sich nicht lesen und wird ausgelassen" : `${parsed.problems.length} Zeilen lassen sich nicht lesen und werden ausgelassen`}</summary>
              <ul>{parsed.problems.slice(0, 50).map((p) => <li key={p.line}>Zeile {p.line}: {p.message}</li>)}</ul>
            </details>
          )}
        </section>
      )}

      {file && plan && plan.entries > 0 && !missing.length && hasDuration && (
        <section className="card card-pad stack" id="imp-people">
          <div>
            <h3>Personen zuordnen und importieren</h3>
            <p className="explain">{n(plan.entries, "Buchung", "Buchungen")} mit {fmt1(plan.hours)} h vom {fmtDate(plan.from)} bis {fmtDate(plan.to)}. Wählen Sie, wem die Stunden gehören. Wer fehlt, laden Sie zuerst unter «Benutzer» ein.</p>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>In der Datei</th><th className="r">Stunden</th><th>Wird gebucht auf</th></tr></thead>
              <tbody>
                {plan.people.map((p) => (
                  <tr key={p.key}>
                    <td>{p.name}{p.email && <div className="muted" style={{ fontSize: "0.8rem" }}>{p.email}</div>}</td>
                    <td className="r num">{fmt1(p.hours)}</td>
                    <td><Select small ariaLabel={`Person für ${p.name}`} value={people[p.key] ?? SKIP} onChange={(v) => setPeople({ ...people, [p.key]: v })} options={[{ value: SKIP, label: "Nicht importieren" }, ...staff.map((u) => ({ value: u.id, label: u.name }))]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(plan.newCustomers.length > 0 || plan.newProjects.length > 0) && (
            <div className="import-new">
              <p><strong>Neu angelegt werden:</strong> {n(plan.newCustomers.length, "Kunde", "Kunden")}{plan.newCustomers.length ? ` (${plan.newCustomers.slice(0, 6).join(", ")}${plan.newCustomers.length > 6 ? " …" : ""})` : ""} und {n(plan.newProjects.length, "Projekt", "Projekte")}. Budgets setzen Sie danach beim Projekt.</p>
              {plan.newCustomers.length > 0 && (
                <label className="field" style={{ maxWidth: 260 }}>
                  <span>Stundensatz für neue Kunden (CHF)</span>
                  <input id="imp-rate" className="input num" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
                </label>
              )}
            </div>
          )}
          <div className="toolbar">
            <button id="imp-run" className="btn primary" disabled={busy || assigned.length === 0 || mode !== "api"} onClick={() => void run()}>
              {busy ? "Importiere …" : `${n(assigned.length, "Buchung", "Buchungen")} importieren`}
            </button>
            <button className="btn ghost" onClick={() => setFile(null)}>Abbrechen</button>
            {mode !== "api" && <span className="muted" style={{ fontSize: "0.84rem" }}>Im Prototyp nur Vorschau; importiert wird in der installierten Version.</span>}
          </div>
        </section>
      )}

      {batches.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Bisherige Importe</h3></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Datei</th><th>Herkunft</th><th>Am</th><th className="r">Buchungen</th><th className="r">Stunden</th><th /></tr></thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id} className={b.undoneAt ? "muted" : ""}>
                    <td>{b.fileName}</td>
                    <td>{IMPORT_SOURCES.find((s) => s.id === b.source)?.label ?? b.source}</td>
                    <td className="num">{fmtDate(b.createdAt.slice(0, 10))}</td>
                    <td className="r num">{b.entries}</td>
                    <td className="r num">{fmt1(Number(b.hours))}</td>
                    <td className="r">{b.undoneAt ? <span className="pill neutral">Rückgängig gemacht</span> : <button className="btn small ghost" onClick={() => void undo(b)}>Rückgängig</button>}</td>
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
