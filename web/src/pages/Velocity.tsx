import { fmt1, fmtCHF, fmtMonthLong, fmtNum } from "@taktwerk/domain";
import { useStore } from "../store";
import { VelocityChart } from "../ui/components";
import { tr } from "../i18n";

export function Velocity() {
  const { velocity, factor, velocitySettings, setVelocitySettings, reports } = useStore();
  const first = velocity.find((m) => m.smoothed !== null);
  const spOpen = reports.reduce((s, r) => s + r.spOpen, 0);
  const remaining = reports.reduce((s, r) => s + r.remainingHours, 0);
  const forecastDelta = reports.reduce((s, r) => s + r.forecastCost - r.actualCost, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{tr("Team-Velocity")}</h1>
          <p className="sub">{tr("Stunden pro Story Point, berechnet aus erledigten JIRA-Issues und den darauf gebuchten Stunden.")}</p>
        </div>
        <div className="toolbar">
          <div className="seg" aria-label={tr("Methode")}>
            <button className={velocitySettings.method === "rolling" ? "on" : ""} onClick={() => setVelocitySettings({ ...velocitySettings, method: "rolling" })}>{tr("Gleitender Schnitt")}</button>
            <button className={velocitySettings.method === "ewma" ? "on" : ""} onClick={() => setVelocitySettings({ ...velocitySettings, method: "ewma" })}>{tr("EWMA")}</button>
          </div>
          <div className="seg" aria-label={tr("Fenster")}>
            {[2, 3, 4, 6].map((w) => (
              <button key={w} className={velocitySettings.window === w ? "on" : ""} onClick={() => setVelocitySettings({ ...velocitySettings, window: w })}>{w}{" "}{tr("Mt.")}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="tiles">
        <div className="card tile">
          <span className="label">{tr("Aktueller Faktor")}</span>
          <span className="value num">{factor ? `${fmt1(factor.current)} h/SP` : "–"}</span>
          <span className="delta">{tr("Stand")}{" "}{factor ? fmtMonthLong(factor.asOf) : "–"}</span>
        </div>
        <div className="card tile">
          <span className="label">{tr("Bandbreite im Fenster")}</span>
          <span className="value num">{factor ? `${fmt1(factor.low)}–${fmt1(factor.high)}` : "–"}</span>
          <span className="delta">{tr("tiefster und höchster Monatswert")}</span>
        </div>
        <div className="card tile">
          <span className="label">{tr("Start der Messung")}</span>
          <span className="value num">{first?.smoothed ? `${fmt1(first.smoothed)} h/SP` : "–"}</span>
          <span className="delta">{first ? fmtMonthLong(first.month) : ""}</span>
        </div>
        <div className="card tile">
          <span className="label">{tr("Auswirkung auf Forecast")}</span>
          <span className="value num">{fmtNum(remaining)}{" "}{tr("h")}</span>
          <span className="delta">{tr("für {0} offene SP · {1} Restkosten", fmtNum(spOpen), fmtCHF(forecastDelta))}</span>
        </div>
      </div>

      <section className="card" style={{ height: 360, display: "flex", flexDirection: "column", paddingBottom: 8 }}>
        <div className="card-head"><h2>{tr("Verlauf pro Monat")}</h2></div>
        <VelocityChart months={velocity} />
      </section>

      <div className="grid-2" style={{ alignItems: "start" }}>
        <section className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>{tr("Monat")}</th><th className="r">{tr("Erledigte SP")}</th><th className="r">{tr("Stunden")}</th><th className="r">{tr("h/SP")}</th><th className="r">{tr("Geglättet")}</th></tr>
              </thead>
              <tbody>
                {[...velocity].reverse().map((m) => (
                  <tr key={m.month}>
                    <td>{fmtMonthLong(m.month)}{m.partial && <span className="pill neutral" style={{ marginLeft: 6 }}>{tr("laufend")}</span>}</td>
                    <td className="r">{fmtNum(m.storyPoints)}</td>
                    <td className="r">{fmtNum(m.hours)}</td>
                    <td className="r">{m.hoursPerSp ? fmt1(m.hoursPerSp) : "–"}</td>
                    <td className="r"><strong>{m.smoothed ? fmt1(m.smoothed) : "–"}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card card-pad explain">
          <h3 style={{ marginBottom: 6 }}>{tr("Berechnung")}</h3>
          <p style={{ marginBottom: 10 }}>
            {tr("Ein Issue zählt im Monat, in dem es in JIRA auf")}{" "}<em>{tr("Done")}</em>{" "}{tr("gesetzt wurde. Dazu kommen alle Stunden, die über seine ganze Laufzeit mit diesem Issue-Schlüssel gebucht wurden. Monatsfaktor =")}{" "}<code>{tr("Σ Stunden / Σ Story Points")}</code>.
          </p>
          <p style={{ marginBottom: 10 }}>
            <strong>{tr("Gleitender Schnitt")}</strong>{" "}{tr("summiert Stunden und Story Points über die letzten N Monate und teilt erst dann. Kleine Monate verzerren den Wert dadurch nicht.")}{" "}<strong>{tr("EWMA")}</strong>{" "}{tr("gewichtet jüngere Monate stärker (α = 2 / (N + 1)) und reagiert schneller auf Veränderungen.")}
          </p>
          <p>
            {tr("Der laufende Monat wird angezeigt, fliesst aber erst nach Monatsende in den Forecast ein. Stunden ohne Issue (Meetings, Projektleitung) zählen nicht zur Velocity, sondern als Overhead-Zuschlag im Forecast.")}
          </p>
        </section>
      </div>
    </>
  );
}
