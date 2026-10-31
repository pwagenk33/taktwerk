import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { tr } from "../i18n";

interface SsoState {
  allowed: boolean;
  saml: { enabled: boolean; entryPoint: string; idpIssuer: string; cert: string };
  domains: string[];
  enforce: boolean;
  scim: { active: boolean; hint: string | null; createdAt: string | null; url: string };
  sp: { entityId: string; acs: string; metadata: string };
}

const DEMO: SsoState = {
  allowed: true,
  saml: { enabled: true, entryPoint: "https://login.microsoftonline.com/1b2c…/saml2", idpIssuer: "https://sts.windows.net/1b2c…/", cert: "MIIC8DCCAdigAwIBAgIQ…" },
  domains: ["beispiel.ch"],
  enforce: false,
  scim: { active: true, hint: "x7Qa", createdAt: "2026-10-20T08:12:00Z", url: "https://beispiel.trackinsight.app/scim/v2" },
  sp: {
    entityId: "https://beispiel.trackinsight.app/api/auth/saml/o1/metadata",
    acs: "https://beispiel.trackinsight.app/api/auth/saml/o1/acs",
    metadata: "https://beispiel.trackinsight.app/api/auth/saml/o1/metadata",
  },
};

/** Settings → Firmen-Login: SAML with Entra ID (or any SAML 2.0 identity provider) and SCIM provisioning. */
export function SsoTab() {
  const { mode, notify } = useStore();
  const demo = mode === "demo";
  const [s, setS] = useState<SsoState | null>(demo ? DEMO : null);
  const [form, setForm] = useState({ enabled: false, entryPoint: "", idpIssuer: "", cert: "", domains: "", enforce: false });
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState("");

  const take = (x: SsoState) => {
    setS(x);
    setForm({ enabled: x.saml.enabled, entryPoint: x.saml.entryPoint, idpIssuer: x.saml.idpIssuer, cert: x.saml.cert, domains: x.domains.join(", "), enforce: x.enforce });
  };
  useEffect(() => {
    if (demo) take(DEMO);
    else api<SsoState>("/api/sso").then(take).catch((e) => setError((e as Error).message));
  }, [demo]);
  if (!s) return <p className={error ? "error" : "muted"}>{error || tr("Lade …")}</p>;

  const copy = (text: string) => { void navigator.clipboard?.writeText(text); notify(tr("Kopiert")); };
  const run = async (fn: () => Promise<void>, msg: string) => {
    if (demo) return notify(tr("Im Prototyp wird nichts gespeichert."));
    try { await fn(); setError(""); notify(msg); } catch (e) { setError((e as Error).message); }
  };
  const save = () => run(async () => {
    take(await api<SsoState>("/api/sso", { method: "PUT", body: { saml: { enabled: form.enabled, entryPoint: form.entryPoint, idpIssuer: form.idpIssuer, cert: form.cert }, domains: form.domains.split(/[\s,;]+/).filter(Boolean), enforce: form.enforce } }));
  }, tr("Firmen-Login gespeichert"));
  const newToken = () => run(async () => {
    const r = await api<SsoState & { token: string }>("/api/sso/scim-token", { body: {} });
    take(r);
    setToken(r.token);
  }, tr("Neues SCIM-Token erstellt"));
  const revoke = () => run(async () => {
    take(await api<SsoState>("/api/sso/scim-token", { method: "DELETE" }));
    setToken(null);
  }, tr("SCIM-Token widerrufen"));

  const Row = ({ label, value }: { label: string; value: string }) => (
    <div className="sso-row"><span className="muted">{label}</span><code>{value}</code><button type="button" className="btn small" onClick={() => copy(value)}>{tr("Kopieren")}</button></div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {!s.allowed && <p className="notice">{tr("Firmen-Login (SAML) und SCIM ist erst im Paket Business enthalten. Wechseln unter Einstellungen → Abo.")}</p>}
      {error && <p className="error">{error}</p>}
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3 style={{ margin: 0 }}>{tr("Firmen-Login mit SAML")}</h3>
        <p className="explain" style={{ margin: 0 }}>{tr("Für Microsoft Entra ID, Okta, Google Workspace und jeden anderen SAML-2.0-Anbieter. Lege dort eine Unternehmensanwendung an und trage diese drei Werte ein:")}</p>
        <Row label={tr("Bezeichner (Entity ID)")} value={s.sp.entityId} />
        <Row label={tr("Antwort-URL (ACS)")} value={s.sp.acs} />
        <Row label={tr("Metadaten")} value={s.sp.metadata} />
        <p className="explain" style={{ margin: 0 }}>{tr("Danach aus Entra ID die Anmelde-URL und das Zertifikat (Base64) hierher kopieren.")}</p>
        <label className="check"><input id="sso-enabled" type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />{tr("Firmen-Login einschalten")}</label>
        <label className="field"><span>{tr("Anmelde-URL des Identity Providers")}</span>
          <input id="sso-entry" className="input" placeholder="https://login.microsoftonline.com/…/saml2" value={form.entryPoint} onChange={(e) => setForm({ ...form, entryPoint: e.target.value })} />
        </label>
        <label className="field"><span>{tr("Microsoft Entra-Bezeichner (optional)")}</span>
          <input id="sso-issuer" className="input" placeholder="https://sts.windows.net/…/" value={form.idpIssuer} onChange={(e) => setForm({ ...form, idpIssuer: e.target.value })} />
        </label>
        <label className="field"><span>{tr("Zertifikat (Base64)")}</span>
          <textarea id="sso-cert" className="input" rows={4} style={{ fontFamily: "var(--mono, monospace)", fontSize: "0.8rem" }} placeholder="-----BEGIN CERTIFICATE-----" value={form.cert} onChange={(e) => setForm({ ...form, cert: e.target.value })} />
        </label>
        <label className="field"><span>{tr("E-Mail-Domains für den Firmen-Login")}</span>
          <input id="sso-domains" className="input" placeholder={tr("z. B. firma.ch, firma.com")} value={form.domains} onChange={(e) => setForm({ ...form, domains: e.target.value })} />
        </label>
        <p className="muted" style={{ margin: 0, fontSize: "0.86rem" }}>{tr("Wer sich mit einer dieser Adressen anmeldet, landet direkt bei euch. Neue Personen werden beim ersten Login als Mitarbeitende angelegt.")}</p>
        <label className="check"><input id="sso-enforce" type="checkbox" checked={form.enforce} disabled={!form.enabled} onChange={(e) => setForm({ ...form, enforce: e.target.checked })} />{tr("Nur noch Firmen-Login erlauben (Admins behalten ihr Passwort als Notzugang)")}</label>
        <div className="toolbar"><button id="sso-save" className="btn primary" disabled={!s.allowed} onClick={save}>{tr("Speichern")}</button></div>
      </section>

      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3 style={{ margin: 0 }}>{tr("Benutzer automatisch abgleichen (SCIM)")}</h3>
        <p className="explain" style={{ margin: 0 }}>{tr("Entra ID legt neue Personen an, ändert Namen und Adressen und deaktiviert Austritte von selbst. Buchungen bleiben für die Reports erhalten. Rollen und Teams vergibst du weiterhin hier.")}</p>
        <Row label={tr("Mandanten-URL")} value={s.scim.url} />
        {s.scim.active
          ? <p style={{ margin: 0 }}>{tr("Token aktiv, endet auf …{0}", s.scim.hint ?? "")}</p>
          : <p className="muted" style={{ margin: 0 }}>{tr("Noch kein Token erstellt.")}</p>}
        {token && (
          <div className="notice">
            <p style={{ margin: "0 0 6px" }}>{tr("Geheimes Token: jetzt kopieren und in Entra ID eintragen. Es wird nur einmal angezeigt.")}</p>
            <Row label={tr("Token")} value={token} />
          </div>
        )}
        <div className="toolbar">
          <button id="scim-token" className="btn" disabled={!s.allowed} onClick={newToken}>{s.scim.active ? tr("Neues Token erstellen") : tr("Token erstellen")}</button>
          {s.scim.active && <button className="btn danger" onClick={revoke}>{tr("Token widerrufen")}</button>}
        </div>
      </section>
    </div>
  );
}
