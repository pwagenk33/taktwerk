import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, loadDataset, loadOlder, upload, type Branding, type Me, type EntryComment, type OpenQuestion, type WeekSubmission, type WeekOverviewRow, type PortalAccount } from "./api";
import { currentVelocity, profitability, projectReports, velocityByMonth, type Profitability, type ProjectReport, type VelocityFactor, type VelocityMonth, applyStamp, type PeriodKind, type StampAction, type TimeModel, type WorkPeriod } from "@taktwerk/domain";
import { NEEDS_APPROVAL, WorkCalendar, absenceProblem, isoWeekKey, monthRange, weekFigures } from "@taktwerk/domain";
import type { Absence, Customer, Dataset, Employee, Expense, Holiday, Project, Role, SubProject, TimeEntry, VelocitySettings } from "@taktwerk/domain";
import { intlLocale, tr, trn } from "./i18n";

export interface WorkSettingsPatch {
  weeklyHours?: number;
  holidays?: Holiday[];
  kmRate?: number;
  vatRate?: number;
  hoursReminder?: boolean;
  closingReminder?: boolean;
  costRate?: number;
  timeModel?: TimeModel;
}

export type WorkModelPatch = Partial<Pick<Employee, "workload" | "vacationDays" | "trackingStart" | "overtimeCarry" | "vacationCarry">>;

// App state: the dataset from the API (or example data in demo mode) plus derived velocity and reports.

export function loadLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: keep working in memory */
  }
}

type Add<T> = (item: Omit<T, "id">) => Promise<void>;
type Patch<T> = (id: string, patch: Partial<Omit<T, "id">>) => Promise<void>;

export type ClosingStatus = "open" | "submitted" | "approved";
export interface Closing {
  userId: string;
  month: string;
  status: Exclude<ClosingStatus, "open">;
}

/** Same rules as the server: approved locks everyone, submitted locks the person themselves. */
export function lockReason(closings: Closing[], actor: { id: string; role: Role; manages?: (userId: string) => boolean }, ownerId: string, date: string): string | null {
  if (actor.role === "auditor") return "Nur-Lesen-Zugang";
  const lead = actor.role === "admin" || actor.role === "consultant";
  if (ownerId !== actor.id && !lead && !actor.manages?.(ownerId)) return tr("Nur eigene Buchungen können geändert werden.");
  const status = closings.find((c) => c.userId === ownerId && c.month === date.slice(0, 7))?.status;
  if (status === "approved") return tr("Monat abgeschlossen");
  if (status === "submitted" && ownerId === actor.id && !lead) return tr("Monat eingereicht");
  return null;
}

/** What the signed-in person may see and do beyond the own bookings. */
export interface Scope {
  /** Admin or consultant: everything of the company. */
  lead: boolean;
  /** Lead or auditor: sees every report and budget. */
  seesAll: boolean;
  /** Auditor (Treuhand): nothing can be changed. */
  readOnly: boolean;
  /** Lead or team lead: approves absences and months of other people. */
  managesPeople: boolean;
  leadsProjects: string[];
  leadsTeams: string[];
  leadsProject: (projectId: string) => boolean;
  /** Whether bookings and absences of this person may be handled. */
  manages: (userId: string) => boolean;
}

export function scopeOf(role: Role, userId: string, data: Pick<Dataset, "projects" | "teams" | "employees">): Scope {
  const lead = role === "admin" || role === "consultant";
  const leadsProjects = lead ? [] : data.projects.filter((p) => p.leadUserId === userId).map((p) => p.id);
  const leadsTeams = lead ? [] : data.teams.filter((t) => t.leadUserId === userId).map((t) => t.id);
  const members = new Set(data.employees.filter((e) => leadsTeams.includes(e.teamId)).map((e) => e.id));
  return {
    lead,
    seesAll: lead || role === "auditor",
    readOnly: role === "auditor",
    managesPeople: lead || leadsTeams.length > 0,
    leadsProjects,
    leadsTeams,
    leadsProject: (id) => lead || leadsProjects.includes(id),
    manages: (id) => lead || id === userId || members.has(id),
  };
}

