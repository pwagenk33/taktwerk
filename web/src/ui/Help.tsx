// The help panel («?» in the top bar or the ? key) and the «Erste Schritte» checklist on the inbox.
import { useEffect, useState } from "react";
import { HELP } from "../help";
import { api } from "../api";
import { loadLocal, saveLocal, useStore } from "../store";
import { Icon } from "./components";

export function HelpPanel({ page, onClose }: { page: string; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(() => HELP.find((a) => a.page === page)?.id ?? null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const needle = q.trim().toLowerCase();
  const list = HELP.filter((a) => !needle || `${a.title} ${a.body.join(" ")}`.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.page === page) - Number(a.page === page));
  return (
    <div className="overlay help-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="help-panel" role="dialog" aria-modal="true" aria-label="Hilfe">
        <div className="help-head">
          <h2>Hilfe</h2>
          <button className="icon-btn" aria-label="Schliessen" onClick={onClose}><Icon.close /></button>
        </div>
        <div className="search help-search">
          <span className="pick-icon"><Icon.search /></span>
          <input id="help-search" className="input" placeholder="Wonach suchen Sie?" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        </div>
        <div className="help-list">
          {list.map((a) => (
            <section key={a.id} className={`help-item ${open === a.id || needle ? "open" : ""}`}>
              <button className="help-title" aria-expanded={open === a.id || !!needle} onClick={() => setOpen(open === a.id ? null : a.id)}>
                {a.title}{a.page === page && <span className="help-here">Diese Seite</span>}
              </button>
              {(open === a.id || needle) && (
                <div className="help-body">
                  {render(a.body)}
                </div>
              )}
            </section>
          ))}
          {list.length === 0 && <p className="muted">Nichts gefunden. Schreiben Sie uns über das Kontaktformular auf der Website.</p>}
        </div>
      </aside>
    </div>
  );
}

function render(body: string[]) {
  const out: React.ReactNode[] = [];
  let items: string[] = [];
  const flush = () => { if (items.length) out.push(<ul key={`l${out.length}`}>{items.map((t) => <li key={t}>{t}</li>)}</ul>); items = []; };
  for (const line of body) {
    if (line.startsWith("- ")) items.push(line.slice(2));
    else { flush(); out.push(<p key={`p${out.length}`}>{line}</p>); }
  }
  flush();
  return out;
}

/** Same as requestNewEntry in App.tsx, without importing App here. */
function newEntry() {
  if (!location.hash.startsWith("#zeit")) location.hash = "#zeit";
  setTimeout(() => window.dispatchEvent(new CustomEvent("ti:new-entry", { detail: {} })), 30);
}

/** Checklist for new companies on the inbox; disappears once the basics are done or when hidden. */
export function GettingStarted() {
  const { data, role, mode, me, currentUserId, notify, reload } = useStore();
  const hideKey = `rt.start-hidden.${me?.id ?? "demo"}`;
  const [hidden, setHidden] = useState(() => loadLocal<boolean>(hideKey, false));
  const [state, setState] = useState<{ sampleBatchId: string | null; imported: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => (mode === "api" ? api<{ sampleBatchId: string | null; imported: boolean }>("/api/onboarding").then(setState).catch(() => undefined) : Promise.resolve());
  useEffect(() => { if (role === "admin") void refresh(); }, [role, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  if (role !== "admin" || hidden) return null;

  const real = (name: string) => !name.startsWith("Beispiel:");
  const customers = data.customers.filter((c) => real(c.name) && c.name !== "Intern");
  const sampleSubs = new Set(data.subProjects.filter((sp) => {
    const p = data.projects.find((x) => x.id === sp.projectId);
    const c = p && data.customers.find((x) => x.id === p.customerId);
    return !!c && !real(c.name);
  }).map((sp) => sp.id));
  const steps = [
    { id: "kunde", label: "Ersten Kunden mit Projekt anlegen", done: customers.length > 0 && data.projects.some((p) => customers.some((c) => c.id === p.customerId)), href: "#projekte" },
    { id: "budget", label: "Budget für ein Projekt festlegen", done: data.projects.some((p) => p.budget > 0 && customers.some((c) => c.id === p.customerId)), href: "#projekte" },
    { id: "team", label: "Team einladen", done: data.employees.filter((e) => e.role !== "customer").length > 1, href: "#einstellungen/users" },
    { id: "zeit", label: "Erste Zeit buchen", done: data.timeEntries.some((e) => e.employeeId === currentUserId && !e.summary && !sampleSubs.has(e.subProjectId)), onClick: newEntry },
    { id: "import", label: "Daten aus dem bisherigen Tool übernehmen", optional: true, done: !!state?.imported && !state.sampleBatchId, href: "#einstellungen/import" },
    { id: "jira", label: "Jira verbinden", optional: true, done: false, href: "#einstellungen/jira" },
  ];
  const required = steps.filter((s) => !s.optional);
  const doneCount = required.filter((s) => s.done).length;
  if (doneCount === required.length && !state?.sampleBatchId) return null;

  const loadSample = async () => {
    setBusy(true);
    try {
      await api("/api/onboarding/sample", { body: {} });
      notify("Beispieldaten geladen");
      await Promise.all([reload(), refresh()]);
    } catch (e) { notify((e as Error).message); } finally { setBusy(false); }
  };
  const removeSample = async () => {
    if (!state?.sampleBatchId) return;
    setBusy(true);
    try {
      await api(`/api/import/${state.sampleBatchId}`, { method: "DELETE" });
      notify("Beispieldaten entfernt");
      await Promise.all([reload(), refresh()]);
    } catch (e) { notify((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <section className="getting-started" id="getting-started" aria-label="Erste Schritte">
      <div className="gs-head">
        <div>
          <h2>Erste Schritte</h2>
          <p className="muted">{doneCount} von {required.length} erledigt. Danach verschwindet diese Liste.</p>
        </div>
        <button className="btn small ghost" onClick={() => { setHidden(true); saveLocal(hideKey, true); }}>Ausblenden</button>
      </div>
      <div className="gs-progress" aria-hidden="true"><span style={{ width: `${(doneCount / required.length) * 100}%` }} /></div>
      <ol className="gs-steps">
        {steps.map((s) => (
          <li key={s.id} className={s.done ? "done" : ""}>
            <span className="gs-check" aria-hidden="true">{s.done ? <Icon.check /> : null}</span>
            {s.href ? <a href={s.href}>{s.label}</a> : <button className="link-btn" onClick={s.onClick}>{s.label}</button>}
            {s.optional && <span className="gs-opt">optional</span>}
          </li>
        ))}
      </ol>
      {mode === "api" && (
        <div className="gs-sample">
          {state?.sampleBatchId ? (
            <>
              <span>Beispieldaten sind geladen: drei Kunden mit sechs Wochen Buchungen. Entfernen Sie sie, bevor Sie richtig starten.</span>
              <button id="gs-remove-sample" className="btn small" disabled={busy} onClick={() => void removeSample()}>Beispieldaten entfernen</button>
            </>
          ) : (
            <>
              <span>Zuerst ausprobieren? Beispieldaten zeigen Budgets, Forecast und Berichte mit Leben gefüllt und lassen sich mit einem Klick wieder entfernen.</span>
              <button id="gs-load-sample" className="btn small" disabled={busy} onClick={() => void loadSample()}>Beispieldaten laden</button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
