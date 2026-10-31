import { DEFAULT_RATES, EXPORT_ENTITIES, PLANS, TIME_MODELS, VAT_RATES, defaultHolidays, type TimeModel, exportRows, fmt1, fmtCHF2, fmtDate, toCsv, type ExportEntity, type Holiday, type PostalAddress } from "@taktwerk/domain";
import { useEffect, useState } from "react";
import { api, type BillingSettings, type Branding, type PlatformOrg, type PlatformSummary, type ScheduledReport, type Settings as OrgSettings, type UserRow } from "../api";
import { useStore } from "../store";
import { BexioCard } from "./Bexio";
import { JiraTab } from "./Jira";
import { IntegrationsTab } from "./Integrations";
import { ImportTab } from "./Import";
import { SsoTab } from "./SsoSettings";
import { PartnersCard, ReferralCard } from "./Growth";
import { ChatTab } from "./ChatSettings";
import { MonitorCard } from "./Monitor";
import { STATUS_LABEL, SubscriptionTab, statusPill, useSubscription } from "./Subscription";
import { BrandMark, MatterhornRidge } from "../ui/motif";
import { Select } from "../ui/Select";
import { Icon } from "../ui/components";
import { OrgDialog, ROLE_LABEL, ReportDialog, TeamDialog, UserDialog } from "./SettingsDialogs";
import { tr, trn } from "../i18n";

export const PRESETS = [
  { name: tr("Violett"), color: "#6D4CF0" },
  { name: tr("Schweizer Rot"), color: "#D52B1E" },
  { name: tr("Bordeaux"), color: "#8C1D2F" },
  { name: tr("Tannengrün"), color: "#1F6B4A" },
  { name: tr("Gletscherblau"), color: "#1E5F99" },
  { name: tr("Anthrazit"), color: "#2E3136" },
];
const ROLE_HINT = tr("Admin und Consultant sehen alles. Mitarbeitende sehen nur Eigenes, ausser sie leiten ein Projekt oder ein Team. Treuhand sieht alles, ändert nichts.");

/** Teams with their leads; members are assigned in the user table. */
function Teams({ users, onChanged }: { users: UserRow[] | null; onChanged: () => void }) {
  const { data, mode } = useStore();
  const [dialog, setDialog] = useState<null | "new" | string>(null);
  const people = (users ?? []).filter((u) => u.active && u.role !== "customer" && u.role !== "auditor");
  const teams = data.teams;
  const members = (teamId: string) => (users ?? []).filter((u) => u.teamId === teamId).length;
  const leadName = (id?: string | null) => data.employees.find((e) => e.id === id)?.name ?? (users ?? []).find((u) => u.id === id)?.name;
  const editing = dialog && dialog !== "new" ? teams.find((t) => t.id === dialog) : undefined;
  return (
    <section className="card" id="teams">
      <div className="card-head">
        <div>
          <h3>{tr("Teams und Teamleitung")}</h3>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.85rem" }}>{tr("Die Teamleitung bewilligt Absenzen, schliesst Monate ab und sieht die Wochen ihres Teams. Projektleitung vergibst du beim Projekt.")}</p>
        </div>
        {mode === "api" && <button id="team-add" className="btn small" onClick={() => setDialog("new")}>{tr("+ Team")}</button>}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>{tr("Team")}</th><th>{tr("Teamleitung")}</th><th className="r">{tr("Personen")}</th><th /></tr></thead>
          <tbody>
            {teams.map((t) => (
              <tr key={t.id} className={mode === "api" ? "clickable" : ""} onClick={() => mode === "api" && setDialog(t.id)}>
                <td><strong>{t.name}</strong></td>
                <td>{leadName(t.leadUserId) ?? <span className="muted">{tr("Keine")}</span>}</td>
                <td className="r num">{users ? members(t.id) : data.employees.filter((e) => e.teamId === t.id).length}</td>
                <td className="r">{mode === "api" && <button className="btn small ghost" onClick={(e) => { e.stopPropagation(); setDialog(t.id); }}>{tr("Bearbeiten")}</button>}</td>
              </tr>
            ))}
            {teams.length === 0 && <tr><td colSpan={4} className="muted">{tr("Noch keine Teams. Mit «+ Team» anlegen.")}</td></tr>}
          </tbody>
        </table>
      </div>
      {dialog && <TeamDialog team={editing} people={people} onClose={() => setDialog(null)} onSaved={onChanged} />}
    </section>
  );
}

