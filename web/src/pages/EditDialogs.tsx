// Popups for creating and editing customers, projects, sub-projects and portal access.
import { useState } from "react";
import { CURRENCIES, PROJECT_KINDS, currencyOf, fmtMoney, rateOn, type Currency, type Customer, type PostalAddress, type Project, type ProjectKind, type SubProject } from "@taktwerk/domain";
import { useStore } from "../store";
import { Field, FieldRow, FieldSection, FormDialog } from "../ui/Dialog";
import { Select } from "../ui/Select";

type Errors = Record<string, string>;
const num = (v: string) => (v.trim() === "" ? NaN : Number(v.replace(/[’',\s]/g, "")));

// ---------- customer ----------

export function CustomerDialog({ customer, onClose, onCreated }: { customer?: Customer; onClose: () => void; onCreated?: () => void }) {
  const { data, role, addCustomer, updateCustomer, notify } = useStore();
  const editing = !!customer;
  const current = customer ? rateOn(customer, data.today) : 0;
  const [name, setName] = useState(customer?.name ?? "");
  const [cur, setCur] = useState<Currency>(customer ? currencyOf(customer) : "CHF");
  const [rate, setRate] = useState(customer ? String(current) : "");
  const [validFrom, setValidFrom] = useState(data.today);
  const a = customer?.address;
  const [addr, setAddr] = useState<PostalAddress>({ name: a?.name ?? "", street: a?.street ?? "", zip: a?.zip ?? "", city: a?.city ?? "", country: a?.country ?? "CH" });
  const canRate = !editing || role === "admin";

  const submit = async () => {
    const e: Errors = {};
    const r = num(rate);
    if (!name.trim()) e.name = "Bitte den Namen des Kunden eingeben.";
    if (!(r > 0)) e.rate = "Bitte einen Stundensatz grösser als 0 eingeben.";
    const anyAddr = addr.street.trim() || addr.zip.trim() || addr.city.trim();
    if (anyAddr && !addr.zip.trim()) e.zip = "Für die QR-Rechnung braucht es die PLZ.";
    if (anyAddr && !addr.city.trim()) e.city = "Für die QR-Rechnung braucht es den Ort.";
    if (editing && r !== current && !validFrom) e.validFrom = "Ab wann gilt der neue Satz?";
    if (Object.keys(e).length) return e;
    const address = anyAddr ? { ...addr, name: addr.name.trim() || name.trim(), country: (addr.country || "CH").toUpperCase() } : undefined;
    if (!editing) {
      await addCustomer({ name: name.trim(), currency: cur, rates: [{ validFrom: data.today, hourlyRate: r }], address });
      notify(`Kunde «${name.trim()}» angelegt`);
      onCreated?.();
    } else {
      await updateCustomer(customer.id, { name: name.trim(), currency: cur, ...(address ? { address } : {}), ...(canRate && r !== current ? { rate: { hourlyRate: r, validFrom } } : {}) });
      notify("Kunde gespeichert");
    }
    onClose();
  };

  return (
    <FormDialog
      id="customer-dialog"
      title={editing ? `${customer.name} bearbeiten` : "Neuer Kunde"}
      subtitle={editing ? "Stammdaten, Stundensatz und Rechnungsadresse dieses Kunden." : "Ein Kunde fasst Projekte zusammen. Der Stundensatz gilt für alle Buchungen auf seine Projekte."}
      submitLabel={editing ? "Speichern" : "Kunde anlegen"}
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label="Name" name="name" required><input id="n-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Rheinlogistik GmbH" /></Field>
      <FieldRow>
        <Field label="Währung" name="currency" required hint="Gilt für Sätze, Budgets und Rechnungen."><Select id="n-currency" value={cur} onChange={(v) => setCur(v as Currency)} options={CURRENCIES.map((c) => ({ value: c, label: c }))} /></Field>
        <Field label={`Stundensatz (${cur})`} name="rate" required hint={editing && !canRate ? "Stundensätze ändern nur Admins." : editing ? `Heute ${fmtMoney(current, cur)} pro Stunde.` : undefined}>
          <input id="n-num" className="input num" inputMode="decimal" value={rate} disabled={!canRate} onChange={(e) => setRate(e.target.value)} placeholder="z. B. 160" />
        </Field>
        {editing && canRate && num(rate) !== current && (
          <Field label="Neuer Satz gilt ab" name="validFrom" required hint="Frühere Buchungen behalten ihren Satz."><input id="n-valid" type="date" className="input" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} /></Field>
        )}
      </FieldRow>
      <FieldSection title="Rechnungsadresse">
        <Field label="Firma oder Name" hint="Leer lassen, um den Kundennamen zu verwenden."><input id="i-name" className="input" value={addr.name} onChange={(e) => setAddr({ ...addr, name: e.target.value })} /></Field>
        <Field label="Strasse und Nummer" name="street"><input id="i-street" className="input" value={addr.street} onChange={(e) => setAddr({ ...addr, street: e.target.value })} /></Field>
        <FieldRow>
          <Field label="PLZ" name="zip"><input id="i-zip" className="input" value={addr.zip} onChange={(e) => setAddr({ ...addr, zip: e.target.value })} /></Field>
          <Field label="Ort" name="city"><input id="i-city" className="input" value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} /></Field>
          <Field label="Land" hint="Zwei Buchstaben, z. B. CH."><input id="i-country" className="input" maxLength={2} value={addr.country} onChange={(e) => setAddr({ ...addr, country: e.target.value.toUpperCase() })} /></Field>
        </FieldRow>
      </FieldSection>
    </FormDialog>
  );
}

// ---------- project ----------

export function ProjectDialog({ project, customerId, onClose }: { project?: Project; customerId: string; onClose: () => void }) {
  const { data, scope, addProject, updateProject, notify } = useStore();
  const customer = data.customers.find((c) => c.id === customerId)!;
  const cur = currencyOf(customer);
  const editing = !!project;
  const [name, setName] = useState(project?.name ?? "");
  const [kind, setKind] = useState<ProjectKind>(project?.kind ?? "tm");
  const [budget, setBudget] = useState(project ? String(project.budget) : "");
  const [retainer, setRetainer] = useState(project?.retainerHours ? String(project.retainerHours) : "");
  const [jira, setJira] = useState(project?.jiraProjectKey ?? "");
  const [lead, setLead] = useState(project?.leadUserId ?? "");
  const people = data.employees.filter((e) => e.role !== "customer" && e.role !== "auditor");
  const canLead = scope.lead && !scope.readOnly;

  const submit = async () => {
    const e: Errors = {};
    const b = num(budget);
    const h = num(retainer);
    if (!name.trim()) e.name = "Bitte einen Projektnamen eingeben.";
    if (kind !== "retainer" && !(b >= 0)) e.budget = kind === "fixed" ? "Bitte den Fixpreis eingeben." : "Bitte ein Budget eingeben, 0 ist erlaubt.";
    if (kind === "retainer" && !(h > 0)) e.retainer = "Wie viele Stunden umfasst das Kontingent pro Monat?";
    if (jira.trim() && !/^[A-Z][A-Z0-9_]{1,19}$/.test(jira.trim())) e.jira = "Ein Jira-Schlüssel besteht aus Grossbuchstaben und Ziffern, z. B. KPR.";
    if (Object.keys(e).length) return e;
    const body = { name: name.trim(), kind, budget: kind === "retainer" && !(b >= 0) ? 0 : b, retainerHours: kind === "retainer" ? h : undefined };
    if (!editing) {
      await addProject({ customerId, ...body, jiraProjectKey: jira.trim() || undefined, ...(canLead && lead ? { leadUserId: lead } : {}) });
      notify(`Projekt «${body.name}» angelegt`);
    } else {
      // An empty string clears the key or the lead; undefined would leave them as they were.
      await updateProject(project.id, { ...body, jiraProjectKey: jira.trim(), ...(canLead ? { leadUserId: lead } : {}) });
      notify("Projekt gespeichert");
    }
    onClose();
  };

  return (
    <FormDialog
      id="project-dialog"
      title={editing ? `${project.name} bearbeiten` : "Neues Projekt"}
      subtitle={<>Bei {customer.name}. {PROJECT_KINDS.find((k) => k.id === kind)?.hint}</>}
      submitLabel={editing ? "Speichern" : "Projekt anlegen"}
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label="Name" name="name" required><input id="p-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Kundenportal Relaunch" /></Field>
      <FieldRow>
        <Field label="Projektart" required><Select id="p-kind" value={kind} onChange={(v) => setKind(v as ProjectKind)} options={PROJECT_KINDS.map((k) => ({ value: k.id, label: k.label }))} /></Field>
        {kind === "retainer" ? (
          <Field label="Kontingent (Stunden pro Monat)" name="retainer" required><input id="p-retainer" className="input num" inputMode="decimal" value={retainer} onChange={(e) => setRetainer(e.target.value)} placeholder="z. B. 120" /></Field>
        ) : (
          <Field label={kind === "fixed" ? `Fixpreis (${cur})` : `Budget (${cur})`} name="budget" required hint={kind === "fixed" ? "Der vereinbarte Gesamtpreis." : "Kann grösser sein als die Summe der Subprojekte, der Rest gilt als Reserve."}>
            <input id="p-budget" className="input num" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="z. B. 120000" />
          </Field>
        )}
      </FieldRow>
      {canLead && (
        <Field label="Projektleitung" hint="Sieht Budget und Buchungen dieses Projekts und plant es, ohne Consultant zu sein.">
          <Select id="p-lead" value={lead} placeholder="Keine" onChange={setLead} options={[{ value: "", label: "Keine" }, ...people.map((p) => ({ value: p.id, label: p.name }))]} />
        </Field>
      )}
      <Field label="Jira-Projektschlüssel" name="jira" hint="Optional. Am einfachsten unter Einstellungen → Jira zuordnen, dann werden Epics und Story Points automatisch geladen.">
        <input id="p-jira" className="input mono" value={jira} onChange={(e) => setJira(e.target.value.toUpperCase())} placeholder="z. B. KPR" />
      </Field>
    </FormDialog>
  );
}

// ---------- sub-project ----------

export function SubProjectDialog({ sub, projectId, onClose }: { sub?: SubProject; projectId: string; onClose: () => void }) {
  const { data, addSubProject, updateSubProject, notify } = useStore();
  const project = data.projects.find((p) => p.id === projectId)!;
  const customer = data.customers.find((c) => c.id === project.customerId)!;
  const cur = currencyOf(customer);
  const siblings = data.subProjects.filter((s) => s.projectId === projectId && s.id !== sub?.id);
  const free = project.budget - siblings.reduce((s, x) => s + x.budget, 0);
  const editing = !!sub;
  const [name, setName] = useState(sub?.name ?? "");
  const [budget, setBudget] = useState(sub ? String(sub.budget) : "");
  const [epic, setEpic] = useState(sub?.jiraEpicKey ?? "");

  const submit = async () => {
    const e: Errors = {};
    const b = num(budget);
    if (!name.trim()) e.name = "Bitte einen Namen eingeben.";
    if (!(b >= 0)) e.budget = "Bitte ein Budget eingeben, 0 ist erlaubt.";
    if (epic.trim() && !/^[A-Z][A-Z0-9_]*-\d+$/.test(epic.trim())) e.epic = "Ein Epic-Schlüssel sieht so aus: KPR-4.";
    if (Object.keys(e).length) return e;
    const body = { name: name.trim(), budget: b, jiraEpicKey: epic.trim() };
    if (!editing) {
      await addSubProject({ projectId, ...body, jiraEpicKey: body.jiraEpicKey || undefined });
      notify(`Subprojekt «${body.name}» angelegt`);
    } else {
      await updateSubProject(sub.id, body);
      notify("Subprojekt gespeichert");
    }
    onClose();
  };

  return (
    <FormDialog
      id="sub-dialog"
      title={editing ? `${sub.name} bearbeiten` : "Neues Subprojekt"}
      subtitle={`In ${project.name}. Subprojekte teilen das Budget auf, zum Beispiel nach Phase oder Epic.`}
      submitLabel={editing ? "Speichern" : "Subprojekt anlegen"}
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label="Name" name="name" required><input id="s-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Checkout" /></Field>
      <FieldRow>
        <Field label={`Budget (${cur})`} name="budget" required hint={`Im Projekt noch nicht verteilt: ${fmtMoney(free, cur)}.`}><input id="s-budget" className="input num" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="z. B. 30000" /></Field>
        <Field label="Jira-Epic" name="epic" hint="Optional. Issues dieses Epics zählen zu diesem Subprojekt."><input id="s-epic" className="input mono" value={epic} onChange={(e) => setEpic(e.target.value.toUpperCase())} placeholder={project.jiraProjectKey ? `z. B. ${project.jiraProjectKey}-4` : "z. B. KPR-4"} /></Field>
      </FieldRow>
    </FormDialog>
  );
}

// ---------- portal access ----------

export function PortalInviteDialog({ customer, onClose, onInvited }: { customer: Customer; onClose: () => void; onInvited: () => void }) {
  const { invitePortal, notify, mode } = useStore();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const submit = async () => {
    const e: Errors = {};
    if (!name.trim()) e.name = "Bitte den Namen der Kontaktperson eingeben.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) e.email = "Bitte eine gültige E-Mail-Adresse eingeben.";
    if (Object.keys(e).length) return e;
    await invitePortal(customer.id, name.trim(), email.trim());
    notify(mode === "api" ? `Einladung an ${email.trim()} geschickt` : "Zugang angelegt (Demo: ohne E-Mail)");
    onInvited();
    onClose();
  };
  return (
    <FormDialog
      id="portal-dialog"
      title="Zugang zum Kundenportal"
      subtitle={`Die Person erhält eine E-Mail mit einem Link zum Setzen des Passworts. Danach sieht sie Budget, Restbudget, Prognose, Monatsreports und Rechnungen von ${customer.name}.`}
      submitLabel="Einladen"
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label="Name" name="name" required><input id="pi-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Vorname Nachname" autoComplete="off" /></Field>
      <Field label="E-Mail" name="email" required><input id="pi-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@kunde.ch" autoComplete="off" /></Field>
    </FormDialog>
  );
}
