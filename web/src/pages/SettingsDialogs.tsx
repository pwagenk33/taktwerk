// Popups for people, teams, scheduled reports and companies in the settings.
import { useState } from "react";
import type { Role } from "@taktwerk/domain";
import { api, type ScheduledReport, type UserRow } from "../api";
import { useStore } from "../store";
import { Field, FieldRow, FormDialog } from "../ui/Dialog";
import { Select } from "../ui/Select";

type Errors = Record<string, string>;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const ROLE_LABEL: Record<Role, string> = { admin: "Admin", consultant: "Consultant", employee: "Mitarbeitende", auditor: "Treuhand (nur lesen)", customer: "Kunde (Portal)" };
const ROLE_HELP: Record<Exclude<Role, "customer">, string> = {
  admin: "Sieht und ändert alles, auch Einstellungen, Sätze und Abo.",
  consultant: "Sieht alle Kunden, Projekte und Berichte und plant, ohne Einstellungen.",
  employee: "Erfasst eigene Zeiten und Spesen. Sieht mehr, wenn die Person ein Projekt oder Team leitet.",
  auditor: "Sieht alles, ändert nichts. Gedacht für Treuhand und Revision; kostet nichts.",
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
    if (!name.trim()) e.name = "Bitte den Namen eingeben.";
    if (!editing && !EMAIL.test(email.trim())) e.email = "Bitte eine gültige E-Mail-Adresse eingeben.";
    if (!editing && !/^[a-zA-Z0-9._@-]{3,80}$/.test(username.trim())) e.username = "Mindestens 3 Zeichen: Buchstaben, Ziffern, Punkt, Bindestrich.";
    if (rate !== null && !(rate >= 0 && rate <= 1000)) e.costRate = "Ein Betrag zwischen 0 und 1000.";
    if (Object.keys(e).length) return e;
    if (!editing) {
      const { id } = await api<{ id: string }>("/api/users", { body: { name: name.trim(), email: email.trim(), username: username.trim(), role } });
      if (teamId || rate !== null) await api(`/api/users/${id}`, { method: "PATCH", body: { ...(teamId ? { teamId } : {}), ...(rate !== null ? { costRate: rate } : {}) } });
      notify(`Einladung an ${email.trim()} gesendet`);
    } else {
      await api(`/api/users/${user.id}`, { method: "PATCH", body: { name: name.trim(), role, teamId: teamId || null, costRate: rate, active } });
      notify(`${name.trim()} gespeichert`);
    }
    onSaved();
    onClose();
  };

  return (
    <FormDialog
      id="user-dialog"
      title={editing ? `${user.name} bearbeiten` : "Person einladen"}
      subtitle={editing ? "Rolle, Team und Kostensatz. E-Mail und Benutzername ändert die Person selbst." : "Die Person erhält eine E-Mail mit einem Link zum Setzen des Passworts."}
      submitLabel={editing ? "Speichern" : "Einladung senden"}
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label="Name" name="name" required>
        <input id="u-name" className="input" value={name} onChange={(e) => { if (!editing && username === suggest(name)) setUsername(suggest(e.target.value)); setName(e.target.value); }} placeholder="Vorname Nachname" autoComplete="off" />
      </Field>
      <FieldRow>
        <Field label="E-Mail" name="email" required={!editing}><input id="u-email" type="email" className="input" value={email} disabled={editing} onChange={(e) => setEmail(e.target.value)} placeholder="name@firma.ch" autoComplete="off" /></Field>
        <Field label="Benutzername" name="username" required={!editing} hint={editing ? undefined : "Zum Anmelden, wird aus dem Namen vorgeschlagen."}><input id="u-username" className="input mono" value={username} disabled={editing} onChange={(e) => setUsername(e.target.value)} placeholder="vorname.nachname" autoComplete="off" /></Field>
      </FieldRow>
      <Field label="Rolle" required hint={ROLE_HELP[role as Exclude<Role, "customer">]}>
        <Select id="u-role" value={role} onChange={(v) => setRole(v as Role)} options={roleOptions} />
      </Field>
      <FieldRow>
        <Field label="Team" hint="Die Teamleitung bewilligt Absenzen und schliesst Monate ab.">
          <Select id="u-team" value={teamId} placeholder="Kein Team" onChange={setTeamId} options={[{ value: "", label: "Kein Team" }, ...data.teams.map((t) => ({ value: t.id, label: t.name }))]} />
        </Field>
        <Field label="Kostensatz (CHF/h)" name="costRate" hint="Für die Marge. Leer heisst Standardsatz der Firma.">
          <input id="u-cost" className="input num" inputMode="decimal" value={costRate} onChange={(e) => setCostRate(e.target.value)} placeholder="Standard" />
        </Field>
      </FieldRow>
      {editing && (
        <label className="check-field">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span><strong>Aktiv</strong><br /><span className="muted">Deaktivierte Personen können sich nicht mehr anmelden und zählen nicht fürs Abo. Ihre Buchungen bleiben.</span></span>
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
    if (!name.trim()) return { name: "Bitte einen Teamnamen eingeben." };
    if (!editing) await api("/api/teams", { body: { name: name.trim(), leadUserId: lead || null } });
    else await api(`/api/teams/${team.id}`, { method: "PATCH", body: { name: name.trim(), leadUserId: lead || null } });
    notify(editing ? "Team gespeichert" : `Team ${name.trim()} angelegt`);
    onSaved();
    onClose();
  };
  const remove = async () => {
    if (!team || !confirm(`Team ${team.name} löschen? Die Personen bleiben ohne Team.`)) return;
    await api(`/api/teams/${team.id}`, { method: "DELETE" });
    notify("Team gelöscht");
    onSaved();
    onClose();
  };
  return (
    <FormDialog
      id="team-dialog"
      title={editing ? `Team ${team.name}` : "Neues Team"}
      subtitle="Die Teamleitung bewilligt Absenzen, schliesst Monate ab und sieht die Wochen ihres Teams. Mitglieder ordnest du bei der Person zu."
      submitLabel={editing ? "Speichern" : "Team anlegen"}
      onClose={onClose}
      onSubmit={submit}
      danger={editing ? <button type="button" className="btn ghost danger" onClick={() => void remove()}>Löschen</button> : undefined}
    >
      <Field label="Name" name="name" required><input id="team-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Beratung" /></Field>
      <Field label="Teamleitung">
        <Select id="team-lead" value={lead} placeholder="Keine" onChange={setLead} options={[{ value: "", label: "Keine" }, ...people.map((u) => ({ value: u.id, label: u.name }))]} />
      </Field>
    </FormDialog>
  );
}

// ---------- scheduled reports ----------

const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

/** Edit one scheduled report; `onSave` stores the whole list. */
export function ReportDialog({ report, isNew, onClose, onSave }: { report: ScheduledReport; isNew: boolean; onClose: () => void; onSave: (r: ScheduledReport) => Promise<void> }) {
  const [r, setR] = useState(report);
  const [recipients, setRecipients] = useState(report.recipients.join(", "));
  const set = (patch: Partial<ScheduledReport>) => setR({ ...r, ...patch });
  const submit = async () => {
    const e: Errors = {};
    const list = recipients.split(/[\s,;]+/).filter(Boolean);
    if (!r.name.trim()) e.name = "Bitte einen Namen eingeben.";
    if (list.length === 0) e.recipients = "Mindestens eine E-Mail-Adresse.";
    else if (list.some((x) => !EMAIL.test(x))) e.recipients = `Keine gültige Adresse: ${list.find((x) => !EMAIL.test(x))}`;
    if (r.kind === "monthly" && !((r.dayOfMonth ?? 0) >= 1 && (r.dayOfMonth ?? 0) <= 28)) e.dayOfMonth = "Ein Tag zwischen 1 und 28.";
    if (!(r.hour >= 0 && r.hour <= 23)) e.hour = "Eine Stunde zwischen 0 und 23.";
    if (Object.keys(e).length) return e;
    await onSave({ ...r, name: r.name.trim(), recipients: list });
    onClose();
  };
  return (
    <FormDialog
      id="report-dialog"
      title={isNew ? "Neuer geplanter Bericht" : r.name || "Bericht"}
      subtitle={r.kind === "weekly" ? "Die Wochenmail fasst für die Projektleitung Stunden, Risiken, offene Freigaben und fehlende Wochen zusammen." : "Die Monatsmail zeigt der Geschäftsführung Umsatz, Auslastung, Marge, Top-Kunden und offene Rechnungen."}
      submitLabel={isNew ? "Bericht anlegen" : "Speichern"}
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label="Name" name="name" required><input id="rep-name" className="input" value={r.name} onChange={(e) => set({ name: e.target.value })} /></Field>
      <Field label="Art" required>
        <Select id="rep-kind" value={r.kind} onChange={(v) => set(v === "weekly" ? { kind: "weekly", dayOfWeek: r.dayOfWeek ?? 1, dayOfMonth: undefined } : { kind: "monthly", dayOfMonth: r.dayOfMonth ?? 2, dayOfWeek: undefined })} options={[{ value: "weekly", label: "Wöchentlich (Projektleitung)" }, { value: "monthly", label: "Monatlich (Geschäftsführung)" }]} />
      </Field>
      <FieldRow>
        {r.kind === "weekly" ? (
          <Field label="Wochentag" required><Select id="rep-dow" value={String(r.dayOfWeek ?? 1)} onChange={(v) => set({ dayOfWeek: Number(v) })} options={WEEKDAYS.map((d, i) => ({ value: String(i + 1), label: d }))} /></Field>
        ) : (
          <Field label="Tag im Monat" name="dayOfMonth" required hint="1 bis 28, damit es jeden Monat gibt."><input id="rep-dom" className="input num" inputMode="numeric" value={r.dayOfMonth ?? ""} onChange={(e) => set({ dayOfMonth: Number(e.target.value) })} /></Field>
        )}
        <Field label="Uhrzeit (Stunde)" name="hour" required hint="Schweizer Zeit, z. B. 7 für 07:00."><input id="rep-hour" className="input num" inputMode="numeric" value={r.hour} onChange={(e) => set({ hour: Number(e.target.value) })} /></Field>
      </FieldRow>
      <Field label="Empfänger" name="recipients" required hint="E-Mail-Adressen, durch Komma getrennt."><input id="rep-to" className="input" value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="gl@firma.ch, pl@firma.ch" /></Field>
      <label className="check-field">
        <input type="checkbox" checked={r.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span><strong>Aktiv</strong><br /><span className="muted">Ausgeschaltete Berichte bleiben gespeichert, werden aber nicht verschickt.</span></span>
      </label>
    </FormDialog>
  );
}

// ---------- companies (operator) ----------

export function OrgDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (f: { name: string; domain: string; adminName: string; adminEmail: string }) => Promise<void> }) {
  const [f, setF] = useState({ name: "", domain: "", adminName: "", adminEmail: "" });
  const submit = async () => {
    const e: Errors = {};
    if (!f.name.trim()) e.name = "Bitte den Firmennamen eingeben.";
    if (f.domain.trim() && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(f.domain.trim())) e.domain = "Eine Domain wie zeit.firma.ch, ohne https://.";
    if (!f.adminName.trim()) e.adminName = "Wer wird Admin der Firma?";
    if (!EMAIL.test(f.adminEmail.trim())) e.adminEmail = "Bitte eine gültige E-Mail-Adresse eingeben.";
    if (Object.keys(e).length) return e;
    await onCreate({ name: f.name.trim(), domain: f.domain.trim().toLowerCase(), adminName: f.adminName.trim(), adminEmail: f.adminEmail.trim() });
    onClose();
  };
  return (
    <FormDialog id="org-dialog" title="Neue Firma" subtitle="Die Firma erhält eigene Benutzer, Kunden, Daten und ein eigenes Design. Der Admin bekommt eine Einladung per E-Mail." submitLabel="Anlegen und einladen" onClose={onClose} onSubmit={submit}>
      <Field label="Firma" name="name" required><input id="org-name" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="z. B. Muster AG" /></Field>
      <Field label="Eigene Domain" name="domain" hint="Optional. Braucht einen DNS-Eintrag auf diesen Server."><input id="org-domain" className="input" value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} placeholder="zeit.firma.ch" /></Field>
      <FieldRow>
        <Field label="Admin, Name" name="adminName" required><input id="org-admin" className="input" value={f.adminName} onChange={(e) => setF({ ...f, adminName: e.target.value })} /></Field>
        <Field label="Admin, E-Mail" name="adminEmail" required><input id="org-email" type="email" className="input" value={f.adminEmail} onChange={(e) => setF({ ...f, adminEmail: e.target.value })} /></Field>
      </FieldRow>
    </FormDialog>
  );
}
