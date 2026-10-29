import { useState, type FormEvent } from "react";
import { passkeysSupported, usePasskey } from "../webauthn";
import { PLANS, type PlanId } from "@taktwerk/domain";
import { api, type Branding, type Providers } from "../api";
import { BrandMark, MatterhornRidge } from "../ui/motif";
import { Icon } from "../ui/components";

const SSO_ERRORS: Record<string, string> = {
  abgebrochen: "Die Anmeldung wurde abgebrochen. Bitte erneut versuchen.",
  fehlgeschlagen: "Die Anmeldung beim Anbieter ist fehlgeschlagen. Bitte erneut versuchen.",
  unbekannt: "Zu diesem Konto gibt es keinen Zugang. Bitte lass dich von einer Admin-Person einladen.",
  email_unbestaetigt: "Die E-Mail-Adresse des Google-Kontos ist nicht bestätigt.",
  abgelaufen: "Der Anmeldelink ist abgelaufen. Bitte melde dich hier noch einmal an.",
};

/** SaaS: a sign-in on the shared address continues on the company's own address. */
type SignedIn = { ok: boolean; redirect?: string; second?: { token: string; totp: boolean; passkey: boolean } };
const follow = (res: SignedIn | null | undefined) => {
  if (!res?.redirect) return false;
  location.href = res.redirect;
  return true;
};

function BrandPanel({ branding }: { branding: Branding }) {
  return (
    <aside className="login-brand">
      <div className="brand">
        <BrandMark logo={branding.logo} inverse size={34} />
        <span>{branding.appName}</span>
      </div>
      <div className="login-claim">
        <h1>Zeit erfassen.<br />Budgets im Griff.</h1>
        <p>Zeiterfassung, Spesen und Kundenreports mit Forecast aus JIRA, an einem Ort.</p>
      </div>
      {branding.showMotif && <MatterhornRidge className="login-motif" snow="var(--brand)" />}
    </aside>
  );
}

export function AuthLayout({ branding, children }: { branding: Branding; children: React.ReactNode }) {
  return (
    <div className="login">
      <BrandPanel branding={branding} />
      <main className="login-main">
        <div className="login-card">{children}</div>
      </main>
    </div>
  );
}

const MicrosoftIcon = () => (
  <svg viewBox="0 0 21 21" width="18" height="18" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022" /><rect x="11" y="1" width="9" height="9" fill="#7fba00" /><rect x="1" y="11" width="9" height="9" fill="#00a4ef" /><rect x="11" y="11" width="9" height="9" fill="#ffb900" /></svg>
);
const GoogleIcon = () => (
  <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.8 6.1C12.4 13.7 17.7 9.5 24 9.5z" /><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 7.1-10 7.1-17.5z" /><path fill="#FBBC05" d="M10.5 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.8-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.8l7.9-6.1z" /><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z" /></svg>
);

interface Props {
  branding: Branding;
  providers: Providers;
  demo: boolean;
  onLoggedIn: () => void;
}

