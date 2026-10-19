import { DEFAULT_RATES, EXPORT_ENTITIES, VAT_RATES, defaultHolidays, exportRows, fmt1, fmtCHF2, fmtDate, toCsv, type ExportEntity, type Holiday, type PostalAddress, type Role } from "@taktwerk/domain";
import { useEffect, useState } from "react";
import { api, type BillingSettings, type Branding, type PlatformOrg, type ScheduledReport, type Settings as OrgSettings, type UserRow } from "../api";
import { useStore } from "../store";
import { BrandMark, MatterhornRidge } from "../ui/motif";
import { Select } from "../ui/Select";

const PRESETS = [
  { name: "Schweizer Rot", color: "#D52B1E" },
  { name: "Bordeaux", color: "#8C1D2F" },
  { name: "Tannengrün", color: "#1F6B4A" },
  { name: "Gletscherblau", color: "#1E5F99" },
  { name: "Anthrazit", color: "#2E3136" },
];
const ROLE_LABEL: Record<Role, string> = { admin: "Admin", consultant: "Consultant", employee: "Mitarbeitende", auditor: "Treuhand (nur lesen)", customer: "Kunde (Portal)" };
const ROLE_HINT = "Admin und Consultant sehen alles. Mitarbeitende sehen nur Eigenes, ausser sie leiten ein Projekt oder ein Team. Treuhand sieht alles, ändert nichts.";

/** Teams with their leads; members are assigned in the user table. */
function Teams({ users, onChanged }: { users: UserRow[] | null; onChanged: () => void }) {
  const { data, mode, notify } = useStore();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const people = (users ?? []).filter((u) => u.active && u.role !== "customer" && u.role !== "auditor");
  const teams = data.teams;
  const members = (teamId: string) => (users ?? []).filter((u) => u.teamId === teamId).length;
  const run = (f: () => Promise<unknown>, msg: string) =>
    f()
      .then(() => { setError(""); notify(msg); onChanged(); })
      .catch((e: Error) => setError(e.message));
  const add = () => {
    if (!name.trim()) return;
    void run(() => api("/api/teams", { body: { name: name.trim() } }), `Team ${name.trim()} angelegt`).then(() => setName(""));
  };
  return (
    <section className="card card-pad" id="teams" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <h3>Teams und Teamleitung</h3>
        <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.85rem" }}>Die Teamleitung bewilligt Absenzen, schliesst Monate ab und sieht die Wochen ihres Teams. Projektleitung vergibst du auf der Projektseite.</p>
      </div>
      {mode === "demo" ? (
        <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
          {teams.map((t) => <li key={t.id}>{t.name} · Leitung {data.employees.find((e) => e.id === t.leadUserId)?.name ?? "keine"}</li>)}
        </ul>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Team</th><th>Teamleitung</th><th className="r">Personen</th><th /></tr></thead>
              <tbody>
                {teams.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>
                      <Select small ariaLabel={`Teamleitung von ${t.name}`} value={t.leadUserId ?? ""} placeholder="Keine" onChange={(v) => void run(() => api(`/api/teams/${t.id}`, { method: "PATCH", body: { leadUserId: v || null } }), "Teamleitung gespeichert")} options={[{ value: "", label: "Keine" }, ...people.map((u) => ({ value: u.id, label: u.name }))]} />
                    </td>
                    <td className="r num">{members(t.id)}</td>
                    <td className="r"><button className="btn small ghost" onClick={() => { if (confirm(`Team ${t.name} löschen? Die Personen bleiben ohne Team.`)) void run(() => api(`/api/teams/${t.id}`, { method: "DELETE" }), "Team gelöscht"); }}>Löschen</button></td>
                  </tr>
                ))}
                {teams.length === 0 && <tr><td colSpan={4} className="muted">Noch keine Teams.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="toolbar">
            <input id="team-name" className="input" placeholder="Neues Team, z. B. Beratung" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} style={{ maxWidth: 280 }} />
            <button id="team-add" className="btn" onClick={add}>Team anlegen</button>
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
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
      notify(file ? "Logo gespeichert" : "Logo entfernt");
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
      notify("Erscheinungsbild gespeichert");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="grid-2" style={{ alignItems: "start" }}>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <label className="field"><span>Name der Anwendung</span>
          <input id="b-name" className="input" maxLength={60} value={draft.appName} onChange={(e) => setDraft({ ...draft, appName: e.target.value })} />
        </label>
        <div className="field">
          <span>Hauptfarbe</span>
          <div className="swatches">
            {PRESETS.map((p) => (
              <button key={p.color} type="button" title={p.name} aria-label={p.name} className={`swatch ${draft.primaryColor.toUpperCase() === p.color ? "on" : ""}`}
                style={{ background: p.color }} onClick={() => setDraft({ ...draft, primaryColor: p.color })} />
            ))}
            <input id="b-color" type="color" aria-label="Eigene Farbe" className="swatch" style={{ padding: 0 }} value={draft.primaryColor} onChange={(e) => setDraft({ ...draft, primaryColor: e.target.value.toUpperCase() })} />
            <input id="b-hex" className="input mono" style={{ width: 110 }} value={draft.primaryColor} onChange={(e) => setDraft({ ...draft, primaryColor: e.target.value })} />
          </div>
        </div>
        <div className="field">
          <span>Logo</span>
          <div className="logo-row">
            <BrandMark logo={branding.logo} size={40} />
            <div className="toolbar">
              <label className="btn small">
                {branding.logo ? "Logo ersetzen" : "Logo hochladen"}
                <input id="b-logo" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden disabled={logoBusy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) changeLogo(f); }} />
              </label>
              {branding.logo && <button className="btn small ghost" disabled={logoBusy} onClick={() => changeLogo(null)}>Entfernen</button>}
            </div>
          </div>
          <span className="muted" style={{ fontSize: "0.78rem", fontWeight: 400 }}>PNG, SVG, JPEG oder WebP bis 1 MB, am besten quadratisch oder quer mit transparentem Hintergrund. Ohne eigenes Logo erscheint das Matterhorn-Zeichen in der Hauptfarbe.</span>
        </div>
        <label className="check"><input id="b-motif" type="checkbox" checked={draft.showMotif} onChange={(e) => setDraft({ ...draft, showMotif: e.target.checked })} />Matterhorn-Motiv auf Anmeldeseite und in der Navigation zeigen</label>
        {error && <p className="error">{error}</p>}
        <div className="toolbar">
          <button className="btn primary" disabled={!valid} onClick={save}>Speichern</button>
          <button className="btn ghost" onClick={() => setDraft(branding)}>Verwerfen</button>
        </div>
        <p className="muted" style={{ fontSize: "0.82rem" }}>Diagrammfarben und Ampeln bleiben unabhängig von der Hauptfarbe, damit Auswertungen eindeutig lesbar sind.</p>
      </section>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h3>Vorschau</h3>
        <div className="preview" style={{ ["--brand" as string]: valid ? draft.primaryColor : branding.primaryColor }}>
          <div className="preview-rail">
            <div className="brand" style={{ fontSize: "0.9rem" }}><BrandMark logo={branding.logo} size={24} />{draft.appName || "–"}</div>
            <div className="nav"><a className="active">Dashboard</a><a>Zeiterfassung</a></div>
            {draft.showMotif && <span className="rail-motif" style={{ marginTop: "auto", margin: "auto -12px -12px" }}><MatterhornRidge /></span>}
          </div>
          <div className="preview-main">
            <strong>Dashboard</strong>
            <div className="toolbar"><button className="btn primary small">Buchen</button><span className="pill risk">Knapp</span></div>
          </div>
        </div>
      </section>
    </div>
  );
}

