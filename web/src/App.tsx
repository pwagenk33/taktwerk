import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import type { Role } from "@taktwerk/domain";
import { BudgetRing, Inbox, useInbox, useVisibleReports } from "./pages/Inbox";
import { TimeTracking } from "./pages/TimeTracking";
import { FeatureGate, SubscriptionBanner, useSubscription } from "./pages/Subscription";
import { canWrite } from "@taktwerk/domain";
import { useStore } from "./store";
import { useTheme, type Theme } from "./theme";
import { elapsedOf, fmtTimer, hoursFromSeconds, timer, useTimer } from "./timer";
import { CommandPalette } from "./ui/CommandPalette";
import { Icon } from "./ui/components";
import { BrandMark } from "./ui/motif";
import { Select } from "./ui/Select";
import { api } from "./api";
import { loadLocal, saveLocal } from "./store";
import { HelpPanel } from "./ui/Help";
import { tr } from "./i18n";

// Pages load when first opened, so the start (Eingang, Zeiterfassung) only downloads what it needs.
// Once the app is idle the rest is fetched in the background, so pages open at once and work offline too.
const pages = {
  Closing: () => import("./pages/Closing").then((m) => ({ default: m.Closing })),
  Dashboard: () => import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })),
  Planning: () => import("./pages/Planning").then((m) => ({ default: m.Planning })),
  Portal: () => import("./pages/Portal").then((m) => ({ default: m.Portal })),
  Profile: () => import("./pages/Profile").then((m) => ({ default: m.Profile })),
  Projects: () => import("./pages/Projects").then((m) => ({ default: m.Projects })),
  Reports: () => import("./pages/Reports").then((m) => ({ default: m.Reports })),
  Settings: () => import("./pages/Settings").then((m) => ({ default: m.Settings })),
  Velocity: () => import("./pages/Velocity").then((m) => ({ default: m.Velocity })),
  WorkTime: () => import("./pages/WorkTime").then((m) => ({ default: m.WorkTime })),
  SetupWizard: () => import("./pages/Setup").then((m) => ({ default: m.SetupWizard })),
};
const Closing = lazy(pages.Closing);
const Dashboard = lazy(pages.Dashboard);
const Planning = lazy(pages.Planning);
const Portal = lazy(pages.Portal);
const Profile = lazy(pages.Profile);
const Projects = lazy(pages.Projects);
const Reports = lazy(pages.Reports);
const Settings = lazy(pages.Settings);
const Velocity = lazy(pages.Velocity);
const WorkTime = lazy(pages.WorkTime);
const SetupWizard = lazy(pages.SetupWizard);
function prefetchPages() {
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData) return;
  const run = () => { for (const load of Object.values(pages)) load().catch(() => {}); };
  if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 5000 });
  else setTimeout(run, 2000);
}

/** A page file that can't be loaded (offline, or replaced by an update): offer a reload instead of a blank page. */
class PageBoundary extends Component<{ children: ReactNode; page: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(prev: { page: string }) { if (prev.page !== this.props.page && this.state.failed) this.setState({ failed: false }); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="center-note">
        <p>{tr("Diese Seite konnte nicht geladen werden. Vielleicht gibt es eine neue Version oder die Verbindung fehlt.")}</p>
        <button className="btn primary" onClick={() => location.reload()}>{tr("Neu laden")}</button>
      </div>
    );
  }
}

/** Minimal Markdown for CHANGELOG.md: headings, bullets and paragraphs. */
function Changelog({ markdown }: { markdown: string }) {
  const out: JSX.Element[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { out.push(<ul key={out.length}>{list.map((l, i) => <li key={i}>{l}</li>)}</ul>); list = []; } };
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("- ")) { list.push(line.slice(2)); continue; }
    flush();
    if (line.startsWith("### ")) out.push(<h4 key={out.length}>{line.slice(4)}</h4>);
    else if (line === "## Unveröffentlicht") continue;
    else if (line.startsWith("## ")) out.push(<h3 key={out.length}>{line.slice(3)}</h3>);
    else if (line.startsWith("# ") || line === "") continue;
    else out.push(<p key={out.length}>{line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")}</p>);
  }
  flush();
  return <div className="changelog">{out}</div>;
}

