import { useState } from "react";
import type { Role } from "@taktwerk/domain";
import { api } from "../api";
import { useStore } from "../store";
import { useTheme, type Theme } from "../theme";
import { Icon } from "../ui/components";
import { useFavorites, useLabels } from "./TimeTracking";

const ROLE_LABEL: Record<Role, string> = { admin: "Admin", consultant: "Consultant", employee: "Mitarbeitende" };
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