interface Store {
  data: Dataset;
  /** "demo": example data in the browser; "api": signed in against the server. */
  mode: "demo" | "api";
  me: Me | null;
  role: Role;
  currentUserId: string;
  scope: Scope;
  /** Installed version: fetch the dataset again (after changes made outside the store). */
  reload: () => Promise<void>;
  /** Installed version: load single bookings back to `date` (older months come as monthly totals). */
  loadFrom: (date: string) => Promise<void>;
  setRole: (r: Role) => void;
  branding: Branding;
  setBranding: (b: Branding) => Promise<void>;
  setLogo: (file: File | null) => Promise<void>;
  logout: () => void;
  velocitySettings: VelocitySettings;
  setVelocitySettings: (s: VelocitySettings) => void;
  velocity: VelocityMonth[];
  factor: VelocityFactor | null;
  reports: ProjectReport[];
  addTimeEntry: Add<TimeEntry>;
  addExpense: Add<Expense>;
  /** Creates an expense and, in the installed version, uploads the receipt with it. */
  addExpenseWithReceipt: (item: Omit<Expense, "id">, receipt?: File | null) => Promise<void>;
  uploadReceipt: (expenseId: string, file: File) => Promise<void>;
  deleteReceipt: (expenseId: string) => Promise<void>;
  decideExpense: (id: string, approve: boolean, comment?: string) => Promise<void>;
  resubmitExpense: (id: string) => Promise<void>;
  addCustomer: Add<Customer>;
  addProject: Add<Project>;
  addSubProject: Add<SubProject>;
  updateTimeEntry: Patch<TimeEntry>;
  deleteTimeEntry: (id: string) => Promise<void>;
  updateExpense: Patch<Expense>;
  updateProject: Patch<Project>;
  updateCustomer: (id: string, patch: { name?: string; currency?: Customer["currency"]; locale?: Customer["locale"]; address?: Customer["address"]; rate?: Customer["rates"][number] }) => Promise<void>;
  /** Resource planning: reserve `hours` of a person for a project in an ISO week (0 removes the reservation). */
  setAllocation: (employeeId: string, projectId: string, week: string, hours: number) => Promise<void>;
  /** Customer portal accounts of a customer (leads). */
  portalAccounts: (customerId: string) => Promise<PortalAccount[]>;
  invitePortal: (customerId: string, name: string, email: string) => Promise<PortalAccount>;
  revokePortal: (customerId: string, userId: string) => Promise<void>;
  /** Margin per project and customer in CHF; leads only (employees get no cost rates). */
  profit: Profitability;
  updateSubProject: Patch<SubProject>;
  deleteExpense: (id: string) => Promise<void>;
  closings: Closing[];
  /** Why the current user may not change a booking of `ownerId` on `date`, or null if allowed. */
  lockOf: (ownerId: string, date: string) => string | null;
  closeMonth: (action: "submit" | "approve" | "reopen", month: string, userId: string) => Promise<void>;
  /** Leads: approve every submitted month at once. Returns how many. */
  approveSubmitted: (month: string) => Promise<number>;
  /** Leads: e-mail one person that the month is still open. */
  remindClosing: (month: string, userId: string) => Promise<void>;
  /** Unanswered questions on bookings the viewer should see (own bookings; leads: all). */
  questions: OpenQuestion[];
  /** Submitted weeks (own; leads: everyone) of the last months. */
  weeks: WeekSubmission[];
  submitWeek: (week: string) => Promise<void>;
  withdrawWeek: (week: string) => Promise<void>;
  /** Leads: team grid of the given ISO weeks. */
  weekOverview: (from: string, to: string) => Promise<WeekOverviewRow[]>;
  /** Bookings made offline that still wait to be sent. */
  pending: number;
  /** Sends queued bookings; called on reconnect and start. */
  flushOutbox: () => Promise<void>;
  comments: (entryId: string) => Promise<EntryComment[]>;
  addComment: (entryId: string, text: string, question: boolean) => Promise<void>;
  addAbsence: (a: Omit<Absence, "id" | "status">) => Promise<Absence["status"]>;
  decideAbsence: (id: string, approve: boolean) => Promise<void>;
  deleteAbsence: (id: string) => Promise<void>;
  updateWorkModel: (userId: string, patch: WorkModelPatch) => Promise<void>;
  setWorkSettings: (s: WorkSettingsPatch) => Promise<void>;
  /** Come/go recording (time model «full»): stamp now, or add, change and remove periods by hand. */
  stamp: (action: StampAction) => Promise<void>;
  addWorkPeriod: (p: { date: string; start: string; end: string; kind: PeriodKind }) => Promise<void>;
  updateWorkPeriod: (id: string, patch: { start?: string; end?: string | null; kind?: PeriodKind }) => Promise<void>;
  deleteWorkPeriod: (id: string) => Promise<void>;
  toast: string | null;
  notify: (msg: string) => void;
}

