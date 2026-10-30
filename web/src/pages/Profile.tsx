import { useEffect, useState } from "react";
import type { Role } from "@taktwerk/domain";
import { loadCalendarStatus, providerLabel, setDemoCalendar, type CalendarStatus } from "../calendar";
import { api } from "../api";
import { loadLocal, saveLocal, useStore } from "../store";
import { Select } from "../ui/Select";
import { useTheme, type Theme } from "../theme";
import { Icon } from "../ui/components";
import { createPasskey, passkeysSupported } from "../webauthn";
import { useFavorites, useLabels } from "./TimeTracking";
import { intlLocale, locale, type Locale, LOCALES, setLocale, tr } from "../i18n";

const ROLE_LABEL: Record<Role, string> = { admin: tr("Admin"), consultant: tr("Consultant"), employee: tr("Mitarbeitende"), auditor: tr("Treuhand (nur lesen)"), customer: tr("Kunde (Portal)") };
const THEMES: { id: Theme; label: string; hint: string; icon: () => JSX.Element }[] = [
  { id: "light", label: tr("Hell"), hint: tr("Weisse Flächen, dunkle Schrift"), icon: Icon.sun },
  { id: "dark", label: tr("Dunkel"), hint: tr("Dunkle Flächen, helle Schrift"), icon: Icon.moon },
  { id: "system", label: tr("Wie das System"), hint: tr("Folgt der Einstellung von Windows oder macOS"), icon: Icon.monitor },
];

