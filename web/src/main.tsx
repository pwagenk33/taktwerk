import { buildDataset, type Dataset } from "@taktwerk/domain";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, DEFAULT_BRANDING, DEMO, api, applyBranding, loadDataset, type Branding, type Me, type Providers } from "./api";
import { App } from "./App";
import { Login, SetPassword } from "./pages/Login";
import { StoreProvider, loadLocal, saveLocal } from "./store";
import "./styles.css";
import { locale, setLocale, tr } from "./i18n";

// Installable app: the service worker keeps the shell and the last data available offline (not in the single-file demo).
if (!DEMO && "serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "login" }
  | { kind: "set-password" }
  | { kind: "app"; data: Dataset; me: Me | null };

function Root() {
  const [branding, setBranding] = useState<Branding>(() => (DEMO ? loadLocal("rt.branding", DEFAULT_BRANDING) : DEFAULT_BRANDING));
  const [providers, setProviders] = useState<Providers>({ password: true, microsoft: false, google: false });
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => applyBranding(branding), [branding]);

  const enter = async () => {
    if (DEMO) {
      saveLocal("rt.demo.loggedIn", true);
      return setState({ kind: "app", data: buildDataset(), me: null });
    }
    try {
      const me = await api<Me>("/api/auth/me");
      // The language chosen in the profile wins over this browser's; switching reloads once.
      if (me.locale && me.locale !== locale) return setLocale(me.locale);
      // Portal accounts have no access to the organization's dataset; the portal loads its own overview.
      const data: Dataset = me.role === "customer"
        ? { teams: [], employees: [], customers: [], projects: [], subProjects: [], timeEntries: [], expenses: [], issues: [], today: new Date().toISOString().slice(0, 10) }
        : await loadDataset();
      setState({ kind: "app", data, me });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setState({ kind: "login" });
      else setState({ kind: "error", message: (e as Error).message });
    }
  };

  useEffect(() => {
    if (DEMO) {
      setState(loadLocal("rt.demo.loggedIn", false) ? { kind: "app", data: buildDataset(), me: null } : { kind: "login" });
      return;
    }
    api<Branding>("/api/branding").then(setBranding).catch(() => {});
    api<Providers>("/api/auth/providers").then(setProviders).catch(() => {});
    if (location.pathname === "/passwort") setState({ kind: "set-password" });
    else if (location.pathname === "/registrieren") setState({ kind: "login" });
    else enter();
  }, []);

  const logout = async () => {
    if (DEMO) saveLocal("rt.demo.loggedIn", false);
    else await api("/api/auth/logout", { body: {} }).catch(() => {});
    setState({ kind: "login" });
  };

  switch (state.kind) {
    case "loading":
      return <div className="center-note">{tr("Lade …")}</div>;
    case "error":
      return <div className="center-note">{tr("Der Server ist nicht erreichbar:")}{" "}{state.message}</div>;
    case "login":
      return <Login branding={branding} providers={providers} demo={DEMO} onLoggedIn={enter} />;
    case "set-password":
      return <SetPassword branding={branding} onDone={enter} />;
    case "app":
      return (
        <StoreProvider initial={state.data} me={state.me} branding={branding} onBranding={setBranding} onLogout={logout}>
          <App />
        </StoreProvider>
      );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
