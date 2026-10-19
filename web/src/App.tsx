import { useEffect, useState } from "react";
import type { Role } from "@taktwerk/domain";
import { Closing } from "./pages/Closing";
import { Dashboard } from "./pages/Dashboard";
import { Profile } from "./pages/Profile";
import { Projects } from "./pages/Projects";
import { Reports } from "./pages/Reports";
import { TimeTracking } from "./pages/TimeTracking";
import { Settings } from "./pages/Settings";
import { Velocity } from "./pages/Velocity";
import { WorkTime } from "./pages/WorkTime";
import { useStore } from "./store";
import { useTheme, type Theme } from "./theme";
import { Icon } from "./ui/components";
import { BrandMark, MatterhornRidge } from "./ui/motif";
import { Select } from "./ui/Select";

const PAGES = [
  { id: "dashboard", label: "Dashboard", icon: Icon.dashboard, lead: false },
  { id: "zeit", label: "Zeiterfassung", icon: Icon.clock, lead: false },
  { id: "arbeitszeit", label: "Absenzen", icon: Icon.balance, lead: false },
  { id: "abschluss", label: "Monatsabschluss", icon: Icon.check, lead: false },
  { id: "projekte", label: "Kunden & Projekte", icon: Icon.folder, lead: true },
  { id: "reports", label: "Reports", icon: Icon.report, lead: true },
  { id: "velocity", label: "Velocity", icon: Icon.velocity, lead: true },
  { id: "einstellungen", label: "Einstellungen", icon: Icon.settings, lead: true, admin: true },
  { id: "profil", label: "Profil", icon: Icon.settings, lead: false, hidden: true },
] as const;

type PageId = (typeof PAGES)[number]["id"];
const ROLE_LABEL: Record<Role, string> = { admin: "Admin · Anna Keller", consultant: "Consultant · Marco Brunner", employee: "Mitarbeiterin · Lea Meier" };

const THEMES: { id: Theme; label: string; icon: () => JSX.Element }[] = [
  { id: "light", label: "Hell", icon: Icon.sun },
  { id: "dark", label: "Dunkel", icon: Icon.moon },
  { id: "system", label: "Wie das System", icon: Icon.monitor },
];

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

  const allowed = PAGES.filter((p) => !(role === "employee" && p.lead) && !("admin" in p && role !== "admin"));
  const visible = allowed.filter((p) => !("hidden" in p));
  const current = allowed.some((p) => p.id === page) ? page : "dashboard";
  const name = me?.name ?? ROLE_LABEL[role].split(" · ")[1];
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("");

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand"><BrandMark logo={branding.logo} /><span>{branding.appName}</span></div>
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
          {mode === "demo" && (
            <>
              <span className="label">Ansicht als</span>
              <Select id="role-select" ariaLabel="Rolle" value={role} onChange={(v) => setRole(v as Role)} options={(Object.keys(ROLE_LABEL) as Role[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
            </>
          )}
          <a href="#profil" className={`user-chip ${current === "profil" ? "active" : ""}`} title="Profil öffnen">
            <span className="who">{initials}</span>
            <span className="user-name">{name}</span>
            <span className="user-sub">Profil</span>
          </a>
          <button className="btn small ghost logout" onClick={logout}><Icon.logout />Abmelden</button>
          <span className="version" title="Version der Anwendung">Version {__BUILD__.hash} · {__BUILD__.date.split("-").reverse().join(".")}</span>
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
        {current === "profil" && <Profile />}
      </main>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
