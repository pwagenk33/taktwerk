// Operator console: response times and recent errors of this installation (GET /api/platform/monitor).
import { fmtDate } from "@taktwerk/domain";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { tr } from "../i18n";

interface MonitorData {
  hours: number;
  requests: number;
  serverErrors: number;
  p50: number;
  p95: number;
  slowest: { route: string; count: number; p50: number; p95: number }[];
  perHour: { hour: string; requests: number; errors: number }[];
  errors: { at: string; source: "server" | "app"; route: string; message: string; detail?: string; version?: string }[];
}

function demoData(): MonitorData {
  const now = Date.now();
  const perHour = Array.from({ length: 24 }, (_, i) => {
    const h = new Date(now - (24 - i) * 3600_000);
    const office = h.getHours() >= 7 && h.getHours() <= 18 ? 1 : 0.1;
    return { hour: h.toISOString(), requests: Math.round(office * (380 + ((i * 37) % 120))), errors: i === 15 ? 2 : 0 };
  });
  return {
    hours: 24,
    requests: perHour.reduce((s, h) => s + h.requests, 0),
    serverErrors: 2,
    p50: 18,
    p95: 140,
    slowest: [
      { route: "GET /api/dataset", count: 312, p50: 96, p95: 240 },
      { route: "GET /api/reports", count: 58, p50: 70, p95: 180 },
      { route: "GET /api/export/time-entries", count: 9, p50: 120, p95: 160 },
      { route: "POST /api/time-entries", count: 1840, p50: 14, p95: 38 },
    ],
    perHour,
    errors: [
      { at: new Date(now - 9 * 3600_000).toISOString(), source: "server", route: "POST /api/invoices/:id/bexio", message: tr("bexio antwortet nicht (Zeitüberschreitung)") },
      { at: new Date(now - 9.2 * 3600_000).toISOString(), source: "app", route: "#reports", message: "TypeError: Cannot read properties of undefined (reading 'budget')", version: __BUILD__.version },
    ],
  };
}

const ms = (v: number) => `${v} ms`;

export function MonitorCard() {
  const { mode } = useStore();
  const [data, setData] = useState<MonitorData | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const load = () => (mode === "api" ? api<MonitorData>("/api/platform/monitor").then(setData).catch((e: Error) => setError(e.message)) : setData(demoData()));
  useEffect(() => { void load(); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <section className="card card-pad"><p className="muted" style={{ margin: 0 }}>{error || tr("Lade …")}</p></section>;
  const max = Math.max(1, ...data.perHour.map((h) => h.requests));
  const errorRate = data.requests ? (data.serverErrors / data.requests) * 100 : 0;
  return (
    <section className="card" id="monitor">
      <div className="card-head">
        <h2>{tr("Betrieb: letzte 24 Stunden")}</h2>
        <button className="btn small ghost" onClick={() => void load()}>{tr("Aktualisieren")}</button>
      </div>
      <div className="card-pad" style={{ paddingTop: 10 }}>
        <div className="mon-figures">
          <div><span className="eyebrow">{tr("Anfragen")}</span><strong className="num">{data.requests.toLocaleString("de-CH")}</strong></div>
          <div><span className="eyebrow">{tr("Antwortzeit Median")}</span><strong className="num">{ms(data.p50)}</strong></div>
          <div><span className="eyebrow">{tr("95 % schneller als")}</span><strong className="num">{ms(data.p95)}</strong></div>
          <div><span className="eyebrow">{tr("Serverfehler")}</span><strong className={`num ${data.serverErrors ? "bad" : ""}`}>{data.serverErrors}</strong><small className="muted">{errorRate ? `${errorRate.toFixed(2)} %` : tr("keine")}</small></div>
        </div>
        <div className="mon-bars" role="img" aria-label={tr("Anfragen pro Stunde")}>
          {data.perHour.map((h) => (
            <span key={h.hour} title={tr("{0} Uhr: {1} Anfragen, {2} Fehler", new Date(h.hour).getHours(), h.requests, h.errors)} className={h.errors ? "err" : ""} style={{ height: `${Math.max(2, (h.requests / max) * 100)}%` }} />
          ))}
        </div>
        <p className="muted" style={{ fontSize: "0.78rem", margin: "6px 0 18px" }}>{tr("Anfragen pro Stunde, rot mit Serverfehlern. Die Zahlen beginnen bei jedem Neustart von vorn.")}</p>

        <h3 className="mon-h">{tr("Langsamste Endpunkte")}</h3>
        {data.slowest.length === 0 ? <p className="muted">{tr("Noch zu wenige Anfragen.")}</p> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{tr("Endpunkt")}</th><th className="r">{tr("Aufrufe")}</th><th className="r">{tr("Median")}</th><th className="r">{tr("95 %")}</th></tr></thead>
              <tbody>{data.slowest.map((r) => <tr key={r.route}><td className="mono">{r.route}</td><td className="r num">{r.count}</td><td className="r num">{ms(r.p50)}</td><td className="r num">{ms(r.p95)}</td></tr>)}</tbody>
            </table>
          </div>
        )}

        <h3 className="mon-h">{tr("Letzte Fehler")}</h3>
        {data.errors.length === 0 ? <p className="muted">{tr("Keine Fehler in den letzten 24 Stunden.")}</p> : (
          <ul className="mon-errors">
            {data.errors.map((e, i) => (
              <li key={i}>
                <button className="mon-err" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                  <span className={`pill ${e.source === "server" ? "over" : "risk"}`}>{e.source === "server" ? tr("Server") : tr("App")}</span>
                  <span className="mono">{e.route}</span>
                  <span className="msg">{e.message}</span>
                  <span className="muted when">{fmtDate(e.at.slice(0, 10))}{" "}{new Date(e.at).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" })}</span>
                </button>
                {open === i && (e.detail || e.version) && <pre className="mon-detail">{e.version ? `${tr("Version")} ${e.version}\n` : ""}{e.detail ?? ""}</pre>}
              </li>
            ))}
          </ul>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </section>
  );
}
