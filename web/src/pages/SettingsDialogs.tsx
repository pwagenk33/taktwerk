// Popups for people, teams, scheduled reports and companies in the settings.
import { useState } from "react";
import type { Role } from "@taktwerk/domain";
import { api, type ScheduledReport, type UserRow } from "../api";
import { useStore } from "../store";
import { Field, FieldRow, FormDialog } from "../ui/Dialog";
import { Select } from "../ui/Select";
import { tr } from "../i18n";

type Errors = Record<string, string>;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const ROLE_LABEL: Record<Role, string> = { admin: tr("Admin"), consultant: tr("Consultant"), employee: tr("Mitarbeitende"), auditor: tr("Treuhand (nur lesen)"), customer: tr("Kunde (Portal)") };
const ROLE_HELP: Record<Exclude<Role, "customer">, string> = {
  admin: tr("Sieht und ändert alles, auch Einstellungen, Sätze und Abo."),
  consultant: tr("Sieht alle Kunden, Projekte und Berichte und plant, ohne Einstellungen."),
  employee: tr("Erfasst eigene Zeiten und Spesen. Sieht mehr, wenn die Person ein Projekt oder Team leitet."),
  auditor: tr("Sieht alles, ändert nichts. Gedacht für Treuhand und Revision; kostet nichts."),
};
const roleOptions = (Object.keys(ROLE_HELP) as Exclude<Role, "customer">[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }));

// ---------- people ----------

/** Invite a new person (no user) or edit one. */
export function UserDialog({ user, onClose, onSaved }: { user?: UserRow; onClose: () => void; onSaved: () => void }) {
  const { data, notify } = useStore();
  const editing = !!user;
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [username, setUsername] = useState(user?.username ?? "");
  const [role, setRole] = useState<Role>(user?.role ?? "employee");
  const [teamId, setTeamId] = useState(user?.teamId ?? "");
  const [costRate, setCostRate] = useState(user?.costRate != null ? String(user.costRate) : "");
  const [active, setActive] = useState(user?.active ?? true);
  const suggest = (n: string) => n.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, ".").replace(/[^a-z0-9._-]/g, "");

  const submit = async () => {
    const e: Errors = {};
    const rate = costRate.trim() === "" ? null : Number(costRate);
    if (!name.trim()) e.name = tr("Bitte den Namen eingeben.");
    if (!editing && !EMAIL.test(email.trim())) e.email = tr("Bitte eine gültige E-Mail-Adresse eingeben.");
    if (!editing && !/^[a-zA-Z0-9._@-]{3,80}$/.test(username.trim())) e.username = tr("Mindestens 3 Zeichen: Buchstaben, Ziffern, Punkt, Bindestrich.");
    if (rate !== null && !(rate >= 0 && rate <= 1000)) e.costRate = tr("Ein Betrag zwischen 0 und 1000.");
    if (Object.keys(e).length) return e;
    if (!editing) {
      const { id } = await api<{ id: string }>("/api/users", { body: { name: name.trim(), email: email.trim(), username: username.trim(), role } });
      if (teamId || rate !== null) await api(`/api/users/${id}`, { method: "PATCH", body: { ...(teamId ? { teamId } : {}), ...(rate !== null ? { costRate: rate } : {}) } });
      notify(tr("Einladung an {0} gesendet", email.trim()));
    } else {
      await api(`/api/users/${user.id}`, { method: "PATCH", body: { name: name.trim(), role, teamId: teamId || null, costRate: rate, active } });
      notify(tr("{0} gespeichert", name.trim()));
    }
    onSaved();
    onClose();
  };

  return (
    <FormDialog
      id="user-dialog"
      title={editing ? tr("{0} bearbeiten", user.name) : tr("Person einladen")}
      subtitle={editing ? tr("Rolle, Team und Kostensatz. E-Mail und Benutzername ändert die Person selbst.") : tr("Die Person erhält eine E-Mail mit einem Link zum Setzen des Passworts.")}
      submitLabel={editing ? tr("Speichern") : tr("Einladung senden")}
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label={tr("Name")} name="name" required>
        <input id="u-name" className="input" value={name} onChange={(e) => { if (!editing && username === suggest(name)) setUsername(suggest(e.target.value)); setName(e.target.value); }} placeholder={tr("Vorname Nachname")} autoComplete="off" />
      </Field>
      <FieldRow>
        <Field label={tr("E-Mail")} name="email" required={!editing}><input id="u-email" type="email" className="input" value={email} disabled={editing} onChange={(e) => setEmail(e.target.value)} placeholder={tr("name@firma.ch")} autoComplete="off" /></Field>
        <Field label={tr("Benutzername")} name="username" required={!editing} hint={editing ? undefined : tr("Zum Anmelden, wird aus dem Namen vorgeschlagen.")}><input id="u-username" className="input mono" value={username} disabled={editing} onChange={(e) => setUsername(e.target.value)} placeholder={tr("vorname.nachname")} autoComplete="off" /></Field>
      </FieldRow>
      <Field label={tr("Rolle")} required hint={ROLE_HELP[role as Exclude<Role, "customer">]}>
        <Select id="u-role" value={role} onChange={(v) => setRole(v as Role)} options={roleOptions} />
      </Field>
      <FieldRow>
        <Field label={tr("Team")} hint={tr("Die Teamleitung bewilligt Absenzen und schliesst Monate ab.")}>
          <Select id="u-team" value={teamId} placeholder={tr("Kein Team")} onChange={setTeamId} options={[{ value: "", label: tr("Kein Team") }, ...data.teams.map((t) => ({ value: t.id, label: t.name }))]} />
        </Field>
        <Field label={tr("Kostensatz (CHF/h)")} name="costRate" hint={tr("Für die Marge. Leer heisst Standardsatz der Firma.")}>
          <input id="u-cost" className="input num" inputMode="decimal" value={costRate} onChange={(e) => setCostRate(e.target.value)} placeholder={tr("Standard")} />
        </Field>
      </FieldRow>
      {editing && (
        <label className="check-field">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span><strong>{tr("Aktiv")}</strong><br /><span className="muted">{tr("Deaktivierte Personen können sich nicht mehr anmelden und zählen nicht fürs Abo. Ihre Buchungen bleiben.")}</span></span>
        </label>
      )}
    </FormDialog>
  );
}

