import { useEffect, useState } from "react";
import type { Role } from "@taktwerk/domain";
import { api } from "../api";
import { loadLocal, saveLocal, useStore } from "../store";
import { Select } from "../ui/Select";
import { useTheme, type Theme } from "../theme";
import { Icon } from "../ui/components";
import { useFavorites, useLabels } from "./TimeTracking";

const ROLE_LABEL: Record<Role, string> = { admin: "Admin", consultant: "Consultant", employee: "Mitarbeitende", customer: "Kunde (Portal)" };
const THEMES: { id: Theme; label: string; hint: string; icon: () => JSX.Element }[] = [
  { id: "light", label: "Hell", hint: "Weisse Flächen, dunkle Schrift", icon: Icon.sun },
  { id: "dark", label: "Dunkel", hint: "Dunkle Flächen, helle Schrift", icon: Icon.moon },
  { id: "system", label: "Wie das System", hint: "Folgt der Einstellung von Windows oder macOS", icon: Icon.monitor },
];

function PasswordCard() {
  const { notify } = useStore();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (next !== again) return setError("Die Wiederholung stimmt nicht überein.");
    setBusy(true);
    try {
      await api("/api/auth/password/change", { body: { current, next } });
      setCurrent("");
      setNext("");
      setAgain("");
      setError("");
      notify("Passwort geändert");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2>Passwort ändern</h2>
      <div className="form-grid">
        <label className="field"><span>Aktuelles Passwort</span><input id="p-current" type="password" autoComplete="current-password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
        <label className="field"><span>Neues Passwort</span><input id="p-next" type="password" autoComplete="new-password" className="input" value={next} onChange={(e) => setNext(e.target.value)} /></label>
        <label className="field"><span>Neues Passwort wiederholen</span><input id="p-again" type="password" autoComplete="new-password" className="input" value={again} onChange={(e) => setAgain(e.target.value)} /></label>
      </div>
      <p className="muted" style={{ fontSize: "0.82rem" }}>Mindestens 10 Zeichen. Wer sich mit Microsoft oder Google anmeldet, braucht kein Passwort.</p>
      {error && <p className="error">{error}</p>}
      <div className="toolbar"><button id="p-save" className="btn primary" disabled={busy || !current || !next} onClick={save}>Passwort speichern</button></div>
    </section>
  );
}

interface Reminder {
  channel: "off" | "mail" | "teams" | "slack";
  time: string;
  days: number[];
  webhookUrl?: string;
}
const DEFAULT_REMINDER: Reminder = { channel: "off", time: "17:00", days: [1, 2, 3, 4, 5] };
const DAY_LABELS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const CHANNELS = [
  { value: "off", label: "Aus" },
  { value: "mail", label: "E-Mail" },
  { value: "teams", label: "Microsoft Teams" },
  { value: "slack", label: "Slack" },
];

