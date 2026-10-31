import { fmtCHF2, fmtDate } from "@taktwerk/domain";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { tr, trn } from "../i18n";

interface Referral {
  code: string;
  link: string;
  bonusDays: number;
  referred: { name: string; since: string; paying: boolean }[];
  earned: number;
  used: number;
  open: number;
}

const DEMO_REFERRAL: Referral = {
  code: "K7M2QX",
  link: "https://trackinsight.app/registrieren?ref=K7M2QX",
  bonusDays: 30,
  referred: [
    { name: tr("Schreinerei Holzer GmbH"), since: "2026-08-14", paying: true },
    { name: tr("Studio Nord Sagl"), since: "2026-10-22", paying: false },
  ],
  earned: 1,
  used: 0,
  open: 1,
};

/** Settings → Abo: recommend the product; every company that pays after a recommendation gives one free month. */
export function ReferralCard() {
  const { mode, notify, role } = useStore();
  const [r, setR] = useState<Referral | null>(mode === "demo" ? DEMO_REFERRAL : null);
  useEffect(() => {
    if (mode === "api" && role === "admin") api<Referral>("/api/referral").then(setR).catch(() => setR(null));
  }, [mode, role]);
  if (!r) return null;
  const copy = () => { void navigator.clipboard?.writeText(r.link); notify(tr("Link kopiert")); };
  return (
    <section className="card card-pad" id="referral" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h3 style={{ margin: 0 }}>{tr("Weiterempfehlen und Gratismonate sammeln")}</h3>
      <p className="explain" style={{ margin: 0 }}>{tr("Wer sich über deinen Link registriert, testet {0} Tage länger. Für jede empfohlene Firma, die danach ein Abo hat, bekommst du einen Monat geschenkt.", r.bonusDays)}</p>
      <div className="sso-row"><span className="muted">{tr("Dein Link")}</span><code>{r.link}</code><button type="button" className="btn small" onClick={copy}>{tr("Kopieren")}</button></div>
      {r.referred.length > 0 ? (
        <>
          <ul className="plain-list" style={{ margin: 0, paddingLeft: 18 }}>
            {r.referred.map((x) => <li key={x.name + x.since}>{x.name} <span className="muted">{tr("seit {0}", fmtDate(x.since.slice(0, 10)))}</span> {x.paying ? <span className="pill ok">{tr("Abo aktiv")}</span> : <span className="pill neutral">{tr("testet")}</span>}</li>)}
          </ul>
          <p style={{ margin: 0 }}>
            <strong>{trn(r.earned, "{0} Gratismonat verdient", "{0} Gratismonate verdient")}</strong>
            {r.open > 0 ? ` · ${trn(r.open, "{0} wird mit der nächsten Rechnung verrechnet", "{0} werden mit den nächsten Rechnungen verrechnet")}` : ""}
          </p>
        </>
      ) : <p className="muted" style={{ margin: 0 }}>{tr("Noch keine Empfehlungen.")}</p>}
    </section>
  );
}

interface Partner {
  id: string;
  code: string;
  name: string;
  email: string;
  commissionPercent: number;
  trialDays: number;
  active: boolean;
  companies: number;
  paying: number;
  mrr: number;
  commission: number;
}

const DEMO_PARTNERS: Partner[] = [
  { id: "p1", code: "TREU-MUSTER", name: tr("Treuhand Muster AG"), email: "info@treu-muster.ch", commissionPercent: 20, trialDays: 60, active: true, companies: 6, paying: 4, mrr: 742, commission: 148.4 },
  { id: "p2", code: "AGENTUR-BLAU", name: tr("Agentur Blau GmbH"), email: "hallo@blau.ch", commissionPercent: 15, trialDays: 45, active: true, companies: 2, paying: 1, mrr: 135, commission: 20.25 },
];

/** Operator console: reseller partners with their companies, revenue and commission per month. */
export function PartnersCard() {
  const { mode, notify } = useStore();
  const demo = mode === "demo";
  const [list, setList] = useState<Partner[] | null>(demo ? DEMO_PARTNERS : null);
  const [form, setForm] = useState({ code: "", name: "", email: "", commissionPercent: "20", trialDays: "60" });
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const load = () => api<Partner[]>("/api/platform/partners").then(setList).catch((e) => setError((e as Error).message));
  useEffect(() => { if (!demo) void load(); }, [demo]);
  if (!list) return null;

  const add = async () => {
    if (demo) return notify(tr("Im Prototyp wird nichts gespeichert."));
    try {
      await api("/api/platform/partners", { body: { code: form.code, name: form.name, email: form.email, commissionPercent: Number(form.commissionPercent), trialDays: Number(form.trialDays) } });
      setAdding(false);
      setForm({ code: "", name: "", email: "", commissionPercent: "20", trialDays: "60" });
      setError("");
      notify(tr("Partner angelegt"));
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const toggle = async (p: Partner) => {
    if (demo) return notify(tr("Im Prototyp wird nichts gespeichert."));
    await api(`/api/platform/partners/${p.id}`, { method: "PATCH", body: { active: !p.active } });
    await load();
  };
  const total = list.reduce((s, p) => s + (p.active ? p.commission : 0), 0);

  return (
    <section className="card" id="partners">
      <div className="card-head">
        <h2>{tr("Partner")}</h2>
        <button className="btn small" onClick={() => setAdding((a) => !a)}>{tr("+ Partner")}</button>
      </div>
      <div className="card-pad" style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
        <p className="muted" style={{ margin: 0 }}>{tr("Treuhänder und Agenturen geben ihren Code weiter (Link …/registrieren?ref=CODE). Ihre Kunden testen länger, der Partner erhält eine Provision auf den Monatsumsatz. Provision diesen Monat: {0}", fmtCHF2(total))}</p>
        {adding && (
          <div className="partner-form">
            <label className="field"><span>{tr("Code")}</span><input id="partner-code" className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="TREU-MUSTER" /></label>
            <label className="field"><span>{tr("Name")}</span><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field"><span>{tr("E-Mail")}</span><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label className="field"><span>{tr("Provision %")}</span><input className="input num" type="number" min="0" max="50" value={form.commissionPercent} onChange={(e) => setForm({ ...form, commissionPercent: e.target.value })} /></label>
            <label className="field"><span>{tr("Testtage")}</span><input className="input num" type="number" min="30" max="120" value={form.trialDays} onChange={(e) => setForm({ ...form, trialDays: e.target.value })} /></label>
            <button className="btn primary" onClick={add} disabled={!form.code || !form.name || !form.email}>{tr("Anlegen")}</button>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>{tr("Partner")}</th><th>{tr("Code")}</th><th className="r">{tr("Firmen")}</th><th className="r">{tr("MRR")}</th><th className="r">{tr("Provision")}</th><th /></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} className={p.active ? "" : "muted"}>
                  <td><strong>{p.name}</strong><div className="muted" style={{ fontSize: "0.78rem" }}>{p.email} · {tr("{0} % · {1} Testtage", p.commissionPercent, p.trialDays)}</div></td>
                  <td className="mono">{p.code}</td>
                  <td className="r num">{tr("{0} von {1} zahlen", p.paying, p.companies)}</td>
                  <td className="r num">{fmtCHF2(p.mrr)}</td>
                  <td className="r num">{fmtCHF2(p.commission)}</td>
                  <td className="r"><button className="btn small ghost" onClick={() => void toggle(p)}>{p.active ? tr("Deaktivieren") : tr("Aktivieren")}</button></td>
                </tr>
              ))}
              {!list.length && <tr><td colSpan={6} className="muted">{tr("Noch keine Partner.")}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
