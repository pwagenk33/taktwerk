import { fmt1, fmtCHF, fmtMonthLong, fmtNum } from "@taktwerk/domain";
import { useStore } from "../store";
import { VelocityChart } from "../ui/components";

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
          <h1>Team-Velocity</h1>
          <p className="sub">Stunden pro Story Point, berechnet aus erledigten JIRA-Issues und den darauf gebuchten Stunden.</p>
        </div>
        <div className="toolbar">
          <div className="seg" aria-label="Methode">
            <button className={velocitySettings.method === "rolling" ? "on" : ""} onClick={() => setVelocitySettings({ ...velocitySettings, method: "rolling" })}>Gleitender Schnitt</button>
            <button className={velocitySettings.method === "ewma" ? "on" : ""} onClick={() => setVelocitySettings({ ...velocitySettings, method: "ewma" })}>EWMA</button>
          </div>
          <div className="seg" aria-label="Fenster">
            {[2, 3, 4, 6].map((w) => (
              <button key={w} className={velocitySettings.window === w ? "on" : ""} onClick={() => setVelocitySettings({ ...velocitySettings, window: w })}>{w} Mt.</button>
            ))}
          </div>
        </div>
      </div>

      <div className="tiles">
        <div className="card tile">
          <span className="label">Aktueller Faktor</span>
          <span className="value num">{factor ? `${fmt1(factor.current)} h/SP` : "–"}</span>
          <span className="delta">Stand {factor ? fmtMonthLong(factor.asOf) : "–"}</span>
        </div>
        <div className="card tile">
          <span className="label">Bandbreite im Fenster</span>
          <span className="value num">{factor ? `${fmt1(factor.low)}–${fmt1(factor.high)}` : "–"}</span>
          <span className="delta">tiefster und höchster Monatswert</span>
        </div>
        <div className="card tile">
          <span className="label">Start der Messung</span>
          <span className="value num">{first?.smoothed ? `${fmt1(first.smoothed)} h/SP` : "–"}</span>
          <span className="delta">{first ? fmtMonthLong(first.month) : ""}</span>
        </div>
        <div className="card tile">
          <span className="label">Auswirkung auf Forecast</span>
          <span className="value num">{fmtNum(remaining)} h</span>
          <span className="delta">für {fmtNum(spOpen)} offene SP · {fmtCHF(forecastDelta)} Restkosten</span>
        </div>
      </div>

      <section className="card" style={{ height: 360, display: "flex", flexDirection: "column", paddingBottom: 8 }}>
        <div className="card-head"><h2>Verlauf pro Monat</h2></div>
        <VelocityChart months={velocity} />
      </section>

      <div className="grid-2" style={{ alignItems: "start" }}>
        <section className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Monat</th><th className="r">Erledigte SP</th><th className="r">Stunden</th><th className="r">h/SP</th><th className="r">Geglättet</th></tr>
              </thead>
              <tbody>
                {[...velocity].reverse().map((m) => (
                  <tr key={m.month}>
                    <td>{fmtMonthLong(m.month)}{m.partial && <span className="pill neutral" style={{ marginLeft: 6 }}>laufend</span>}</td>
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
          <h3 style={{ marginBottom: 6 }}>Berechnung</h3>
          <p style={{ marginBottom: 10 }}>
            Ein Issue zählt im Monat, in dem es in JIRA auf <em>Done</em> gesetzt wurde. Dazu kommen alle Stunden, die über seine ganze Laufzeit mit diesem
            Issue-Schlüssel gebucht wurden. Monatsfaktor = <code>Σ Stunden / Σ Story Points</code>.
          </p>
          <p style={{ marginBottom: 10 }}>
            <strong>Gleitender Schnitt</strong> summiert Stunden und Story Points über die letzten N Monate und teilt erst dann. Kleine Monate verzerren den Wert dadurch
            nicht. <strong>EWMA</strong> gewichtet jüngere Monate stärker (α = 2 / (N + 1)) und reagiert schneller auf Veränderungen.
          </p>
          <p>
            Der laufende Monat wird angezeigt, fliesst aber erst nach Monatsende in den Forecast ein. Stunden ohne Issue (Meetings, Projektleitung) zählen nicht zur
            Velocity, sondern als Overhead-Zuschlag im Forecast.
          </p>
        </section>
      </div>
    </>
  );
}
