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
import { elapsedOf, fmtTimer, hoursFromSeconds, timer, useTimer } from "./timer";
import { CommandPalette } from "./ui/CommandPalette";
import { Icon } from "./ui/components";
import { BrandMark } from "./ui/motif";
import { Select } from "./ui/Select";

const PAGES = [
  { id: "dashboard", label: "Übersicht", icon: Icon.dashboard, lead: false },
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
/** Pages shown in the phone tab bar; the rest sit behind "Mehr". */
const PHONE_TABS: PageId[] = ["dashboard", "zeit", "arbeitszeit", "projekte"];

const THEMES: { id: Theme; label: string; icon: () => JSX.Element }[] = [
  { id: "light", label: "Hell", icon: Icon.sun },
  { id: "dark", label: "Dunkel", icon: Icon.moon },
  { id: "system", label: "Wie das System", icon: Icon.monitor },
];

/** "#projekte/c/abc" → page "projekte"; the rest of the hash is read by the page itself. */
function readHash(): PageId {
  const h = location.hash.replace("#", "").split("/")[0];
  return (PAGES.find((p) => p.id === h)?.id ?? "dashboard") as PageId;
}

/** Tells the time-tracking page to open the booking dialog; navigates there first if needed. */
export interface NewEntryRequest { date?: string; startTime?: string; hours?: number }
export function requestNewEntry(detail: NewEntryRequest = {}) {
  if (readHash() !== "zeit") location.hash = "#zeit";
  setTimeout(() => window.dispatchEvent(new CustomEvent("ti:new-entry", { detail })), 30);
}

/** Header stopwatch: start, pause, resume, and stop into a prefilled booking. */
function HeaderTimer() {
  const t = useTimer();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!t?.runningSince) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [t?.runningSince]);
  if (!t) return <button id="timer-start" className="btn timer-btn" title="Stoppuhr starten" onClick={() => timer.start()}><Icon.clock /><span>Timer</span></button>;
  const sec = elapsedOf(t);
  const stop = () => {
    const r = timer.stop();
    if (!r) return;
    const d = new Date(r.startedAt);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    requestNewEntry({ date: local.toISOString().slice(0, 10), startTime: `${String(d.getHours()).padStart(2, "0")}:${String(Math.floor(d.getMinutes() / 15) * 15).padStart(2, "0")}`, hours: hoursFromSeconds(r.seconds) });
  };
  return (
    <div className={`timer-chip ${t.runningSince ? "running" : "paused"}`} role="group" aria-label="Stoppuhr">
      <span className="timer-dot" />
      <span className="timer-time num">{fmtTimer(sec)}</span>
      {t.runningSince
        ? <button id="timer-pause" className="timer-ctl" title="Pause" aria-label="Pause" onClick={() => timer.pause()}>❚❚</button>
        : <button id="timer-resume" className="timer-ctl" title="Weiter" aria-label="Weiter" onClick={() => timer.resume()}>▶</button>}
      <button id="timer-stop" className="timer-ctl stop" title="Stoppen und buchen" aria-label="Stoppen und buchen" onClick={stop}>■</button>
    </div>
  );
}

const isTyping = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.closest("[role=dialog]") !== null);

