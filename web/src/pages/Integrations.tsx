import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { Field, FormDialog } from "../ui/Dialog";
import { Icon } from "../ui/components";
import { intlLocale, tr } from "../i18n";

interface KeyRow { id: string; name: string; prefix: string; scope: "read" | "write"; createdAt: string; lastUsedAt: string | null }
interface HookRow { id: string; url: string; description: string | null; events: string[]; active: boolean; failures: number; lastStatus: number | null; lastDeliveryAt: string | null; secret: string }
interface Delivery { id: string; event: string; createdAt: string; attempts: number; nextAttemptAt: string; deliveredAt: string | null; failedAt: string | null; lastStatus: number | null; lastError: string | null }
interface State { events: string[]; keys: KeyRow[]; webhooks: HookRow[] }

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(intlLocale, { dateStyle: "short", timeStyle: "short" }) : "–");
const GROUP_LABEL: Record<string, string> = { time_entry: tr("Buchungen"), expense: tr("Spesen"), absence: tr("Absenzen"), month: tr("Monatsabschluss"), invoice: tr("Rechnungen") };

/** Settings → API: keys for the public API and webhooks for events. */
export function IntegrationsTab() {
  const { mode, notify } = useStore();
  const [s, setS] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [newKey, setNewKey] = useState(false);
  const [shown, setShown] = useState<{ name: string; key: string } | null>(null);
  const [hookDialog, setHookDialog] = useState(false);
  const [log, setLog] = useState<{ hook: HookRow; rows: Delivery[] } | null>(null);
  const load = () => api<State>("/api/integrations").then(setS).catch((e) => setError((e as Error).message));
  useEffect(() => { if (mode === "api") void load(); }, [mode]);

  if (mode === "demo")
    return (
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h3 style={{ margin: 0 }}>{tr("Offene API und Webhooks")}</h3>
        <p className="explain" style={{ margin: 0 }}>{tr("In der installierten Version erstellt ein Admin hier API-Schlüssel (nur lesen oder lesen und schreiben) und Webhooks. Damit lesen andere Systeme Kunden, Projekte, Buchungen, Spesen, Absenzen, Budgets und Rechnungen, legen Buchungen an und erhalten jede Änderung sofort als signierte Nachricht.")}</p>
        <p className="muted" style={{ margin: 0, fontSize: "0.86rem" }}>{tr("Beschreibung der Schnittstelle: /api/v1/openapi.json und docs/API.md. Im Paket Business enthalten.")}</p>
        <p className="muted" style={{ margin: 0, fontSize: "0.86rem" }}>{tr("Für Power BI gibt es hier eine fertige Vorlage mit allen Abfragen (docs/POWERBI.md).")}</p>
      </section>
    );
  if (!s) return <p className={error ? "error" : "muted"}>{error || tr("Lade …")}</p>;

  const run = async (fn: () => Promise<unknown>, msg?: string) => {
    try { await fn(); setError(""); if (msg) notify(msg); await load(); } catch (e) { setError((e as Error).message); }
  };
  const copy = (text: string) => { void navigator.clipboard?.writeText(text); notify(tr("Kopiert")); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {error && <p className="error">{error}</p>}
      <section className="card">
        <div className="card-head"><h2>{tr("API-Schlüssel")}</h2><button id="api-key-new" className="btn small" onClick={() => setNewKey(true)}>{tr("+ Schlüssel")}</button></div>
        <p className="explain" style={{ margin: 0, padding: "0 16px 12px" }}>{tr("Ein Schlüssel handelt mit deinen Rechten als Admin. Er gilt für /api/v1, als Kopfzeile «Authorization: Bearer …». Beschreibung: /api/v1/openapi.json.")}</p>
        <div className="table-wrap">
          <table className="data" id="api-keys">
            <thead><tr><th>{tr("Name")}</th><th>{tr("Schlüssel")}</th><th>{tr("Rechte")}</th><th>{tr("Erstellt")}</th><th>{tr("Zuletzt benutzt")}</th><th /></tr></thead>
            <tbody>
              {s.keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td className="mono">{k.prefix}…</td>
                  <td>{k.scope === "write" ? tr("Lesen und schreiben") : tr("Nur lesen")}</td>
                  <td className="num">{when(k.createdAt)}</td>
                  <td className="num">{when(k.lastUsedAt)}</td>
                  <td style={{ textAlign: "right" }}><button className="btn small ghost" onClick={() => { if (confirm(tr("Schlüssel «{0}» widerrufen? Systeme, die ihn benutzen, verlieren sofort den Zugang.", k.name))) void run(() => api(`/api/integrations/keys/${k.id}`, { method: "DELETE" }), tr("Schlüssel widerrufen")); }}>{tr("Widerrufen")}</button></td>
                </tr>
              ))}
              {!s.keys.length && <tr><td colSpan={6} className="muted">{tr("Noch kein Schlüssel.")}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card card-pad" id="powerbi" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h3 style={{ margin: 0 }}>{tr("Power BI")}</h3>
        <p className="explain" style={{ margin: 0 }}>{tr("Vorlage mit allen Abfragen (Kunden, Projekte, Buchungen, Spesen, Absenzen, Budgets mit Forecast, Rechnungen) für Power BI Desktop. Adresse ist eingetragen, den Schlüssel (nur lesen) fügst du ein. Anleitung im Kopf der Datei.")}</p>
        <div><a className="btn small" id="powerbi-download" href="/api/integrations/powerbi" download>{tr("Power-BI-Vorlage herunterladen")}</a></div>
      </section>

      <section className="card">
        <div className="card-head"><h2>{tr("Webhooks")}</h2><button id="webhook-new" className="btn small" onClick={() => setHookDialog(true)}>{tr("+ Webhook")}</button></div>
        <p className="explain" style={{ margin: 0, padding: "0 16px 12px" }}>{tr("Bei jeder Änderung schickt TrackInsight ein JSON per HTTPS POST an die Adresse. Die Kopfzeile TrackInsight-Signature enthält eine HMAC-SHA256-Signatur mit dem Geheimnis des Webhooks. Fehlgeschlagene Zustellungen werden bis zu einem Tag lang wiederholt.")}</p>
        <div className="table-wrap">
          <table className="data" id="webhooks">
            <thead><tr><th>{tr("Adresse")}</th><th>{tr("Ereignisse")}</th><th>{tr("Status")}</th><th>{tr("Letzte Zustellung")}</th><th /></tr></thead>
            <tbody>
              {s.webhooks.map((h) => (
                <tr key={h.id}>
                  <td><div className="mono" style={{ wordBreak: "break-all" }}>{h.url}</div>{h.description && <div className="muted" style={{ fontSize: "0.78rem" }}>{h.description}</div>}</td>
                  <td style={{ fontSize: "0.82rem" }}>{h.events.includes("*") ? tr("Alle") : h.events.join(", ")}</td>
                  <td>{h.active ? <span className={`pill ${h.failures ? "risk" : "ok"}`}>{h.failures ? tr("{0} Fehler", h.failures) : tr("Aktiv")}</span> : <span className="pill neutral">{tr("Aus")}</span>}</td>
                  <td className="num">{when(h.lastDeliveryAt)}{h.lastStatus ? ` · ${h.lastStatus}` : ""}</td>
                  <td>
                    <div className="closing-actions">
                      <button className="btn small" onClick={() => void run(async () => { const r = await api<{ ok: boolean; status: number; error: string | null }>(`/api/integrations/webhooks/${h.id}/test`, { body: {} }); notify(r.ok ? tr("Test zugestellt (HTTP {0})", r.status) : tr("Test fehlgeschlagen: {0}", r.error ?? "")); })}>{tr("Testen")}</button>
                      <button className="btn small ghost" onClick={() => copy(h.secret)} title={tr("Geheimnis zum Prüfen der Signatur kopieren")}>{tr("Geheimnis")}</button>
                      <button className="btn small ghost" onClick={() => void api<Delivery[]>(`/api/integrations/webhooks/${h.id}/deliveries`).then((rows) => setLog({ hook: h, rows }))}>{tr("Verlauf")}</button>
                      <button className="btn small ghost" onClick={() => void run(() => api(`/api/integrations/webhooks/${h.id}`, { method: "PATCH", body: { active: !h.active } }), h.active ? tr("Webhook ausgeschaltet") : tr("Webhook eingeschaltet"))}>{h.active ? tr("Ausschalten") : tr("Einschalten")}</button>
                      <button className="btn small ghost" aria-label={tr("{0} entfernen", h.url)} onClick={() => { if (confirm(tr("Webhook an {0} entfernen?", h.url))) void run(() => api(`/api/integrations/webhooks/${h.id}`, { method: "DELETE" }), tr("Webhook entfernt")); }}><Icon.trash /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {!s.webhooks.length && <tr><td colSpan={5} className="muted">{tr("Noch kein Webhook.")}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {newKey && <KeyDialog onClose={() => setNewKey(false)} onCreated={(name, key) => { setShown({ name, key }); void load(); }} />}
      {shown && (
        <FormDialog id="api-key-shown" title={tr("Schlüssel «{0}»", shown.name)} subtitle={tr("Jetzt kopieren und sicher ablegen. TrackInsight speichert nur einen Fingerabdruck und kann den Schlüssel nicht noch einmal zeigen.")} submitLabel={tr("Kopiert, schliessen")} onClose={() => setShown(null)} onSubmit={() => setShown(null)}>
          <div style={{ display: "flex", gap: 8 }}>
            <input id="api-key-value" className="input mono" readOnly value={shown.key} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1 }} />
            <button type="button" className="btn" onClick={() => copy(shown.key)}>{tr("Kopieren")}</button>
          </div>
        </FormDialog>
      )}
      {hookDialog && <HookDialog events={s.events} onClose={() => setHookDialog(false)} onSaved={() => { notify(tr("Webhook angelegt")); void load(); }} />}
      {log && (
        <FormDialog id="webhook-log" wide readOnly title={tr("Verlauf")} subtitle={log.hook.url} onClose={() => setLog(null)} onSubmit={() => setLog(null)}>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{tr("Zeit")}</th><th>{tr("Ereignis")}</th><th className="r">{tr("Versuche")}</th><th>{tr("Ergebnis")}</th></tr></thead>
              <tbody>
                {log.rows.map((d) => (
                  <tr key={d.id}>
                    <td className="num">{when(d.createdAt)}</td>
                    <td className="mono">{d.event}</td>
                    <td className="r num">{d.attempts}</td>
                    <td>{d.deliveredAt ? tr("Zugestellt ({0})", d.lastStatus ?? "") : d.failedAt ? tr("Aufgegeben: {0}", d.lastError ?? "") : d.attempts ? tr("Neuer Versuch {0}: {1}", when(d.nextAttemptAt), d.lastError ?? "") : tr("Wartet")}</td>
                  </tr>
                ))}
                {!log.rows.length && <tr><td colSpan={4} className="muted">{tr("Noch keine Zustellungen.")}</td></tr>}
              </tbody>
            </table>
          </div>
        </FormDialog>
      )}
    </div>
  );
}

function KeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string, key: string) => void }) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  return (
    <FormDialog
      id="api-key-dialog"
      title={tr("Neuer API-Schlüssel")}
      onClose={onClose}
      submitLabel={tr("Erstellen")}
      onSubmit={async () => {
        if (!name.trim()) return { name: tr("Name fehlt") };
        const r = await api<{ key: string; name: string }>("/api/integrations/keys", { body: { name: name.trim(), scope } });
        onClose();
        onCreated(r.name, r.key);
      }}
    >
      <Field label={tr("Name")} name="name" required hint={tr("Wofür der Schlüssel ist, z. B. Power BI oder Ticketsystem.")}><input id="api-key-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label={tr("Rechte")}>
        <div className="seg" role="radiogroup">
          <button type="button" role="radio" aria-checked={scope === "read"} className={scope === "read" ? "on" : ""} onClick={() => setScope("read")}>{tr("Nur lesen")}</button>
          <button type="button" role="radio" aria-checked={scope === "write"} className={scope === "write" ? "on" : ""} onClick={() => setScope("write")}>{tr("Lesen und schreiben")}</button>
        </div>
      </Field>
    </FormDialog>
  );
}