// ---------- teams ----------

export function TeamDialog({ team, people, onClose, onSaved }: { team?: { id: string; name: string; leadUserId?: string | null }; people: UserRow[]; onClose: () => void; onSaved: () => void }) {
  const { notify } = useStore();
  const editing = !!team;
  const [name, setName] = useState(team?.name ?? "");
  const [lead, setLead] = useState(team?.leadUserId ?? "");
  const submit = async () => {
    if (!name.trim()) return { name: tr("Bitte einen Teamnamen eingeben.") };
    if (!editing) await api("/api/teams", { body: { name: name.trim(), leadUserId: lead || null } });
    else await api(`/api/teams/${team.id}`, { method: "PATCH", body: { name: name.trim(), leadUserId: lead || null } });
    notify(editing ? tr("Team gespeichert") : tr("Team {0} angelegt", name.trim()));
    onSaved();
    onClose();
  };
  const remove = async () => {
    if (!team || !confirm(tr("Team {0} löschen? Die Personen bleiben ohne Team.", team.name))) return;
    await api(`/api/teams/${team.id}`, { method: "DELETE" });
    notify(tr("Team gelöscht"));
    onSaved();
    onClose();
  };
  return (
    <FormDialog
      id="team-dialog"
      title={editing ? tr("Team {0}", team.name) : tr("Neues Team")}
      subtitle={tr("Die Teamleitung bewilligt Absenzen, schliesst Monate ab und sieht die Wochen ihres Teams. Mitglieder ordnest du bei der Person zu.")}
      submitLabel={editing ? tr("Speichern") : tr("Team anlegen")}
      onClose={onClose}
      onSubmit={submit}
      danger={editing ? <button type="button" className="btn ghost danger" onClick={() => void remove()}>{tr("Löschen")}</button> : undefined}
    >
      <Field label={tr("Name")} name="name" required><input id="team-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("z. B. Beratung")} /></Field>
      <Field label={tr("Teamleitung")}>
        <Select id="team-lead" value={lead} placeholder={tr("Keine")} onChange={setLead} options={[{ value: "", label: tr("Keine") }, ...people.map((u) => ({ value: u.id, label: u.name }))]} />
      </Field>
    </FormDialog>
  );
}

// ---------- scheduled reports ----------

const WEEKDAYS = [tr("Montag"), tr("Dienstag"), tr("Mittwoch"), tr("Donnerstag"), tr("Freitag"), tr("Samstag"), tr("Sonntag")];

