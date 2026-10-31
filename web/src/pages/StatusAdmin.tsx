import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { tr } from "../i18n";
import { Select } from "../ui/Select";

type Status = "investigating" | "identified" | "monitoring" | "resolved" | "scheduled" | "in_progress" | "completed";
interface Incident {
  id: string;
  title: string;
  impact: "minor" | "major" | "maintenance";
  status: Status;
  startsAt: string;
  endsAt: string | null;
  updates: { at: string; status: Status; text: string }[];
}

const STATUS_LABEL: Record<Status, string> = {
  investigating: tr("Wird untersucht"),
  identified: tr("Ursache gefunden"),
  monitoring: tr("Wird beobachtet"),
  resolved: tr("Behoben"),
  scheduled: tr("Geplant"),
  in_progress: tr("Läuft"),
  completed: tr("Abgeschlossen"),
};
const IMPACT_LABEL = { minor: tr("Einschränkung"), major: tr("Störung"), maintenance: tr("Wartung") };
const NEXT: Record<Incident["impact"], Status[]> = {
  minor: ["identified", "monitoring", "resolved"],
  major: ["identified", "monitoring", "resolved"],
  maintenance: ["in_progress", "completed"],
};
const open = (i: Incident) => !["resolved", "completed"].includes(i.status);

const DEMO: Incident[] = [
  { id: "i2", title: tr("Wartung: Datenbank-Update"), impact: "maintenance", status: "scheduled", startsAt: "2026-11-08T21:00:00Z", endsAt: "2026-11-08T21:30:00Z", updates: [{ at: "2026-10-30T09:00:00Z", status: "scheduled", text: tr("Kurzes Datenbank-Update am Sonntagabend, die App ist etwa 10 Minuten nicht erreichbar.") }] },
  { id: "i1", title: tr("Langsame Anmeldung mit Microsoft"), impact: "minor", status: "resolved", startsAt: "2026-10-24T07:40:00Z", endsAt: "2026-10-24T08:15:00Z", updates: [{ at: "2026-10-24T07:45:00Z", status: "investigating", text: tr("Die Anmeldung mit Microsoft dauert länger als üblich.") }, { at: "2026-10-24T08:15:00Z", status: "resolved", text: tr("Microsoft hat die Störung behoben.") }] },
];

/** Operator console: post disruptions and planned maintenance to the public status page. */
export function IncidentsCard() {
  const { mode, notify } = useStore();
  const demo = mode === "demo";
  const [list, setList] = useState<Incident[] | null>(demo ? DEMO : null);
  const [form, setForm] = useState<{ title: string; impact: Incident["impact"]; text: string; startsAt: string; endsAt: string } | null>(null);
  const [update, setUpdate] = useState<{ id: string; status: Status; text: string } | null>(null);
  const [error, setError] = useState("");
  const load = () => api<Incident[]>("/api/platform/incidents").then(setList).catch((e) => setError((e as Error).message));
  useEffect(() => { if (!demo) void load(); }, [demo]);
  if (!list) return null;

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    if (demo) return notify(tr("Im Prototyp wird nichts gespeichert."));
    try { await fn(); setError(""); notify(msg); await load(); } catch (e) { setError((e as Error).message); }
  };
  const iso = (local: string) => (local ? new Date(local).toISOString() : undefined);
  const fmt = (s: string) => new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  return (
    <section className="card" id="incidents">
      <div className="card-head">
        <h2>{tr("Statusseite")}</h2>
        <div style={{ display: "flex", gap: 6 }}>
          <a className="btn small ghost" href="/status" target="_blank" rel="noreferrer">{tr("Öffnen")}</a>
          <button className="btn small" onClick={() => setForm(form ? null : { title: "", impact: "minor", text: "", startsAt: "", endsAt: "" })}>{tr("+ Meldung")}</button>
        </div>
      </div>
      <div className="card-pad" style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
        <p className="muted" style={{ margin: 0 }}>{tr("Die öffentliche Seite /status zeigt die Erreichbarkeit der letzten 90 Tage (Messung jede Minute) und eure Meldungen. Mit SaaS-Domain auch unter status.<Domain>.")}</p>
        {form && (
          <div className="partner-form">
            <label className="field" style={{ gridColumn: "1 / -1" }}><span>{tr("Titel")}</span><input id="inc-title" className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
            <label className="field"><span>{tr("Art")}</span>
              <Select value={form.impact} onChange={(v) => setForm({ ...form, impact: v as Incident["impact"] })} options={(["minor", "major", "maintenance"] as const).map((k) => ({ value: k, label: IMPACT_LABEL[k] }))} />
            </label>
            {form.impact === "maintenance" && <>
              <label className="field"><span>{tr("Beginn")}</span><input className="input" type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} /></label>
              <label className="field"><span>{tr("Ende")}</span><input className="input" type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} /></label>
            </>}
            <label className="field" style={{ gridColumn: "1 / -1" }}><span>{tr("Text für Kundinnen und Kunden")}</span><textarea id="inc-text" className="input" rows={2} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} /></label>
            <button className="btn primary" disabled={form.title.trim().length < 3 || !form.text.trim()} onClick={() => run(async () => { await api("/api/platform/incidents", { body: { title: form.title, impact: form.impact, text: form.text, startsAt: iso(form.startsAt), endsAt: iso(form.endsAt) } }); setForm(null); }, tr("Meldung veröffentlicht"))}>{tr("Veröffentlichen")}</button>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        {list.length === 0 && <p className="muted" style={{ margin: 0 }}>{tr("Keine Meldungen. Die Statusseite zeigt «Alle Systeme laufen».")}</p>}
        {list.map((i) => (
          <div key={i.id} className={`incident-row ${open(i) ? "" : "muted"}`}>
            <div>
              <strong>{i.title}</strong> <span className={`pill ${i.impact === "major" ? "over" : i.impact === "maintenance" ? "neutral" : "risk"}`}>{IMPACT_LABEL[i.impact]}</span> <span className="pill neutral">{STATUS_LABEL[i.status]}</span>
              <div className="muted" style={{ fontSize: "0.8rem" }}>{fmt(i.startsAt)}{i.endsAt ? ` – ${fmt(i.endsAt)}` : ""} · {i.updates.at(-1)?.text}</div>
            </div>
            {open(i) && (update?.id === i.id ? (
              <div className="incident-update">
                <Select value={update.status} onChange={(v) => setUpdate({ ...update, status: v as Status })} options={NEXT[i.impact].map((k) => ({ value: k, label: STATUS_LABEL[k] }))} />
                <input className="input" placeholder={tr("Was ist neu?")} value={update.text} onChange={(e) => setUpdate({ ...update, text: e.target.value })} />
                <button className="btn small primary" disabled={!update.text.trim()} onClick={() => run(async () => { await api(`/api/platform/incidents/${i.id}/updates`, { body: { status: update.status, text: update.text } }); setUpdate(null); }, tr("Meldung ergänzt"))}>{tr("Posten")}</button>
              </div>
            ) : <button className="btn small" onClick={() => setUpdate({ id: i.id, status: NEXT[i.impact][0]!, text: "" })}>{tr("Ergänzen")}</button>)}
          </div>
        ))}
      </div>
    </section>
  );
}
