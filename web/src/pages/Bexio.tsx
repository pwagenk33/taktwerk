import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { tr } from "../i18n";

export interface BexioStatus { configured: boolean; connected: { account: string | null; since: string } | null }

/** Settings → Rechnung: connect bexio; invoices then go there as drafts from Reports → Rechnungen. */
export function BexioCard() {
  const { mode, notify, role } = useStore();
  const demo = mode === "demo";
  const [s, setS] = useState<BexioStatus | null>(null);
  const [error, setError] = useState("");
  const load = () => (demo ? Promise.resolve(setS({ configured: true, connected: null })) : api<BexioStatus>("/api/bexio").then(setS).catch((e) => setError((e as Error).message)));
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const outcome = q.get("bexio");
    if (outcome === "ok") notify(tr("Mit bexio verbunden"));
    if (outcome === "fehler") setError(tr("bexio hat die Verbindung abgelehnt. Bitte nochmals versuchen."));
    if (outcome) history.replaceState(null, "", location.pathname + location.hash);
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return null;
  const disconnect = async () => {
    try { await api("/api/bexio", { method: "DELETE" }); notify(tr("Verbindung mit bexio getrennt")); void load(); } catch (e) { setError((e as Error).message); }
  };
  return (
    <section className="card card-pad" id="bexio" style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <h3 style={{ margin: 0 }}>{tr("bexio")}</h3>
      <p className="explain" style={{ margin: 0 }}>{tr("Rechnungen aus TrackInsight gehen auf Knopfdruck als Entwurf nach bexio, mit dem Kunden als Kontakt, den Positionen und dem passenden MWST-Satz. Prüfen, verbuchen und versenden geschieht danach in bexio.")}</p>
      {!s.configured ? (
        <p className="muted" style={{ margin: 0, fontSize: "0.86rem" }}>{tr("Die Verbindung mit bexio ist auf dieser Installation noch nicht eingerichtet. Der Betreiber trägt dafür BEXIO_CLIENT_ID und BEXIO_CLIENT_SECRET ein, die Anleitung steht in docs/BETRIEB.md.")}</p>
      ) : s.connected ? (
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span className="pill ok">{tr("Verbunden")}{s.connected.account ? ` · ${s.connected.account}` : ""}</span>
          {role === "admin" && <button className="btn small ghost" onClick={() => void disconnect()}>{tr("Trennen")}</button>}
        </div>
      ) : role === "admin" ? (
        <div>
          {demo ? <button className="btn" onClick={() => notify(tr("In der Demo wird keine Verbindung zu bexio aufgebaut."))}>{tr("Mit bexio verbinden")}</button> : <a className="btn" id="bexio-connect" href="/api/bexio/connect">{tr("Mit bexio verbinden")}</a>}
        </div>
      ) : (
        <p className="muted" style={{ margin: 0 }}>{tr("Ein Admin kann bexio hier verbinden.")}</p>
      )}
      {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
    </section>
  );
}

/** Whether bexio is connected, for the invoice list. */
export function useBexio() {
  const { mode } = useStore();
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (mode === "api") api<BexioStatus>("/api/bexio").then((s) => setOn(!!s.connected)).catch(() => setOn(false));
  }, [mode]);
  return on;
}
