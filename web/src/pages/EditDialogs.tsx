// Popups for creating and editing customers, projects, sub-projects and portal access.
import { useState } from "react";
import { CURRENCIES, LOCALES, PROJECT_KINDS, currencyOf, fmtMoney, rateOn, type Currency, type Customer, type Locale, type PostalAddress, type Project, type ProjectKind, type SubProject } from "@taktwerk/domain";
import { useStore } from "../store";
import { Field, FieldRow, FieldSection, FormDialog } from "../ui/Dialog";
import { Select } from "../ui/Select";
import { tr } from "../i18n";

type Errors = Record<string, string>;
const num = (v: string) => (v.trim() === "" ? NaN : Number(v.replace(/[’',\s]/g, "")));

// ---------- customer ----------

export function CustomerDialog({ customer, onClose, onCreated }: { customer?: Customer; onClose: () => void; onCreated?: () => void }) {
  const { data, role, addCustomer, updateCustomer, notify } = useStore();
  const editing = !!customer;
  const current = customer ? rateOn(customer, data.today) : 0;
  const [name, setName] = useState(customer?.name ?? "");
  const [cur, setCur] = useState<Currency>(customer ? currencyOf(customer) : "CHF");
  const [lang, setLang] = useState<Locale>(customer?.locale ?? "de");
  const [rate, setRate] = useState(customer ? String(current) : "");
  const [validFrom, setValidFrom] = useState(data.today);
  const a = customer?.address;
  const [addr, setAddr] = useState<PostalAddress>({ name: a?.name ?? "", street: a?.street ?? "", zip: a?.zip ?? "", city: a?.city ?? "", country: a?.country ?? "CH" });
  const canRate = !editing || role === "admin";

  const submit = async () => {
    const e: Errors = {};
    const r = num(rate);
    if (!name.trim()) e.name = tr("Bitte den Namen des Kunden eingeben.");
    if (!(r > 0)) e.rate = tr("Bitte einen Stundensatz grösser als 0 eingeben.");
    const anyAddr = addr.street.trim() || addr.zip.trim() || addr.city.trim();
    if (anyAddr && !addr.zip.trim()) e.zip = tr("Für die QR-Rechnung braucht es die PLZ.");
    if (anyAddr && !addr.city.trim()) e.city = tr("Für die QR-Rechnung braucht es den Ort.");
    if (editing && r !== current && !validFrom) e.validFrom = tr("Ab wann gilt der neue Satz?");
    if (Object.keys(e).length) return e;
    const address = anyAddr ? { ...addr, name: addr.name.trim() || name.trim(), country: (addr.country || "CH").toUpperCase() } : undefined;
    if (!editing) {
      await addCustomer({ name: name.trim(), currency: cur, locale: lang, rates: [{ validFrom: data.today, hourlyRate: r }], address });
      notify(tr("Kunde «{0}» angelegt", name.trim()));
      onCreated?.();
    } else {
      await updateCustomer(customer.id, { name: name.trim(), currency: cur, locale: lang, ...(address ? { address } : {}), ...(canRate && r !== current ? { rate: { hourlyRate: r, validFrom } } : {}) });
      notify(tr("Kunde gespeichert"));
    }
    onClose();
  };

  return (
    <FormDialog
      id="customer-dialog"
      title={editing ? tr("{0} bearbeiten", customer.name) : tr("Neuer Kunde")}
      subtitle={editing ? tr("Stammdaten, Stundensatz und Rechnungsadresse dieses Kunden.") : tr("Ein Kunde fasst Projekte zusammen. Der Stundensatz gilt für alle Buchungen auf seine Projekte.")}
      submitLabel={editing ? tr("Speichern") : tr("Kunde anlegen")}
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label={tr("Name")} name="name" required><input id="n-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("z. B. Rheinlogistik GmbH")} /></Field>
      <FieldRow>
        <Field label={tr("Währung")} name="currency" required hint={tr("Gilt für Sätze, Budgets und Rechnungen.")}><Select id="n-currency" value={cur} onChange={(v) => setCur(v as Currency)} options={CURRENCIES.map((c) => ({ value: c, label: c }))} /></Field>
        <Field label={tr("Sprache")} name="locale" required hint={tr("Für Reports, Rechnungen und das Kundenportal.")}><Select id="n-locale" value={lang} onChange={(v) => setLang(v as Locale)} options={LOCALES.map((l) => ({ value: l.id, label: l.label }))} /></Field>
      </FieldRow>
      <FieldRow>
        <Field label={tr("Stundensatz ({0})", cur)} name="rate" required hint={editing && !canRate ? tr("Stundensätze ändern nur Admins.") : editing ? tr("Heute {0} pro Stunde.", fmtMoney(current, cur)) : undefined}>
          <input id="n-num" className="input num" inputMode="decimal" value={rate} disabled={!canRate} onChange={(e) => setRate(e.target.value)} placeholder={tr("z. B. 160")} />
        </Field>
        {editing && canRate && num(rate) !== current && (
          <Field label={tr("Neuer Satz gilt ab")} name="validFrom" required hint={tr("Frühere Buchungen behalten ihren Satz.")}><input id="n-valid" type="date" className="input" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} /></Field>
        )}
      </FieldRow>
      <FieldSection title={tr("Rechnungsadresse")}>
        <Field label={tr("Firma oder Name")} hint={tr("Leer lassen, um den Kundennamen zu verwenden.")}><input id="i-name" className="input" value={addr.name} onChange={(e) => setAddr({ ...addr, name: e.target.value })} /></Field>
        <Field label={tr("Strasse und Nummer")} name="street"><input id="i-street" className="input" value={addr.street} onChange={(e) => setAddr({ ...addr, street: e.target.value })} /></Field>
        <FieldRow>
          <Field label={tr("PLZ")} name="zip"><input id="i-zip" className="input" value={addr.zip} onChange={(e) => setAddr({ ...addr, zip: e.target.value })} /></Field>
          <Field label={tr("Ort")} name="city"><input id="i-city" className="input" value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} /></Field>
          <Field label={tr("Land")} hint={tr("Zwei Buchstaben, z. B. CH.")}><input id="i-country" className="input" maxLength={2} value={addr.country} onChange={(e) => setAddr({ ...addr, country: e.target.value.toUpperCase() })} /></Field>
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
  const [closed, setClosed] = useState(!!project?.closedOn);
  const [closedOn, setClosedOn] = useState(project?.closedOn ?? data.today);
  const people = data.employees.filter((e) => e.role !== "customer" && e.role !== "auditor");
  const canLead = scope.lead && !scope.readOnly;

  const submit = async () => {
    const e: Errors = {};
    const b = num(budget);
    const h = num(retainer);
    if (!name.trim()) e.name = tr("Bitte einen Projektnamen eingeben.");
    if (kind !== "retainer" && !(b >= 0)) e.budget = kind === "fixed" ? tr("Bitte den Fixpreis eingeben.") : tr("Bitte ein Budget eingeben, 0 ist erlaubt.");
    if (kind === "retainer" && !(h > 0)) e.retainer = tr("Wie viele Stunden umfasst das Kontingent pro Monat?");
    if (closed && !/^\d{4}-\d{2}-\d{2}$/.test(closedOn)) e.closedOn = tr("Bitte ein Datum wählen.");
    if (jira.trim() && !/^[A-Z][A-Z0-9_]{1,19}$/.test(jira.trim())) e.jira = tr("Ein Jira-Schlüssel besteht aus Grossbuchstaben und Ziffern, z. B. KPR.");
    if (Object.keys(e).length) return e;
    const body = { name: name.trim(), kind, budget: kind === "retainer" && !(b >= 0) ? 0 : b, retainerHours: kind === "retainer" ? h : undefined };
    if (!editing) {
      await addProject({ customerId, ...body, jiraProjectKey: jira.trim() || undefined, ...(canLead && lead ? { leadUserId: lead } : {}) });
      notify(tr("Projekt «{0}» angelegt", body.name));
    } else {
      // An empty string clears the key or the lead; undefined would leave them as they were.
      await updateProject(project.id, { ...body, jiraProjectKey: jira.trim(), closedOn: closed ? closedOn : null, ...(canLead ? { leadUserId: lead } : {}) });
      notify(closed && !project.closedOn ? tr("Projekt «{0}» abgeschlossen", body.name) : !closed && project.closedOn ? tr("Projekt «{0}» wieder geöffnet", body.name) : tr("Projekt gespeichert"));
    }
    onClose();
  };

  return (
    <FormDialog
      id="project-dialog"
      title={editing ? tr("{0} bearbeiten", project.name) : tr("Neues Projekt")}
      subtitle={<>{tr("Bei {0}.", customer.name)}{" "}{PROJECT_KINDS.find((k) => k.id === kind)?.hint}</>}
      submitLabel={editing ? tr("Speichern") : tr("Projekt anlegen")}
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label={tr("Name")} name="name" required><input id="p-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("z. B. Kundenportal Relaunch")} /></Field>
      <FieldRow>
        <Field label={tr("Projektart")} required><Select id="p-kind" value={kind} onChange={(v) => setKind(v as ProjectKind)} options={PROJECT_KINDS.map((k) => ({ value: k.id, label: k.label }))} /></Field>
        {kind === "retainer" ? (
          <Field label={tr("Kontingent (Stunden pro Monat)")} name="retainer" required><input id="p-retainer" className="input num" inputMode="decimal" value={retainer} onChange={(e) => setRetainer(e.target.value)} placeholder={tr("z. B. 120")} /></Field>
        ) : (
          <Field label={kind === "fixed" ? tr("Fixpreis ({0})", cur) : tr("Budget ({0})", cur)} name="budget" required hint={kind === "fixed" ? tr("Der vereinbarte Gesamtpreis.") : tr("Kann grösser sein als die Summe der Subprojekte, der Rest gilt als Reserve.")}>
            <input id="p-budget" className="input num" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={tr("z. B. 120000")} />
          </Field>
        )}
      </FieldRow>
      {canLead && (
        <Field label={tr("Projektleitung")} hint={tr("Sieht Budget und Buchungen dieses Projekts und plant es, ohne Consultant zu sein.")}>
          <Select id="p-lead" value={lead} placeholder={tr("Keine")} onChange={setLead} options={[{ value: "", label: tr("Keine") }, ...people.map((p) => ({ value: p.id, label: p.name }))]} />
        </Field>
      )}
      <Field label={tr("Jira-Projektschlüssel")} name="jira" hint={tr("Optional. Am einfachsten unter Einstellungen → Jira zuordnen, dann werden Epics und Story Points automatisch geladen.")}>
        <input id="p-jira" className="input mono" value={jira} onChange={(e) => setJira(e.target.value.toUpperCase())} placeholder={tr("z. B. KPR")} />
      </Field>
      {editing && (
        <Field label={tr("Abschluss")} name="closedOn" hint={tr("Nach diesem Tag sind keine Buchungen mehr möglich, Retainer werden nicht mehr verrechnet und das Projekt verschwindet aus der Auswahl. Bisherige Buchungen und Berichte bleiben.")}>
          <div>
            <label className="check"><input id="p-closed" type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} />{" "}{tr("Projekt ist abgeschlossen")}</label>
            {closed && <input id="p-closed-on" type="date" className="input" value={closedOn} onChange={(e) => setClosedOn(e.target.value)} style={{ marginTop: 6, maxWidth: 200 }} />}
          </div>
        </Field>
      )}
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
    if (!name.trim()) e.name = tr("Bitte einen Namen eingeben.");
    if (!(b >= 0)) e.budget = tr("Bitte ein Budget eingeben, 0 ist erlaubt.");
    if (epic.trim() && !/^[A-Z][A-Z0-9_]*-\d+$/.test(epic.trim())) e.epic = tr("Ein Epic-Schlüssel sieht so aus: KPR-4.");
    if (Object.keys(e).length) return e;
    const body = { name: name.trim(), budget: b, jiraEpicKey: epic.trim() };
    if (!editing) {
      await addSubProject({ projectId, ...body, jiraEpicKey: body.jiraEpicKey || undefined });
      notify(tr("Subprojekt «{0}» angelegt", body.name));
    } else {
      await updateSubProject(sub.id, body);
      notify(tr("Subprojekt gespeichert"));
    }
    onClose();
  };

  return (
    <FormDialog
      id="sub-dialog"
      title={editing ? tr("{0} bearbeiten", sub.name) : tr("Neues Subprojekt")}
      subtitle={tr("In {0}. Subprojekte teilen das Budget auf, zum Beispiel nach Phase oder Epic.", project.name)}
      submitLabel={editing ? tr("Speichern") : tr("Subprojekt anlegen")}
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label={tr("Name")} name="name" required><input id="s-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("z. B. Checkout")} /></Field>
      <FieldRow>
        <Field label={tr("Budget ({0})", cur)} name="budget" required hint={tr("Im Projekt noch nicht verteilt: {0}.", fmtMoney(free, cur))}><input id="s-budget" className="input num" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={tr("z. B. 30000")} /></Field>
        <Field label={tr("Jira-Epic")} name="epic" hint={tr("Optional. Issues dieses Epics zählen zu diesem Subprojekt.")}><input id="s-epic" className="input mono" value={epic} onChange={(e) => setEpic(e.target.value.toUpperCase())} placeholder={project.jiraProjectKey ? `z. B. ${project.jiraProjectKey}-4` : tr("z. B. KPR-4")} /></Field>
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
    if (!name.trim()) e.name = tr("Bitte den Namen der Kontaktperson eingeben.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) e.email = tr("Bitte eine gültige E-Mail-Adresse eingeben.");
    if (Object.keys(e).length) return e;
    await invitePortal(customer.id, name.trim(), email.trim());
    notify(mode === "api" ? tr("Einladung an {0} geschickt", email.trim()) : tr("Zugang angelegt (Demo: ohne E-Mail)"));
    onInvited();
    onClose();
  };
  return (
    <FormDialog
      id="portal-dialog"
      title={tr("Zugang zum Kundenportal")}
      subtitle={tr("Die Person erhält eine E-Mail mit einem Link zum Setzen des Passworts. Danach sieht sie Budget, Restbudget, Prognose, Monatsreports und Rechnungen von {0}.", customer.name)}
      submitLabel={tr("Einladen")}
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label={tr("Name")} name="name" required><input id="pi-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("Vorname Nachname")} autoComplete="off" /></Field>
      <Field label={tr("E-Mail")} name="email" required><input id="pi-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={tr("name@kunde.ch")} autoComplete="off" /></Field>
    </FormDialog>
  );
}
