import { FEATURE_LABEL, MIN_SEATS, PLANS, TRIAL_DAYS, canWrite, fmtCHF, fmtCHF2, fmtDate, hasFeature, planById, priceOf, trialDaysLeft, type BillingInterval, type Feature, type PlanId, type Subscription } from "@taktwerk/domain";
import { useEffect, useState } from "react";
import { api, type SubscriptionInfo } from "../api";
import { loadLocal, saveLocal, useStore } from "../store";
import { Icon } from "../ui/components";

/** Plain check mark (Icon.check is the calendar-check used for closings). */
export const Tick = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>
);

// ---------- subscription state shared by banner, gates and the Abo tab ----------

const EVENT = "ti:subscription";
let override: Subscription | null = null;
/** Demo: a team package in its trial, so the prototype shows the banner and the Abo tab. */
const demoDefault = (): Subscription => ({ plan: "team", status: "trialing", interval: "month", billing: "invoice", trialEndsAt: new Date(Date.now() + 12 * 86_400_000).toISOString() });

function publish(sub: Subscription) {
  override = sub;
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** The company's subscription, or null when the installation runs without packages (self-hosted). */
export function useSubscription(): Subscription | null {
  const { me, mode } = useStore();
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  if (override) return override;
  if (mode === "demo") return loadLocal<Subscription | null>("rt.subscription", null) ?? demoDefault();
  return me?.subscription ?? null;
}

const dateOf = (iso?: string | null) => (iso ? fmtDate(iso.slice(0, 10)) : "–");
const STATUS_LABEL: Record<Subscription["status"], string> = { trialing: "Testphase", active: "Aktiv", past_due: "Zahlung offen", canceled: "Beendet", expired: "Testphase abgelaufen" };
export const statusPill = (s: Subscription["status"]) => (s === "active" ? "ok" : s === "trialing" ? "neutral" : s === "past_due" ? "risk" : "over");
export { STATUS_LABEL };

// ---------- banner and feature gate ----------

/** Thin notice under the top bar: trial running out, payment open, or read-only. */
export function SubscriptionBanner() {
  const sub = useSubscription();
  const { role } = useStore();
  if (!sub) return null;
  const admin = role === "admin";
  const cta = admin ? <a href="#einstellungen/abo" className="banner-cta">Paket wählen</a> : <span className="banner-cta muted">Bitte die Admin-Person informieren.</span>;
  if (!canWrite(sub)) {
    return (
      <div className="sub-banner crit" role="status" id="sub-banner">
        <Icon.lock />
        <span><strong>Nur lesen.</strong> {sub.status === "past_due" ? "Die letzte Zahlung ist offen." : sub.status === "canceled" ? "Das Abo ist beendet." : "Die Testphase ist abgelaufen."} Alle Daten bleiben erhalten und lassen sich exportieren.</span>
        {cta}
      </div>
    );
  }
  if (sub.status === "past_due")
    return (
      <div className="sub-banner warn" role="status" id="sub-banner">
        <span><strong>Zahlung offen.</strong> Bitte die Zahlungsdaten prüfen, sonst ist die Firma nach einer Woche nur noch lesbar.</span>
        {admin ? <a href="#einstellungen/abo" className="banner-cta">Zahlungsdaten</a> : cta}
      </div>
    );
  const left = trialDaysLeft(sub);
  if (left === null || left > 14) return null;
  return (
    <div className="sub-banner" role="status" id="sub-banner">
      <span>
        <strong>Testphase {planById(sub.plan).name}:</strong> {left > 1 ? `noch ${left} Tage` : left === 1 ? "endet morgen" : left === 0 ? "endet heute" : "abgelaufen, eine Woche Schonfrist"}.
        {" "}Mit einem Paket geht es ohne Unterbruch weiter.
      </span>
      {cta}
    </div>
  );
}

/** Replaces a page whose function the package does not include. */
export function FeatureGate({ feature, children }: { feature: Feature; children: React.ReactNode }) {
  const sub = useSubscription();
  const { role } = useStore();
  if (hasFeature(sub, feature)) return <>{children}</>;
  const from = PLANS.find((p) => p.features.includes(feature))!;
  return (
    <section className="card upgrade" id="upgrade-hint">
      <div className="upgrade-icon"><Icon.lock /></div>
      <h2>{FEATURE_LABEL[feature]} gehört zum Paket {from.name}</h2>
      <p className="muted">Deine Firma nutzt {planById(sub!.plan).name}. Mit {from.name} ({fmtCHF(from.perUser)} pro Person und Monat) ist {FEATURE_LABEL[feature]} sofort freigeschaltet; die Daten sind schon da.</p>
      {role === "admin" ? <a className="btn primary" href="#einstellungen/abo">Pakete ansehen</a> : <p className="muted">Die Admin-Person deiner Firma kann das Paket wechseln.</p>}
    </section>
  );
}

// ---------- Settings → Abo ----------

export function SubscriptionTab({ onSetup }: { onSetup: () => void }) {
  const { mode, notify, data } = useStore();
  const current = useSubscription();
  const [info, setInfo] = useState<SubscriptionInfo | null>(null);
  const [interval, setBilling] = useState<BillingInterval>("month");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const demoSeats = data.employees.filter((e) => e.role !== "customer" && e.role !== "auditor").length;

  const apply = (next: SubscriptionInfo) => {
    setInfo(next);
    setBilling(next.subscription.interval);
    publish(next.subscription);
    if (mode === "demo") saveLocal("rt.subscription", next.subscription);
  };
  useEffect(() => {
    if (mode === "api") api<SubscriptionInfo>("/api/subscription").then(apply).catch((e: Error) => setError(e.message));
    else if (current) apply({ subscription: current, canceledAt: loadLocal<string | null>("rt.subCanceled", null), seats: demoSeats, payment: "invoice", cardOnFile: false, plans: PLANS });
    const q = new URLSearchParams(location.search).get("abo");
    if (q === "ok") notify("Danke! Das Abo ist aktiv, sobald die Zahlung bestätigt ist.");
    if (q) history.replaceState(null, "", location.pathname + location.hash);
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!current && mode === "api" && !info) return <p className="muted">{error || "Lade …"}</p>;
  if (!info) return <p className="muted">{error || "Lade …"}</p>;
  const sub = info.subscription;
  const plan = planById(sub.plan);
  const left = trialDaysLeft(sub);
  const paying = sub.status === "active" || sub.status === "past_due";

  const run = async (key: string, f: () => Promise<void>) => {
    setBusy(key);
    setError("");
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const choose = (id: PlanId) =>
    run(id, async () => {
      if (mode === "demo") {
        const end = new Date();
        if (interval === "year") end.setFullYear(end.getFullYear() + 1);
        else end.setMonth(end.getMonth() + 1);
        apply({ ...info, canceledAt: null, subscription: { plan: id, interval, status: "active", billing: "invoice", currentPeriodEnd: end.toISOString(), trialEndsAt: null } });
        saveLocal("rt.subCanceled", null);
        notify(`Paket ${planById(id).name} gewählt. Die Rechnung kommt per E-Mail.`);
        return;
      }
      const res = await api<SubscriptionInfo & { url?: string; done?: boolean }>("/api/subscription/checkout", { body: { plan: id, interval } });
      if (res.url) {
        location.href = res.url;
        return;
      }
      apply(res);
      notify(info.payment === "invoice" ? `Paket ${planById(id).name} ist aktiv. Die Rechnung kommt per E-Mail.` : `Gewechselt zu ${planById(id).name}.`);
    });
  const portal = () => run("portal", async () => { location.href = (await api<{ url: string }>("/api/subscription/portal", { body: {} })).url; });
  const cancel = () => {
    if (!confirm(`Abo kündigen? Es läuft bis ${dateOf(sub.currentPeriodEnd)} weiter, danach sind die Daten nur noch lesbar.`)) return;
    void run("cancel", async () => {
      if (mode === "demo") { const at = new Date().toISOString(); saveLocal("rt.subCanceled", at); setInfo({ ...info, canceledAt: at }); }
      else apply(await api<SubscriptionInfo>("/api/subscription/cancel", { body: {} }));
      notify("Abo gekündigt");
    });
  };
  const resume = () =>
    run("resume", async () => {
      if (mode === "demo") { saveLocal("rt.subCanceled", null); setInfo({ ...info, canceledAt: null }); }
      else apply(await api<SubscriptionInfo>("/api/subscription/resume", { body: {} }));
      notify("Kündigung zurückgenommen");
    });

  return (
    <div className="stack" id="abo">
      <section className="card sub-status">
        <div className="sub-status-main">
          <div>
            <div className="eyebrow">Dein Paket</div>
            <div className="sub-plan-row">
              <h2 className="sub-plan">{plan.name}</h2>
              <span className={`pill ${statusPill(sub.status)}`}>{STATUS_LABEL[sub.status]}</span>
            </div>
            <p className="muted" style={{ margin: "2px 0 0" }}>
              {sub.status === "trialing" && left !== null && (left >= 0 ? `Kostenlos bis ${dateOf(sub.trialEndsAt)}, noch ${left} ${left === 1 ? "Tag" : "Tage"}.` : `Testphase seit ${dateOf(sub.trialEndsAt)} vorbei.`)}
              {paying && `${fmtCHF(priceOf(plan, sub.interval, info.seats))} ${sub.interval === "year" ? "pro Jahr" : "pro Monat"}, zzgl. MWST · ${info.canceledAt ? "endet" : "nächste Periode ab"} ${dateOf(sub.currentPeriodEnd)} · ${sub.billing === "stripe" ? "Karte" : "Rechnung"}`}
              {(sub.status === "canceled" || sub.status === "expired") && "Die Daten sind lesbar und exportierbar. Mit einem Paket geht es sofort weiter."}
            </p>
          </div>
          <div className="seats" aria-label={`${info.seats} aktive Personen`}>
            <div className="seats-num"><strong className="num">{info.seats}</strong><span className="muted"> {info.seats === 1 ? "Person" : "Personen"} aktiv</span></div>
            <div className="muted seats-note">Verrechnet werden mindestens {MIN_SEATS}. Kundenportal und Treuhand zählen nicht.</div>
          </div>
        </div>
        {(info.cardOnFile || paying) && (
          <div className="sub-actions">
            {info.cardOnFile && <button className="btn small" disabled={!!busy} onClick={() => void portal()}><Icon.key />Zahlungsdaten und Quittungen</button>}
            {paying && !info.canceledAt && <button id="sub-cancel" className="btn small ghost" disabled={!!busy} onClick={cancel}>Abo kündigen</button>}
            {paying && info.canceledAt && <button id="sub-resume" className="btn small" disabled={!!busy} onClick={() => void resume()}>Kündigung zurücknehmen</button>}
          </div>
        )}
      </section>

      <div className="plans-head">
        <h2>Preis pro Person</h2>
        <div className="seg" role="radiogroup" aria-label="Zahlungsweise">
          <button role="radio" id="iv-month" aria-checked={interval === "month"} className={interval === "month" ? "on" : ""} onClick={() => setBilling("month")}>Monatlich</button>
          <button role="radio" id="iv-year" aria-checked={interval === "year"} className={interval === "year" ? "on" : ""} onClick={() => setBilling("year")}>Jährlich <span className="save-tag">2 Monate gratis</span></button>
        </div>
      </div>
      <div className="plans" id="plans">
        {PLANS.map((p) => {
          const isCurrent = p.id === sub.plan && paying && sub.interval === interval;
          const label = isCurrent ? "Dein Paket" : paying ? (p.perUser > plan.perUser ? `Auf ${p.name} wechseln` : `Zu ${p.name} wechseln`) : `${p.name} wählen`;
          return (
            <article key={p.id} className={`card plan ${p.id === "team" ? "featured" : ""} ${p.id === sub.plan ? "mine" : ""}`} id={`plan-${p.id}`}>
              {p.id === "team" && <span className="plan-flag">Beliebt</span>}
              <h3>{p.name}</h3>
              <div className="plan-users">{p.tagline}</div>
              <div className="plan-price">
                <span className="num">{interval === "year" ? fmtCHF2((p.perUser * 10) / 12) : fmtCHF(p.perUser)}</span>
                <span className="muted">pro Person und Monat</span>
              </div>
              <div className="muted plan-billing">Für {Math.max(MIN_SEATS, info.seats)} Personen {fmtCHF(priceOf(p, interval, info.seats))} {interval === "year" ? "jährlich" : "monatlich"}, zzgl. MWST</div>
              <ul className="plan-list">
                {p.highlights.map((h) => <li key={h}><Tick />{h}</li>)}
              </ul>
              <button className={`btn block ${isCurrent ? "" : p.id === "team" ? "primary" : ""}`} disabled={isCurrent || !!busy} onClick={() => void choose(p.id)}>
                {busy === p.id ? "Einen Moment …" : label}
              </button>
            </article>
          );
        })}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <p className="muted plans-foot">
        {info.payment === "stripe"
          ? "Bezahlung per Karte über Stripe. Wechsel und neue Personen gelten sofort und werden anteilig verrechnet."
          : "Bezahlung auf Rechnung, zahlbar innert 30 Tagen. Das Paket ist sofort aktiv."}
        {" "}Neue Firmen testen {TRIAL_DAYS} Tage kostenlos. Ab 100 Personen machen wir ein Angebot.
      </p>

      <section className="card card-pad setup-teaser">
        <div>
          <h2>Erste Schritte</h2>
          <p className="muted" style={{ margin: "2px 0 0" }}>Der Einrichtungsassistent führt in fünf Schritten durch Firma, Arbeitszeit, ersten Kunden und Team.</p>
        </div>
        <button id="open-setup" className="btn" onClick={onSetup}>Assistent öffnen</button>
      </section>

      <OwnDomain sub={sub} />
    </div>
  );
}

/** Business: the company's own address (CNAME on the installation). */
function OwnDomain({ sub }: { sub: Subscription }) {
  const { mode, notify } = useStore();
  const [domain, setDomain] = useState("");
  const [dns, setDns] = useState<{ type: string; name: string; value: string } | null>(null);
  const [error, setError] = useState("");
  const allowed = hasFeature(sub, "customDomain");
  const save = async () => {
    setError("");
    try {
      if (mode === "demo") setDns(domain ? { type: "CNAME", name: domain, value: "beispiel.trackinsight.ch" } : null);
      else setDns((await api<{ dns: typeof dns }>("/api/org/domain", { method: "PUT", body: { domain: domain.trim().toLowerCase() || null } })).dns);
      notify(domain ? "Domain gespeichert" : "Domain entfernt");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="card card-pad" id="own-domain">
      <div className="card-head" style={{ padding: 0, marginBottom: 6 }}>
        <h2>Eigene Adresse</h2>
        {!allowed && <span className="pill neutral">ab Business</span>}
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Deine Firma ist unter {location.host || "firma.trackinsight.ch"} erreichbar. Mit Business läuft sie auch unter einer eigenen Domain wie zeit.firma.ch, mit eurem Design schon auf der Anmeldeseite.
      </p>
      {allowed && (
        <div className="toolbar" style={{ gap: 8 }}>
          <input id="own-domain-input" className="input" placeholder="zeit.firma.ch" value={domain} onChange={(e) => setDomain(e.target.value)} style={{ maxWidth: 260 }} />
          <button className="btn" onClick={() => void save()}>Speichern</button>
        </div>
      )}
      {dns && (
        <p className="notice" style={{ marginBottom: 0 }}>
          Beim Domain-Anbieter eintragen: <span className="mono">{dns.name}</span> als <strong>{dns.type}</strong> auf <span className="mono">{dns.value}</span>. Das Zertifikat entsteht beim ersten Aufruf automatisch.
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
