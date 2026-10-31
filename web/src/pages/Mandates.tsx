// Overview across every company the person has an account in: for fiduciaries and group controllers.
import { fmt1, fmtCHF, fmtMonthLong } from "@taktwerk/domain";
import { useEffect, useState } from "react";
import { api } from "../api";
import { tr } from "../i18n";
import { useStore } from "../store";

interface Mandate {
  organizationId: string;
  name: string;
  role: string;
  current: boolean;
  people: number;
  month: string;
  hours: number;
  approved: number;
  openInvoices: number;
  openAmount: number;
  overdue: number;
  atRisk: number | null;
}

const ROLE: Record<string, string> = { admin: "Admin", consultant: "Consultant", employee: "Mitarbeitende", auditor: "Treuhand (nur lesen)" };

/** Prototype: three example companies so the view can be tried without accounts. */
function demoMandates(today: string): Mandate[] {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  return [
    { organizationId: "demo-1", name: "Beispiel AG", role: "admin", current: true, people: 7, month: prev, hours: 1012.5, approved: 5, openInvoices: 3, openAmount: 48215.4, overdue: 1, atRisk: 2 },
    { organizationId: "demo-2", name: "Schreinerei Holzer GmbH", role: "auditor", current: false, people: 12, month: prev, hours: 1840, approved: 12, openInvoices: 1, openAmount: 6120, overdue: 0, atRisk: 0 },
    { organizationId: "demo-3", name: "Studio Nord Sagl", role: "auditor", current: false, people: 4, month: prev, hours: 512.25, approved: 2, openInvoices: 4, openAmount: 21980.5, overdue: 3, atRisk: 1 },
  ];
}

export function Mandates() {
  const { mode, data, notify } = useStore();
  const [rows, setRows] = useState<Mandate[] | null>(mode === "demo" ? demoMandates(data.today) : null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (mode === "demo") return;
    api<{ mandates: Mandate[] }>("/api/mandates").then((r) => setRows(r.mandates)).catch((e: Error) => setError(e.message));
  }, [mode]);

  const open = async (m: Mandate) => {
    if (m.current) return void (location.hash = "#eingang");
    if (mode === "demo") return notify(tr("Im Prototyp nicht verfügbar"));
    try {
      const res = await api<{ ok: boolean; redirect?: string }>("/api/auth/switch", { body: { organizationId: m.organizationId } });
      if (res.redirect) location.href = res.redirect;
      else location.replace("/#eingang");
    } catch (err) {
      notify((err as Error).message);
    }
  };

  const attention = rows?.filter((m) => m.approved < m.people || m.overdue > 0 || (m.atRisk ?? 0) > 0).length ?? 0;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{tr("Alle Firmen")}</h1>
          <p className="sub">{rows ? (attention ? tr("{0} Firmen · {1} brauchen Aufmerksamkeit", rows.length, attention) : tr("{0} Firmen · alles im Lot", rows.length)) : tr("Lade …")}</p>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {rows && (
        <section className="card" id="mandates">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{tr("Firma")}</th>
                  <th className="r">{tr("Personen")}</th>
                  <th className="r">{tr("Stunden {0}", fmtMonthLong(rows[0]?.month ?? data.today.slice(0, 7)))}</th>
                  <th>{tr("Monatsabschluss")}</th>
                  <th className="r">{tr("Offene Rechnungen")}</th>
                  <th className="r">{tr("Knappe Budgets")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.organizationId}>
                    <td><strong>{m.name}</strong>{m.current && <span className="pill neutral" style={{ marginLeft: 6 }}>{tr("hier angemeldet")}</span>}<div className="muted" style={{ fontSize: "0.78rem" }}>{tr(ROLE[m.role] ?? m.role)}</div></td>
                    <td className="r num">{m.people}</td>
                    <td className="r num">{fmt1(m.hours)}</td>
                    <td>{m.approved >= m.people ? <span className="pill ok">{tr("freigegeben")}</span> : <span className="pill risk">{tr("{0} von {1} offen", m.people - m.approved, m.people)}</span>}</td>
                    <td className="r num">{m.openInvoices ? <>{fmtCHF(m.openAmount)}<div className={m.overdue ? "neg" : "muted"} style={{ fontSize: "0.78rem" }}>{m.overdue ? tr("{0} überfällig", m.overdue) : tr("{0} offen", m.openInvoices)}</div></> : "–"}</td>
                    <td className="r num">{m.atRisk === null ? "–" : m.atRisk ? <span className="pill over">{m.atRisk}</span> : "0"}</td>
                    <td className="r"><button className="btn small" onClick={() => void open(m)}>{m.current ? tr("Zum Eingang") : tr("Öffnen")}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