const DEMO_CHANGELOG = `## ${__BUILD__.version} – ${__BUILD__.date}\n### Neu\n- Mehrere Firmen auf einer Installation, strikt getrennt, mit eigener Domain und eigenem Design.\n- Versionsnummer und Änderungsliste in der App.\n- Ressourcenplanung und Kundenportal.\n- Projektarten, Profitabilität, Mehrwährung, Forecast-Szenarien, geplante Berichte, Export, neue Widgets.`;

function VersionInfo({ mode }: { mode: "demo" | "api" }) {
  const [open, setOpen] = useState(false);
  const [md, setMd] = useState<string | null>(null);
  const [seen, setSeen] = useState(() => loadLocal<string>("rt.seenVersion", ""));
  const fresh = seen !== __BUILD__.version;
  const show = async () => {
    setOpen(true);
    saveLocal("rt.seenVersion", __BUILD__.version);
    setSeen(__BUILD__.version);
    if (md !== null) return;
    if (mode === "api") setMd(await api<{ markdown: string }>("/api/changelog").then((r) => r.markdown).catch(() => tr("Die Änderungsliste konnte nicht geladen werden.")));
    else setMd(DEMO_CHANGELOG);
  };
  return (
    <>
      <button className="version" id="version-btn" title={tr("Was ist neu?")} onClick={() => void show()}>
        {tr("Version {0} ·", __BUILD__.version)}{" "}{__BUILD__.hash}{fresh && <span className="new-dot" aria-label={tr("Neue Version")} />}
      </button>
      {open && (
        <div className="overlay" onMouseDown={(ev) => ev.target === ev.currentTarget && setOpen(false)}>
          <div className="dialog" role="dialog" aria-label={tr("Was ist neu")} id="changelog-dialog">
            <div className="dialog-head"><h2>{tr("Was ist neu")}</h2><button className="btn small ghost" onClick={() => setOpen(false)} aria-label={tr("Schliessen")}><Icon.close /></button></div>
            <p className="muted" style={{ margin: 0 }}>{tr("Version {0} · Build {1} vom", __BUILD__.version, __BUILD__.hash)}{" "}{__BUILD__.date.split("-").reverse().join(".")}</p>
            {md === null ? <p className="muted">{tr("Lade …")}</p> : <Changelog markdown={md} />}
          </div>
        </div>
      )}
    </>
  );
}

const PAGES = [
  { id: "eingang", label: tr("Eingang"), icon: Icon.inbox, lead: false },
  { id: "zeit", label: tr("Zeiterfassung"), icon: Icon.clock, lead: false },
  { id: "arbeitszeit", label: tr("Absenzen"), icon: Icon.balance, lead: false },
  { id: "abschluss", label: tr("Monatsabschluss"), icon: Icon.check, lead: false },
  { id: "projekte", label: tr("Kunden & Projekte"), icon: Icon.folder, lead: true },
  { id: "planung", label: tr("Planung"), icon: Icon.plan, lead: true },
  { id: "reports", label: tr("Reports"), icon: Icon.report, lead: true },
  { id: "velocity", label: tr("Velocity"), icon: Icon.velocity, lead: true },
  { id: "dashboard", label: tr("Dashboard"), icon: Icon.dashboard, lead: false },
  { id: "einstellungen", label: tr("Einstellungen"), icon: Icon.settings, lead: true, admin: true },
  { id: "profil", label: tr("Profil"), icon: Icon.settings, lead: false, hidden: true },
] as const;

type PageId = (typeof PAGES)[number]["id"];
const ROLE_LABEL: Record<Role, string> = { admin: tr("Admin · Anna Keller"), consultant: tr("Consultant · Marco Brunner"), employee: tr("Mitarbeiterin · Lea Meier"), auditor: tr("Treuhand (nur lesen) · Anna Keller"), customer: tr("Kundin · Claudia Steiner") };
/** Lead pages a project lead may open as well. */
const PROJECT_LEAD_PAGES: PageId[] = ["projekte", "planung", "reports"];
/** Pages shown in the phone tab bar; the rest sit behind "Mehr". */
const PHONE_TABS: PageId[] = ["eingang", "zeit", "arbeitszeit", "projekte"];
/** Rail sections: daily work on top, evaluations below the project list. */
const DAILY: PageId[] = ["eingang", "zeit", "arbeitszeit", "abschluss"];
const EVALUATE: PageId[] = ["projekte", "planung", "reports", "velocity", "dashboard"];
/** Projects listed in the rail; the rest are one click away under «Kunden & Projekte». */
const RAIL_PROJECTS = 6;
const SEVERITY = { over: 0, risk: 1, ok: 2 } as const;