/** Edit one scheduled report; `onSave` stores the whole list. */
export function ReportDialog({ report, isNew, onClose, onSave }: { report: ScheduledReport; isNew: boolean; onClose: () => void; onSave: (r: ScheduledReport) => Promise<void> }) {
  const [r, setR] = useState(report);
  const [recipients, setRecipients] = useState(report.recipients.join(", "));
  const set = (patch: Partial<ScheduledReport>) => setR({ ...r, ...patch });
  const submit = async () => {
    const e: Errors = {};
    const list = recipients.split(/[\s,;]+/).filter(Boolean);
    if (!r.name.trim()) e.name = tr("Bitte einen Namen eingeben.");
    if (list.length === 0) e.recipients = tr("Mindestens eine E-Mail-Adresse.");
    else if (list.some((x) => !EMAIL.test(x))) e.recipients = tr("Keine gültige Adresse: {0}", list.find((x) => !EMAIL.test(x)));
    if (r.kind === "monthly" && !((r.dayOfMonth ?? 0) >= 1 && (r.dayOfMonth ?? 0) <= 28)) e.dayOfMonth = tr("Ein Tag zwischen 1 und 28.");
    if (!(r.hour >= 0 && r.hour <= 23)) e.hour = tr("Eine Stunde zwischen 0 und 23.");
    if (Object.keys(e).length) return e;
    await onSave({ ...r, name: r.name.trim(), recipients: list });
    onClose();
  };
  return (
    <FormDialog
      id="report-dialog"
      title={isNew ? tr("Neuer geplanter Bericht") : r.name || tr("Bericht")}
      subtitle={r.kind === "weekly" ? tr("Die Wochenmail fasst für die Projektleitung Stunden, Risiken, offene Freigaben und fehlende Wochen zusammen.") : tr("Die Monatsmail zeigt der Geschäftsführung Umsatz, Auslastung, Marge, Top-Kunden und offene Rechnungen.")}
      submitLabel={isNew ? tr("Bericht anlegen") : tr("Speichern")}
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label={tr("Name")} name="name" required><input id="rep-name" className="input" value={r.name} onChange={(e) => set({ name: e.target.value })} /></Field>
      <Field label={tr("Art")} required>
        <Select id="rep-kind" value={r.kind} onChange={(v) => set(v === "weekly" ? { kind: "weekly", dayOfWeek: r.dayOfWeek ?? 1, dayOfMonth: undefined } : { kind: "monthly", dayOfMonth: r.dayOfMonth ?? 2, dayOfWeek: undefined })} options={[{ value: "weekly", label: tr("Wöchentlich (Projektleitung)") }, { value: "monthly", label: tr("Monatlich (Geschäftsführung)") }]} />
      </Field>
      <FieldRow>
        {r.kind === "weekly" ? (
          <Field label={tr("Wochentag")} required><Select id="rep-dow" value={String(r.dayOfWeek ?? 1)} onChange={(v) => set({ dayOfWeek: Number(v) })} options={WEEKDAYS.map((d, i) => ({ value: String(i + 1), label: d }))} /></Field>
        ) : (
          <Field label={tr("Tag im Monat")} name="dayOfMonth" required hint={tr("1 bis 28, damit es jeden Monat gibt.")}><input id="rep-dom" className="input num" inputMode="numeric" value={r.dayOfMonth ?? ""} onChange={(e) => set({ dayOfMonth: Number(e.target.value) })} /></Field>
        )}
        <Field label={tr("Uhrzeit (Stunde)")} name="hour" required hint={tr("Schweizer Zeit, z. B. 7 für 07:00.")}><input id="rep-hour" className="input num" inputMode="numeric" value={r.hour} onChange={(e) => set({ hour: Number(e.target.value) })} /></Field>
      </FieldRow>
      <Field label={tr("Empfänger")} name="recipients" required hint={tr("E-Mail-Adressen, durch Komma getrennt.")}><input id="rep-to" className="input" value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder={tr("gl@firma.ch, pl@firma.ch")} /></Field>
      <label className="check-field">
        <input type="checkbox" checked={r.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span><strong>{tr("Aktiv")}</strong><br /><span className="muted">{tr("Ausgeschaltete Berichte bleiben gespeichert, werden aber nicht verschickt.")}</span></span>
      </label>
    </FormDialog>
  );
}

// ---------- companies (operator) ----------

export function OrgDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (f: { name: string; domain: string; adminName: string; adminEmail: string }) => Promise<void> }) {
  const [f, setF] = useState({ name: "", domain: "", adminName: "", adminEmail: "" });
  const submit = async () => {
    const e: Errors = {};
    if (!f.name.trim()) e.name = tr("Bitte den Firmennamen eingeben.");
    if (f.domain.trim() && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(f.domain.trim())) e.domain = tr("Eine Domain wie zeit.firma.ch, ohne https://.");
    if (!f.adminName.trim()) e.adminName = tr("Wer wird Admin der Firma?");
    if (!EMAIL.test(f.adminEmail.trim())) e.adminEmail = tr("Bitte eine gültige E-Mail-Adresse eingeben.");
    if (Object.keys(e).length) return e;
    await onCreate({ name: f.name.trim(), domain: f.domain.trim().toLowerCase(), adminName: f.adminName.trim(), adminEmail: f.adminEmail.trim() });
    onClose();
  };
  return (
    <FormDialog id="org-dialog" title={tr("Neue Firma")} subtitle={tr("Die Firma erhält eigene Benutzer, Kunden, Daten und ein eigenes Design. Der Admin bekommt eine Einladung per E-Mail.")} submitLabel={tr("Anlegen und einladen")} onClose={onClose} onSubmit={submit}>
      <Field label={tr("Firma")} name="name" required><input id="org-name" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={tr("z. B. Muster AG")} /></Field>
      <Field label={tr("Eigene Domain")} name="domain" hint={tr("Optional. Braucht einen DNS-Eintrag auf diesen Server.")}><input id="org-domain" className="input" value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} placeholder={tr("zeit.firma.ch")} /></Field>
      <FieldRow>
        <Field label={tr("Admin, Name")} name="adminName" required><input id="org-admin" className="input" value={f.adminName} onChange={(e) => setF({ ...f, adminName: e.target.value })} /></Field>
        <Field label={tr("Admin, E-Mail")} name="adminEmail" required><input id="org-email" type="email" className="input" value={f.adminEmail} onChange={(e) => setF({ ...f, adminEmail: e.target.value })} /></Field>
      </FieldRow>
    </FormDialog>
  );
}
