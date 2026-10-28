import { TIME_MODELS, type TimeModel } from "@taktwerk/domain";
import { useState } from "react";
import { api } from "../api";
import { saveLocal, useStore } from "../store";
import { BrandMark } from "../ui/motif";
import { PRESETS } from "./Settings";
import { Tick } from "./Subscription";

const STEPS = ["Firma", "Arbeitszeit", "Erster Kunde", "Team", "Fertig"] as const;
type Invite = { name: string; email: string };

/**
 * Setup wizard for a new company: name and colour, working time, a first customer with project, team invitations.
 * Every step saves on «Weiter»; «Später» closes it and it can be reopened under Einstellungen → Abo.
 */
export function SetupWizard({ onClose }: { onClose: () => void }) {
  const { mode, branding, setBranding, setWorkSettings, data, reload, notify, addCustomer } = useStore();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [company, setCompany] = useState("");
  const [appName, setAppName] = useState(branding.appName);
  const [color, setColor] = useState(branding.primaryColor);
  const [weekly, setWeekly] = useState(data.workModel?.weeklyHours ?? 42);
  const [model, setModel] = useState<TimeModel>(data.workModel?.timeModel ?? "simplified");
  const [customer, setCustomer] = useState({ name: "", rate: 150, project: "", budget: 20000 });
  const [invites, setInvites] = useState<Invite[]>([{ name: "", email: "" }, { name: "", email: "" }]);
  const [sent, setSent] = useState(0);

  const finish = async (done: boolean) => {
    if (mode === "api") await api("/api/settings", { method: "PUT", body: { onboarding: "done" } }).catch(() => {});
    else saveLocal("rt.onboarding", "done");
    if (done) notify("Eingerichtet. Viel Erfolg mit dem Team!");
    onClose();
  };

  const next = async () => {
    setError("");
    setBusy(true);
    try {
      if (step === 0) {
        if (mode === "api" && company.trim()) await api("/api/settings", { method: "PUT", body: { name: company.trim() } });
        await setBranding({ ...branding, appName: appName.trim() || branding.appName, primaryColor: color });
      }
      if (step === 1) await setWorkSettings({ weeklyHours: weekly, timeModel: model });
      if (step === 2 && customer.name.trim()) {
        if (mode === "api") {
          const { id } = await api<{ id: string }>("/api/customers", { body: { name: customer.name.trim(), hourlyRate: customer.rate } });
          if (customer.project.trim()) await api("/api/projects", { body: { customerId: id, name: customer.project.trim(), budget: customer.budget } });
          await reload();
        } else {
          await addCustomer({ name: customer.name.trim(), rates: [{ validFrom: data.today.slice(0, 8) + "01", hourlyRate: customer.rate }] });
        }
      }
      if (step === 3) {
        let n = 0;
        for (const p of invites.filter((i) => i.name.trim() && i.email.includes("@"))) {
          if (mode === "api") await api("/api/users", { body: { name: p.name.trim(), email: p.email.trim().toLowerCase(), username: p.email.trim().toLowerCase(), role: "employee" } });
          n++;
        }
        setSent(n);
      }
      if (step === 4) return await finish(true);
      setStep((s) => s + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay setup-overlay">
      <div className="dialog setup" role="dialog" aria-label="Einrichtung" id="setup-wizard">
        <div className="setup-side" style={{ ["--brand" as string]: color }}>
          <div className="setup-brand"><BrandMark logo={branding.logo} inverse size={28} /><span>{appName || "TrackInsight"}</span></div>
          <ol className="setup-steps">
            {STEPS.map((s, i) => (
              <li key={s} className={i === step ? "on" : i < step ? "done" : ""}>
                <span className="dot">{i < step ? <Tick /> : i + 1}</span>{s}
              </li>
            ))}
          </ol>
          <p className="setup-side-note">Alles lässt sich später unter Einstellungen ändern.</p>
        </div>
        <div className="setup-main">
          <div className="dialog-head">
            <span className="eyebrow">Schritt {step + 1} von {STEPS.length}</span>
            <button className="btn small ghost" onClick={() => void finish(false)} id="setup-later">Später</button>
          </div>

          {step === 0 && (
            <div className="setup-body">
              <h2>Willkommen! So heisst deine Firma</h2>
              <p className="muted">Name und Farbe erscheinen in der App, in E-Mails und auf Kundenreports.</p>
              {mode === "api" && <label className="field"><span>Firma</span><input id="su-company" className="input" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="z. B. Muster Engineering AG" /></label>}
              <label className="field"><span>Name der App für dein Team</span><input id="su-app" className="input" value={appName} onChange={(e) => setAppName(e.target.value)} /></label>
              <div className="field">
                <span>Farbe</span>
                <div className="swatches">
                  {PRESETS.map((p) => (
                    <button key={p.color} type="button" className={`swatch ${color.toLowerCase() === p.color.toLowerCase() ? "on" : ""}`} style={{ background: p.color }} title={p.name} aria-label={p.name} onClick={() => setColor(p.color)} />
                  ))}
                  <input type="color" aria-label="Eigene Farbe" value={color} onChange={(e) => setColor(e.target.value)} className="swatch-picker" />
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="setup-body">
              <h2>Wie arbeitet ihr?</h2>
              <p className="muted">Die Sollzeit ist die Grundlage für Saldo, Ferien und Überstunden.</p>
              <label className="field"><span>Wochenstunden bei 100 %</span><input id="su-weekly" className="input" type="number" min={1} max={60} step={0.5} value={weekly} onChange={(e) => setWeekly(Number(e.target.value))} style={{ maxWidth: 140 }} /></label>
              <div className="field">
                <span>Arbeitszeiterfassung</span>
                <div className="choice-list">
                  {TIME_MODELS.map((m) => (
                    <button key={m.id} type="button" className={`choice ${model === m.id ? "on" : ""}`} onClick={() => setModel(m.id)} aria-pressed={model === m.id}>
                      <strong>{m.label}</strong>
                      <span className="muted">{m.hint}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="setup-body">
              <h2>Dein erster Kunde</h2>
              <p className="muted">Damit dein Team gleich buchen kann. Leer lassen, wenn du das später machst.</p>
              <div className="form-grid">
                <label className="field"><span>Kunde</span><input id="su-customer" className="input" value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} placeholder="z. B. Stadtwerke Zug" /></label>
                <label className="field"><span>Stundensatz CHF</span><input className="input" type="number" min={1} value={customer.rate} onChange={(e) => setCustomer({ ...customer, rate: Number(e.target.value) })} /></label>
                <label className="field"><span>Projekt</span><input id="su-project" className="input" value={customer.project} onChange={(e) => setCustomer({ ...customer, project: e.target.value })} placeholder="z. B. Kundenportal 2027" /></label>
                <label className="field"><span>Budget CHF</span><input className="input" type="number" min={0} step={1000} value={customer.budget} onChange={(e) => setCustomer({ ...customer, budget: Number(e.target.value) })} /></label>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="setup-body">
              <h2>Wer arbeitet mit?</h2>
              <p className="muted">Alle bekommen eine Einladung per E-Mail und setzen selbst ein Passwort. Rollen kannst du später anpassen.</p>
              <div className="invite-rows">
                {invites.map((p, i) => (
                  <div className="invite-row" key={i}>
                    <input className="input" aria-label={`Name ${i + 1}`} placeholder="Name" value={p.name} onChange={(e) => setInvites(invites.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                    <input className="input" aria-label={`E-Mail ${i + 1}`} type="email" placeholder="name@firma.ch" value={p.email} onChange={(e) => setInvites(invites.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} />
                  </div>
                ))}
              </div>
              {invites.length < 10 && <button type="button" className="link" onClick={() => setInvites([...invites, { name: "", email: "" }])}>+ weitere Person</button>}
            </div>
          )}

          {step === 4 && (
            <div className="setup-body setup-done">
              <div className="done-mark"><Tick /></div>
              <h2>Alles bereit</h2>
              <p className="muted">
                {sent > 0 ? `${sent} ${sent === 1 ? "Einladung ist" : "Einladungen sind"} unterwegs. ` : ""}
                Als Nächstes: Zeit buchen mit «Buchen» oder der Taste N, Projekte unter Kunden & Projekte verfeinern, JIRA für den Forecast verbinden.
              </p>
            </div>
          )}

          {error && <p className="error" role="alert">{error}</p>}
          <div className="setup-foot">
            {step > 0 && step < 4 ? <button className="btn ghost" onClick={() => setStep((s) => s - 1)}>Zurück</button> : <span />}
            <button id="setup-next" className="btn primary" disabled={busy} onClick={() => void next()}>
              {busy ? "Speichere …" : step === 4 ? "Los geht's" : step === 2 && !customer.name.trim() ? "Überspringen" : step === 3 && !invites.some((i) => i.email.includes("@")) ? "Überspringen" : step === 3 ? "Einladen und weiter" : "Weiter"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