function HookDialog({ events, onClose, onSaved }: { events: string[]; onClose: () => void; onSaved: () => void }) {
  const [url, setUrl] = useState("https://");
  const [description, setDescription] = useState("");
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const groups = [...new Set(events.map((e) => e.split(".")[0]!))];
  return (
    <FormDialog
      id="webhook-dialog"
      title={tr("Neuer Webhook")}
      wide
      onClose={onClose}
      submitLabel={tr("Anlegen")}
      onSubmit={async () => {
        const e: Record<string, string> = {};
        if (!/^https:\/\/.+\..+/.test(url.trim())) e.url = tr("Die Webhook-URL muss mit https:// beginnen.");
        if (!all && !picked.length) e.events = tr("Mindestens ein Ereignis wählen.");
        if (Object.keys(e).length) return e;
        await api("/api/integrations/webhooks", { body: { url: url.trim(), description: description.trim() || undefined, events: all ? ["*"] : picked } });
        onClose();
        onSaved();
      }}
    >
      <Field label={tr("Adresse")} name="url" required><input id="webhook-url" className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} /></Field>
      <Field label={tr("Beschreibung")}><input id="webhook-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label={tr("Ereignisse")} name="events">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> {tr("Alle Ereignisse, auch künftige")}</label>
          {!all && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "6px 16px" }}>
              {groups.map((g) => (
                <div key={g}>
                  <strong style={{ fontSize: "0.82rem" }}>{GROUP_LABEL[g] ?? g}</strong>
                  {events.filter((e) => e.startsWith(`${g}.`)).map((e) => (
                    <label key={e} className="check mono" style={{ display: "block", fontSize: "0.8rem" }}>
                      <input type="checkbox" checked={picked.includes(e)} onChange={(ev) => setPicked(ev.target.checked ? [...picked, e] : picked.filter((x) => x !== e))} /> {e}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </Field>
    </FormDialog>
  );
}