function PasswordCard() {
  const { notify } = useStore();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (next !== again) return setError(tr("Die Wiederholung stimmt nicht überein."));
    setBusy(true);
    try {
      await api("/api/auth/password/change", { body: { current, next } });
      setCurrent("");
      setNext("");
      setAgain("");
      setError("");
      notify(tr("Passwort geändert"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2>{tr("Passwort ändern")}</h2>
      <div className="form-grid">
        <label className="field"><span>{tr("Aktuelles Passwort")}</span><input id="p-current" type="password" autoComplete="current-password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
        <label className="field"><span>{tr("Neues Passwort")}</span><input id="p-next" type="password" autoComplete="new-password" className="input" value={next} onChange={(e) => setNext(e.target.value)} /></label>
        <label className="field"><span>{tr("Neues Passwort wiederholen")}</span><input id="p-again" type="password" autoComplete="new-password" className="input" value={again} onChange={(e) => setAgain(e.target.value)} /></label>
      </div>
      <p className="muted" style={{ fontSize: "0.82rem" }}>{tr("Mindestens 10 Zeichen. Wer sich mit Microsoft oder Google anmeldet, braucht kein Passwort.")}</p>
      {error && <p className="error">{error}</p>}
      <div className="toolbar"><button id="p-save" className="btn primary" disabled={busy || !current || !next} onClick={save}>{tr("Passwort speichern")}</button></div>
    </section>
  );
}

interface SecurityInfo {
  totp: boolean;
  recoveryCodesLeft: number;
  passkeys: { id: string; name: string; createdAt: string; lastUsedAt: string | null; backedUp: boolean }[];
  hasPassword: boolean;
}
interface SessionRow { id: string; current: boolean; device: string; ip: string | null; lastSeenAt: string; createdAt: string }
const when = (iso: string) => new Date(iso).toLocaleString(intlLocale, { dateStyle: "medium", timeStyle: "short" });

/** Second factor (authenticator app, passkeys) and the list of signed-in devices. */
function SecurityCard() {
  const { notify } = useStore();
  const [info, setInfo] = useState<SecurityInfo | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [setup, setSetup] = useState<{ secret: string; url: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [keyName, setKeyName] = useState("");
  const reload = async () => {
    setInfo(await api<SecurityInfo>("/api/me/security"));
    setSessions(await api<SessionRow[]>("/api/me/sessions"));
  };
  useEffect(() => { reload().catch((e: Error) => setError(e.message)); }, []);
  const run = async (fn: () => Promise<void>, msg?: string) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      if (msg) notify(msg);
      await reload();
    } catch (e) {
      setError((e as Error).name === "NotAllowedError" ? tr("Abgebrochen.") : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const startTotp = () => run(async () => setSetup(await api("/api/me/totp/setup", { body: {} })));
  const enableTotp = () => run(async () => { const r = await api<{ recoveryCodes: string[] }>("/api/me/totp/enable", { body: { code } }); setCodes(r.recoveryCodes); setSetup(null); setCode(""); }, tr("Authenticator-App aktiviert"));
  const disableTotp = () => { if (confirm(tr("Zweiten Faktor per App wirklich ausschalten?"))) void run(() => api("/api/me/totp", { method: "DELETE", body: { password: pw } }).then(() => setPw("")), tr("Authenticator-App entfernt")); };
  const newCodes = () => run(async () => { const r = await api<{ recoveryCodes: string[] }>("/api/me/totp/recovery", { body: { password: pw } }); setCodes(r.recoveryCodes); setPw(""); });
  const addKey = () => run(async () => {
    if (!passkeysSupported()) throw new Error(tr("Dieser Browser unterstützt keine Passkeys."));
    const options = await api<Record<string, unknown>>("/api/me/passkeys/options", { body: {} });
    const response = await createPasskey(options);
    await api("/api/me/passkeys", { body: { name: keyName.trim() || tr("Mein Passkey"), response } });
    setKeyName("");
  }, tr("Passkey gespeichert"));
  const delKey = (id: string, name: string) => { if (confirm(tr("Passkey «{0}» entfernen?", name))) void run(() => api(`/api/me/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" }), tr("Passkey entfernt")); };
  const endSession = (s: SessionRow) => run(() => api(`/api/me/sessions/${s.id}`, { method: "DELETE" }), tr("Gerät abgemeldet"));
  const logoutOthers = () => run(() => api("/api/me/sessions/logout-others", { body: {} }).then((r) => notify(tr("{0} andere Geräte abgemeldet", (r as { closed: number }).closed))));

  if (!info) return <section className="card card-pad"><h2>{tr("Sicherheit")}</h2><p className="muted">{error || tr("Lade …")}</p></section>;
  return (
    <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 14 }} id="security">
      <h2><Icon.shield />{" "}{tr("Sicherheit")}</h2>

      <div className="sec-block">
        <div className="sec-head"><strong>{tr("Authenticator-App")}</strong>{info.totp ? <span className="pill ok">{tr("Aktiv · {0} Wiederherstellungscodes", info.recoveryCodesLeft)}</span> : <span className="pill neutral">{tr("Aus")}</span>}</div>
        {!info.totp && !setup && <p className="muted">{tr("Zweiter Schritt bei der Anmeldung mit einem Code aus Google Authenticator, Microsoft Authenticator, 1Password oder einer anderen TOTP-App.")}</p>}
        {!info.totp && !setup && <div><button id="totp-start" className="btn" disabled={busy} onClick={() => void startTotp()}>{tr("Einrichten")}</button></div>}
        {setup && (
          <div className="totp-setup">
            <img src={setup.qr} alt={tr("QR-Code für die Authenticator-App")} width={160} height={160} />
            <div>
              <p className="muted" style={{ marginTop: 0 }}>{tr("QR-Code mit der App scannen oder den Schlüssel von Hand eingeben:")}{" "}<code className="mono">{setup.secret}</code></p>
              <label className="field"><span>{tr("Code aus der App")}</span><input id="totp-code" className="input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></label>
              <div className="toolbar" style={{ marginTop: 8 }}>
                <button id="totp-enable" className="btn primary" disabled={busy || code.trim().length < 6} onClick={() => void enableTotp()}>{tr("Aktivieren")}</button>
                <button className="btn ghost" onClick={() => setSetup(null)}>{tr("Abbrechen")}</button>
              </div>
            </div>
          </div>
        )}
        {codes && (
          <div className="notice" id="recovery-codes">
            <strong>{tr("Wiederherstellungscodes")}</strong>{" "}{tr("– jeder gilt einmal, falls die App nicht verfügbar ist. Jetzt sicher ablegen; sie werden nicht noch einmal angezeigt.")}
            <div className="codes mono">{codes.map((c) => <span key={c}>{c}</span>)}</div>
            <button className="btn small" onClick={() => { navigator.clipboard?.writeText(codes.join("\n")); notify(tr("Codes kopiert")); }}>{tr("Kopieren")}</button>
            <button className="btn small ghost" onClick={() => setCodes(null)}>{tr("Ausblenden")}</button>
          </div>
        )}
        {info.totp && info.hasPassword && (
          <div className="toolbar">
            <input className="input" type="password" placeholder={tr("Passwort zur Bestätigung")} aria-label={tr("Passwort")} autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} style={{ maxWidth: 240 }} />
            <button className="btn small" disabled={busy || !pw} onClick={() => void newCodes()}>{tr("Neue Wiederherstellungscodes")}</button>
            <button id="totp-disable" className="btn small ghost" disabled={busy || !pw} onClick={disableTotp}>{tr("Ausschalten")}</button>
          </div>
        )}
      </div>

      <div className="sec-block">
        <div className="sec-head"><strong>{tr("Passkeys")}</strong><span className="muted" style={{ fontSize: "0.8rem" }}>{tr("Anmeldung ohne Passwort mit Face ID, Touch ID, Windows Hello oder Sicherheitsschlüssel")}</span></div>
        {info.passkeys.length > 0 && (
          <ul className="fav-list">
            {info.passkeys.map((k) => (
              <li key={k.id}>
                <div><strong>{k.name}</strong><div className="muted" style={{ fontSize: "0.78rem" }}>{tr("erstellt")}{" "}{when(k.createdAt)}{k.lastUsedAt ? tr(" · zuletzt {0}", when(k.lastUsedAt)) : ""}{k.backedUp ? tr(" · synchronisiert") : ""}</div></div>
                <button className="icon-btn" aria-label={tr("Passkey entfernen")} title={tr("Entfernen")} onClick={() => delKey(k.id, k.name)}><Icon.trash /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="toolbar">
          <input id="pk-name" className="input" placeholder={tr("Name, z. B. MacBook")} aria-label={tr("Name des Passkeys")} value={keyName} onChange={(e) => setKeyName(e.target.value)} style={{ maxWidth: 220 }} />
          <button id="pk-add" className="btn" disabled={busy} onClick={() => void addKey()}><Icon.key />{tr("Passkey hinzufügen")}</button>
        </div>
        {info.passkeys.length > 0 && <p className="muted" style={{ fontSize: "0.8rem", margin: 0 }}>{tr("Mit Passkey gilt auch die Passwort-Anmeldung als zweistufig: nach dem Passwort wird der Passkey verlangt.")}</p>}
      </div>

      <div className="sec-block">
        <div className="sec-head"><strong>{tr("Angemeldete Geräte")}</strong>{sessions.length > 1 && <button id="logout-others" className="btn small" disabled={busy} onClick={() => void logoutOthers()}>{tr("Überall sonst abmelden")}</button>}</div>
        <ul className="fav-list" id="sessions">
          {sessions.map((s) => (
            <li key={s.id}>
              <div><strong>{s.device}</strong>{s.current && <span className="pill ok" style={{ marginLeft: 8 }}>{tr("Dieses Gerät")}</span>}<div className="muted" style={{ fontSize: "0.78rem" }}>{tr("zuletzt")}{" "}{when(s.lastSeenAt)}{s.ip ? ` · ${s.ip}` : ""}{" "}{tr("· angemeldet seit")}{" "}{when(s.createdAt)}</div></div>
              {!s.current && <button className="icon-btn" aria-label={tr("Abmelden")} title={tr("Dieses Gerät abmelden")} onClick={() => void endSession(s)}><Icon.logout /></button>}
            </li>
          ))}
        </ul>
      </div>
      {error && <p className="error">{error}</p>}
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
const DAY_LABELS = [tr("Mo"), tr("Di"), tr("Mi"), tr("Do"), tr("Fr"), tr("Sa"), tr("So")];
const CHANNELS = [
  { value: "off", label: tr("Aus") },
  { value: "mail", label: "E-Mail" },
  { value: "teams", label: tr("Microsoft Teams") },
  { value: "slack", label: tr("Slack") },
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
        if (chat && !r.webhookUrl) throw new Error(tr("Für Teams oder Slack brauchst du die Webhook-URL deines Kanals."));
        saveLocal("rt.reminder", r);
        setSaved(r);
      }
      setError("");
      notify(r.channel === "off" ? tr("Erinnerung ausgeschaltet") : tr("Erinnerung gespeichert: {0} um {1}", CHANNELS.find((c) => c.value === r.channel)?.label, r.time));
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
      notify(mode === "api" ? tr("Testnachricht gesendet") : tr("In der installierten Version geht jetzt eine Testnachricht raus (Demo)"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2>{tr("Erinnerung «Heute noch nichts gebucht»")}</h2>
      <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>{tr("An deinen Arbeitstagen zur gewählten Uhrzeit, aber nur, wenn bis dahin noch keine Zeit erfasst ist. Bei Ferien und Feiertagen bleibt es still.")}</p>
      <div className="form-grid">
        <label className="field"><span>{tr("Kanal")}</span><Select id="r-channel" ariaLabel={tr("Kanal")} value={r.channel} onChange={(v) => setR({ ...r, channel: v as Reminder["channel"] })} options={CHANNELS} /></label>
        <label className="field"><span>{tr("Uhrzeit")}</span><input id="r-time" type="time" className="input" value={r.time} disabled={r.channel === "off"} onChange={(e) => setR({ ...r, time: e.target.value })} /></label>
      </div>
      <div className="field">
        <span>{tr("Tage")}</span>
        <div className="day-pick" role="group" aria-label={tr("Wochentage")}>
          {DAY_LABELS.map((l, i) => (
            <button key={l} type="button" aria-pressed={r.days.includes(i + 1)} className={`day ${r.days.includes(i + 1) ? "on" : ""}`} disabled={r.channel === "off"} onClick={() => toggleDay(i + 1)}>{l}</button>
          ))}
        </div>
      </div>
      {chat && (
        <label className="field">
          <span>{tr("Webhook-URL deines")}{" "}{r.channel === "teams" ? "Teams-Kanals" : "Slack-Kanals"}</span>
          <input id="r-webhook" type="url" className="input" placeholder={r.channel === "teams" ? tr("https://….webhook.office.com/… oder https://….logic.azure.com/…") : "https://hooks.slack.com/services/…"} value={r.webhookUrl ?? ""} onChange={(e) => setR({ ...r, webhookUrl: e.target.value })} />
          <span className="muted" style={{ fontWeight: 400 }}>
            {r.channel === "teams"
              ? tr("In Teams: Kanal → ··· → Workflows → «Bei Empfang einer Webhookanforderung in einem Kanal posten», die erzeugte URL hier einfügen. Für eine Nachricht nur an dich einen privaten Kanal verwenden.")
              : tr("In Slack: Apps → Incoming Webhooks → Kanal oder deine Direktnachricht wählen, die erzeugte URL hier einfügen.")}
          </span>
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <div className="toolbar" style={{ gap: 8 }}>
        <button id="r-save" className="btn primary" disabled={busy || !dirty} onClick={save}>{tr("Speichern")}</button>
        {saved.channel !== "off" && <button id="r-test" className="btn ghost" disabled={busy || dirty} onClick={test}>{tr("Testnachricht senden")}</button>}
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
          <h1>{tr("Profil")}</h1>
          <p className="sub">{tr("Dein Konto, deine Darstellung und deine Favoriten für die Zeiterfassung.")}</p>
        </div>
      </div>
      <div className="grid-2" style={{ alignItems: "start" }}>
        <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="profile-head">
            <span className="avatar">{initials}</span>
            <div>
              <h2 style={{ margin: 0 }}>{name}</h2>
              <div className="muted" style={{ fontSize: "0.85rem" }}>{ROLE_LABEL[role]}{employee?.workload ? tr(" · Pensum {0} %", employee.workload) : ""}</div>
            </div>
          </div>
          <dl className="kv">
            <dt>{tr("Benutzername")}</dt><dd>{me?.username ?? "demo"}</dd>
            <dt>{tr("E-Mail")}</dt><dd>{me?.email ?? "–"}</dd>
            <dt>{tr("Rolle")}</dt><dd>{ROLE_LABEL[role]}</dd>
          </dl>
          <p className="muted" style={{ fontSize: "0.82rem" }}>{tr("Name, E-Mail und Rolle ändern Admins unter Einstellungen → Benutzer.")}</p>
        </section>
        <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h2>{tr("Darstellung")}</h2>
          <div className="theme-cards" role="radiogroup" aria-label={tr("Darstellung")}>
            {THEMES.map((t) => (
              <button key={t.id} role="radio" aria-checked={theme === t.id} className={`theme-card ${theme === t.id ? "on" : ""}`} onClick={() => setTheme(t.id)}>
                <t.icon />
                <strong>{t.label}</strong>
                <span>{t.hint}</span>
              </button>
            ))}
          </div>
          <p className="muted" style={{ fontSize: "0.82rem" }}>{tr("Gilt für diesen Browser. Das Logo und die Hauptfarbe legen Admins unter Einstellungen → Erscheinungsbild fest.")}</p>
        </section>
        <LanguageCard />
        <CalendarCard />
        <ReminderCard />
        {mode === "api" && <SecurityCard />}
        <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 8 }} id="my-data">
          <h2>{tr("Meine Daten")}</h2>
          <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>{tr("Alles, was über dich gespeichert ist, als Datei (Auskunftsrecht nach Datenschutzgesetz): Profil, Buchungen, Spesen, Absenzen, Abschlüsse, Geräte. Buchungen bleiben als Geschäftsunterlagen 10 Jahre aufbewahrt, auch nach einem Austritt.")}</p>
          {mode === "api" ? (
            <div className="toolbar"><a id="data-export" className="btn small" href="/api/me/export" download>{tr("Auskunft herunterladen (JSON)")}</a></div>
          ) : (
            <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>{tr("In der installierten Version lädst du die Datei hier herunter.")}</p>
          )}
        </section>
        {mode === "demo" && (
          <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h2><Icon.shield />{" "}{tr("Sicherheit")}</h2>
            <p className="muted" style={{ fontSize: "0.85rem" }}>{tr("In der installierten Version: Zwei-Faktor-Anmeldung mit Authenticator-App und Wiederherstellungscodes, Passkeys (Face ID, Touch ID, Windows Hello), Übersicht der angemeldeten Geräte mit «Überall sonst abmelden».")}</p>
          </section>
        )}
        {mode === "api" ? <PasswordCard /> : (
          <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h2>{tr("Passwort ändern")}</h2>
            <p className="muted" style={{ fontSize: "0.85rem" }}>{tr("In der Demo ohne Anmeldung gibt es kein Passwort. In der installierten Version steht hier das Formular zum Ändern.")}</p>
          </section>
        )}
        <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h2>{tr("Favoriten für die Zeiterfassung")}</h2>
          {fav.favorites.length === 0 ? (
            <p className="muted" style={{ fontSize: "0.85rem" }}>{tr("Noch keine Favoriten. Im Eintrags-Fenster den Stern neben «Grund / Tätigkeit» anklicken, dann erscheint die Kombination zuoberst in der Schnellwahl.")}</p>
          ) : (
            <ul className="fav-list">
              {fav.favorites.map((f) => (
                <li key={`${f.subProjectId}|${f.reason}|${f.jiraIssueKey ?? ""}`}>
                  <div><strong>{f.reason}</strong><div className="muted" style={{ fontSize: "0.78rem" }}>{labels.long(f.subProjectId)}</div></div>
                  <button className="icon-btn" aria-label={tr("Favorit entfernen")} title={tr("Favorit entfernen")} onClick={() => fav.toggle(f)}><Icon.close /></button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

/** Language of the app and of the e-mails this person receives. */
function LanguageCard() {
  const { mode, notify } = useStore();
  const choose = async (next: Locale) => {
    if (next === locale) return;
    try {
      if (mode === "api") await api("/api/me/locale", { method: "PUT", body: { locale: next } });
      setLocale(next);
    } catch (e) { notify((e as Error).message); }
  };
  return (
    <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }} id="language">
      <h2>{tr("Sprache")}</h2>
      <div className="seg" role="radiogroup" aria-label={tr("Sprache")}>
        {LOCALES.map((l) => (
          <button key={l.id} id={`lang-${l.id}`} role="radio" aria-checked={locale === l.id} className={locale === l.id ? "on" : ""} lang={l.id} onClick={() => void choose(l.id)}>{l.label}</button>
        ))}
      </div>
      <p className="muted" style={{ fontSize: "0.82rem" }}>{tr("Gilt für die App und für E-Mails an dich. Reports und Rechnungen erhalten Kunden in der Sprache, die beim Kunden eingestellt ist.")}</p>
    </section>
  );
}

/** Outlook or Google calendar: meetings show up in Zeiterfassung as booking suggestions. */
function CalendarCard() {
  const { mode, notify } = useStore();
  const demo = mode === "demo";
  const [s, setS] = useState<CalendarStatus | null>(null);
  const load = () => loadCalendarStatus(demo).then(setS).catch(() => setS(null));
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const outcome = q.get("kalender");
    if (outcome === "ok") notify(tr("Kalender verbunden"));
    if (outcome === "fehler") notify(tr("Der Kalender konnte nicht verbunden werden. Bitte nochmals versuchen."));
    if (outcome) history.replaceState(null, "", location.pathname + location.hash);
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return null;
  const offered = (["microsoft", "google"] as const).filter((p) => s.providers[p]);
  if (!offered.length) return null;
  const connect = (p: "microsoft" | "google") => {
    if (demo) { setDemoCalendar(p); void load(); notify(tr("Kalender verbunden")); return; }
    location.href = `/api/calendar/${p}`;
  };
  const disconnect = async () => {
    try {
      if (demo) setDemoCalendar(null); else await api("/api/calendar", { method: "DELETE" });
      notify(tr("Kalender getrennt"));
      void load();
    } catch (e) { notify((e as Error).message); }
  };
  return (
    <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }} id="calendar">
      <h2>{tr("Kalender")}</h2>
      <p className="muted" style={{ fontSize: "0.86rem", margin: 0 }}>{tr("Termine aus deinem Kalender erscheinen in der Zeiterfassung als Vorschläge. Ein Klick bucht sie mit Zeit, Dauer und Titel. TrackInsight liest den Kalender nur und speichert keine Termine.")}</p>
      {s.connected ? (
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span className="pill ok">{providerLabel(s.connected.provider)}{s.connected.account ? ` · ${s.connected.account}` : ""}</span>
          <button className="btn small ghost" onClick={() => void disconnect()}>{tr("Trennen")}</button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {offered.map((p) => <button key={p} id={`cal-connect-${p}`} className="btn small" onClick={() => connect(p)}>{tr("{0} verbinden", providerLabel(p))}</button>)}
        </div>
      )}
    </section>
  );
}