/** «Heute noch nichts gebucht»: each person picks channel, time and weekdays; Teams and Slack via an incoming webhook. */
function ReminderCard() {
  const { notify, mode } = useStore();
  const [r, setR] = useState<Reminder>(() => (mode === "api" ? DEFAULT_REMINDER : loadLocal<Reminder>("rt.reminder", DEFAULT_REMINDER)));
  const [saved, setSaved] = useState<Reminder>(r);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (mode !== "api") return;
    api<Reminder>("/api/me/reminder").then((x) => { setR(x); setSaved(x); }).catch(() => {});
  }, [mode]);
  const chat = r.channel === "teams" || r.channel === "slack";
  const dirty = JSON.stringify(r) !== JSON.stringify(saved);
  const toggleDay = (d: number) => setR({ ...r, days: r.days.includes(d) ? r.days.filter((x) => x !== d) : [...r.days, d].sort() });
  const save = async () => {
    setBusy(true);
    try {
      if (mode === "api") {
        const next = await api<Reminder>("/api/me/reminder", { method: "PUT", body: r });
        setR(next);
        setSaved(next);
      } else {
        if (chat && !r.webhookUrl) throw new Error("Für Teams oder Slack brauchst du die Webhook-URL deines Kanals.");
        saveLocal("rt.reminder", r);
        setSaved(r);
      }
      setError("");
      notify(r.channel === "off" ? "Erinnerung ausgeschaltet" : `Erinnerung gespeichert: ${CHANNELS.find((c) => c.value === r.channel)?.label} um ${r.time}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    try {
      if (mode === "api") await api("/api/me/reminder/test", { body: {} });
      setError("");
      notify(mode === "api" ? "Testnachricht gesendet" : "In der installierten Version geht jetzt eine Testnachricht raus (Demo)");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2>Erinnerung «Heute noch nichts gebucht»</h2>
      <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>An deinen Arbeitstagen zur gewählten Uhrzeit, aber nur, wenn bis dahin noch keine Zeit erfasst ist. Bei Ferien und Feiertagen bleibt es still.</p>
      <div className="form-grid">
        <label className="field"><span>Kanal</span><Select id="r-channel" ariaLabel="Kanal" value={r.channel} onChange={(v) => setR({ ...r, channel: v as Reminder["channel"] })} options={CHANNELS} /></label>
        <label className="field"><span>Uhrzeit</span><input id="r-time" type="time" className="input" value={r.time} disabled={r.channel === "off"} onChange={(e) => setR({ ...r, time: e.target.value })} /></label>
      </div>
      <div className="field">
        <span>Tage</span>
        <div className="day-pick" role="group" aria-label="Wochentage">
          {DAY_LABELS.map((l, i) => (
            <button key={l} type="button" aria-pressed={r.days.includes(i + 1)} className={`day ${r.days.includes(i + 1) ? "on" : ""}`} disabled={r.channel === "off"} onClick={() => toggleDay(i + 1)}>{l}</button>
          ))}
        </div>
      </div>
      {chat && (
        <label className="field">
          <span>Webhook-URL deines {r.channel === "teams" ? "Teams-Kanals" : "Slack-Kanals"}</span>
          <input id="r-webhook" type="url" className="input" placeholder={r.channel === "teams" ? "https://….webhook.office.com/… oder https://….logic.azure.com/…" : "https://hooks.slack.com/services/…"} value={r.webhookUrl ?? ""} onChange={(e) => setR({ ...r, webhookUrl: e.target.value })} />
          <span className="muted" style={{ fontWeight: 400 }}>
            {r.channel === "teams"
              ? "In Teams: Kanal → ··· → Workflows → «Bei Empfang einer Webhookanforderung in einem Kanal posten», die erzeugte URL hier einfügen. Für eine Nachricht nur an dich einen privaten Kanal verwenden."
              : "In Slack: Apps → Incoming Webhooks → Kanal oder deine Direktnachricht wählen, die erzeugte URL hier einfügen."}
          </span>
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <div className="toolbar" style={{ gap: 8 }}>
        <button id="r-save" className="btn primary" disabled={busy || !dirty} onClick={save}>Speichern</button>
        {saved.channel !== "off" && <button id="r-test" className="btn ghost" disabled={busy || dirty} onClick={test}>Testnachricht senden</button>}
      </div>
    </section>
  );
}

/** Own account: who am I, appearance, favourites and password. */
export function Profile() {
  const { data, me, mode, role, currentUserId } = useStore();
  const [theme, setTheme] = useTheme();
  const employee = data.employees.find((e) => e.id === currentUserId);
  const name = me?.name ?? employee?.name ?? "–";
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("");
  const fav = useFavorites(currentUserId);
  const labels = useLabels();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Profil</h1>
          <p className="sub">Dein Konto, deine Darstellung und deine Favoriten für die Zeiterfassung.</p>
        </div>
      </div>
      <div className="grid-2" style={{ alignItems: "start" }}>
        <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="profile-head">
            <span className="avatar">{initials}</span>
            <div>
              <h2 style={{ margin: 0 }}>{name}</h2>
              <div className="muted" style={{ fontSize: "0.85rem" }}>{ROLE_LABEL[role]}{employee?.workload ? ` · Pensum ${employee.workload} %` : ""}</div>
            </div>
          </div>
          <dl className="kv">
            <dt>Benutzername</dt><dd>{me?.username ?? "demo"}</dd>
            <dt>E-Mail</dt><dd>{me?.email ?? "–"}</dd>
            <dt>Rolle</dt><dd>{ROLE_LABEL[role]}</dd>
          </dl>
          <p className="muted" style={{ fontSize: "0.82rem" }}>Name, E-Mail und Rolle ändern Admins unter Einstellungen → Benutzer.</p>
        </section>
        <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h2>Darstellung</h2>
          <div className="theme-cards" role="radiogroup" aria-label="Darstellung">
            {THEMES.map((t) => (
              <button key={t.id} role="radio" aria-checked={theme === t.id} className={`theme-card ${theme === t.id ? "on" : ""}`} onClick={() => setTheme(t.id)}>
                <t.icon />
                <strong>{t.label}</strong>
                <span>{t.hint}</span>
              </button>
            ))}
          </div>
          <p className="muted" style={{ fontSize: "0.82rem" }}>Gilt für diesen Browser. Das Logo und die Hauptfarbe legen Admins unter Einstellungen → Erscheinungsbild fest.</p>
        </section>
        <ReminderCard />
        {mode === "api" ? <PasswordCard /> : (
          <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h2>Passwort ändern</h2>
            <p className="muted" style={{ fontSize: "0.85rem" }}>In der Demo ohne Anmeldung gibt es kein Passwort. In der installierten Version steht hier das Formular zum Ändern.</p>
          </section>
        )}
        <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h2>Favoriten für die Zeiterfassung</h2>
          {fav.favorites.length === 0 ? (
            <p className="muted" style={{ fontSize: "0.85rem" }}>Noch keine Favoriten. Im Eintrags-Fenster den Stern neben «Grund / Tätigkeit» anklicken, dann erscheint die Kombination zuoberst in der Schnellwahl.</p>
          ) : (
            <ul className="fav-list">
              {fav.favorites.map((f) => (
                <li key={`${f.subProjectId}|${f.reason}|${f.jiraIssueKey ?? ""}`}>
                  <div><strong>{f.reason}</strong><div className="muted" style={{ fontSize: "0.78rem" }}>{labels.long(f.subProjectId)}</div></div>
                  <button className="icon-btn" aria-label="Favorit entfernen" title="Favorit entfernen" onClick={() => fav.toggle(f)}><Icon.close /></button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
