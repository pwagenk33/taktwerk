import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { Select } from "../ui/Select";

interface JiraStatus {
  configured: boolean;
  connected: boolean;
  site?: { name: string; url: string };
  storyPointFields?: number;
  lastSyncAt?: string | null;
  lastResult?: { ok: boolean; message: string } | null;
}
interface JiraProjectRow { key: string; name: string; project: { id: string; name: string } | null }

const REASON: Record<string, string> = {
  abgebrochen: "Die Anmeldung bei Atlassian wurde abgebrochen.",
  "keine-site": "Dein Atlassian-Konto hat keinen Zugriff auf eine Jira-Cloud-Site.",
  atlassian: "Atlassian hat die Verbindung abgelehnt. Bitte nochmals versuchen.",
};
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("de-CH", { dateStyle: "short", timeStyle: "short" }) : "noch nie");

/** Settings → Jira: connect the Jira Cloud site, link Jira projects to projects, sync now. */
export function JiraTab() {
  const { mode, notify, data, reload } = useStore();
  const demo = mode === "demo";
  const [status, setStatus] = useState<JiraStatus | null>(null);
  const [rows, setRows] = useState<JiraProjectRow[] | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (demo) {
      // Prototype: a connected example site with the sample projects plus one not yet taken over.
      setStatus({ configured: true, connected: true, site: { name: "beispiel", url: "https://beispiel.atlassian.net" }, storyPointFields: 1, lastSyncAt: new Date(Date.now() - 6 * 60_000).toISOString(), lastResult: { ok: true, message: `${data.issues.length} Issues aus ${data.projects.filter((p) => p.jiraProjectKey).length} Projekten abgeglichen.` } });
      setRows([
        ...data.projects.filter((p) => p.jiraProjectKey).map((p) => ({ key: p.jiraProjectKey!, name: p.name, project: { id: p.id, name: p.name } })),
        { key: "INT", name: "Intranet 2027", project: null },
      ]);
      return;
    }
    try {
      const s = await api<JiraStatus>("/api/jira");
      setStatus(s);
      setRows(s.connected ? await api<JiraProjectRow[]>("/api/jira/projects") : null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const outcome = q.get("jira");
    if (outcome === "ok") notify("Mit Atlassian verbunden");
    if (outcome === "fehler") setError(REASON[q.get("grund") ?? ""] ?? REASON.atlassian!);
    if (outcome) history.replaceState(null, "", location.pathname + location.hash);
    load();
  }, []);

  const targets = useMemo(() => {
    const linked = new Set((rows ?? []).map((r) => r.project?.id).filter(Boolean));
    return [
      ...data.customers.map((c) => ({ value: `neu:${c.id}`, label: `Neues Projekt bei ${c.name}` })),
      ...data.projects.filter((p) => !linked.has(p.id)).map((p) => ({ value: `p:${p.id}`, label: `Mit «${p.name}» verknüpfen` })),
    ];
  }, [rows, data]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const link = (row: JiraProjectRow) => run(async () => {
    const target = choice[row.key];
    if (!target) return;
    if (demo) { notify("In der Demo werden keine Projekte übernommen."); return; }
    const [kind, id] = target.split(":");
    const { result } = await api<{ result: { ok: boolean; message: string } }>("/api/jira/link", { method: "POST", body: { jiraKey: row.key, name: row.name, ...(kind === "neu" ? { customerId: id } : { projectId: id }) } });
    notify(result.message);
    await reload();
    await load();
  });
  const unlink = (row: JiraProjectRow) => run(async () => {
    if (demo) { notify("In der Demo bleibt die Verknüpfung bestehen."); return; }
    await api("/api/jira/unlink", { method: "POST", body: { projectId: row.project!.id } });
    await load();
  });
  const sync = () => run(async () => {
    if (demo) { notify("Abgleich gestartet"); return; }
    const r = await api<{ ok: boolean; message: string }>("/api/jira/sync", { method: "POST" });
    notify(r.message);
    await reload();
    await load();
  });
  const disconnect = () => run(async () => {
    if (demo) { notify("In der Demo bleibt die Verbindung bestehen."); return; }
    await api("/api/jira", { method: "DELETE" });
    notify("Verbindung mit Atlassian getrennt");
    await load();
  });

  if (!status) return <p className="muted">{error || "Lade …"}</p>;

  if (!status.configured)
    return (
      <section className="card card-pad jira-intro">
        <h3>Jira Cloud verbinden</h3>
        <p className="muted">Die Verbindung mit Atlassian ist auf dieser Installation noch nicht eingerichtet. Der Betreiber trägt dafür ATLASSIAN_CLIENT_ID und ATLASSIAN_CLIENT_SECRET ein, die Anleitung steht in docs/BETRIEB.md.</p>
      </section>
    );

  if (!status.connected)
    return (
      <section className="card card-pad jira-intro">
        <h3>Jira Cloud verbinden</h3>
        <p>Verbinde TrackInsight mit deiner Jira-Cloud-Site. Danach wählst du, welche Jira-Projekte übernommen werden. Epics werden zu Subprojekten, Issues und Story Points werden alle 15 Minuten abgeglichen und speisen Velocity und Forecast.</p>
        <p className="muted">TrackInsight liest nur. Es ändert in Jira nichts und speichert von jedem Issue nur Schlüssel, Titel, Status und Story Points.</p>
        {error && <p className="error">{error}</p>}
        <div><a className="btn primary" id="jira-connect" href="/api/jira/connect">Mit Atlassian verbinden</a></div>
      </section>
    );

  const open = (rows ?? []).filter((r) => !r.project);
  const linked = (rows ?? []).filter((r) => r.project);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section className="card card-pad jira-site">
        <div>
          <p className="muted" style={{ margin: 0, fontSize: "0.82rem" }}>Verbunden mit</p>
          <h3 style={{ margin: "2px 0 0" }}><a href={status.site!.url} target="_blank" rel="noreferrer">{status.site!.url.replace(/^https:\/\//, "")}</a></h3>
          <p className={status.lastResult && !status.lastResult.ok ? "error" : "muted"} style={{ margin: "6px 0 0", fontSize: "0.86rem" }}>
            Letzter Abgleich {when(status.lastSyncAt)}{status.lastResult ? `: ${status.lastResult.message}` : ""}
          </p>
          {status.storyPointFields === 0 && <p className="error" style={{ margin: "6px 0 0", fontSize: "0.86rem" }}>In Jira wurde kein Feld für Story Points gefunden. Issues kommen ohne Punkte an.</p>}
        </div>
        <div className="jira-actions">
          <button className="btn primary" id="jira-sync" disabled={busy} onClick={sync}>Jetzt abgleichen</button>
          <button className="btn ghost" disabled={busy} onClick={disconnect}>Trennen</button>
        </div>
      </section>
      {error && <p className="error">{error}</p>}

      <section className="card">
        <div className="card-head"><h2>Jira-Projekte</h2><span className="muted" style={{ fontSize: "0.8rem" }}>{linked.length} von {(rows ?? []).length} übernommen</span></div>
        <div className="table-wrap">
          <table className="data" id="jira-projects">
            <thead><tr><th>Schlüssel</th><th>Jira-Projekt</th><th>In TrackInsight</th><th /></tr></thead>
            <tbody>
              {linked.map((r) => (
                <tr key={r.key}>
                  <td className="mono">{r.key}</td>
                  <td>{r.name}</td>
                  <td>{r.project!.name}</td>
                  <td style={{ textAlign: "right" }}><button className="btn small ghost" disabled={busy} onClick={() => unlink(r)}>Lösen</button></td>
                </tr>
              ))}
              {open.map((r) => (
                <tr key={r.key}>
                  <td className="mono">{r.key}</td>
                  <td>{r.name}</td>
                  <td style={{ minWidth: 240 }}><Select small id={`jira-target-${r.key}`} value={choice[r.key] ?? ""} onChange={(v) => setChoice({ ...choice, [r.key]: v })} options={targets} placeholder="Nicht übernehmen" ariaLabel={`Ziel für ${r.key}`} /></td>
                  <td style={{ textAlign: "right" }}><button className="btn small" disabled={busy || !choice[r.key]} onClick={() => link(r)}>Übernehmen</button></td>
                </tr>
              ))}
              {!rows?.length && <tr><td colSpan={4} className="muted">In dieser Jira-Site gibt es keine Projekte, auf die du Zugriff hast.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ margin: 0, padding: "12px 16px", fontSize: "0.82rem" }}>Ein neues Projekt startet mit Budget 0. Budgets pro Projekt und Subprojekt trägst du unter Kunden & Projekte ein.</p>
      </section>
    </div>
  );
}