function Users() {
  const { mode, notify, data, reload: reloadData } = useStore();
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [form, setForm] = useState({ name: "", email: "", username: "", role: "employee" as Role });
  const [error, setError] = useState("");
  const reload = () => api<UserRow[]>("/api/users").then(setRows).catch((e) => setError(e.message));
  useEffect(() => {
    if (mode === "api") reload();
  }, [mode]);

  if (mode === "demo")
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <p className="notice">Im Prototyp gibt es keine Benutzerverwaltung. In der installierten Version lädst du hier Personen per E-Mail ein und vergibst Rollen. {ROLE_HINT}</p>
        <Teams users={null} onChanged={() => undefined} />
      </div>
    );

  const invite = async () => {
    try {
      await api("/api/users", { body: form });
      setForm({ name: "", email: "", username: "", role: "employee" });
      setError("");
      notify(`Einladung an ${form.email} gesendet`);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
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
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3>Person einladen</h3>
        <div className="form-grid" style={{ alignItems: "end" }}>
          <label className="field"><span>Name</span><input id="u-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field"><span>E-Mail</span><input id="u-email" type="email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label className="field"><span>Benutzername</span><input id="u-username" className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="z. B. vorname.nachname" /></label>
          <label className="field"><span>Rolle</span>
            <Select id="u-role" value={form.role} onChange={(v) => setForm({ ...form, role: v as Role })} options={(Object.keys(ROLE_LABEL) as Role[]).filter((r) => r !== "customer").map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
          </label>
          <button className="btn primary" onClick={invite}>Einladung senden</button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>
      <section className="card">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Name</th><th>Benutzername</th><th>E-Mail</th><th>Rolle</th><th>Team</th><th className="r">Kostensatz CHF/h</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows?.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td className="mono">{u.username}</td>
                  <td>{u.email}</td>
                  <td>
                    <Select small ariaLabel={`Rolle von ${u.name}`} value={u.role} onChange={(v) => patch(u.id, { role: v })} options={(Object.keys(ROLE_LABEL) as Role[]).filter((r) => r !== "customer").map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
                  </td>
                  <td>
                    <Select small ariaLabel={`Team von ${u.name}`} value={u.teamId ?? ""} placeholder="Kein Team" onChange={(v) => patch(u.id, { teamId: v || null })} options={[{ value: "", label: "Kein Team" }, ...data.teams.map((t) => ({ value: t.id, label: t.name }))]} />
                  </td>
                  <td className="r">
                    <input className="input num" type="number" min={0} step={5} style={{ width: 90, textAlign: "right" }} aria-label={`Kostensatz von ${u.name}`} placeholder="Standard" defaultValue={u.costRate ?? ""} onBlur={(e) => { const v = e.target.value.trim(); const next = v === "" ? null : Number(v); if ((u.costRate ?? null) !== next) patch(u.id, { costRate: next }); }} />
                  </td>
                  <td>{!u.active ? <span className="pill neutral">Deaktiviert</span> : u.lastLoginAt ? <span className="pill ok">Aktiv</span> : <span className="pill risk">Eingeladen</span>}</td>
                  <td className="r" style={{ whiteSpace: "nowrap" }}>
                    <button className="btn small ghost" title="Zweiten Faktor und Passkeys entfernen, alle Geräte abmelden" onClick={() => { if (confirm(`Zweiten Faktor von ${u.name} zurücksetzen? Alle Geräte werden abgemeldet.`)) void api(`/api/users/${u.id}/security/reset`, { body: {} }).then(() => notify("Zweiter Faktor zurückgesetzt")).catch((e: Error) => setError(e.message)); }}>2FA zurücksetzen</button>
                    <button className="btn small ghost" onClick={() => patch(u.id, { active: !u.active })}>{u.active ? "Deaktivieren" : "Aktivieren"}</button>
                    {!u.active && !u.username.startsWith("ehemalig-") && (
                      <>
                        <a className="btn small ghost" href={`/api/users/${u.id}/export`} download title="Auskunft nach DSG als Datei">Auskunft</a>
                        <button className="btn small ghost" title="Name, E-Mail, Zugänge und Erinnerungen entfernen; Buchungen bleiben anonym erhalten" onClick={() => { const pw = prompt(`${u.name} anonymisieren? Das lässt sich nicht rückgängig machen.\nZur Bestätigung dein Passwort:`); if (pw) void api(`/api/users/${u.id}/anonymize`, { body: { password: pw } }).then(() => { notify("Person anonymisiert"); reload(); }).catch((e: Error) => setError(e.message)); }}>Anonymisieren</button>
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
  if (mode === "demo") return <p className="notice">Im Prototyp nicht verfügbar. Hier legst du in der installierten Version fest, welche Firmen-Domains sich ohne Einladung mit Microsoft oder Google anmelden dürfen, und prüfst den E-Mail-Versand.</p>;

  const save = async () => {
    try {
      const list = domains.split(/[\s,;]+/).filter(Boolean);
      setSettings(await api<OrgSettings>("/api/settings", { method: "PUT", body: { ssoAutoProvisionDomains: list } }));
      setError("");
      notify("Anmeldung gespeichert");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const saveReportDay = async () => {
    try {
      setSettings(await api<OrgSettings>("/api/settings", { method: "PUT", body: { reportDay: Number(reportDay) } }));
      setError("");
      notify("Versandtag gespeichert");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const testMail = async () => {
    const r = await api<{ smtp: boolean }>("/api/settings/test-mail", { body: {} });
    notify(r.smtp ? "Test-E-Mail an dich gesendet" : "Kein SMTP-Server eingerichtet, E-Mail nur ins Server-Log geschrieben");
  };

  return (
    <div className="grid-2" style={{ alignItems: "start" }}>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3>Microsoft und Google</h3>
        <p className="explain">Personen mit Einladung können sich immer mit Microsoft oder Google anmelden, wenn das Konto dieselbe E-Mail-Adresse hat. Für die folgenden Domains wird beim ersten Login automatisch ein Zugang als Mitarbeitende angelegt.</p>
        <label className="field"><span>Domains (durch Komma getrennt)</span>
          <input id="s-domains" className="input" placeholder="z. B. firma.ch, firma.com" value={domains} onChange={(e) => setDomains(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="toolbar"><button className="btn primary" disabled={!settings} onClick={save}>Speichern</button></div>
      </section>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3>E-Mail-Versand (SMTP)</h3>
        <p className="explain">Einladungen und Links zum Zurücksetzen des Passworts gehen über den SMTP-Server aus der Server-Konfiguration (<code>SMTP_HOST</code>, <code>SMTP_PORT</code>, <code>SMTP_USER</code>, <code>SMTP_PASSWORD</code>, <code>SMTP_FROM</code>).</p>
        <div className="toolbar"><button className="btn" onClick={testMail}>Test-E-Mail an mich senden</button></div>
        <h3 style={{ marginTop: 8 }}>Monatlicher Kundenreport</h3>
        <p className="explain">Der Report des Vormonats (PDF und Excel) geht an alle Kunden mit hinterlegten Empfängern (Reports → Kunde wählen). Budget-Alarme bei 80, 95 und 100 % des Forecasts gehen an Admins und Consultants.</p>
        <div className="export-bar">
          <label className="field"><span>Versand am Tag (07:00 Uhr)</span>
            <input id="s-report-day" type="number" min="1" max="28" className="input num" value={reportDay} onChange={(e) => setReportDay(e.target.value)} />
          </label>
          <button className="btn" disabled={!settings || reportDay === String(settings.reportDay ?? 3)} onClick={saveReportDay}>Speichern</button>
        </div>
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
  const [holidays, setHolidays] = useState<Holiday[]>(model.holidays);
  const [year, setYear] = useState(Number(data.today.slice(0, 4)));
  const [draft, setDraft] = useState<Holiday>({ date: `${year}-05-01`, name: "", fraction: 1 });
  const [error, setError] = useState("");
  const ofYear = holidays.filter((h) => h.date.startsWith(String(year))).sort((a, b) => a.date.localeCompare(b.date));
  const changed = Number(weeklyHours) !== model.weeklyHours || JSON.stringify(holidays) !== JSON.stringify(model.holidays) || reminder !== reminderSaved || closingRem !== closingRemSaved;

  const upsert = (list: Holiday[]) => {
    const map = new Map(holidays.map((h) => [h.date, h]));
    for (const h of list) map.set(h.date, h);
    setHolidays([...map.values()].sort((a, b) => a.date.localeCompare(b.date)));
  };
  const save = async () => {
    try {
      await setWorkSettings({ weeklyHours: Number(weeklyHours), holidays, hoursReminder: reminder, closingReminder: closingRem });
      setReminderSaved(reminder);
      setClosingRemSaved(closingRem);
      setError("");
      notify("Arbeitszeitmodell gespeichert");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="grid-2" style={{ alignItems: "start" }}>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3>Sollzeit</h3>
        <p className="explain">Sollzeit pro Woche bei 100 % Pensum, verteilt auf Montag bis Freitag. Pensum, Ferientage und Überträge pro Person legst du unter Absenzen → Team fest.</p>
        <label className="field" style={{ maxWidth: 220 }}><span>Stunden pro Woche</span>
          <input id="w-hours" type="number" step={0.25} min={1} max={60} className="input num" value={weeklyHours} onChange={(e) => setWeeklyHours(e.target.value)} />
        </label>
        <p className="muted" style={{ fontSize: "0.82rem" }}>Das sind {(Number(weeklyHours) / 5 || 0).toFixed(2)} h pro Arbeitstag bei 100 %.</p>
        <h3>Erinnerung</h3>
        <label className="check"><input id="w-reminder" type="checkbox" checked={reminder} onChange={(e) => setReminder(e.target.checked)} />Montags per E-Mail erinnern, wenn in der Vorwoche mehr als zwei Stunden fehlen</label>
        <p className="muted" style={{ fontSize: "0.82rem" }}>Die Erinnerung geht ab 09:00 Uhr an die betroffene Person und nennt die fehlenden Stunden. Bei Ferien und Krankheit zählen die gutgeschriebenen Stunden mit.</p>
        <label className="check"><input id="w-closing-reminder" type="checkbox" checked={closingRem} onChange={(e) => setClosingRem(e.target.checked)} />Am 1. per E-Mail an den Monatsabschluss erinnern</label>
        <p className="muted" style={{ fontSize: "0.82rem" }}>Wer den Vormonat noch nicht eingereicht hat, bekommt am 1. ab 09:00 Uhr eine Mail. Am 5. erhalten Admins und Consultants eine Übersicht, wer fehlt und was auf Freigabe wartet.</p>
        {error && <p className="error">{error}</p>}
        <div className="toolbar"><button className="btn primary" disabled={!changed} onClick={save}>Speichern</button></div>
      </section>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="tree-row">
          <h3>Feiertage</h3>
          <Select small ariaLabel="Jahr" value={String(year)} onChange={(v) => setYear(Number(v))} options={[-1, 0, 1].map((n) => Number(data.today.slice(0, 4)) + n).map((y) => ({ value: String(y), label: String(y) }))} />
        </div>
        <p className="explain">Feiertage unterscheiden sich je nach Kanton. Der Vorschlag enthält die Feiertage der meisten Deutschschweizer Kantone; ergänze oder entferne, was bei euch gilt.</p>
        {ofYear.length === 0 && <p className="muted">Für {year} sind noch keine Feiertage erfasst.</p>}
        {ofYear.map((h) => (
          <div className="holiday-row" key={h.date}>
            <span className="num">{fmtDate(h.date)}</span>
            <span>{h.name}</span>
            <span className="muted" style={{ fontSize: "0.8rem" }}>{h.fraction === 1 ? "ganzer Tag" : "halber Tag"}</span>
            <button className="icon-btn" aria-label={`${h.name} entfernen`} title="Entfernen" onClick={() => setHolidays(holidays.filter((x) => x.date !== h.date))}>✕</button>
          </div>
        ))}
        <div className="holiday-row">
          <input type="date" className="input" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
          <input className="input" placeholder="Name, z. B. Sechseläuten (Nachmittag)" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <Select value={String(draft.fraction)} onChange={(v) => setDraft({ ...draft, fraction: Number(v) })} options={[{ value: "1", label: "ganzer Tag" }, { value: "0.5", label: "halber Tag" }]} />
          <button className="btn small" disabled={!draft.name.trim() || !draft.date} onClick={() => { upsert([{ ...draft, name: draft.name.trim() }]); setDraft({ ...draft, name: "" }); }}>Hinzufügen</button>
        </div>
        <div className="toolbar">
          <button className="btn ghost" onClick={() => upsert(defaultHolidays(year))}>Vorschlag für {year} einfügen</button>
          <button className="btn primary" disabled={!changed} onClick={save}>Speichern</button>
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
      notify("Wechselkurse gespeichert");
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
      notify(`Kurse vom ${f.asOf.split("-").reverse().join(".")} geladen`);
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
      notify("Ansätze gespeichert");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const saveBilling = async () => {
    try {
      const body = { ...billing, vatNumber: billing.vatNumber?.trim() || undefined, footer: billing.footer?.trim() || undefined };
      await api("/api/settings", { method: "PUT", body: { billing: body } });
      setError("");
      notify("Rechnungsabsender gespeichert");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const billingOk = billing.address.name.trim() && billing.address.zip.trim() && billing.address.city.trim() && billing.iban.replace(/\s+/g, "").length === 21;

  return (
    <div className="grid-2" style={{ alignItems: "start" }}>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3>Absender und Zahlung</h3>
        <p className="explain">Erscheint auf jeder Rechnung und im QR-Zahlteil. Die IBAN muss zu einem Schweizer oder Liechtensteiner Konto gehören.</p>
        {mode === "demo" ? (
          <p className="notice">Im Prototyp werden keine Rechnungen erstellt. In der installierten Version hinterlegst du hier Adresse, IBAN und MwSt-Nummer deiner Firma.</p>
        ) : (
          <>
            <div className="form-grid">
              <label className="field"><span>Firma</span><input id="bl-name" className="input" value={billing.address.name} onChange={(e) => addr("name", e.target.value)} /></label>
              <label className="field"><span>Strasse</span><input id="bl-street" className="input" value={billing.address.street} onChange={(e) => addr("street", e.target.value)} /></label>
              <label className="field"><span>PLZ</span><input id="bl-zip" className="input" value={billing.address.zip} onChange={(e) => addr("zip", e.target.value)} /></label>
              <label className="field"><span>Ort</span><input id="bl-city" className="input" value={billing.address.city} onChange={(e) => addr("city", e.target.value)} /></label>
              <label className="field"><span>IBAN</span><input id="bl-iban" className="input mono" placeholder="CH93 0076 2011 6238 5295 7" value={billing.iban} onChange={(e) => setBilling({ ...billing, iban: e.target.value })} /></label>
              <label className="field"><span>MwSt-Nummer (optional)</span><input id="bl-vat" className="input" placeholder="CHE-123.456.789 MWST" value={billing.vatNumber} onChange={(e) => setBilling({ ...billing, vatNumber: e.target.value })} /></label>
              <label className="field"><span>Zahlungsfrist (Tage)</span><input id="bl-days" type="number" min={0} max={120} className="input num" value={billing.paymentDays} onChange={(e) => setBilling({ ...billing, paymentDays: Number(e.target.value) })} /></label>
            </div>
            <label className="field"><span>Fusstext (optional)</span><input id="bl-footer" className="input" placeholder="z. B. Vielen Dank für die gute Zusammenarbeit." value={billing.footer} onChange={(e) => setBilling({ ...billing, footer: e.target.value })} /></label>
            <div className="toolbar"><button id="bl-save" className="btn primary" disabled={!billingOk} onClick={saveBilling}>Speichern</button></div>
          </>
        )}
      </section>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3>Ansätze</h3>
        <p className="explain">Die Kilometerpauschale bewertet Spesen der Kategorie «Kilometer». Der MwSt-Satz gilt für die Rechnungen an Kunden.</p>
        <div className="form-grid">
          <label className="field"><span>Kilometerpauschale (CHF/km)</span><input id="bl-km" type="number" step={0.05} min={0} max={5} className="input num" value={kmRate} onChange={(e) => setKmRate(e.target.value)} /></label>
          <label className="field">
            <span>MwSt-Satz auf Rechnungen</span>
            <Select id="bl-vatrate" value={String(vatRate)} onChange={(v) => setVatRate(Number(v))} options={VAT_RATES.map((v) => ({ value: String(v), label: v === 0 ? "keine MwSt" : `${fmt1(v)} %` }))} />
          </label>
        </div>
        <label className="field" style={{ maxWidth: 260 }}><span>Interner Kostensatz Standard (CHF/h)</span><input id="bl-cost" type="number" step={5} min={0} className="input num" value={costRate} onChange={(e) => setCostRate(e.target.value)} /></label>
        <p className="muted" style={{ fontSize: "0.82rem" }}>100 km ergeben {fmtCHF2(Math.round(100 * Number(kmRate) * 20) / 20)}. Der Kostensatz gilt für die Profitabilität bei Personen ohne eigenen Satz (Benutzer).</p>
        {error && <p className="error">{error}</p>}
        <div className="toolbar"><button className="btn primary" onClick={saveRates}>Ansätze speichern</button></div>
      </section>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3>Wechselkurse</h3>
        <p className="explain">Für Kunden in EUR oder USD. CHF pro Einheit, täglich von der EZB geladen; von Hand gesetzte Kurse bleiben, bis du wieder «Jetzt laden» drückst.</p>
        <div className="form-grid">
          <label className="field"><span>1 EUR in CHF</span><input id="fx-eur" type="number" step={0.0001} min={0} className="input num" value={fx.EUR} onChange={(e) => setFx({ ...fx, EUR: e.target.value })} /></label>
          <label className="field"><span>1 USD in CHF</span><input id="fx-usd" type="number" step={0.0001} min={0} className="input num" value={fx.USD} onChange={(e) => setFx({ ...fx, USD: e.target.value })} /></label>
        </div>
        <p className="muted" style={{ fontSize: "0.82rem" }}>{fx.asOf ? `Stand ${fx.asOf.split("-").reverse().join(".")} · ${fx.manual ? "manuell" : fx.source || "automatisch"}` : "Noch keine Kurse geladen."}</p>
        <div className="toolbar" style={{ gap: 8 }}>
          <button id="fx-save" className="btn primary" onClick={saveFx} disabled={mode === "demo"}>Kurse speichern</button>
          <button id="fx-refresh" className="btn ghost" onClick={refreshFx} disabled={fxBusy || mode === "demo"}>{fxBusy ? "Lädt …" : "Jetzt von der EZB laden"}</button>
        </div>
      </section>
    </div>
  );
}

const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
const newReport = (kind: ScheduledReport["kind"]): ScheduledReport =>
  kind === "weekly"
    ? { id: `r${Date.now().toString(36)}`, name: "Wochenmail Projektleitung", kind, dayOfWeek: 1, hour: 7, recipients: [], enabled: true }
    : { id: `r${Date.now().toString(36)}`, name: "Monatsmail Geschäftsführung", kind, dayOfMonth: 2, hour: 7, recipients: [], enabled: true };

/** Digest mails on a schedule plus the complete data export. */
function ReportsAndExport() {
  const { mode, data, notify } = useStore();
  const [list, setList] = useState<ScheduledReport[]>([]);
  const [saved, setSaved] = useState("[]");
  const [error, setError] = useState("");
  const [entity, setEntity] = useState<ExportEntity | "invoices">("time-entries");
  const [from, setFrom] = useState(`${data.today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(data.today);
  useEffect(() => {
    if (mode !== "api") return;
    api<OrgSettings>("/api/settings").then((s) => { setList(s.scheduledReports ?? []); setSaved(JSON.stringify(s.scheduledReports ?? [])); }).catch((e) => setError((e as Error).message));
  }, [mode]);
  const update = (id: string, patch: Partial<ScheduledReport>) => setList(list.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const save = async () => {
    try {
      const s = await api<OrgSettings>("/api/settings", { method: "PUT", body: { scheduledReports: list } });
      setList(s.scheduledReports ?? []);
      setSaved(JSON.stringify(s.scheduledReports ?? []));
      setError("");
      notify("Berichte gespeichert");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const sendNow = async (r: ScheduledReport) => {
    try {
      const res = await api<{ to: string }>(`/api/settings/reports/${r.id}/send`, { body: {} });
      notify(`«${r.name}» an ${res.to} gesendet`);
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
    if (entity === "invoices") return setError("Rechnungen gibt es nur in der installierten Version.");
    const rows = exportRows(data, entity, from, to);
    const blob = new Blob([format === "csv" ? toCsv(rows) : JSON.stringify(rows, null, 2)], { type: format === "csv" ? "text/csv;charset=utf-8" : "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${entity}-${data.today}.${format}`;
    a.click();
    URL.revokeObjectURL(a.href);
    notify(`${rows.length} Zeilen exportiert`);
  };
  const dirty = JSON.stringify(list) !== saved;
  const rangeApplies = !(entity === "customers" || entity === "projects" || entity === "employees");
  return (
    <div className="grid-2" style={{ alignItems: "start" }}>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3>Geplante Berichte</h3>
        <p className="explain">Die Wochenmail fasst für die Projektleitung Stunden, Risiken, offene Freigaben und fehlende Wochen zusammen. Die Monatsmail zeigt der Geschäftsführung Umsatz, Auslastung, Marge, Top-Kunden und offene Rechnungen.</p>
        {mode === "demo" ? (
          <p className="notice">Im Prototyp werden keine E-Mails verschickt. In der installierten Version richtest du hier beliebig viele Berichte mit Empfängern, Wochentag oder Monatstag und Uhrzeit ein.</p>
        ) : (
          <>
            {list.map((r) => (
              <div key={r.id} className="report-row">
                <div className="form-grid" style={{ alignItems: "end" }}>
                  <label className="field"><span>Name</span><input className="input" value={r.name} onChange={(e) => update(r.id, { name: e.target.value })} /></label>
                  <label className="field"><span>Art</span><Select small value={r.kind} onChange={(v) => update(r.id, v === "weekly" ? { kind: "weekly", dayOfWeek: r.dayOfWeek ?? 1, dayOfMonth: undefined } : { kind: "monthly", dayOfMonth: r.dayOfMonth ?? 2, dayOfWeek: undefined })} options={[{ value: "weekly", label: "Wöchentlich (Projektleitung)" }, { value: "monthly", label: "Monatlich (Geschäftsführung)" }]} /></label>
                  {r.kind === "weekly" ? (
                    <label className="field"><span>Wochentag</span><Select small value={String(r.dayOfWeek ?? 1)} onChange={(v) => update(r.id, { dayOfWeek: Number(v) })} options={WEEKDAYS.map((d, i) => ({ value: String(i + 1), label: d }))} /></label>
                  ) : (
                    <label className="field"><span>Tag im Monat</span><input className="input num" type="number" min={1} max={28} value={r.dayOfMonth ?? 2} onChange={(e) => update(r.id, { dayOfMonth: Number(e.target.value) })} /></label>
                  )}
                  <label className="field"><span>Uhrzeit</span><input className="input num" type="number" min={0} max={23} value={r.hour} onChange={(e) => update(r.id, { hour: Number(e.target.value) })} /></label>
                </div>
                <label className="field" style={{ marginTop: 8 }}><span>Empfänger (E-Mails, durch Komma getrennt)</span><input className="input" value={r.recipients.join(", ")} onChange={(e) => update(r.id, { recipients: e.target.value.split(/[\s,;]+/).filter(Boolean) })} placeholder="z. B. gl@firma.ch, pl@firma.ch" /></label>
                <div className="toolbar" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
                  <label className="check"><input type="checkbox" checked={r.enabled} onChange={(e) => update(r.id, { enabled: e.target.checked })} />Aktiv</label>
                  <button className="btn small ghost" disabled={dirty} title={dirty ? "Zuerst speichern" : "Schickt den Bericht jetzt an dich"} onClick={() => sendNow(r)}>Jetzt an mich senden</button>
                  <button className="btn small ghost" onClick={() => setList(list.filter((x) => x.id !== r.id))}>Entfernen</button>
                </div>
              </div>
            ))}
            <div className="toolbar" style={{ gap: 8, flexWrap: "wrap" }}>
              <button id="rep-add-weekly" className="btn small" onClick={() => setList([...list, newReport("weekly")])}>+ Wochenmail</button>
              <button id="rep-add-monthly" className="btn small" onClick={() => setList([...list, newReport("monthly")])}>+ Monatsmail</button>
              <button id="rep-save" className="btn primary" disabled={!dirty} onClick={save}>Speichern</button>
            </div>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </section>
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3>Datenexport</h3>
        <p className="explain">Alle Daten als CSV (öffnet direkt in Excel) oder JSON für Power BI und eigene Auswertungen. Mitarbeitende erhalten nur ihre eigenen Buchungen.</p>
        <div className="form-grid">
          <label className="field"><span>Daten</span><Select id="ex-entity" value={entity} onChange={(v) => setEntity(v as ExportEntity)} options={[...EXPORT_ENTITIES.map((e) => ({ value: e.id, label: e.label })), ...(mode === "api" ? [{ value: "invoices", label: "Rechnungen" }] : [])]} /></label>
          <label className="field"><span>Von</span><input id="ex-from" type="date" className="input" value={from} disabled={!rangeApplies} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field"><span>Bis</span><input id="ex-to" type="date" className="input" value={to} disabled={!rangeApplies} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        <div className="toolbar" style={{ gap: 8 }}>
          <button id="ex-csv" className="btn primary" onClick={() => download("csv")}>CSV herunterladen</button>
          <button id="ex-json" className="btn" onClick={() => download("json")}>JSON herunterladen</button>
        </div>
      </section>
    </div>
  );
}

/** Operator console: the companies on this installation, each strictly separated by organization. */
function Operator() {
  const { mode, notify } = useStore();
  const [data, setData] = useState<{ registrationOpen: boolean; mainOrigin: string; orgs: PlatformOrg[] } | null>(null);
  const [form, setForm] = useState({ name: "", domain: "", adminName: "", adminEmail: "" });
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const demoOrgs: PlatformOrg[] = [
    { id: "o1", name: "Beispiel AG", slug: "beispiel", domain: "zeit.beispiel.ch", active: true, appName: "TrackInsight", users: 7, createdAt: "2026-01-05" },
    { id: "o2", name: "Zweite GmbH", slug: "zweite-gmbh", domain: null, active: true, appName: "ZweiteZeit", users: 12, createdAt: "2026-06-12" },
    { id: "o3", name: "Alte AG", slug: "alte-ag", domain: null, active: false, appName: "TrackInsight", users: 3, createdAt: "2025-11-20" },
  ];
  const load = () => (mode === "api" ? api<typeof data>("/api/platform/orgs").then(setData).catch((e: Error) => setError(e.message)) : Promise.resolve(setData({ registrationOpen: false, mainOrigin: "https://app.trackinsight.ch", orgs: demoOrgs })));
  useEffect(() => { void load(); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      if (mode === "api") await api("/api/platform/orgs", { body: { name: form.name, domain: form.domain || undefined, adminName: form.adminName, adminEmail: form.adminEmail } });
      else setData((d) => d && { ...d, orgs: [...d.orgs, { id: `o${d.orgs.length + 1}`, name: form.name, slug: form.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), domain: form.domain || null, active: true, appName: "TrackInsight", users: 1, createdAt: new Date().toISOString() }] });
      notify(`${form.name} angelegt, Einladung an ${form.adminEmail} geschickt`);
      setForm({ name: "", domain: "", adminName: "", adminEmail: "" });
      setOpen(false);
      if (mode === "api") await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const patch = async (o: PlatformOrg, body: Partial<Pick<PlatformOrg, "active" | "domain">>) => {
    if (body.active === false && !confirm(`${o.name} deaktivieren? Alle Personen werden sofort abgemeldet und können sich nicht mehr anmelden.`)) return;
    if (mode === "api") await api(`/api/platform/orgs/${o.id}`, { method: "PATCH", body });
    setData((d) => d && { ...d, orgs: d.orgs.map((x) => (x.id === o.id ? { ...x, ...body } : x)) });
    notify(body.active === false ? `${o.name} deaktiviert` : body.active === true ? `${o.name} aktiviert` : "Domain gespeichert");
  };
  if (!data) return <p className="muted">{error || "Lade …"}</p>;
  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2>Firmen auf dieser Installation</h2>
          <button id="org-add" className="btn small" onClick={() => setOpen((o) => !o)}>+ Firma</button>
        </div>
        <div className="card-pad" style={{ paddingTop: 10 }}>
          <p className="muted" style={{ marginTop: 0 }}>
            Jede Firma ist strikt getrennt: eigene Benutzer, Kunden, Daten und Design. Mit eigener Domain (DNS-Eintrag auf diesen Server) erscheint ihr Design schon auf der Anmeldeseite, und nur ihre Benutzer können sich dort anmelden.
            {" "}Selbstregistrierung unter {data.mainOrigin}/registrieren ist {data.registrationOpen ? "offen" : "geschlossen"} (Umgebungsvariable REGISTRATION_OPEN).
          </p>
          {open && (
            <form className="form-grid" style={{ marginBottom: 14 }} onSubmit={(e) => { e.preventDefault(); void create(); }}>
              <label className="field"><span>Firma</span><input id="org-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
              <label className="field"><span>Eigene Domain (optional)</span><input id="org-domain" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="zeit.firma.ch" /></label>
              <label className="field"><span>Admin, Name</span><input id="org-admin" value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} required /></label>
              <label className="field"><span>Admin, E-Mail</span><input id="org-email" type="email" value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} required /></label>
              <div className="field"><span>&nbsp;</span><button id="org-create" className="btn primary" disabled={busy}>Anlegen und einladen</button></div>
              {error && <p className="error" style={{ gridColumn: "1 / -1" }}>{error}</p>}
            </form>
          )}
          <div className="table-wrap">
            <table className="data" id="org-table">
              <thead><tr><th>Firma</th><th>Kürzel</th><th>Domain</th><th className="r">Benutzer</th><th>Status</th><th /></tr></thead>
              <tbody>
                {data.orgs.map((o) => (
                  <tr key={o.id} className={o.active ? "" : "muted"}>
                    <td><strong>{o.name}</strong><div className="muted" style={{ fontSize: "0.78rem" }}>{o.appName} · seit {fmtDate(o.createdAt.slice(0, 10))}</div></td>
                    <td className="mono">{o.slug ?? "–"}</td>
                    <td>
                      <input className="input-inline" defaultValue={o.domain ?? ""} placeholder="zeit.firma.ch" aria-label={`Domain von ${o.name}`} onBlur={(e) => { const v = e.target.value.trim().toLowerCase(); if (v !== (o.domain ?? "")) void patch(o, { domain: v || null }).catch((err: Error) => { setError(err.message); e.target.value = o.domain ?? ""; }); }} />
                    </td>
                    <td className="r num">{o.users}</td>
                    <td><span className={`pill ${o.active ? "ok" : "neutral"}`}>{o.active ? "Aktiv" : "Deaktiviert"}</span></td>
                    <td className="r"><button className="btn small ghost" onClick={() => void patch(o, { active: !o.active })}>{o.active ? "Deaktivieren" : "Aktivieren"}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error && !open && <p className="error">{error}</p>}
        </div>
      </section>
    </div>
  );
}

export function Settings() {
  const { me, mode } = useStore();
  const operator = mode === "demo" || !!me?.platformAdmin;
  const [tab, setTab] = useState<"look" | "users" | "signin" | "work" | "billing" | "reports" | "operator">("look");
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Einstellungen</h1>
          <p className="sub">Corporate Design, Benutzer, Anmeldung, Arbeitszeitmodell, Rechnungsstellung, Berichte und Export.</p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" className={tab === "look" ? "on" : ""} onClick={() => setTab("look")}>Erscheinungsbild</button>
        <button role="tab" className={tab === "users" ? "on" : ""} onClick={() => setTab("users")}>Benutzer</button>
        <button role="tab" className={tab === "signin" ? "on" : ""} onClick={() => setTab("signin")}>Anmeldung & E-Mail</button>
        <button role="tab" className={tab === "work" ? "on" : ""} onClick={() => setTab("work")}>Arbeitszeit</button>
        <button role="tab" className={tab === "billing" ? "on" : ""} onClick={() => setTab("billing")}>Rechnung</button>
        <button role="tab" className={tab === "reports" ? "on" : ""} onClick={() => setTab("reports")}>Berichte & Export</button>
        {operator && <button role="tab" id="tab-operator" className={tab === "operator" ? "on" : ""} onClick={() => setTab("operator")}>Betreiber</button>}
      </div>
      {tab === "look" && <Appearance />}
      {tab === "users" && <Users />}
      {tab === "signin" && <SignIn />}
      {tab === "work" && <WorkSettings />}
      {tab === "billing" && <Billing />}
      {tab === "reports" && <ReportsAndExport />}
      {tab === "operator" && operator && <Operator />}
    </>
  );
}
