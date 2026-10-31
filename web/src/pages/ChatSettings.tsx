import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { tr } from "../i18n";

interface ChatState {
  slack: { configured: boolean; url: string };
  teams: { configured: boolean; url: string };
  linked: number;
}

const DEMO: ChatState = {
  slack: { configured: true, url: "https://beispiel.trackinsight.app/api/chat/slack/o1" },
  teams: { configured: false, url: "https://beispiel.trackinsight.app/api/chat/teams/o1" },
  linked: 4,
};

/** Settings → Chat: booking from Slack (slash command) and Microsoft Teams (outgoing webhook). */
export function ChatTab() {
  const { mode, notify } = useStore();
  const demo = mode === "demo";
  const [s, setS] = useState<ChatState | null>(demo ? DEMO : null);
  const [slack, setSlack] = useState("");
  const [teams, setTeams] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (demo) setS(DEMO);
    else api<ChatState>("/api/chat").then(setS).catch((e) => setError((e as Error).message));
  }, [demo]);
  if (!s) return <p className={error ? "error" : "muted"}>{error || tr("Lade …")}</p>;

  const copy = (text: string) => { void navigator.clipboard?.writeText(text); notify(tr("Kopiert")); };
  const save = async (body: { slackSigningSecret?: string; teamsSecret?: string }, msg: string) => {
    if (demo) return notify(tr("Im Prototyp wird nichts gespeichert."));
    try {
      setS(await api<ChatState>("/api/chat", { method: "PUT", body }));
      setSlack("");
      setTeams("");
      setError("");
      notify(msg);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const Url = ({ value }: { value: string }) => (
    <div className="sso-row"><span className="muted">{tr("Adresse")}</span><code>{value}</code><button type="button" className="btn small" onClick={() => copy(value)}>{tr("Kopieren")}</button></div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {error && <p className="error">{error}</p>}
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h3 style={{ margin: 0 }}>{tr("Aus dem Chat buchen")}</h3>
        <p className="explain" style={{ margin: 0 }}>{tr("Alle buchen mit einer Zeile, ohne die App zu öffnen: «2h Muster Website Startseite überarbeitet». «heute» und «woche» zeigen die eigenen Stunden. Beim ersten Mal kommt ein Link, mit dem jede Person ihr Chat-Konto einmal verbindet.")}</p>
        <p className="muted" style={{ margin: 0, fontSize: "0.86rem" }}>{tr("Verbundene Chat-Konten: {0}", s.linked)}</p>
      </section>

      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="card-head" style={{ padding: 0 }}><h3 style={{ margin: 0 }}>{tr("Slack")}</h3>{s.slack.configured && <span className="pill ok">{tr("eingerichtet")}</span>}</div>
        <ol className="explain" style={{ margin: 0, paddingLeft: 18 }}>
          <li>{tr("api.slack.com/apps → Create New App → From scratch, im eigenen Workspace.")}</li>
          <li>{tr("Slash Commands → Create New Command: Befehl /zeit, Request URL = diese Adresse:")}</li>
        </ol>
        <Url value={s.slack.url} />
        <ol className="explain" start={3} style={{ margin: 0, paddingLeft: 18 }}>
          <li>{tr("Basic Information → Signing Secret kopieren und hier einfügen, danach die App im Workspace installieren.")}</li>
        </ol>
        <div className="export-bar">
          <label className="field" style={{ flex: 1 }}><span>{tr("Signing Secret")}</span>
            <input id="chat-slack" className="input" autoComplete="off" placeholder={s.slack.configured ? "••••••••" : ""} value={slack} onChange={(e) => setSlack(e.target.value)} />
          </label>
          <button className="btn primary" disabled={!slack.trim()} onClick={() => save({ slackSigningSecret: slack.trim() }, tr("Slack verbunden"))}>{tr("Speichern")}</button>
          {s.slack.configured && <button className="btn" onClick={() => save({ slackSigningSecret: "" }, tr("Slack getrennt"))}>{tr("Trennen")}</button>}
        </div>
      </section>

      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="card-head" style={{ padding: 0 }}><h3 style={{ margin: 0 }}>{tr("Microsoft Teams")}</h3>{s.teams.configured && <span className="pill ok">{tr("eingerichtet")}</span>}</div>
        <ol className="explain" style={{ margin: 0, paddingLeft: 18 }}>
          <li>{tr("Im Team → Apps verwalten → Ausgehenden Webhook erstellen. Name «TrackInsight», Rückruf-URL = diese Adresse:")}</li>
        </ol>
        <Url value={s.teams.url} />
        <ol className="explain" start={2} style={{ margin: 0, paddingLeft: 18 }}>
          <li>{tr("Das angezeigte Sicherheitstoken hier einfügen. Gebucht wird mit «@TrackInsight 2h Muster Website Text» im Kanal.")}</li>
        </ol>
        <div className="export-bar">
          <label className="field" style={{ flex: 1 }}><span>{tr("Sicherheitstoken")}</span>
            <input id="chat-teams" className="input" autoComplete="off" placeholder={s.teams.configured ? "••••••••" : ""} value={teams} onChange={(e) => setTeams(e.target.value)} />
          </label>
          <button className="btn primary" disabled={!teams.trim()} onClick={() => save({ teamsSecret: teams.trim() }, tr("Teams verbunden"))}>{tr("Speichern")}</button>
          {s.teams.configured && <button className="btn" onClick={() => save({ teamsSecret: "" }, tr("Teams getrennt"))}>{tr("Trennen")}</button>}
        </div>
      </section>
    </div>
  );
}