export function Login({ branding, providers, demo, onLoggedIn }: Props) {
  const ssoError = new URLSearchParams(location.search).get("anmeldung");
  const [view, setView] = useState<"login" | "forgot" | "sent" | "register" | "second">(location.pathname === "/registrieren" ? "register" : "login");
  const [second, setSecond] = useState<{ token: string; totp: boolean; passkey: boolean } | null>(null);
  const [code, setCode] = useState("");
  const [company, setCompany] = useState("");
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState(demo ? "anna.keller" : "");
  const [password, setPassword] = useState(demo ? "demo-passwort" : "");
  const [email, setEmail] = useState("");
  // A package can be preselected by a link from the website (?paket=team); the form itself shows no prices.
  const [plan] = useState<PlanId>(() => (PLANS.find((p) => p.id === new URLSearchParams(location.search).get("paket"))?.id ?? "team"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(ssoError ? SSO_ERRORS[ssoError] ?? SSO_ERRORS.fehlgeschlagen : "");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (demo) return onLoggedIn();
    setBusy(true);
    try {
      const res = await api<SignedIn>("/api/auth/login", { body: { username, password } });
      if (follow(res)) return;
      if (!res.ok && res.second) {
        setSecond(res.second);
        setView("second");
        setCode("");
        return;
      }
      history.replaceState(null, "", "/");
      onLoggedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const forgot = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (!demo) {
      try {
        await api("/api/auth/password/forgot", { body: { email } });
      } catch (err) {
        return setError((err as Error).message);
      }
    }
    setView("sent");
  };

  const finishTotp = async (e: FormEvent) => {
    e.preventDefault();
    if (!second) return;
    setError("");
    setBusy(true);
    try {
      if (follow(await api<SignedIn>("/api/auth/2fa/totp", { body: { token: second.token, code } }))) return;
      history.replaceState(null, "", "/");
      onLoggedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Passkey: as second step (token) or passwordless from the login form. */
  const withPasskey = async (token?: string) => {
    setError("");
    if (demo) return setError("Im Prototyp gibt es keine Passkeys. Bitte mit Benutzername und Passwort anmelden.");
    if (!passkeysSupported()) return setError("Dieser Browser unterstützt keine Passkeys.");
    setBusy(true);
    try {
      const options = await api<Record<string, unknown>>("/api/auth/passkey/options", { body: token ? { token } : {} });
      const response = await usePasskey(options);
      if (follow(await api<SignedIn>("/api/auth/passkey/verify", { body: { token, response } }))) return;
      history.replaceState(null, "", "/");
      onLoggedIn();
    } catch (err) {
      setError((err as Error).name === "NotAllowedError" ? "Abgebrochen oder kein passender Passkey." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const register = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (demo) return setError("Im Prototyp gibt es keine Registrierung. Melde dich mit den Beispieldaten an.");
    setBusy(true);
    try {
      if (follow(await api<SignedIn>("/api/orgs/register", { body: { company, name: fullName, email, password, ...(providers.saas ? { plan } : {}) } }))) return;
      history.replaceState(null, "", "/");
      onLoggedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sso = (provider: "microsoft" | "google") => {
    if (demo) return setError("Im Prototyp ist die Anmeldung mit Microsoft und Google nicht verbunden. Bitte mit Benutzername und Passwort anmelden.");
    location.href = `/api/auth/${provider}`;
  };
  const showMs = demo || providers.microsoft;
  const showGoogle = demo || providers.google;

  return (
    <AuthLayout branding={branding}>
      {view === "login" && (
        <form onSubmit={submit} className="login-form">
          <div>
            <h2>Anmelden</h2>
            <p className="muted">Mit deinem Firmenkonto oder Benutzername und Passwort.</p>
          </div>
          {(showMs || showGoogle) && (
            <div className="sso">
              {showMs && <button type="button" className="btn sso-btn" onClick={() => sso("microsoft")}><MicrosoftIcon />Mit Microsoft anmelden</button>}
              {showGoogle && <button type="button" className="btn sso-btn" onClick={() => sso("google")}><GoogleIcon />Mit Google anmelden</button>}
            </div>
          )}
          {(showMs || showGoogle) && <div className="divider"><span>oder</span></div>}
          <label className="field"><span>Benutzername oder E-Mail</span>
            <input id="l-user" className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </label>
          <label className="field"><span>Passwort</span>
            <input id="l-pass" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn primary block" disabled={busy}>{busy ? "Anmelden …" : "Anmelden"}</button>
          {!demo && <button type="button" id="l-passkey" className="btn block" disabled={busy} onClick={() => void withPasskey()}><Icon.key />Mit Passkey anmelden</button>}
          <button type="button" className="link" onClick={() => { setView("forgot"); setError(""); }}>Passwort vergessen?</button>
          {providers.registration && !demo && <button type="button" id="to-register" className="link" onClick={() => { setView("register"); setError(""); }}>Neue Firma registrieren</button>}
          {demo && <p className="notice">Prototyp mit Beispieldaten: Die Felder sind vorausgefüllt, einfach auf «Anmelden» klicken.</p>}
        </form>
      )}
      {view === "forgot" && (
        <form onSubmit={forgot} className="login-form">
          <div>
            <h2>Passwort zurücksetzen</h2>
            <p className="muted">Wir senden dir einen Link, mit dem du ein neues Passwort festlegst.</p>
          </div>
          <label className="field"><span>E-Mail-Adresse</span>
            <input id="f-email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn primary block">Link senden</button>
          <button type="button" className="link" onClick={() => setView("login")}>Zurück zur Anmeldung</button>
        </form>
      )}
      {view === "second" && second && (
        <form onSubmit={finishTotp} className="login-form">
          <div>
            <h2>Zweiter Schritt</h2>
            <p className="muted">{second.totp ? "Gib den sechsstelligen Code aus deiner Authenticator-App ein, oder einen deiner Wiederherstellungscodes." : "Bestätige die Anmeldung mit deinem Passkey."}</p>
          </div>
          {second.totp && (
            <label className="field"><span>Code</span>
              <input id="l-code" className="input" inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value)} required />
            </label>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          {second.totp && <button id="l-code-submit" className="btn primary block" disabled={busy || code.trim().length < 6}>{busy ? "Prüfe …" : "Bestätigen"}</button>}
          {second.passkey && <button type="button" className={`btn block ${second.totp ? "" : "primary"}`} disabled={busy} onClick={() => void withPasskey(second.token)}><Icon.key />Mit Passkey bestätigen</button>}
          <button type="button" className="link" onClick={() => { setView("login"); setSecond(null); setError(""); }}>Abbrechen</button>
        </form>
      )}
      {view === "register" && (
        <form onSubmit={register} className="login-form">
          <div>
            <h2>Firma registrieren</h2>
            <p className="muted">Deine Firma bekommt einen eigenen, getrennten Bereich. Du bist Admin und lädst dein Team selbst ein.</p>
          </div>
          <label className="field"><span>Firma</span><input id="r-company" className="input" value={company} onChange={(e) => setCompany(e.target.value)} required minLength={2} /></label>
          <label className="field"><span>Dein Name</span><input id="r-name" className="input" autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} required /></label>
          <label className="field"><span>E-Mail (ist dein Benutzername)</span><input id="r-email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label className="field"><span>Passwort (mindestens 10 Zeichen)</span><input id="r-pass" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <button id="r-submit" className="btn primary block" disabled={busy}>{busy ? "Richte ein …" : "Firma anlegen"}</button>
          <button type="button" className="link" onClick={() => { setView("login"); setError(""); }}>Zurück zur Anmeldung</button>
        </form>
      )}
      {view === "sent" && (
        <div className="login-form">
          <h2>E-Mail ist unterwegs</h2>
          <p className="muted">Falls zu {email} ein Konto existiert, erhältst du in den nächsten Minuten einen Link. Er ist eine Stunde gültig.</p>
          <button type="button" className="btn block" onClick={() => setView("login")}>Zurück zur Anmeldung</button>
        </div>
      )}
    </AuthLayout>
  );
}

export function SetPassword({ branding, onDone }: { branding: Branding; onDone: () => void }) {
  const token = new URLSearchParams(location.search).get("token") ?? "";
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw !== pw2) return setError("Die beiden Passwörter stimmen nicht überein.");
    try {
      await api("/api/auth/password/set", { body: { token, password: pw } });
      history.replaceState(null, "", "/");
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <AuthLayout branding={branding}>
      <form onSubmit={submit} className="login-form">
        <div>
          <h2>Passwort festlegen</h2>
          <p className="muted">Mindestens 10 Zeichen. Danach bist du direkt angemeldet.</p>
        </div>
        <label className="field"><span>Neues Passwort</span>
          <input id="p-1" className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={10} />
        </label>
        <label className="field"><span>Passwort wiederholen</span>
          <input id="p-2" className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary block">Speichern und anmelden</button>
      </form>
    </AuthLayout>
  );
}