const THEMES: { id: Theme; label: string; icon: () => JSX.Element }[] = [
  { id: "light", label: tr("Hell"), icon: Icon.sun },
  { id: "dark", label: tr("Dunkel"), icon: Icon.moon },
  { id: "system", label: tr("Wie das System"), icon: Icon.monitor },
];

/** "#projekte/c/abc" → page "projekte"; the rest of the hash is read by the page itself. */
function readHash(): PageId {
  const h = location.hash.replace("#", "").split("/")[0];
  return (PAGES.find((p) => p.id === h)?.id ?? "eingang") as PageId;
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
  if (!t) return <button id="timer-start" className="btn timer-btn" title={tr("Stoppuhr starten")} onClick={() => timer.start()}><Icon.play /><span>{tr("Stoppuhr")}</span></button>;
  const sec = elapsedOf(t);
  const stop = () => {
    const r = timer.stop();
    if (!r) return;
    const d = new Date(r.startedAt);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    requestNewEntry({ date: local.toISOString().slice(0, 10), startTime: `${String(d.getHours()).padStart(2, "0")}:${String(Math.floor(d.getMinutes() / 15) * 15).padStart(2, "0")}`, hours: hoursFromSeconds(r.seconds) });
  };
  return (
    <div className={`timer-chip ${t.runningSince ? "running" : "paused"}`} role="group" aria-label={tr("Stoppuhr")}>
      <span className="timer-dot" />
      <span className="timer-time num">{fmtTimer(sec)}</span>
      {t.runningSince
        ? <button id="timer-pause" className="timer-ctl" title={tr("Pause")} aria-label={tr("Pause")} onClick={() => timer.pause()}>❚❚</button>
        : <button id="timer-resume" className="timer-ctl" title={tr("Weiter")} aria-label={tr("Weiter")} onClick={() => timer.resume()}>▶</button>}
      <button id="timer-stop" className="timer-ctl stop" title={tr("Stoppen und buchen")} aria-label={tr("Stoppen und buchen")} onClick={stop}>■</button>
    </div>
  );
}

const isTyping = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.closest("[role=dialog]") !== null);