function Appearance() {
  const { branding, setBranding, setLogo, notify } = useStore();
  const [draft, setDraft] = useState<Branding>(branding);
  const [error, setError] = useState("");
  const [logoBusy, setLogoBusy] = useState(false);
  const changeLogo = async (file: File | null) => {
    setLogoBusy(true);
    try {
      await setLogo(file);
      setError("");
      notify(file ? tr("Logo gespeichert") : tr("Logo entfernt"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLogoBusy(false);
    }
  };
  const valid = /^#[0-9a-fA-F]{6}$/.test(draft.primaryColor) && draft.appName.trim() !== "";

  const save = async () => {
    try {
      await setBranding({ ...draft, appName: draft.appName.trim() });
      setError("");
      notify(tr("Erscheinungsbild gespeichert"));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="grid-2" style={{ alignItems: "start" }}>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <label className="field"><span>{tr("Name der Anwendung")}</span>
          <input id="b-name" className="input" maxLength={60} value={draft.appName} onChange={(e) => setDraft({ ...draft, appName: e.target.value })} />
        </label>
        <div className="field">
          <span>{tr("Hauptfarbe")}</span>
          <div className="swatches">
            {PRESETS.map((p) => (
              <button key={p.color} type="button" title={p.name} aria-label={p.name} className={`swatch ${draft.primaryColor.toUpperCase() === p.color ? "on" : ""}`}
                style={{ background: p.color }} onClick={() => setDraft({ ...draft, primaryColor: p.color })} />
            ))}
            <input id="b-color" type="color" aria-label={tr("Eigene Farbe")} className="swatch" style={{ padding: 0 }} value={draft.primaryColor} onChange={(e) => setDraft({ ...draft, primaryColor: e.target.value.toUpperCase() })} />
            <input id="b-hex" className="input mono" style={{ width: 110 }} value={draft.primaryColor} onChange={(e) => setDraft({ ...draft, primaryColor: e.target.value })} />
          </div>
        </div>
        <div className="field">
          <span>{tr("Logo")}</span>
          <div className="logo-row">
            <BrandMark logo={branding.logo} size={40} />
            <div className="toolbar">
              <label className="btn small">
                {branding.logo ? tr("Logo ersetzen") : tr("Logo hochladen")}
                <input id="b-logo" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden disabled={logoBusy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) changeLogo(f); }} />
              </label>
              {branding.logo && <button className="btn small ghost" disabled={logoBusy} onClick={() => changeLogo(null)}>{tr("Entfernen")}</button>}
            </div>
          </div>
          <span className="muted" style={{ fontSize: "0.78rem", fontWeight: 400 }}>{tr("PNG, SVG, JPEG oder WebP bis 1 MB, am besten quadratisch oder quer mit transparentem Hintergrund. Ohne eigenes Logo erscheint das Matterhorn-Zeichen in der Hauptfarbe.")}</span>
        </div>
        <label className="check"><input id="b-motif" type="checkbox" checked={draft.showMotif} onChange={(e) => setDraft({ ...draft, showMotif: e.target.checked })} />{tr("Matterhorn-Motiv auf Anmeldeseite und in der Navigation zeigen")}</label>
        {error && <p className="error">{error}</p>}
        <div className="toolbar">
          <button className="btn primary" disabled={!valid} onClick={save}>{tr("Speichern")}</button>
          <button className="btn ghost" onClick={() => setDraft(branding)}>{tr("Verwerfen")}</button>
        </div>
        <p className="muted" style={{ fontSize: "0.82rem" }}>{tr("Diagrammfarben und Ampeln bleiben unabhängig von der Hauptfarbe, damit Auswertungen eindeutig lesbar sind.")}</p>
      </section>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h3>{tr("Vorschau")}</h3>
        <div className="preview" style={{ ["--brand" as string]: valid ? draft.primaryColor : branding.primaryColor }}>
          <div className="preview-rail">
            <div className="brand" style={{ fontSize: "0.9rem" }}><BrandMark logo={branding.logo} size={24} />{draft.appName || "–"}</div>
            <div className="nav"><a className="active">{tr("Dashboard")}</a><a>{tr("Zeiterfassung")}</a></div>
            {draft.showMotif && <span className="rail-motif" style={{ marginTop: "auto", margin: "auto -12px -12px" }}><MatterhornRidge /></span>}
          </div>
          <div className="preview-main">
            <strong>{tr("Dashboard")}</strong>
            <div className="toolbar"><button className="btn primary small">{tr("Buchen")}</button><span className="pill risk">{tr("Knapp")}</span></div>
          </div>
        </div>
      </section>
    </div>
  );
}

function Users() {
  const { mode, notify, data, reload: reloadData } = useStore();
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [dialog, setDialog] = useState<null | "new" | UserRow>(null);
  const [error, setError] = useState("");
  const reload = () => api<UserRow[]>("/api/users").then(setRows).catch((e) => setError(e.message));
  useEffect(() => {
    if (mode === "api") reload();
  }, [mode]);

  if (mode === "demo")
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <p className="notice">{tr("Im Prototyp gibt es keine Benutzerverwaltung. In der installierten Version lädst du hier Personen per E-Mail ein und vergibst Rollen.")}{" "}{ROLE_HINT}</p>
        <Teams users={null} onChanged={() => undefined} />
      </div>
    );

  const patch = async (id: string, body: object) => {
    try {
      await api(`/api/users/${id}`, { method: "PATCH", body });
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section className="card" id="people">
        <div className="card-head">
          <h3>{tr("Personen")}</h3>
          <button id="u-invite" className="btn small primary" onClick={() => setDialog("new")}>{tr("+ Person einladen")}</button>
        </div>
        {error && <p className="error card-pad" style={{ paddingTop: 0 }}>{error}</p>}
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>{tr("Name")}</th><th>{tr("Benutzername")}</th><th>{tr("E-Mail")}</th><th>{tr("Rolle")}</th><th>{tr("Team")}</th><th className="r">{tr("Kostensatz CHF/h")}</th><th>{tr("Status")}</th><th /></tr></thead>
            <tbody>
              {rows?.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td className="mono">{u.username}</td>
                  <td>{u.email}</td>
                  <td>{ROLE_LABEL[u.role]}</td>
                  <td>{data.teams.find((t) => t.id === u.teamId)?.name ?? <span className="muted">–</span>}</td>
                  <td className="r num">{u.costRate ?? <span className="muted">{tr("Standard")}</span>}</td>
                  <td>{!u.active ? <span className="pill neutral">{tr("Deaktiviert")}</span> : u.lastLoginAt ? <span className="pill ok">{tr("Aktiv")}</span> : <span className="pill risk">{tr("Eingeladen")}</span>}</td>
                  <td className="r" style={{ whiteSpace: "nowrap" }}>
                    <button className="btn small ghost" title={tr("Zweiten Faktor und Passkeys entfernen, alle Geräte abmelden")} onClick={() => { if (confirm(tr("Zweiten Faktor von {0} zurücksetzen? Alle Geräte werden abgemeldet.", u.name))) void api(`/api/users/${u.id}/security/reset`, { body: {} }).then(() => notify(tr("Zweiter Faktor zurückgesetzt"))).catch((e: Error) => setError(e.message)); }}>{tr("2FA zurücksetzen")}</button>
                    <button className="btn small" onClick={() => setDialog(u)}>{tr("Bearbeiten")}</button>
                    {!u.active && <button className="btn small ghost" onClick={() => patch(u.id, { active: true })}>{tr("Aktivieren")}</button>}
                    {!u.active && !u.username.startsWith("ehemalig-") && (
                      <>
                        <a className="btn small ghost" href={`/api/users/${u.id}/export`} download title={tr("Auskunft nach DSG als Datei")}>{tr("Auskunft")}</a>
                        <button className="btn small ghost" title={tr("Name, E-Mail, Zugänge und Erinnerungen entfernen; Buchungen bleiben anonym erhalten")} onClick={() => { const pw = prompt(tr("{0} anonymisieren? Das lässt sich nicht rückgängig machen.\nZur Bestätigung dein Passwort:", u.name)); if (pw) void api(`/api/users/${u.id}/anonymize`, { body: { password: pw } }).then(() => { notify(tr("Person anonymisiert")); reload(); }).catch((e: Error) => setError(e.message)); }}>{tr("Anonymisieren")}</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>{ROLE_HINT}</p>
      {dialog && <UserDialog user={dialog === "new" ? undefined : dialog} onClose={() => setDialog(null)} onSaved={() => { reload(); void reloadData(); }} />}
      <Teams users={rows} onChanged={() => { reload(); void reloadData(); }} />
    </div>
  );
}

function SignIn() {
  const { mode, notify } = useStore();
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [domains, setDomains] = useState("");
  const [reportDay, setReportDay] = useState("3");
  const [error, setError] = useState("");
  useEffect(() => {
    if (mode !== "api") return;
    api<OrgSettings>("/api/settings").then((s) => {
      setSettings(s);
      setDomains(s.ssoAutoProvisionDomains.join(", "));
      setReportDay(String(s.reportDay ?? 3));
    });
  }, [mode]);
  if (mode === "demo") return <p className="notice">{tr("Im Prototyp nicht verfügbar. Hier legst du in der installierten Version fest, welche Firmen-Domains sich ohne Einladung mit Microsoft oder Google anmelden dürfen, und prüfst den E-Mail-Versand.")}</p>;

  const save = async () => {
    try {
      const list = domains.split(/[\s,;]+/).filter(Boolean);
      setSettings(await api<OrgSettings>("/api/settings", { method: "PUT", body: { ssoAutoProvisionDomains: list } }));
      setError("");
      notify(tr("Anmeldung gespeichert"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const saveReportDay = async () => {
    try {
      setSettings(await api<OrgSettings>("/api/settings", { method: "PUT", body: { reportDay: Number(reportDay) } }));
      setError("");
      notify(tr("Versandtag gespeichert"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const testMail = async () => {
    const r = await api<{ smtp: boolean }>("/api/settings/test-mail", { body: {} });
    notify(r.smtp ? tr("Test-E-Mail an dich gesendet") : tr("Kein SMTP-Server eingerichtet, E-Mail nur ins Server-Log geschrieben"));
  };

  return (
    <div className="grid-2" style={{ alignItems: "start" }}>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3>{tr("Microsoft und Google")}</h3>
        <p className="explain">{tr("Personen mit Einladung können sich immer mit Microsoft oder Google anmelden, wenn das Konto dieselbe E-Mail-Adresse hat. Für die folgenden Domains wird beim ersten Login automatisch ein Zugang als Mitarbeitende angelegt.")}</p>
        <label className="field"><span>{tr("Domains (durch Komma getrennt)")}</span>
          <input id="s-domains" className="input" placeholder={tr("z. B. firma.ch, firma.com")} value={domains} onChange={(e) => setDomains(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="toolbar"><button className="btn primary" disabled={!settings} onClick={save}>{tr("Speichern")}</button></div>
      </section>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3>{tr("E-Mail-Versand (SMTP)")}</h3>
        <p className="explain">{tr("Einladungen und Links zum Zurücksetzen des Passworts gehen über den SMTP-Server aus der Server-Konfiguration (")}<code>{tr("SMTP_HOST")}</code>, <code>{tr("SMTP_PORT")}</code>, <code>{tr("SMTP_USER")}</code>, <code>{tr("SMTP_PASSWORD")}</code>, <code>{tr("SMTP_FROM")}</code>).</p>
        <div className="toolbar"><button className="btn" onClick={testMail}>{tr("Test-E-Mail an mich senden")}</button></div>
        <h3 style={{ marginTop: 8 }}>{tr("Monatlicher Kundenreport")}</h3>
        <p className="explain">{tr("Der Report des Vormonats (PDF und Excel) geht an alle Kunden mit hinterlegten Empfängern (Reports → Kunde wählen). Budget-Alarme bei 80, 95 und 100 % des Forecasts gehen an Admins und Consultants.")}</p>
        <div className="export-bar">
          <label className="field"><span>{tr("Versand am Tag (07:00 Uhr)")}</span>
            <input id="s-report-day" type="number" min="1" max="28" className="input num" value={reportDay} onChange={(e) => setReportDay(e.target.value)} />
          </label>
          <button className="btn" disabled={!settings || reportDay === String(settings.reportDay ?? 3)} onClick={saveReportDay}>{tr("Speichern")}</button>
        </div>
        <h3 style={{ marginTop: 8 }}>{tr("Retainer-Rechnungen")}</h3>
        <label className="check">
          <input id="s-auto-retainer" type="checkbox" disabled={!settings} checked={!!settings?.autoRetainerInvoices} onChange={async (e) => {
            const on = e.target.checked;
            try {
              setSettings(await api<OrgSettings>("/api/settings", { method: "PUT", body: { autoRetainerInvoices: on } }));
              notify(on ? tr("Retainer-Rechnungen werden am 1. als Entwurf erstellt") : tr("Automatische Retainer-Rechnungen aus"));
            } catch (err) {
              setError((err as Error).message);
            }
          }} />
          {tr("Am 1. für jeden Kunden mit Retainer die Rechnung des Vormonats als Entwurf anlegen (Kontingent plus Mehraufwand). Versendet wird nichts automatisch.")}
        </label>
      </section>
    </div>
  );
}

function WorkSettings() {
  const { data, setWorkSettings, notify, mode } = useStore();
  const model = data.workModel ?? { weeklyHours: 42, holidays: [] };
  const [reminder, setReminder] = useState(true);
  const [reminderSaved, setReminderSaved] = useState(true);
  const [closingRem, setClosingRem] = useState(true);
  const [closingRemSaved, setClosingRemSaved] = useState(true);
  useEffect(() => {
    if (mode === "demo") return;
    api<OrgSettings>("/api/settings").then((s) => {
      setReminder(s.hoursReminder ?? true); setReminderSaved(s.hoursReminder ?? true);
      setClosingRem(s.closingReminder ?? true); setClosingRemSaved(s.closingReminder ?? true);
    }).catch(() => {});
  }, [mode]);
  const [weeklyHours, setWeeklyHours] = useState(String(model.weeklyHours));
  const [timeModel, setTimeModel] = useState<TimeModel>(model.timeModel ?? "simplified");
  const [holidays, setHolidays] = useState<Holiday[]>(model.holidays);
  const [year, setYear] = useState(Number(data.today.slice(0, 4)));
  const [draft, setDraft] = useState<Holiday>({ date: `${year}-05-01`, name: "", fraction: 1 });
  const [error, setError] = useState("");
  const ofYear = holidays.filter((h) => h.date.startsWith(String(year))).sort((a, b) => a.date.localeCompare(b.date));
  const changed = Number(weeklyHours) !== model.weeklyHours || JSON.stringify(holidays) !== JSON.stringify(model.holidays) || reminder !== reminderSaved || closingRem !== closingRemSaved || timeModel !== (model.timeModel ?? "simplified");

  const upsert = (list: Holiday[]) => {
    const map = new Map(holidays.map((h) => [h.date, h]));
    for (const h of list) map.set(h.date, h);
    setHolidays([...map.values()].sort((a, b) => a.date.localeCompare(b.date)));
  };
  const save = async () => {
    try {
      await setWorkSettings({ weeklyHours: Number(weeklyHours), holidays, hoursReminder: reminder, closingReminder: closingRem, timeModel });
      setReminderSaved(reminder);
      setClosingRemSaved(closingRem);
      setError("");
      notify(tr("Arbeitszeitmodell gespeichert"));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="grid-2" style={{ alignItems: "start" }}>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3>{tr("Sollzeit")}</h3>
        <p className="explain">{tr("Sollzeit pro Woche bei 100 % Pensum, verteilt auf Montag bis Freitag. Pensum, Ferientage und Überträge pro Person legst du unter Absenzen → Team fest.")}</p>
        <label className="field" style={{ maxWidth: 220 }}><span>{tr("Stunden pro Woche")}</span>
          <input id="w-hours" type="number" step={0.25} min={1} max={60} className="input num" value={weeklyHours} onChange={(e) => setWeeklyHours(e.target.value)} />
        </label>
        <p className="muted" style={{ fontSize: "0.82rem" }}>{tr("Das sind {0} h pro Arbeitstag bei 100 %.", (Number(weeklyHours) / 5 || 0).toFixed(2))}</p>
        <h3>{tr("Arbeitszeiterfassung nach Arbeitsgesetz")}</h3>
        <p className="explain">{tr("Wie die Arbeitszeit erfasst wird, gilt für die ganze Firma. Die vereinfachte Erfassung braucht eine schriftliche Vereinbarung; sonst gilt Kommen/Gehen.")}</p>
        <Select id="w-model" ariaLabel={tr("Erfassungsmodell")} value={timeModel} onChange={(v) => setTimeModel(v as TimeModel)} options={TIME_MODELS.map((m) => ({ value: m.id, label: m.label }))} />
        <p className="muted" style={{ fontSize: "0.82rem" }}>{tr(TIME_MODELS.find((m) => m.id === timeModel)?.hint ?? "")}</p>
        <h3>{tr("Erinnerung")}</h3>
        <label className="check"><input id="w-reminder" type="checkbox" checked={reminder} onChange={(e) => setReminder(e.target.checked)} />{tr("Montags per E-Mail erinnern, wenn in der Vorwoche mehr als zwei Stunden fehlen")}</label>
        <p className="muted" style={{ fontSize: "0.82rem" }}>{tr("Die Erinnerung geht ab 09:00 Uhr an die betroffene Person und nennt die fehlenden Stunden. Bei Ferien und Krankheit zählen die gutgeschriebenen Stunden mit.")}</p>
        <label className="check"><input id="w-closing-reminder" type="checkbox" checked={closingRem} onChange={(e) => setClosingRem(e.target.checked)} />{tr("Am 1. per E-Mail an den Monatsabschluss erinnern")}</label>
        <p className="muted" style={{ fontSize: "0.82rem" }}>{tr("Wer den Vormonat noch nicht eingereicht hat, bekommt am 1. ab 09:00 Uhr eine Mail. Am 5. erhalten Admins und Consultants eine Übersicht, wer fehlt und was auf Freigabe wartet.")}</p>
        {error && <p className="error">{error}</p>}
        <div className="toolbar"><button className="btn primary" disabled={!changed} onClick={save}>{tr("Speichern")}</button></div>
      </section>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="tree-row">
          <h3>{tr("Feiertage")}</h3>
          <Select small ariaLabel={tr("Jahr")} value={String(year)} onChange={(v) => setYear(Number(v))} options={[-1, 0, 1].map((n) => Number(data.today.slice(0, 4)) + n).map((y) => ({ value: String(y), label: String(y) }))} />
        </div>
        <p className="explain">{tr("Feiertage unterscheiden sich je nach Kanton. Der Vorschlag enthält die Feiertage der meisten Deutschschweizer Kantone; ergänze oder entferne, was bei euch gilt.")}</p>
        {ofYear.length === 0 && <p className="muted">{tr("Für {0} sind noch keine Feiertage erfasst.", year)}</p>}
        {ofYear.map((h) => (
          <div className="holiday-row" key={h.date}>
            <span className="num">{fmtDate(h.date)}</span>
            <span>{tr(h.name)}</span>
            <span className="muted" style={{ fontSize: "0.8rem" }}>{h.fraction === 1 ? tr("ganzer Tag") : tr("halber Tag")}</span>
            <button className="icon-btn" aria-label={tr("{0} entfernen", tr(h.name))} title={tr("Entfernen")} onClick={() => setHolidays(holidays.filter((x) => x.date !== h.date))}>✕</button>
          </div>
        ))}
        <div className="holiday-row">
          <input type="date" className="input" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
          <input className="input" placeholder={tr("Name, z. B. Sechseläuten (Nachmittag)")} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <Select value={String(draft.fraction)} onChange={(v) => setDraft({ ...draft, fraction: Number(v) })} options={[{ value: "1", label: tr("ganzer Tag") }, { value: "0.5", label: tr("halber Tag") }]} />
          <button className="btn small" disabled={!draft.name.trim() || !draft.date} onClick={() => { upsert([{ ...draft, name: draft.name.trim() }]); setDraft({ ...draft, name: "" }); }}>{tr("Hinzufügen")}</button>
        </div>
        <div className="toolbar">
          <button className="btn ghost" onClick={() => upsert(defaultHolidays(year))}>{tr("Vorschlag für {0} einfügen", year)}</button>
          <button className="btn primary" disabled={!changed} onClick={save}>{tr("Speichern")}</button>
        </div>
      </section>
    </div>
  );
}

const EMPTY_BILLING: BillingSettings = { address: { name: "", street: "", zip: "", city: "", country: "CH" }, iban: "", vatNumber: "", paymentDays: 30, footer: "" };

function Billing() {
  const { data, mode, setWorkSettings, notify } = useStore();
  const [billing, setBilling] = useState<BillingSettings>(EMPTY_BILLING);
  const [kmRate, setKmRate] = useState(String(data.rates?.kmRate ?? DEFAULT_RATES.kmRate));
  const [vatRate, setVatRate] = useState(data.rates?.vatRate ?? DEFAULT_RATES.vatRate);
  const [costRate, setCostRate] = useState(String(data.rates?.costRate ?? 95));
  const [fx, setFx] = useState<{ EUR: string; USD: string; asOf: string; source: string; manual: boolean }>({ EUR: data.fx?.rates.EUR ? String(data.fx.rates.EUR) : "", USD: data.fx?.rates.USD ? String(data.fx.rates.USD) : "", asOf: data.fx?.asOf ?? "", source: data.fx?.source ?? "", manual: false });
  const [fxBusy, setFxBusy] = useState(false);
  const [error, setError] = useState("");
  const addr = (k: keyof PostalAddress, v: string) => setBilling({ ...billing, address: { ...billing.address, [k]: v } });
  useEffect(() => {
    if (mode === "demo") return;
    api<OrgSettings>("/api/settings").then((s) => {
      if (s.billing) setBilling({ ...EMPTY_BILLING, ...s.billing, vatNumber: s.billing.vatNumber ?? "", footer: s.billing.footer ?? "" });
      setKmRate(String(s.kmRate ?? DEFAULT_RATES.kmRate));
      setVatRate(s.vatRate ?? DEFAULT_RATES.vatRate);
      setCostRate(String(s.costRate ?? 95));
      if (s.fx) setFx({ EUR: s.fx.rates.EUR ? String(s.fx.rates.EUR) : "", USD: s.fx.rates.USD ? String(s.fx.rates.USD) : "", asOf: s.fx.asOf, source: s.fx.source ?? "", manual: Boolean(s.fx.manual) });
    }).catch((e) => setError((e as Error).message));
  }, [mode]);

  const saveFx = async () => {
    try {
      const rates = { ...(fx.EUR ? { EUR: Number(fx.EUR) } : {}), ...(fx.USD ? { USD: Number(fx.USD) } : {}) };
      const s = await api<OrgSettings>("/api/settings", { method: "PUT", body: { fx: { rates, manual: true } } });
      if (s.fx) setFx({ EUR: String(s.fx.rates.EUR ?? ""), USD: String(s.fx.rates.USD ?? ""), asOf: s.fx.asOf, source: s.fx.source ?? "", manual: true });
      setError("");
      notify(tr("Wechselkurse gespeichert"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const refreshFx = async () => {
    setFxBusy(true);
    try {
      const f = await api<NonNullable<OrgSettings["fx"]>>("/api/settings/fx/refresh", { body: {} });
      setFx({ EUR: String(f.rates.EUR ?? ""), USD: String(f.rates.USD ?? ""), asOf: f.asOf, source: f.source ?? "", manual: false });
      setError("");
      notify(tr("Kurse vom {0} geladen", f.asOf.split("-").reverse().join(".")));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFxBusy(false);
    }
  };
  const saveRates = async () => {
    try {
      await setWorkSettings({ kmRate: Number(kmRate), vatRate, costRate: Number(costRate) });
      setError("");
      notify(tr("Ansätze gespeichert"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const saveBilling = async () => {
    try {
      const body = { ...billing, vatNumber: billing.vatNumber?.trim() || undefined, footer: billing.footer?.trim() || undefined };
      await api("/api/settings", { method: "PUT", body: { billing: body } });
      setError("");
      notify(tr("Rechnungsabsender gespeichert"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const billingOk = billing.address.name.trim() && billing.address.zip.trim() && billing.address.city.trim() && billing.iban.replace(/\s+/g, "").length === 21;

  return (
    <div className="grid-2" style={{ alignItems: "start" }}>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3>{tr("Absender und Zahlung")}</h3>
        <p className="explain">{tr("Erscheint auf jeder Rechnung und im QR-Zahlteil. Die IBAN muss zu einem Schweizer oder Liechtensteiner Konto gehören.")}</p>
        {mode === "demo" ? (
          <p className="notice">{tr("Im Prototyp werden keine Rechnungen erstellt. In der installierten Version hinterlegst du hier Adresse, IBAN und MwSt-Nummer deiner Firma.")}</p>
        ) : (
          <>
            <div className="form-grid">
              <label className="field"><span>{tr("Firma")}</span><input id="bl-name" className="input" value={billing.address.name} onChange={(e) => addr("name", e.target.value)} /></label>
              <label className="field"><span>{tr("Strasse")}</span><input id="bl-street" className="input" value={billing.address.street} onChange={(e) => addr("street", e.target.value)} /></label>
              <label className="field"><span>{tr("PLZ")}</span><input id="bl-zip" className="input" value={billing.address.zip} onChange={(e) => addr("zip", e.target.value)} /></label>
              <label className="field"><span>{tr("Ort")}</span><input id="bl-city" className="input" value={billing.address.city} onChange={(e) => addr("city", e.target.value)} /></label>
              <label className="field"><span>{tr("IBAN")}</span><input id="bl-iban" className="input mono" placeholder={tr("CH93 0076 2011 6238 5295 7")} value={billing.iban} onChange={(e) => setBilling({ ...billing, iban: e.target.value })} /></label>
              <label className="field"><span>{tr("MwSt-Nummer (optional)")}</span><input id="bl-vat" className="input" placeholder={tr("CHE-123.456.789 MWST")} value={billing.vatNumber} onChange={(e) => setBilling({ ...billing, vatNumber: e.target.value })} /></label>
              <label className="field"><span>{tr("Zahlungsfrist (Tage)")}</span><input id="bl-days" type="number" min={0} max={120} className="input num" value={billing.paymentDays} onChange={(e) => setBilling({ ...billing, paymentDays: Number(e.target.value) })} /></label>
            </div>
            <label className="field"><span>{tr("Fusstext (optional)")}</span><input id="bl-footer" className="input" placeholder={tr("z. B. Vielen Dank für die gute Zusammenarbeit.")} value={billing.footer} onChange={(e) => setBilling({ ...billing, footer: e.target.value })} /></label>
            <div className="toolbar"><button id="bl-save" className="btn primary" disabled={!billingOk} onClick={saveBilling}>{tr("Speichern")}</button></div>
          </>
        )}
      </section>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3>{tr("Ansätze")}</h3>
        <p className="explain">{tr("Die Kilometerpauschale bewertet Spesen der Kategorie «Kilometer». Der MwSt-Satz gilt für die Rechnungen an Kunden.")}</p>
        <div className="form-grid">
          <label className="field"><span>{tr("Kilometerpauschale (CHF/km)")}</span><input id="bl-km" type="number" step={0.05} min={0} max={5} className="input num" value={kmRate} onChange={(e) => setKmRate(e.target.value)} /></label>
          <label className="field">
            <span>{tr("MwSt-Satz auf Rechnungen")}</span>
            <Select id="bl-vatrate" value={String(vatRate)} onChange={(v) => setVatRate(Number(v))} options={VAT_RATES.map((v) => ({ value: String(v), label: v === 0 ? tr("keine MwSt") : `${fmt1(v)} %` }))} />
          </label>
        </div>
        <label className="field" style={{ maxWidth: 260 }}><span>{tr("Interner Kostensatz Standard (CHF/h)")}</span><input id="bl-cost" type="number" step={5} min={0} className="input num" value={costRate} onChange={(e) => setCostRate(e.target.value)} /></label>
        <p className="muted" style={{ fontSize: "0.82rem" }}>{tr("100 km ergeben {0}. Der Kostensatz gilt für die Profitabilität bei Personen ohne eigenen Satz (Benutzer).", fmtCHF2(Math.round(100 * Number(kmRate) * 20) / 20))}</p>
        {error && <p className="error">{error}</p>}
        <div className="toolbar"><button className="btn primary" onClick={saveRates}>{tr("Ansätze speichern")}</button></div>
      </section>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3>{tr("Wechselkurse")}</h3>
        <p className="explain">{tr("Für Kunden in EUR oder USD. CHF pro Einheit, täglich von der EZB geladen; von Hand gesetzte Kurse bleiben, bis du wieder «Jetzt laden» drückst.")}</p>
        <div className="form-grid">
          <label className="field"><span>{tr("1 EUR in CHF")}</span><input id="fx-eur" type="number" step={0.0001} min={0} className="input num" value={fx.EUR} onChange={(e) => setFx({ ...fx, EUR: e.target.value })} /></label>
          <label className="field"><span>{tr("1 USD in CHF")}</span><input id="fx-usd" type="number" step={0.0001} min={0} className="input num" value={fx.USD} onChange={(e) => setFx({ ...fx, USD: e.target.value })} /></label>
        </div>
        <p className="muted" style={{ fontSize: "0.82rem" }}>{fx.asOf ? tr("Stand {0} · {1}", fx.asOf.split("-").reverse().join("."), fx.manual ? tr("manuell") : fx.source || tr("automatisch")) : tr("Noch keine Kurse geladen.")}</p>
        <div className="toolbar" style={{ gap: 8 }}>
          <button id="fx-save" className="btn primary" onClick={saveFx} disabled={mode === "demo"}>{tr("Kurse speichern")}</button>
          <button id="fx-refresh" className="btn ghost" onClick={refreshFx} disabled={fxBusy || mode === "demo"}>{fxBusy ? tr("Lädt …") : tr("Jetzt von der EZB laden")}</button>
        </div>
      </section>
    </div>
  );
}

const WEEKDAYS = [tr("Montag"), tr("Dienstag"), tr("Mittwoch"), tr("Donnerstag"), tr("Freitag"), tr("Samstag"), tr("Sonntag")];
const newReport = (kind: ScheduledReport["kind"]): ScheduledReport =>
  kind === "weekly"
    ? { id: `r${Date.now().toString(36)}`, name: tr("Wochenmail Projektleitung"), kind, dayOfWeek: 1, hour: 7, recipients: [], enabled: true }
    : { id: `r${Date.now().toString(36)}`, name: tr("Monatsmail Geschäftsführung"), kind, dayOfMonth: 2, hour: 7, recipients: [], enabled: true };

/** Digest mails on a schedule plus the complete data export. */
function ReportsAndExport() {
  const { mode, data, notify } = useStore();
  const [list, setList] = useState<ScheduledReport[]>([]);
  const [dialog, setDialog] = useState<{ report: ScheduledReport; isNew: boolean } | null>(null);
  const [error, setError] = useState("");
  const [entity, setEntity] = useState<ExportEntity | "invoices">("time-entries");
  const [from, setFrom] = useState(`${data.today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(data.today);
  useEffect(() => {
    if (mode !== "api") return;
    api<OrgSettings>("/api/settings").then((s) => setList(s.scheduledReports ?? [])).catch((e) => setError((e as Error).message));
  }, [mode]);
  /** Every change saves the whole list right away. */
  const store = async (next: ScheduledReport[], msg: string) => {
    const s = await api<OrgSettings>("/api/settings", { method: "PUT", body: { scheduledReports: next } });
    setList(s.scheduledReports ?? []);
    setError("");
    notify(msg);
  };
  const sendNow = async (r: ScheduledReport) => {
    try {
      const res = await api<{ to: string }>(`/api/settings/reports/${r.id}/send`, { body: {} });
      notify(tr("«{0}» an {1} gesendet", r.name, res.to));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const download = (format: "csv" | "json") => {
    if (mode === "api") {
      const q = new URLSearchParams({ format, ...(entity === "customers" || entity === "projects" || entity === "employees" ? {} : { from, to }) });
      window.open(`/api/export/${entity}?${q}`, "_blank");
      return;
    }
    if (entity === "invoices") return setError(tr("Rechnungen gibt es nur in der installierten Version."));
    const rows = exportRows(data, entity, from, to);
    const blob = new Blob([format === "csv" ? toCsv(rows) : JSON.stringify(rows, null, 2)], { type: format === "csv" ? "text/csv;charset=utf-8" : "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${entity}-${data.today}.${format}`;
    a.click();
    URL.revokeObjectURL(a.href);
    notify(tr("{0} Zeilen exportiert", rows.length));
  };
  const rangeApplies = !(entity === "customers" || entity === "projects" || entity === "employees");
  return (
    <div className="grid-2" style={{ alignItems: "start" }}>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3>{tr("Geplante Berichte")}</h3>
        <p className="explain">{tr("Die Wochenmail fasst für die Projektleitung Stunden, Risiken, offene Freigaben und fehlende Wochen zusammen. Die Monatsmail zeigt der Geschäftsführung Umsatz, Auslastung, Marge, Top-Kunden und offene Rechnungen.")}</p>
        {mode === "demo" ? (
          <p className="notice">{tr("Im Prototyp werden keine E-Mails verschickt. In der installierten Version richtest du hier beliebig viele Berichte mit Empfängern, Wochentag oder Monatstag und Uhrzeit ein.")}</p>
        ) : (
          <>
            {list.length === 0 && <p className="muted" style={{ margin: 0 }}>{tr("Noch kein Bericht geplant.")}</p>}
            {list.length > 0 && (
              <ul className="report-list">
                {list.map((r) => (
                  <li key={r.id}>
                    <button className="report-item" onClick={() => setDialog({ report: r, isNew: false })}>
                      <strong>{r.name}</strong> {!r.enabled && <span className="pill neutral">{tr("Aus")}</span>}
                      <span className="muted">{r.kind === "weekly" ? tr("Jeden {0}", WEEKDAYS[(r.dayOfWeek ?? 1) - 1]) : tr("Am {0}. des Monats", r.dayOfMonth ?? 2)}{" "}{tr("um {0}:00 · an", String(r.hour).padStart(2, "0"))}{" "}{r.recipients.length ? r.recipients.join(", ") : tr("niemanden")}</span>
                    </button>
                    <span className="report-actions">
                      <button className="btn small ghost" title={tr("Schickt den Bericht jetzt an dich")} onClick={() => sendNow(r)}>{tr("Jetzt an mich")}</button>
                      <button className="btn small ghost" aria-label={tr("{0} entfernen", r.name)} onClick={() => { if (confirm(tr("Bericht «{0}» entfernen?", r.name))) void store(list.filter((x) => x.id !== r.id), tr("Bericht entfernt")); }}><Icon.trash /></button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="toolbar" style={{ gap: 8, flexWrap: "wrap" }}>
              <button id="rep-add-weekly" className="btn small" onClick={() => setDialog({ report: newReport("weekly"), isNew: true })}>{tr("+ Wochenmail")}</button>
              <button id="rep-add-monthly" className="btn small" onClick={() => setDialog({ report: newReport("monthly"), isNew: true })}>{tr("+ Monatsmail")}</button>
            </div>
            {dialog && <ReportDialog report={dialog.report} isNew={dialog.isNew} onClose={() => setDialog(null)} onSave={(r) => store(dialog.isNew ? [...list, r] : list.map((x) => (x.id === r.id ? r : x)), dialog.isNew ? tr("Bericht angelegt") : tr("Bericht gespeichert"))} />}
          </>
        )}
        {error && <p className="error">{error}</p>}
      </section>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3>{tr("Datenexport")}</h3>
        <p className="explain">{tr("Alle Daten als CSV (öffnet direkt in Excel) oder JSON für Power BI und eigene Auswertungen. Mitarbeitende erhalten nur ihre eigenen Buchungen.")}</p>
        <div className="form-grid">
          <label className="field"><span>{tr("Daten")}</span><Select id="ex-entity" value={entity} onChange={(v) => setEntity(v as ExportEntity)} options={[...EXPORT_ENTITIES.map((e) => ({ value: e.id, label: tr(e.label) })), ...(mode === "api" ? [{ value: "invoices", label: tr("Rechnungen") }] : [])]} /></label>
          <label className="field"><span>{tr("Von")}</span><input id="ex-from" type="date" className="input" value={from} disabled={!rangeApplies} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field"><span>{tr("Bis")}</span><input id="ex-to" type="date" className="input" value={to} disabled={!rangeApplies} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        <div className="toolbar" style={{ gap: 8 }}>
          <button id="ex-csv" className="btn primary" onClick={() => download("csv")}>{tr("CSV herunterladen")}</button>
          <button id="ex-json" className="btn" onClick={() => download("json")}>{tr("JSON herunterladen")}</button>
        </div>
      </section>
    </div>
  );
}

/** Operator console: the companies on this installation, each strictly separated by organization. */
function Operator() {
  const { mode, notify } = useStore();
  const [data, setData] = useState<{ registrationOpen: boolean; saas?: boolean; mainOrigin: string; summary?: PlatformSummary; orgs: PlatformOrg[] } | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const demoOrgs: PlatformOrg[] = [
    { id: "o1", name: tr("Beispiel AG"), slug: "beispiel", domain: "zeit.beispiel.ch", active: true, appName: "TrackInsight", users: 7, createdAt: "2026-01-05", plan: "business", status: "active", interval: "year", billing: "invoice", seats: 7, mrr: 128.33, currentPeriodEnd: "2027-01-05T00:00:00Z", freeMonthsOpen: 1 },
    { id: "o2", name: tr("Zweite GmbH"), slug: "zweite-gmbh", domain: null, active: true, appName: "ZweiteZeit", users: 12, createdAt: "2026-06-12", plan: "team", status: "active", interval: "month", billing: "stripe", seats: 12, mrr: 180, currentPeriodEnd: "2026-11-12T00:00:00Z" },
    { id: "o4", name: tr("Holzbau Gisler GmbH"), slug: "holzbau-gisler", domain: null, active: true, appName: "TrackInsight", users: 6, createdAt: "2026-10-16", plan: "start", status: "trialing", interval: "month", billing: "invoice", seats: 6, mrr: 0, trialEndsAt: "2026-11-15T00:00:00Z" },
    { id: "o5", name: tr("Atelier Nord"), slug: "atelier-nord", domain: null, active: true, appName: "TrackInsight", users: 9, createdAt: "2026-05-02", plan: "start", status: "past_due", interval: "month", billing: "stripe", seats: 9, mrr: 81, currentPeriodEnd: "2026-10-02T00:00:00Z" },
    { id: "o3", name: tr("Alte AG"), slug: "alte-ag", domain: null, active: false, appName: "TrackInsight", users: 3, createdAt: "2025-11-20", plan: "start", status: "canceled", interval: "month", billing: "invoice", seats: 3, mrr: 0 },
  ];
  const demoSummary = (orgs: PlatformOrg[]): PlatformSummary => ({
    mrr: orgs.reduce((s, o) => s + (o.active ? o.mrr ?? 0 : 0), 0),
    active: orgs.filter((o) => o.active && o.status === "active").length,
    trialing: orgs.filter((o) => o.active && o.status === "trialing").length,
    pastDue: orgs.filter((o) => o.active && o.status === "past_due").length,
    ended: orgs.filter((o) => o.status === "canceled" || o.status === "expired").length,
  });
  const load = () => (mode === "api" ? api<typeof data>("/api/platform/orgs").then(setData).catch((e: Error) => setError(e.message)) : Promise.resolve(setData({ registrationOpen: true, saas: true, mainOrigin: "https://trackinsight.ch", summary: demoSummary(demoOrgs), orgs: demoOrgs })));
  useEffect(() => { void load(); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const create = async (form: { name: string; domain: string; adminName: string; adminEmail: string }) => {
    if (mode === "api") await api("/api/platform/orgs", { body: { name: form.name, domain: form.domain || undefined, adminName: form.adminName, adminEmail: form.adminEmail } });
    else setData((d) => d && { ...d, orgs: [...d.orgs, { id: `o${d.orgs.length + 1}`, name: form.name, slug: form.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), domain: form.domain || null, active: true, appName: "TrackInsight", users: 1, createdAt: new Date().toISOString() }] });
    notify(tr("{0} angelegt, Einladung an {1} geschickt", form.name, form.adminEmail));
    if (mode === "api") await load();
  };
  const patch = async (o: PlatformOrg, body: Partial<Pick<PlatformOrg, "active" | "domain" | "plan" | "status">>) => {
    if (body.active === false && !confirm(tr("{0} deaktivieren? Alle Personen werden sofort abgemeldet und können sich nicht mehr anmelden.", o.name))) return;
    const { status, ...rest } = body;
    if (mode === "api") {
      const after = await api<PlatformOrg>(`/api/platform/orgs/${o.id}`, { method: "PATCH", body: { ...rest, ...(status ? { subStatus: status } : {}) } });
      await load();
      void after;
    } else setData((d) => { if (!d) return d; const orgs = d.orgs.map((x) => (x.id === o.id ? { ...x, ...body } : x)); return { ...d, orgs, summary: demoSummary(orgs) }; });
    notify(body.active === false ? tr("{0} deaktiviert", o.name) : body.active === true ? tr("{0} aktiviert", o.name) : body.domain !== undefined ? tr("Domain gespeichert") : tr("{0} aktualisiert", o.name));
  };
  if (!data) return <p className="muted">{error || tr("Lade …")}</p>;
  const s = data.summary;
  return (
    <div className="stack">
      {data.saas && s && (
        <div className="tiles" id="op-tiles">
          <div className="card tile"><span className="eyebrow">{tr("Monatlicher Umsatz")}</span><span className="value num">{fmtCHF2(s.mrr)}</span><span className="delta">{fmtCHF2(s.mrr * 12)}{" "}{tr("pro Jahr, zzgl. MWST")}</span></div>
          <div className="card tile"><span className="eyebrow">{tr("Zahlende Firmen")}</span><span className="value num">{s.active}</span><span className="delta">{s.pastDue > 0 ? tr("{0} mit offener Zahlung", s.pastDue) : tr("alle Zahlungen aktuell")}</span></div>
          <div className="card tile"><span className="eyebrow">{tr("In der Testphase")}</span><span className="value num">{s.trialing}</span><span className="delta">{s.active + s.trialing > 0 ? tr("{0} % wandeln um", Math.round((s.active / Math.max(1, s.active + s.trialing + s.ended)) * 100)) : tr("noch keine")}</span></div>
          <div className="card tile"><span className="eyebrow">{tr("Beendet")}</span><span className="value num">{s.ended}</span><span className="delta">{tr("gekündigt oder Testphase abgelaufen")}</span></div>
        </div>
      )}
      <MonitorCard />
      {(data.saas || mode === "demo") && <PartnersCard />}
      <section className="card">
        <div className="card-head">
          <h2>{tr("Firmen auf dieser Installation")}</h2>
          <button id="org-add" className="btn small" onClick={() => setOpen(true)}>{tr("+ Firma")}</button>
        </div>
        <div className="card-pad" style={{ paddingTop: 10 }}>
          <p className="muted" style={{ marginTop: 0 }}>
            {tr("Jede Firma ist strikt getrennt: eigene Benutzer, Kunden, Daten und Design. Mit eigener Domain (DNS-Eintrag auf diesen Server) erscheint ihr Design schon auf der Anmeldeseite, und nur ihre Benutzer können sich dort anmelden.  Selbstregistrierung unter {0}/registrieren ist", data.mainOrigin)}{" "}{data.registrationOpen ? tr("offen") : "geschlossen"}{" "}{tr("(Umgebungsvariable REGISTRATION_OPEN).")}
          </p>
          {open && <OrgDialog onClose={() => setOpen(false)} onCreate={create} />}
          <div className="table-wrap">
            <table className="data" id="org-table">
              <thead><tr><th>{tr("Firma")}</th><th>{tr("Kürzel")}</th><th>{tr("Domain")}</th>{data.saas && <th>{tr("Paket")}</th>}<th className="r">{tr("Benutzer")}</th>{data.saas && <th className="r">{tr("MRR")}</th>}<th>{tr("Status")}</th><th /></tr></thead>
              <tbody>
                {data.orgs.map((o) => (
                  <tr key={o.id} className={o.active ? "" : "muted"}>
                    <td><strong>{o.name}</strong><div className="muted" style={{ fontSize: "0.78rem" }}>{o.appName}{" "}{tr("· seit")}{" "}{fmtDate(o.createdAt.slice(0, 10))}</div></td>
                    <td className="mono">{o.slug ?? "–"}</td>
                    <td>
                      <input className="input-inline" defaultValue={o.domain ?? ""} placeholder={tr("zeit.firma.ch")} aria-label={tr("Domain von {0}", o.name)} onBlur={(e) => { const v = e.target.value.trim().toLowerCase(); if (v !== (o.domain ?? "")) void patch(o, { domain: v || null }).catch((err: Error) => { setError(err.message); e.target.value = o.domain ?? ""; }); }} />
                    </td>
                    {data.saas && (
                      <td>
                        <select className="input-inline" aria-label={tr("Paket von {0}", o.name)} value={o.plan} onChange={(e) => void patch(o, { plan: e.target.value as PlatformOrg["plan"] }).catch((err: Error) => setError(err.message))}>
                          {PLANS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                        <div className="muted" style={{ fontSize: "0.74rem" }}>{o.billing === "stripe" ? tr("Karte") : tr("Rechnung")}{o.interval === "year" ? tr(" · jährlich") : ""}</div>
                      </td>
                    )}
                    <td className="r num">{o.users}</td>
                    {data.saas && <td className="r num">{o.mrr ? fmtCHF2(o.mrr) : "–"}</td>}
                    <td>
                      {!o.active ? <span className="pill neutral">{tr("Deaktiviert")}</span> : data.saas && o.status ? (
                        <>
                          <span className={`pill ${statusPill(o.status)}`}>{STATUS_LABEL[o.status]}</span>
                          {o.status === "trialing" && o.trialEndsAt && <div className="muted" style={{ fontSize: "0.74rem" }}>{tr("bis {0}", fmtDate(o.trialEndsAt.slice(0, 10)))}</div>}
                          {o.canceledAt && o.status === "active" && <div className="muted" style={{ fontSize: "0.74rem" }}>{tr("gekündigt")}</div>}
                        </>
                      ) : <span className="pill ok">{tr("Aktiv")}</span>}
                    </td>
                    <td className="r op-actions">
                      {!!o.freeMonthsOpen && <button className="btn small" title={tr("Aus Empfehlungen verdient. Klicken, wenn auf der Rechnung gutgeschrieben.")} onClick={() => void (mode === "demo" ? Promise.resolve(notify(tr("Im Prototyp wird nichts gespeichert."))) : api(`/api/platform/orgs/${o.id}/free-month`, { body: {} }).then(() => { notify(tr("Gratismonat verrechnet")); return load(); })).catch((err: Error) => setError(err.message))}>{tr("Gratismonat verrechnen ({0} offen)", o.freeMonthsOpen)}</button>}
                      {data.saas && o.active && o.status !== "active" && <button className="btn small" title={tr("Zahlung erhalten, Abo aktiv setzen")} onClick={() => void patch(o, { status: "active" }).catch((err: Error) => setError(err.message))}>{tr("Aktiv setzen")}</button>}
                      <button className="btn small ghost" onClick={() => void patch(o, { active: !o.active })}>{o.active ? tr("Deaktivieren") : tr("Aktivieren")}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
      </section>
    </div>
  );
}

type Tab = "look" | "users" | "signin" | "sso" | "chat" | "work" | "billing" | "reports" | "import" | "jira" | "api" | "abo" | "operator";
const tabOfHash = (): Tab | null => (location.hash.startsWith("#einstellungen/") ? (location.hash.split("/")[1] as Tab) : null);

const NAV_ICON: Partial<Record<Tab, () => JSX.Element>> = {
  look: () => <svg viewBox="0 0 24 24" {...NAV_P}><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.8 1.5-1.5 0-.9-.6-1.2-.6-2 0-.9.7-1.5 1.6-1.5H17a4 4 0 0 0 4-4c0-5-4-9-9-9Z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10.5" cy="7" r="1" /><circle cx="15" cy="7.5" r="1" /></svg>,
  users: Icon.users,
  work: Icon.clock,
  signin: Icon.lock,
  sso: Icon.shield,
  chat: () => <svg viewBox="0 0 24 24" {...NAV_P}><path d="M4 5h16v11H9l-5 4V5Z" /><path d="M8 9.5h8M8 12.5h5" /></svg>,
  billing: () => <svg viewBox="0 0 24 24" {...NAV_P}><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 8h6M9 12h6" /></svg>,
  abo: () => <svg viewBox="0 0 24 24" {...NAV_P}><rect x="3" y="5.5" width="18" height="13" rx="2" /><path d="M3 10h18M7 15h4" /></svg>,
  reports: Icon.report,
  import: () => <svg viewBox="0 0 24 24" {...NAV_P}><path d="M12 3v12M7 10l5 5 5-5" /><path d="M4 17v3h16v-3" /></svg>,
  jira: () => <svg viewBox="0 0 24 24" {...NAV_P}><path d="M12 3 21 12l-9 9-9-9 9-9Z" /><path d="M12 8.5 15.5 12 12 15.5 8.5 12 12 8.5Z" /></svg>,
  api: () => <svg viewBox="0 0 24 24" {...NAV_P}><path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" /></svg>,
  operator: Icon.shield,
};
const NAV_P = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

type NavItem = { id: Tab; label: string; badge?: { text: string; tone: "warn" | "good" | "n" } };
type NavGroup = { id: string; label: string; items: NavItem[] };

/** Small status hints next to the settings entries: missing IBAN, Jira connection, team size, trial days. */
function useNavHints(enabled: boolean) {
  const { mode } = useStore();
  const [hints, setHints] = useState<{ ibanMissing?: boolean; jira?: boolean; sso?: boolean }>({});
  useEffect(() => {
    if (!enabled) return;
    if (mode === "demo") { setHints({ ibanMissing: false, jira: true, sso: true }); return; }
    api<OrgSettings>("/api/settings").then((s) => setHints((h) => ({ ...h, ibanMissing: !s.billing?.iban, sso: !!s.ssoActive }))).catch(() => {});
    api<{ connected: boolean }>("/api/jira").then((j) => setHints((h) => ({ ...h, jira: j.connected }))).catch(() => {});
  }, [enabled, mode]);
  return hints;
}

export function Settings() {
  const { me, mode, role, data } = useStore();
  const operator = mode === "demo" || !!me?.platformAdmin;
  const sub = useSubscription();
  const [tab, setTab] = useState<Tab>(() => tabOfHash() ?? "look");
  // On phones the list is its own screen; picking an entry opens it, «Einstellungen» goes back.
  const [listOpen, setListOpen] = useState(() => !tabOfHash());
  const [query, setQuery] = useState("");
  const hints = useNavHints(role === "admin");
  useEffect(() => {
    const on = () => { const t = tabOfHash(); if (t) { setTab(t); setListOpen(false); } };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const open = (t: Tab) => {
    setTab(t);
    setListOpen(false);
    history.replaceState(null, "", `#einstellungen/${t}`);
  };

  const people = data.employees.filter((e) => e.role !== "customer").length;
  const trialDays = sub?.status === "trialing" && sub.trialEndsAt ? Math.max(0, Math.ceil((Date.parse(sub.trialEndsAt) - Date.now()) / 86_400_000)) : null;
  const groups: NavGroup[] = [
    { id: "firma", label: tr("Firma"), items: [
      { id: "look", label: tr("Erscheinungsbild") },
      { id: "users", label: tr("Benutzer"), badge: people ? { text: String(people), tone: "n" } : undefined },
      { id: "work", label: tr("Arbeitszeit") },
    ] },
    { id: "login", label: tr("Anmeldung"), items: [{ id: "signin", label: tr("Anmeldung & E-Mail") }, ...(role === "admin" ? [{ id: "sso" as Tab, label: tr("Firmen-Login (SSO)"), badge: hints.sso ? { text: tr("aktiv"), tone: "good" as const } : undefined }] : [])] },
    { id: "geld", label: tr("Abrechnung"), items: [
      { id: "billing", label: tr("Rechnung"), badge: hints.ibanMissing ? { text: tr("IBAN fehlt"), tone: "warn" } : undefined },
      ...(sub ? [{ id: "abo" as Tab, label: tr("Abo"), badge: trialDays !== null ? { text: trn(trialDays, "{0} Tag", "{0} Tage"), tone: "n" as const } : sub.status === "past_due" ? { text: tr("Zahlung offen"), tone: "warn" as const } : undefined }] : []),
    ] },
    { id: "daten", label: tr("Daten"), items: [
      { id: "reports", label: tr("Berichte & Export") },
      ...(role === "admin" ? [{ id: "import" as Tab, label: tr("Import") }] : []),
    ] },
    { id: "conn", label: tr("Verbindungen"), items: [
      { id: "jira", label: tr("Jira"), badge: hints.jira ? { text: tr("verbunden"), tone: "good" } : undefined },
      ...(role === "admin" ? [{ id: "chat" as Tab, label: tr("Slack & Teams") }, { id: "api" as Tab, label: tr("API & Webhooks") }] : []),
    ] },
    ...(operator ? [{ id: "op", label: tr("Plattform"), items: [{ id: "operator" as Tab, label: tr("Betreiber") }] }] : []),
  ];
  const q = query.trim().toLowerCase();
  const shown = groups.map((g) => ({ ...g, items: g.items.filter((i) => !q || i.label.toLowerCase().includes(q) || g.label.toLowerCase().includes(q)) })).filter((g) => g.items.length);
  const current = groups.find((g) => g.items.some((i) => i.id === tab));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{tr("Einstellungen")}</h1>
          <p className="sub">{tr("Für die ganze Firma.")}</p>
        </div>
      </div>
      <div className={`set-layout${listOpen ? " list-open" : ""}`}>
        <nav className="set-nav" aria-label={tr("Einstellungen")}>
          <label className="set-search">
            <Icon.search />
            <input id="set-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr("Einstellung suchen")} aria-label={tr("Einstellung suchen")} />
          </label>
          {shown.map((g) => (
            <div key={g.id} className={`set-group g-${g.id}`}>
              <div className="set-group-label">{g.label}</div>
              {g.items.map((i) => {
                const I = NAV_ICON[i.id];
                return (
                  <button key={i.id} id={`tab-${i.id}`} type="button" className={`set-item${tab === i.id ? " on" : ""}`} aria-current={tab === i.id ? "page" : undefined} onClick={() => open(i.id)}>
                    {I && <I />}
                    <span className="set-label">{i.label}</span>
                    {i.badge && <span className={`set-badge ${i.badge.tone}`}>{i.badge.text}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {!shown.length && <p className="muted set-empty">{tr("Nichts gefunden.")}</p>}
        </nav>
        <div className="set-main">
          <button type="button" className="set-back" onClick={() => setListOpen(true)}><Icon.back /> {tr("Einstellungen")}</button>
          {current && <div className="set-crumb">{current.label}</div>}
          {tab === "look" && <Appearance />}
          {tab === "users" && <Users />}
          {tab === "signin" && <SignIn />}
          {tab === "sso" && role === "admin" && <SsoTab />}
          {tab === "chat" && role === "admin" && <ChatTab />}
          {tab === "work" && <WorkSettings />}
          {tab === "billing" && <><Billing /><BexioCard /></>}
          {tab === "reports" && <ReportsAndExport />}
          {tab === "import" && role === "admin" && <ImportTab />}
          {tab === "jira" && <JiraTab />}
          {tab === "api" && role === "admin" && <IntegrationsTab />}
          {tab === "abo" && sub && <div style={{ display: "flex", flexDirection: "column", gap: 16 }}><SubscriptionTab onSetup={() => window.dispatchEvent(new CustomEvent("ti:setup"))} />{role === "admin" && <ReferralCard />}</div>}
          {tab === "operator" && operator && <Operator />}
        </div>
      </div>
    </>
  );
}
