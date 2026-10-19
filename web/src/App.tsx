import { useEffect, useState } from "react";
import type { Role } from "@taktwerk/domain";
import { Closing } from "./pages/Closing";
import { Dashboard } from "./pages/Dashboard";
import { Projects } from "./pages/Projects";
import { Reports } from "./pages/Reports";
import { TimeTracking } from "./pages/TimeTracking";
import { Settings } from "./pages/Settings";
import { Velocity } from "./pages/Velocity";
import { WorkTime } from "./pages/WorkTime";
import { loadLocal, saveLocal, useStore } from "./store";
import { Icon } from "./ui/components";
import { MatterhornMark, MatterhornRidge } from "./ui/motif";

const PAGES = [
  { id: "dashboard", label: "Dashboard", icon: Icon.dashboard, lead: false },
  { id: "zeit", label: "Zeiterfassung", icon: Icon.clock, lead: false },
  { id: "arbeitszeit", label: "Absenzen", icon: Icon.balance, lead: false },
  { id: "abschluss", label: "Monatsabschluss", icon: Icon.check, lead: false },
  { id: "projekte", label: "Kunden & Projekte", icon: Icon.folder, lead: true },
  { id: "reports", label: "Reports", icon: Icon.report, lead: true },
  { id: "velocity", label: "Velocity", icon: Icon.velocity, lead: true },
  { id: "einstellungen", label: "Einstellungen", icon: Icon.settings, lead: true, admin: true },
] as const;

type PageId = (typeof PAGES)[number]["id"];
const ROLE_LABEL: Record<Role, string> = { admin: "Admin · Anna Keller", consultant: "Consultant · Marco Brunner", employee: "Mitarbeiterin · Lea Meier" };

type Theme = "system" | "light" | "dark";
const THEMES: { id: Theme; label: string; icon: () => JSX.Element }[] = [
  { id: "light", label: "Hell", icon: Icon.sun },
  { id: "dark", label: "Dunkel", icon: Icon.moon },
  { id: "system", label: "Wie das System", icon: Icon.monitor },
];

/** Light, dark or the system setting; kept per browser and applied before the first paint by index.html. */
function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => loadLocal<Theme>("rt.theme", "system"));
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    saveLocal("rt.theme", theme);
  }, [theme]);
  return [theme, setTheme] as const;
}

function readHash(): PageId {
  const h = location.hash.replace("#", "");
  return (PAGES.find((p) => p.id === h)?.id ?? "dashboard") as PageId;
}

export function App() {
  const { role, setRole, toast, branding, mode, me, logout } = useStore();
  const [page, setPage] = useState<PageId>(readHash);
  const [theme, setTheme] = useTheme();
  useEffect(() => {
    const onHash = () => setPage(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const visible = PAGES.filter((p) => !(role === "employee" && p.lead) && !("admin" in p && role !== "admin"));
  const current = visible.some((p) => p.id === page) ? page : "dashboard";

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand"><span className="brand-mark"><MatterhornMark /></span><span>{branding.appName}</span></div>
        <nav className="nav">
          {visible.map((p) => (
            <a key={p.id} href={`#${p.id}`} className={current === p.id ? "active" : ""} aria-label={p.label}>
              <p.icon />
              <span>{p.label}</span>
            </a>
          ))}
        </nav>
        <div className="rail-foot">
          <div className="seg theme-seg" role="radiogroup" aria-label="Darstellung">
            {THEMES.map((t) => (
              <button key={t.id} id={`theme-${t.id}`} role="radio" aria-checked={theme === t.id} className={theme === t.id ? "on" : ""} title={t.label} aria-label={t.label} onClick={() => setTheme(t.id)}><t.icon /></button>
            ))}
          </div>
          {mode === "demo" ? (
            <>
              <span className="label">Ansicht als</span>
              <select aria-label="Rolle" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
              <button className="link" onClick={logout}>Abmelden</button>
            </>
          ) : (
            <>
              <div className="user-chip">
                <span className="who">{me?.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("")}</span>
                <span>{me?.name}</span>
              </div>
              <button className="link" onClick={logout}>Abmelden</button>
            </>
          )}
          {branding.showMotif && <span className="rail-motif"><MatterhornRidge /></span>}
        </div>
      </aside>
      <main className="main">
        {current === "dashboard" && <Dashboard key={role === "employee" ? "employee" : "lead"} />}
        {current === "zeit" && <TimeTracking />}
        {current === "arbeitszeit" && <WorkTime />}
        {current === "abschluss" && <Closing />}
        {current === "projekte" && <Projects />}
        {current === "reports" && <Reports />}
        {current === "velocity" && <Velocity />}
        {current === "einstellungen" && <Settings />}
      </main>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