export function App() {
  const { role, setRole, toast, branding, mode, me, logout } = useStore();
  const [page, setPage] = useState<PageId>(readHash);
  const [theme, setTheme] = useTheme();
  const [palette, setPalette] = useState(false);
  const [more, setMore] = useState(false);

  useEffect(() => {
    const onHash = () => { setPage(readHash()); setMore(false); };
    window.addEventListener("hashchange", onHash);
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") { ev.preventDefault(); setPalette((p) => !p); return; }
      if (ev.metaKey || ev.ctrlKey || ev.altKey || isTyping(ev.target)) return;
      if (ev.key === "n" || ev.key === "N") { ev.preventDefault(); requestNewEntry(); }
      if (ev.key === "s" || ev.key === "S") { ev.preventDefault(); if (!timer.get()) timer.start(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("hashchange", onHash); window.removeEventListener("keydown", onKey); };
  }, []);

  const allowed = PAGES.filter((p) => !(role === "employee" && p.lead) && !("admin" in p && role !== "admin"));
  const visible = allowed.filter((p) => !("hidden" in p));
  const current = allowed.some((p) => p.id === page) ? page : "dashboard";
  const name = me?.name ?? ROLE_LABEL[role].split(" · ")[1];
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("");
  const tabs = visible.filter((p) => PHONE_TABS.includes(p.id));
  const rest = visible.filter((p) => !PHONE_TABS.includes(p.id));

  const navLink = (p: (typeof PAGES)[number]) => (
    <a key={p.id} href={`#${p.id}`} className={current === p.id ? "active" : ""} aria-label={p.label}>
      <p.icon />
      <span>{p.label}</span>
    </a>
  );

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand"><BrandMark logo={branding.logo} /><span>{branding.appName}</span></div>
        <nav className="nav">
          {visible.filter((p) => !p.lead).map(navLink)}
          {visible.some((p) => p.lead) && <span className="nav-sec">Leitung</span>}
          {visible.filter((p) => p.lead).map(navLink)}
        </nav>
        <div className="rail-foot">
          {mode === "demo" && (
            <Select id="role-select" ariaLabel="Rolle" value={role} onChange={(v) => setRole(v as Role)} options={(Object.keys(ROLE_LABEL) as Role[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }))} small />
          )}
          <div className="rail-tools">
            <div className="seg theme-seg" role="radiogroup" aria-label="Darstellung">
              {THEMES.map((t) => (
                <button key={t.id} id={`theme-${t.id}`} role="radio" aria-checked={theme === t.id} className={theme === t.id ? "on" : ""} title={t.label} aria-label={t.label} onClick={() => setTheme(t.id)}><t.icon /></button>
              ))}
            </div>
            <button className="btn small ghost logout" onClick={logout} title="Abmelden" aria-label="Abmelden"><Icon.logout /></button>
          </div>
          <span className="version" title="Version der Anwendung">Version {__BUILD__.hash} · {__BUILD__.date.split("-").reverse().join(".")}</span>
        </div>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <button className="brand brand-phone" onClick={() => (location.hash = "#dashboard")} aria-label="Zur Übersicht"><BrandMark logo={branding.logo} /></button>
          <button id="open-palette" className="search-btn" onClick={() => setPalette(true)} aria-label="Suchen oder Befehl eingeben">
            <Icon.search />
            <span>Suchen oder Befehl …</span>
            <kbd>⌘K</kbd>
          </button>
          <HeaderTimer />
          <button id="topbar-new" className="btn primary new-btn" onClick={() => requestNewEntry()}>
            <span className="plus">+</span><span>Buchen</span><kbd>N</kbd>
          </button>
          <a href="#profil" className={`avatar-link ${current === "profil" ? "active" : ""}`} title={`${name} · Profil`} aria-label="Profil">
            <span className="who">{initials}</span>
          </a>
        </header>
        <main className="main">
          {current === "dashboard" && <Dashboard key={role === "employee" ? "employee" : "lead"} firstName={name.split(/\s+/)[0]} />}
          {current === "zeit" && <TimeTracking />}
          {current === "arbeitszeit" && <WorkTime />}
          {current === "abschluss" && <Closing />}
          {current === "projekte" && <Projects />}
          {current === "reports" && <Reports />}
          {current === "velocity" && <Velocity />}
          {current === "einstellungen" && <Settings />}
          {current === "profil" && <Profile />}
        </main>
      </div>

      <nav className="tabbar" aria-label="Hauptnavigation">
        {tabs.map((p) => (
          <a key={p.id} href={`#${p.id}`} className={current === p.id ? "active" : ""}><p.icon /><span>{p.label.split(" ")[0]}</span></a>
        ))}
        <button className={more ? "active" : ""} onClick={() => setMore((m) => !m)} aria-expanded={more}><Icon.grip /><span>Mehr</span></button>
      </nav>
      {more && (
        <div className="more-sheet" onClick={() => setMore(false)}>
          <div className="sheet">
            {rest.map((p) => <a key={p.id} href={`#${p.id}`} className={current === p.id ? "active" : ""}><p.icon />{p.label}</a>)}
            <a href="#profil"><span className="who small">{initials}</span>Profil</a>
            <button onClick={logout}><Icon.logout />Abmelden</button>
          </div>
        </div>
      )}

      <CommandPalette open={palette} onClose={() => setPalette(false)} pages={visible.map((p) => ({ id: p.id, label: p.label }))} onNewEntry={requestNewEntry} />
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