export function App() {
  const { role, setRole, toast, branding, mode, me, logout, pending, flushOutbox, scope } = useStore();
  const [page, setPage] = useState<PageId>(readHash);
  const [hash, setHash] = useState(location.hash);
  const [theme, setTheme] = useTheme();
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [more, setMore] = useState(false);
  const [setup, setSetup] = useState(false);
  const sub = useSubscription();
  const inboxCount = useInbox().reduce((n, g) => n + g.items.length, 0);
  const projects = useVisibleReports();
  const openProject = page === "projekte" ? hash.match(/^#projekte\/p\/([^/]+)/)?.[1] ?? null : null;
  const locked = !!sub && !canWrite(sub);
  useEffect(() => { if (role !== "customer") prefetchPages(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // New companies: the setup wizard opens for admins until it is finished or put off.
  useEffect(() => {
    const open = () => setSetup(true);
    window.addEventListener("ti:setup", open);
    if (role === "admin") {
      if (mode === "demo") { if (loadLocal<string>("rt.onboarding", "done") === "open") setSetup(true); }
      else api<{ onboarding?: string }>("/api/settings").then((s) => s.onboarding === "open" && setSetup(true)).catch(() => {});
    }
    return () => window.removeEventListener("ti:setup", open);
  }, [role, mode]);

  useEffect(() => {
    const onHash = () => { setPage(readHash()); setHash(location.hash); setMore(false); };
    window.addEventListener("hashchange", onHash);
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") { ev.preventDefault(); setPalette((p) => !p); return; }
      if (ev.metaKey || ev.ctrlKey || ev.altKey || isTyping(ev.target)) return;
      if (ev.key === "n" || ev.key === "N") { ev.preventDefault(); requestNewEntry(); }
      if (ev.key === "s" || ev.key === "S") { ev.preventDefault(); if (!timer.get()) timer.start(); }
      if (ev.key === "?") { ev.preventDefault(); setHelp(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("hashchange", onHash); window.removeEventListener("keydown", onKey); };
  }, []);

  // Portal accounts get their own, reduced application.
  if (role === "customer") return <><Suspense fallback={<div className="center-note">{tr("Lade …")}</div>}><Portal /></Suspense>{toast && <div className="toast" role="status">{toast}</div>}</>;

  const allowed = PAGES.filter((p) => (!p.lead || scope.seesAll || (scope.leadsProjects.length > 0 && PROJECT_LEAD_PAGES.includes(p.id))) && !("admin" in p && role !== "admin"));
  const visible = allowed.filter((p) => !("hidden" in p));
  const current = allowed.some((p) => p.id === page) ? page : "eingang";
  const name = me?.name ?? ROLE_LABEL[role].split(" · ")[1];
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("");
  const tabs = visible.filter((p) => PHONE_TABS.includes(p.id));
  const rest = visible.filter((p) => !PHONE_TABS.includes(p.id));

  const navLink = (p: (typeof PAGES)[number], count?: number) => (
    <a key={p.id} href={`#${p.id}`} className={current === p.id && !(p.id === "projekte" && openProject) ? "active" : ""}>
      <span className="nm">{p.label}</span>
      {!!count && <span className="count">{count}</span>}
    </a>
  );
  const evaluate = visible.filter((p) => EVALUATE.includes(p.id));
  const settings = visible.find((p) => p.id === "einstellungen");
  const railProjects = [...projects].sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status] || a.project.name.localeCompare(b.project.name, "de")).slice(0, RAIL_PROJECTS);

  return (
    <div className="shell" data-readonly={scope.readOnly || locked || undefined}>
      <aside className="rail">
        <div className="brand"><BrandMark logo={branding.logo} size={22} /><span>{branding.appName}</span></div>
        <nav className="nav" aria-label={tr("Hauptnavigation")}>
          {visible.filter((p) => DAILY.includes(p.id)).map((p) => navLink(p, p.id === "eingang" ? inboxCount : undefined))}
        </nav>
        {railProjects.length > 0 && (
          <nav className="nav" aria-label={tr("Projekte")}>
            <span className="nav-sec">{tr("Projekte")}</span>
            {railProjects.map((r) => (
              <a key={r.project.id} href={`#projekte/p/${r.project.id}`} className={openProject === r.project.id ? "active" : ""} title={`${r.customer.name} · ${r.project.name} · ${r.status === "over" ? tr("über Budget") : r.status === "risk" ? "knapp" : tr("im Budget")}`}>
                <BudgetRing ratio={r.retainer ? Math.max(r.retainer.used, r.retainer.avg3) / r.retainer.hoursPerMonth : r.budget > 0 ? r.forecastCost / r.budget : 0} status={r.status} size={14} />
                <span className="nm">{r.project.name}</span>
              </a>
            ))}
          </nav>
        )}
        {evaluate.length > 0 && (
          <nav className="nav" aria-label={tr("Auswerten")}>
            <span className="nav-sec">{tr("Auswerten")}</span>
            {evaluate.map((p) => navLink(p))}
          </nav>
        )}
        <div className="rail-foot">
          {settings && <nav className="nav">{navLink(settings)}</nav>}
          {mode === "demo" && (
            <Select id="role-select" ariaLabel={tr("Rolle")} value={role} onChange={(v) => setRole(v as Role)} options={(Object.keys(ROLE_LABEL) as Role[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }))} small />
          )}
          <div className="rail-tools">
            <div className="seg theme-seg" role="radiogroup" aria-label={tr("Darstellung")}>
              {THEMES.map((t) => (
                <button key={t.id} id={`theme-${t.id}`} role="radio" aria-checked={theme === t.id} className={theme === t.id ? "on" : ""} title={t.label} aria-label={t.label} onClick={() => setTheme(t.id)}><t.icon /></button>
              ))}
            </div>
            <button className="btn small ghost logout" onClick={logout} title={tr("Abmelden")} aria-label={tr("Abmelden")}><Icon.logout /></button>
          </div>
          <VersionInfo mode={mode} />
        </div>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <button className="brand brand-phone" onClick={() => (location.hash = "#eingang")} aria-label={tr("Zum Eingang")}><BrandMark logo={branding.logo} /></button>
          <button id="open-palette" className="search-btn" onClick={() => setPalette(true)} aria-label={tr("Suchen oder Befehl eingeben")}>
            <Icon.search />
            <span>{tr("Suchen oder Befehl …")}</span>
            <kbd>{tr("⌘K")}</kbd>
          </button>
          {pending > 0 && <button className="btn small offline-chip" title={tr("Buchungen, die auf Netz warten. Klick versucht es erneut.")} onClick={() => void flushOutbox()}>{tr("⇅ {0} offline", pending)}</button>}
          {scope.readOnly || locked ? (
            <span className="ro-chip" title={locked ? tr("Ohne aktives Paket sind die Daten nur lesbar") : tr("Treuhand-Zugang: alles einsehen, nichts ändern")}>{tr("Nur lesen")}</span>
          ) : (
            <>
              <HeaderTimer />
              <button id="topbar-new" className="btn primary new-btn" onClick={() => requestNewEntry()}>
                <span className="plus">+</span><span>{tr("Zeit buchen")}</span><kbd>{tr("N")}</kbd>
              </button>
            </>
          )}
          <button id="open-help" className="icon-btn help-btn" title={tr("Hilfe (?)")} aria-label={tr("Hilfe")} onClick={() => setHelp(true)}>?</button>
          <a href="#profil" className={`avatar-link ${current === "profil" ? "active" : ""}`} title={tr("{0} · Profil", name)} aria-label={tr("Profil")}>
            <span className="who">{initials}</span>
          </a>
        </header>
        <SubscriptionBanner />
        {help && <HelpPanel page={current} onClose={() => setHelp(false)} />}
        <main className={`main ${current === "eingang" ? "flush" : ""}`}>
          <PageBoundary page={current}>
          <Suspense fallback={<div className="page-loading" aria-busy="true" />}>
          {current === "eingang" && <Inbox />}
          {current === "dashboard" && <Dashboard key={role === "employee" ? "employee" : "lead"} />}
          {current === "zeit" && <TimeTracking />}
          {current === "arbeitszeit" && <WorkTime />}
          {current === "abschluss" && <Closing />}
          {current === "projekte" && <Projects />}
          {current === "planung" && <FeatureGate feature="planning"><Planning /></FeatureGate>}
          {current === "reports" && <Reports />}
          {current === "velocity" && <FeatureGate feature="forecast"><Velocity /></FeatureGate>}
          {current === "einstellungen" && <Settings />}
          {current === "profil" && <Profile />}
          </Suspense>
          </PageBoundary>
        </main>
      </div>

      <nav className="tabbar" aria-label={tr("Hauptnavigation")}>
        {tabs.map((p) => (
          <a key={p.id} href={`#${p.id}`} className={current === p.id ? "active" : ""}><p.icon /><span>{p.label.split(" ")[0]}</span></a>
        ))}
        <button className={more ? "active" : ""} onClick={() => setMore((m) => !m)} aria-expanded={more}><Icon.grip /><span>{tr("Mehr")}</span></button>
      </nav>
      {more && (
        <div className="more-sheet" onClick={() => setMore(false)}>
          <div className="sheet">
            {rest.map((p) => <a key={p.id} href={`#${p.id}`} className={current === p.id ? "active" : ""}><p.icon />{p.label}</a>)}
            <a href="#profil"><span className="who small">{initials}</span>{tr("Profil")}</a>
            <button onClick={logout}><Icon.logout />{tr("Abmelden")}</button>
          </div>
        </div>
      )}

      <CommandPalette open={palette} onClose={() => setPalette(false)} pages={visible.map((p) => ({ id: p.id, label: p.label }))} onNewEntry={requestNewEntry} />
      {setup && <Suspense fallback={null}><SetupWizard onClose={() => setSetup(false)} /></Suspense>}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