const Ctx = createContext<Store | null>(null);
const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface ProviderProps {
  children: ReactNode;
  initial: Dataset;
  me: Me | null;
  branding: Branding;
  onBranding: (b: Branding) => void;
  onLogout: () => void;
}

export function StoreProvider({ children, initial, me, branding, onBranding, onLogout }: ProviderProps) {
  const mode = me ? "api" : "demo";
  const [data, setData] = useState<Dataset>(() =>
    me
      ? initial
      : {
          ...initial,
          allocations: loadLocal<Dataset["allocations"] | null>("rt.allocations", null) ?? initial.allocations,
          workPeriods: loadLocal<WorkPeriod[]>("rt.presence", []),
          workModel: { ...initial.workModel!, timeModel: loadLocal<TimeModel>("rt.timeModel", "simplified") },
        },
  );
  const [demoRole, setDemoRole] = useState<Role>(() => loadLocal<Role>("rt.role", "admin"));
  const [velocitySettings, setVS] = useState<VelocitySettings>(() =>
    loadLocal<VelocitySettings>("rt.velocity", { method: "rolling", window: 3 }),
  );
  const [toast, setToast] = useState<string | null>(null);
  const notify = (msg: string) => setToast(msg);
  const [closings, setClosings] = useState<Closing[]>(() => (me ? [] : loadLocal<Closing[]>("rt.closings", [])));
  const loadClosings = async () => setClosings(await api<Closing[]>("/api/closings"));
  const [questions, setQuestions] = useState<OpenQuestion[]>([]);
  const loadQuestions = async () => setQuestions(await api<OpenQuestion[]>("/api/comments/open"));
  const [weeks, setWeeks] = useState<WeekSubmission[]>(() => (me ? [] : loadLocal<WeekSubmission[]>("rt.weeks", [])));
  const weekSpan = () => {
    const today = new Date().toISOString().slice(0, 10);
    const d = new Date(today);
    d.setDate(d.getDate() - 7 * 16);
    return { from: isoWeekKey(d.toISOString().slice(0, 10)), to: isoWeekKey(today) };
  };
  const loadWeeks = async () => {
    const { from, to } = weekSpan();
    setWeeks(await api<WeekSubmission[]>(`/api/weeks?from=${from}&to=${to}`));
  };
  // Demo mode keeps comments in the browser so the flow can be tried without a server.
  type LocalComment = EntryComment & { entryId: string };
  const [localComments, setLocalCommentsState] = useState<LocalComment[]>(() => (me ? [] : loadLocal<LocalComment[]>("rt.comments", [])));
  // A ref keeps `comments()` fresh for callers holding an older render's closure.
  const localRef = useRef(localComments);
  const setLocalComments = (next: LocalComment[]) => { localRef.current = next; setLocalCommentsState(next); };

  useEffect(() => {
    if (me && me.role !== "customer") { loadClosings().catch(() => {}); loadQuestions().catch(() => {}); loadWeeks().catch(() => {}); }
  }, [me]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const velocity = useMemo(() => velocityByMonth(data, velocitySettings), [data, velocitySettings]);
  const factor = useMemo(() => currentVelocity(velocity, velocitySettings), [velocity, velocitySettings]);
  const reports = useMemo(() => projectReports(data, velocitySettings), [data, velocitySettings]);
  const profit = useMemo(() => profitability(data, reports), [data, reports]);

  // In API mode every change goes to the server, then the dataset is reloaded so all figures stay consistent.
  const remote = async (path: string, body: unknown) => {
    await api(path, { body });
    setData(await loadDataset());
  };
  // Offline: bookings are queued in the browser and shown in the calendar at once; they are sent when the network is back.
  type Queued = { tempId: string; body: Record<string, unknown>; employeeId: string; hourlyRate: number };
  const [outbox, setOutboxState] = useState<Queued[]>(() => (me ? loadLocal<Queued[]>("rt.outbox", []) : []));
  const outboxRef = useRef(outbox);
  const setOutbox = (next: Queued[]) => { outboxRef.current = next; setOutboxState(next); saveLocal("rt.outbox", next); };
  const isOffline = (e: unknown) => (e instanceof TypeError) || (e instanceof Error && /offline|Failed to fetch|NetworkError|Load failed/i.test(e.message)) || (typeof navigator !== "undefined" && !navigator.onLine);
  const addEntryRemote = async (item: Omit<TimeEntry, "id">) => {
    const { hourlyRate, employeeId, ...body } = item;
    try {
      await remote("/api/time-entries", body);
    } catch (e) {
      if (!isOffline(e)) throw e;
      const tempId = uid("offline-");
      setOutbox([...outboxRef.current, { tempId, body: body as Record<string, unknown>, employeeId, hourlyRate }]);
      setData((d) => ({ ...d, timeEntries: [...d.timeEntries, { ...item, id: tempId }] }));
      setTimeout(() => notify(tr("Kein Netz: Buchung zwischengespeichert, wird gesendet sobald du online bist")), 60);
    }
  };
  const flushing = useRef(false);
  const flushOutbox = async () => {
    if (mode !== "api" || flushing.current || outboxRef.current.length === 0) return;
    flushing.current = true;
    try {
      let sent = 0;
      for (const q of [...outboxRef.current]) {
        try {
          await api("/api/time-entries", { body: q.body });
          setOutbox(outboxRef.current.filter((x) => x.tempId !== q.tempId));
          sent++;
        } catch (e) {
          if (isOffline(e)) break;
          // Rejected by the server (e.g. month locked): drop it and tell the person.
          setOutbox(outboxRef.current.filter((x) => x.tempId !== q.tempId));
          notify(tr("Offline-Buchung abgelehnt: {0}", (e as Error).message));
        }
      }
      if (sent > 0) {
        setData(await loadDataset());
        notify(trn(sent, "{0} Offline-Buchung gesendet", "{0} Offline-Buchungen gesendet"));
      }
    } finally {
      flushing.current = false;
    }
  };
  useEffect(() => {
    if (mode !== "api") return;
    void flushOutbox();
    const on = () => void flushOutbox();
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = async (method: "PATCH" | "DELETE", path: string, body?: unknown) => {
    await api(path, { method, body });
    setData(await loadDataset());
  };
  const localPatch = (key: "timeEntries" | "expenses" | "projects" | "subProjects") => async (id: string, patch: object) =>
    setData((d) => ({ ...d, [key]: (d[key] as { id: string }[]).map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  const localDelete = (key: "timeEntries" | "expenses") => async (id: string) =>
    setData((d) => ({ ...d, [key]: (d[key] as { id: string }[]).filter((x) => x.id !== id) }));
  const local = <K extends keyof Dataset>(key: K, prefix: string) => async (item: object) =>
    setData((d) => ({ ...d, [key]: [...(d[key] as object[]), { ...item, id: uid(prefix) }] }));

  const role = me?.role ?? demoRole;
  // Demo: admin and consultant act as Anna/Marco, the employee view as Lea.
  const currentUserId = me?.id ?? (role === "admin" || role === "auditor" ? "e1" : role === "consultant" ? "e2" : "e3");
  const scope = scopeOf(role, currentUserId, data);
  const store: Store = {
    data,
    mode,
    me,
    scope,
    reload: async () => { if (mode === "api") setData(await loadDataset()); },
    loadFrom: async (date) => {
      if (mode !== "api" || !data.detailFrom || date >= data.detailFrom) return;
      const next = await loadOlder(date);
      if (next) setData(next);
    },
    role,
    currentUserId,
    setRole: (r) => {
      setDemoRole(r);
      saveLocal("rt.role", r);
    },
    branding,
    setBranding: async (b) => {
      if (mode === "api") await api("/api/settings", { method: "PUT", body: { branding: { appName: b.appName, primaryColor: b.primaryColor, showMotif: b.showMotif } } });
      else saveLocal("rt.branding", b);
      onBranding(b);
    },
    setLogo: async (file) => {
      let next: Branding;
      if (mode === "api") {
        next = file ? await upload<Branding>("/api/branding/logo", file) : await api<Branding>("/api/branding/logo", { method: "DELETE" });
      } else {
        if (file && file.size > 300 * 1024) throw new Error(tr("In der Demo sind Logos bis 300 KB möglich."));
        const logo = file ? await new Promise<string>((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => fail(new Error(tr("Datei konnte nicht gelesen werden."))); r.readAsDataURL(file); }) : undefined;
        const { logo: _l, logoMime: _m, ...rest } = branding;
        next = logo ? { ...rest, logo, logoMime: file!.type } : rest;
        saveLocal("rt.branding", next);
      }
      onBranding(next);
    },
    logout: onLogout,
    velocitySettings,
    setVelocitySettings: (s) => {
      setVS(s);
      saveLocal("rt.velocity", s);
    },
    velocity,
    factor,
    reports,
    addTimeEntry: mode === "api" ? addEntryRemote : local("timeEntries", "t"),
    addExpense: mode === "api" ? (e) => remote("/api/expenses", e) : local("expenses", "x"),
    addExpenseWithReceipt: async (e, receipt) => {
      if (mode === "api") {
        const created = await api<{ id: string }>("/api/expenses", { body: e });
        if (receipt) await upload(`/api/expenses/${created.id}/receipt`, receipt);
        setData(await loadDataset());
        return;
      }
      // Demo: employees' expenses wait for approval, like on the server; the receipt stays in the browser only.
      const status = scope.lead ? "approved" : "requested";
      const item = { ...e, status, receipt: receipt ? { name: receipt.name, mime: receipt.type } : undefined, id: uid("x") } as Expense;
      setData((d) => ({ ...d, expenses: [...d.expenses, item] }));
    },
    uploadReceipt: async (id, file) => {
      if (mode === "api") {
        await upload(`/api/expenses/${id}/receipt`, file);
        setData(await loadDataset());
        return;
      }
      setData((d) => ({ ...d, expenses: d.expenses.map((x) => (x.id === id ? { ...x, receipt: { name: file.name, mime: file.type } } : x)) }));
    },
    deleteReceipt: mode === "api" ? (id) => send("DELETE", `/api/expenses/${id}/receipt`) : async (id) => setData((d) => ({ ...d, expenses: d.expenses.map((x) => (x.id === id ? { ...x, receipt: undefined } : x)) })),
    decideExpense: async (id, approve, comment) => {
      if (mode === "api") {
        await api(`/api/expenses/${id}/decide`, { body: { approve, comment: comment || undefined } });
        setData(await loadDataset());
        return;
      }
      setData((d) => ({ ...d, expenses: d.expenses.map((x) => (x.id === id ? { ...x, status: approve ? "approved" : "rejected" } : x)) }));
    },
    resubmitExpense: async (id) => {
      if (mode === "api") {
        await api(`/api/expenses/${id}/resubmit`, { body: {} });
        setData(await loadDataset());
        return;
      }
      setData((d) => ({ ...d, expenses: d.expenses.map((x) => (x.id === id ? { ...x, status: "requested" } : x)) }));
    },
    addCustomer:
      mode === "api"
        ? (c) => remote("/api/customers", { name: c.name, hourlyRate: c.rates[0].hourlyRate, validFrom: c.rates[0].validFrom, currency: c.currency, locale: c.locale, address: c.address })
        : local("customers", "c"),
    setAllocation: async (employeeId, projectId, week, hours) => {
      const h = Math.round(hours * 2) / 2;
      if (mode === "api") {
        await api("/api/planning", { method: "PUT", body: { employeeId, projectId, week, hours: h } });
        setData(await loadDataset());
        return;
      }
      setData((d) => {
        const rest = (d.allocations ?? []).filter((a) => !(a.employeeId === employeeId && a.projectId === projectId && a.week === week));
        const next = h > 0 ? [...rest, { id: uid("al"), employeeId, projectId, week, hours: h }] : rest;
        saveLocal("rt.allocations", next);
        return { ...d, allocations: next };
      });
    },
    portalAccounts: async (customerId) => (mode === "api" ? api<PortalAccount[]>(`/api/customers/${customerId}/portal`) : loadLocal<PortalAccount[]>("rt.portal", []).filter((a) => a.username.startsWith(`${customerId}:`))),
    invitePortal: async (customerId, name, email) => {
      if (mode === "api") return api<PortalAccount>(`/api/customers/${customerId}/portal`, { body: { name, email } });
      const acc: PortalAccount = { id: uid("pu"), name, email: email.toLowerCase(), username: `${customerId}:${email.toLowerCase()}`, active: true, lastLoginAt: null, hasPassword: false };
      saveLocal("rt.portal", [...loadLocal<PortalAccount[]>("rt.portal", []), acc]);
      return acc;
    },
    revokePortal: async (customerId, userId) => {
      if (mode === "api") {
        await api(`/api/customers/${customerId}/portal/${userId}`, { method: "DELETE" });
        return;
      }
      saveLocal("rt.portal", loadLocal<PortalAccount[]>("rt.portal", []).filter((a) => a.id !== userId));
    },
    updateCustomer: async (id, patch) => {
      if (mode === "api") {
        await api(`/api/customers/${id}`, { method: "PATCH", body: patch });
        setData(await loadDataset());
        return;
      }
      const { rate, ...rest } = patch;
      setData((d) => ({
        ...d,
        customers: d.customers.map((c) => (c.id === id ? { ...c, ...rest, rates: rate ? [...c.rates.filter((r) => r.validFrom !== rate.validFrom), rate].sort((a, b) => a.validFrom.localeCompare(b.validFrom)) : c.rates } : c)),
      }));
    },
    profit,
    addProject: mode === "api" ? (p) => remote("/api/projects", p) : local("projects", "p"),
    addSubProject: mode === "api" ? (s) => remote("/api/sub-projects", s) : local("subProjects", "s"),
    updateTimeEntry: mode === "api" ? (id, p) => send("PATCH", `/api/time-entries/${id}`, p) : localPatch("timeEntries"),
    deleteTimeEntry: mode === "api" ? (id) => send("DELETE", `/api/time-entries/${id}`) : localDelete("timeEntries"),
    updateExpense: mode === "api" ? (id, p) => send("PATCH", `/api/expenses/${id}`, p) : localPatch("expenses"),
    updateProject: mode === "api" ? (id, p) => send("PATCH", `/api/projects/${id}`, p) : localPatch("projects"),
    updateSubProject: mode === "api" ? (id, p) => send("PATCH", `/api/sub-projects/${id}`, p) : localPatch("subProjects"),
    deleteExpense: mode === "api" ? (id) => send("DELETE", `/api/expenses/${id}`) : localDelete("expenses"),
    closings,
    lockOf: (ownerId, date) => lockReason(closings, { id: currentUserId, role, manages: scope.manages }, ownerId, date),
    closeMonth: async (action, month, userId) => {
      if (mode === "api") {
        await api(`/api/months/${month}/${action}`, { body: action === "submit" ? {} : { userId } });
        await loadClosings();
        return;
      }
      const rest = closings.filter((c) => !(c.userId === userId && c.month === month));
      const next = action === "reopen" ? rest : [...rest, { userId, month, status: action === "submit" ? ("submitted" as const) : ("approved" as const) }];
      setClosings(next);
      saveLocal("rt.closings", next);
    },
    approveSubmitted: async (month) => {
      if (mode === "api") {
        const res = await api<{ approved: number }>(`/api/months/${month}/approve-all`, { body: {} });
        await loadClosings();
        return res.approved;
      }
      const hit = closings.filter((c) => c.month === month && c.status === "submitted");
      const next = closings.map((c) => (c.month === month && c.status === "submitted" ? { ...c, status: "approved" as const } : c));
      setClosings(next);
      saveLocal("rt.closings", next);
      return hit.length;
    },
    remindClosing: async (month, userId) => {
      if (mode === "api") await api(`/api/months/${month}/remind`, { body: { userId } });
    },
    pending: outbox.length,
    flushOutbox,
    weeks,
    submitWeek: async (week) => {
      if (mode === "api") {
        await api(`/api/weeks/${week}/submit`, { body: {} });
        await loadWeeks();
        return;
      }
      const emp = data.employees.find((e) => e.id === currentUserId);
      const hours = emp ? weekFigures(new WorkCalendar(data, emp), week).worked : 0;
      const next = [...weeks.filter((w) => !(w.userId === currentUserId && w.week === week)), { userId: currentUserId, week, hours, submittedAt: new Date().toISOString() }];
      setWeeks(next);
      saveLocal("rt.weeks", next);
    },
    withdrawWeek: async (week) => {
      if (mode === "api") {
        await api(`/api/weeks/${week}/submit`, { method: "DELETE" });
        await loadWeeks();
        return;
      }
      const next = weeks.filter((w) => !(w.userId === currentUserId && w.week === week));
      setWeeks(next);
      saveLocal("rt.weeks", next);
    },
    weekOverview: async (from, to) => {
      if (mode === "api") return api<WeekOverviewRow[]>(`/api/weeks/overview?from=${from}&to=${to}`);
      const keys: string[] = [];
      for (let k = from; k <= to && keys.length < 12; ) {
        keys.push(k);
        const [y, w] = k.split("-W").map(Number);
        k = w >= 52 ? `${y + 1}-W01` : `${y}-W${String(w + 1).padStart(2, "0")}`;
      }
      return data.employees.map((e) => {
        const cal = new WorkCalendar(data, e);
        return {
          userId: e.id,
          name: e.name,
          weeks: keys.map((week) => {
            const f = weekFigures(cal, week);
            const sub = weeks.find((w) => w.userId === e.id && w.week === week);
            return { week, due: f.due, worked: f.worked, submitted: Boolean(sub), submittedAt: sub?.submittedAt ?? null };
          }),
        };
      });
    },
    questions:
      mode === "api"
        ? questions
        : localComments
            .filter((c) => c.kind === "question" && !c.resolvedAt)
            .map((c) => {
              const e = data.timeEntries.find((x) => x.id === c.entryId);
              return e ? { entryId: e.id, ownerId: e.employeeId, date: e.date, reason: e.reason, text: c.text, askedBy: c.authorName, createdAt: c.createdAt } : null;
            })
            .filter((q): q is OpenQuestion => q !== null && (scope.managesPeople || q.ownerId === currentUserId)),
    comments: async (entryId) => (mode === "api" ? api<EntryComment[]>(`/api/time-entries/${entryId}/comments`) : localRef.current.filter((c) => c.entryId === entryId)),
    addComment: async (entryId, text, question) => {
      if (mode === "api") {
        await api(`/api/time-entries/${entryId}/comments`, { body: { text, question } });
        await loadQuestions();
        return;
      }
      const e = data.timeEntries.find((x) => x.id === entryId);
      const owner = e?.employeeId === currentUserId;
      const author = data.employees.find((x) => x.id === currentUserId)?.name ?? tr("Ich");
      const now = new Date().toISOString();
      const resolved = localRef.current.map((c) => (owner && c.entryId === entryId && c.kind === "question" && !c.resolvedAt ? { ...c, resolvedAt: now } : c));
      const next = [...resolved, { id: uid("c"), entryId, kind: question && !owner && scope.managesPeople ? ("question" as const) : ("comment" as const), text, authorId: currentUserId, authorName: author, createdAt: now, resolvedAt: null }];
      setLocalComments(next);
      saveLocal("rt.comments", next);
    },
    addAbsence: async (a) => {
      if (mode === "api") {
        const res = await api<Absence>("/api/absences", { body: a });
        setData(await loadDataset());
        return res.status;
      }
      // Demo: same rules as the server.
      const lead = scope.lead || (a.employeeId !== currentUserId && scope.manages(a.employeeId));
      for (const m of monthRange(a.startDate.slice(0, 7), a.endDate.slice(0, 7))) {
        const lock = lockReason(closings, { id: currentUserId, role }, a.employeeId, `${m}-01` < a.startDate ? a.startDate : `${m}-01`);
        if (lock) throw new Error(lock);
      }
      const problem = absenceProblem(data, a);
      if (problem) throw new Error(problem);
      const status = lead || !NEEDS_APPROVAL.includes(a.type) ? "approved" : "requested";
      setData((d) => ({ ...d, absences: [...(d.absences ?? []), { ...a, id: uid("a"), status }] }));
      return status;
    },
    decideAbsence: async (id, approve) => {
      if (mode === "api") {
        await api(`/api/absences/${id}/decide`, { body: { approve } });
        setData(await loadDataset());
        return;
      }
      setData((d) => ({ ...d, absences: (d.absences ?? []).map((a) => (a.id === id ? { ...a, status: approve ? "approved" : "rejected" } : a)) }));
    },
    deleteAbsence: mode === "api" ? (id) => send("DELETE", `/api/absences/${id}`) : async (id) => setData((d) => ({ ...d, absences: (d.absences ?? []).filter((a) => a.id !== id) })),
    updateWorkModel:
      mode === "api"
        ? (userId, patch) => send("PATCH", `/api/users/${userId}/work-model`, patch)
        : async (userId, patch) => setData((d) => ({ ...d, employees: d.employees.map((e) => (e.id === userId ? { ...e, ...patch } : e)) })),
    stamp: async (action) => {
      if (mode === "api") {
        await api("/api/presence/stamp", { body: { action } });
        setData(await loadDataset());
        return;
      }
      const now = new Intl.DateTimeFormat(intlLocale, { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()).replace(".", ":");
      setData((d) => {
        const next = applyStamp(d.workPeriods ?? [], action, currentUserId, d.today, now, () => uid("wp"));
        saveLocal("rt.presence", next);
        return { ...d, workPeriods: next };
      });
    },
    addWorkPeriod: async (p) => {
      if (mode === "api") {
        await api("/api/presence", { body: p });
        setData(await loadDataset());
        return;
      }
      setData((d) => {
        const next = [...(d.workPeriods ?? []), { ...p, id: uid("wp"), employeeId: currentUserId }];
        saveLocal("rt.presence", next);
        return { ...d, workPeriods: next };
      });
    },
    updateWorkPeriod: async (id, patch) => {
      if (mode === "api") {
        await api(`/api/presence/${id}`, { method: "PUT", body: patch });
        setData(await loadDataset());
        return;
      }
      setData((d) => {
        const next = (d.workPeriods ?? []).map((p) => (p.id === id ? { ...p, ...patch, end: patch.end === null ? undefined : (patch.end ?? p.end) } : p));
        saveLocal("rt.presence", next);
        return { ...d, workPeriods: next };
      });
    },
    deleteWorkPeriod: async (id) => {
      if (mode === "api") {
        await api(`/api/presence/${id}`, { method: "DELETE" });
        setData(await loadDataset());
        return;
      }
      setData((d) => {
        const next = (d.workPeriods ?? []).filter((p) => p.id !== id);
        saveLocal("rt.presence", next);
        return { ...d, workPeriods: next };
      });
    },
    setWorkSettings: async (w) => {
      if (mode === "api") {
        await api("/api/settings", { method: "PUT", body: w });
        setData(await loadDataset());
        return;
      }
      if (w.timeModel) saveLocal("rt.timeModel", w.timeModel);
      setData((d) => ({
        ...d,
        workModel: { weeklyHours: w.weeklyHours ?? d.workModel!.weeklyHours, holidays: w.holidays ?? d.workModel!.holidays, timeModel: w.timeModel ?? d.workModel!.timeModel },
        rates: { kmRate: w.kmRate ?? d.rates?.kmRate ?? 0.7, vatRate: w.vatRate ?? d.rates?.vatRate ?? 8.1, costRate: w.costRate ?? d.rates?.costRate },
      }));
    },
    toast,
    notify: setToast,
  };
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error(tr("StoreProvider missing"));
  return s;
}

/** Resolves chart colors from CSS tokens and follows theme changes (Recharts needs concrete values). */
export function useThemeColors() {
  const read = () => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string) => cs.getPropertyValue(n).trim();
    return {
      s1: v("--series-1"), s2: v("--series-2"), s3: v("--series-3"), s4: v("--series-4"), s1soft: v("--series-1-soft"),
      grid: v("--grid"), axis: v("--axis"), muted: v("--muted"), ink: v("--ink"), ink2: v("--ink-2"), surface: v("--surface"),
      crit: v("--crit"),
    };
  };
  const [colors, setColors] = useState(read);
  useEffect(() => {
    const update = () => setColors(read());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", update);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq.removeEventListener("change", update);
      mo.disconnect();
    };
  }, []);
  return colors;
}
