import { useMemo, useState } from "react";
import { currentVelocity, fmt1, fmtCHF, fmtMonth, fmtMonthLong, fmtNum, velocityBreakdown, velocityByMonth, type VelocityGroup } from "@taktwerk/domain";
import { useStore } from "../store";
import { Select } from "../ui/Select";
import { VelocityChart } from "../ui/charts";
import { tr } from "../i18n";

export function Velocity() {
  const { data, velocity: all, factor: allFactor, velocitySettings, setVelocitySettings, reports } = useStore();
  const [teamId, setTeamId] = useState("");
  const velocity = useMemo(() => (teamId ? velocityByMonth(data, velocitySettings, teamId) : all), [teamId, data, velocitySettings, all]);
  const factor = teamId ? currentVelocity(velocity, velocitySettings) : allFactor;
  const breakdown = useMemo(() => velocityBreakdown(data, velocitySettings.window), [data, velocitySettings.window]);
  const teamName = new Map(data.teams.map((t) => [t.id, t.name]));
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
          {data.teams.length > 1 && <div style={{ width: 200 }}><Select id="v-team" value={teamId} onChange={setTeamId} options={[{ value: "", label: tr("Alle Teams") }, ...data.teams.map((t) => ({ value: t.id, label: t.name }))]} /></div>}
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
        <GroupTable title={tr("Teams im Vergleich")} rows={breakdown.teams} overall={breakdown.overall.hoursPerSp} from={breakdown.from} to={breakdown.to} id="v-teams" />
        <GroupTable title={tr("Nach Issue-Typ")} rows={breakdown.types} overall={breakdown.overall.hoursPerSp} from={breakdown.from} to={breakdown.to} id="v-types" />
      </div>

      <section className="card" id="v-outliers">
        <div className="card-head">
          <h2>{tr("Ausreisser")}</h2>
          <span className="muted" style={{ fontSize: "0.8rem" }}>{tr("Issues mit mindestens 1.8-mal mehr oder weniger Stunden pro SP als der Schnitt von {0}", breakdown.overall.hoursPerSp ? `${fmt1(breakdown.overall.hoursPerSp)} h/SP` : "–")}</span>
        </div>
        {breakdown.outliers.length === 0 ? (
          <p className="muted card-pad" style={{ margin: 0 }}>{tr("Keine Ausreisser im Fenster. Die Schätzungen treffen den Aufwand gut.")}</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{tr("Issue")}</th><th>{tr("Typ")}</th><th>{tr("Team")}</th><th className="r">{tr("SP")}</th><th className="r">{tr("Stunden")}</th><th className="r">{tr("h/SP")}</th><th className="r">{tr("vs. Schnitt")}</th></tr></thead>
              <tbody>
                {breakdown.outliers.slice(0, 12).map((o) => (
                  <tr key={o.key}>
                    <td><span className="mono">{o.key}</span>{" "}<span className="muted">{o.summary}</span></td>
                    <td>{o.issueType}</td>
                    <td>{o.teamId ? teamName.get(o.teamId) ?? "–" : "–"}</td>
                    <td className="r num">{fmtNum(o.storyPoints)}</td>
                    <td className="r num">{fmt1(o.hours)}</td>
                    <td className="r num">{fmt1(o.hoursPerSp)}</td>
                    <td className={`r num ${o.ratio > 1 ? "neg" : "pos"}`}>{o.ratio > 1 ? tr("{0}× teurer", fmt1(o.ratio)) : tr("{0}× günstiger", fmt1(1 / o.ratio))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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

/** Hours per SP of a group (team or issue type) over the window, with the window before as trend. */
function GroupTable({ title, rows, overall, from, to, id }: { title: string; rows: VelocityGroup[]; overall: number | null; from: string; to: string; id: string }) {
  return (
    <section className="card" id={id}>
      <div className="card-head">
        <h2>{title}</h2>
        <span className="muted" style={{ fontSize: "0.8rem" }}>{from === to ? fmtMonth(from) : `${fmtMonth(from)} – ${fmtMonth(to)}`}</span>
      </div>
      {rows.length === 0 ? <p className="muted card-pad" style={{ margin: 0 }}>{tr("Noch keine erledigten Issues im Fenster.")}</p> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>{title === tr("Nach Issue-Typ") ? tr("Typ") : tr("Team")}</th><th className="r">{tr("Issues")}</th><th className="r">{tr("SP")}</th><th className="r">{tr("h/SP")}</th><th className="r">{tr("Vorher")}</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const off = r.hoursPerSp !== null && overall ? r.hoursPerSp / overall : 1;
                const trend = r.hoursPerSp !== null && r.previous !== null ? r.hoursPerSp - r.previous : null;
                return (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td className="r num">{fmtNum(r.issues)}</td>
                    <td className="r num">{fmtNum(r.storyPoints)}</td>
                    <td className={`r num ${off > 1.15 ? "neg" : off < 0.87 ? "pos" : ""}`}><strong>{r.hoursPerSp !== null ? fmt1(r.hoursPerSp) : "–"}</strong></td>
                    <td className="r num muted">{r.previous !== null ? fmt1(r.previous) : "–"}{trend !== null && Math.abs(trend) >= 0.1 && <span className={trend > 0 ? "neg" : "pos"}>{" "}{trend > 0 ? "↑" : "↓"}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
