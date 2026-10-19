import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, loadDataset, upload, type Branding, type Me } from "./api";
import { currentVelocity, projectReports, velocityByMonth, type ProjectReport, type VelocityFactor, type VelocityMonth } from "@taktwerk/domain";
import { NEEDS_APPROVAL, absenceProblem, monthRange } from "@taktwerk/domain";
import type { Absence, Customer, Dataset, Employee, Expense, Holiday, Project, Role, SubProject, TimeEntry, VelocitySettings } from "@taktwerk/domain";

export interface WorkSettingsPatch {
  weeklyHours?: number;
  holidays?: Holiday[];
  kmRate?: number;
  vatRate?: number;
  hoursReminder?: boolean;
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
export function lockReason(closings: Closing[], actor: { id: string; role: Role }, ownerId: string, date: string): string | null {
  if (ownerId !== actor.id && actor.role === "employee") return "Nur eigene Buchungen können geändert werden.";
  const status = closings.find((c) => c.userId === ownerId && c.month === date.slice(0, 7))?.status;
  if (status === "approved") return "Monat abgeschlossen";
  if (status === "submitted" && actor.role === "employee") return "Monat eingereicht";
  return null;
}

interface Store {
  data: Dataset;
  /** "demo": example data in the browser; "api": signed in against the server. */
  mode: "demo" | "api";
  me: Me | null;
  role: Role;
  currentUserId: string;
  setRole: (r: Role) => void;
  branding: Branding;
  setBranding: (b: Branding) => Promise<void>;
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
  updateSubProject: Patch<SubProject>;
  deleteExpense: (id: string) => Promise<void>;
  closings: Closing[];
  /** Why the current user may not change a booking of `ownerId` on `date`, or null if allowed. */
  lockOf: (ownerId: string, date: string) => string | null;
  closeMonth: (action: "submit" | "approve" | "reopen", month: string, userId: string) => Promise<void>;
  addAbsence: (a: Omit<Absence, "id" | "status">) => Promise<Absence["status"]>;
  decideAbsence: (id: string, approve: boolean) => Promise<void>;
  deleteAbsence: (id: string) => Promise<void>;
  updateWorkModel: (userId: string, patch: WorkModelPatch) => Promise<void>;
  setWorkSettings: (s: WorkSettingsPatch) => Promise<void>;
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
  const [data, setData] = useState<Dataset>(initial);
  const [demoRole, setDemoRole] = useState<Role>(() => loadLocal<Role>("rt.role", "admin"));
  const [velocitySettings, setVS] = useState<VelocitySettings>(() =>
    loadLocal<VelocitySettings>("rt.velocity", { method: "rolling", window: 3 }),
  );
  const [toast, setToast] = useState<string | null>(null);
  const [closings, setClosings] = useState<Closing[]>(() => (me ? [] : loadLocal<Closing[]>("rt.closings", [])));
  const loadClosings = async () => setClosings(await api<Closing[]>("/api/closings"));

  useEffect(() => {
    if (me) loadClosings().catch(() => {});
  }, [me]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const velocity = useMemo(() => velocityByMonth(data, velocitySettings), [data, velocitySettings]);
  const factor = useMemo(() => currentVelocity(velocity, velocitySettings), [velocity, velocitySettings]);
  const reports = useMemo(() => projectReports(data, velocitySettings), [data, velocitySettings]);

  // In API mode every change goes to the server, then the dataset is reloaded so all figures stay consistent.
  const remote = async (path: string, body: unknown) => {
    await api(path, { body });
    setData(await loadDataset());
  };
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
  const currentUserId = me?.id ?? (role === "admin" ? "e1" : role === "consultant" ? "e2" : "e3");
  const store: Store = {
    data,
    mode,
    me,
    role,
    currentUserId,
    setRole: (r) => {
      setDemoRole(r);
      saveLocal("rt.role", r);
    },
    branding,
    setBranding: async (b) => {
      if (mode === "api") await api("/api/settings", { method: "PUT", body: { branding: b } });
      else saveLocal("rt.branding", b);
      onBranding(b);
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
    addTimeEntry: mode === "api" ? ({ hourlyRate: _rate, ...e }) => remote("/api/time-entries", e) : local("timeEntries", "t"),
    addExpense: mode === "api" ? (e) => remote("/api/expenses", e) : local("expenses", "x"),
    addExpenseWithReceipt: async (e, receipt) => {
      if (mode === "api") {
        const created = await api<{ id: string }>("/api/expenses", { body: e });
        if (receipt) await upload(`/api/expenses/${created.id}/receipt`, receipt);
        setData(await loadDataset());
        return;
      }
      // Demo: employees' expenses wait for approval, like on the server; the receipt stays in the browser only.
      const status = role === "employee" ? "requested" : "approved";
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
        ? (c) => remote("/api/customers", { name: c.name, hourlyRate: c.rates[0].hourlyRate, validFrom: c.rates[0].validFrom })
        : local("customers", "c"),
    addProject: mode === "api" ? (p) => remote("/api/projects", p) : local("projects", "p"),
    addSubProject: mode === "api" ? (s) => remote("/api/sub-projects", s) : local("subProjects", "s"),
    updateTimeEntry: mode === "api" ? (id, p) => send("PATCH", `/api/time-entries/${id}`, p) : localPatch("timeEntries"),
    deleteTimeEntry: mode === "api" ? (id) => send("DELETE", `/api/time-entries/${id}`) : localDelete("timeEntries"),
    updateExpense: mode === "api" ? (id, p) => send("PATCH", `/api/expenses/${id}`, p) : localPatch("expenses"),
    updateProject: mode === "api" ? (id, p) => send("PATCH", `/api/projects/${id}`, p) : localPatch("projects"),
    updateSubProject: mode === "api" ? (id, p) => send("PATCH", `/api/sub-projects/${id}`, p) : localPatch("subProjects"),
    deleteExpense: mode === "api" ? (id) => send("DELETE", `/api/expenses/${id}`) : localDelete("expenses"),
    closings,
    lockOf: (ownerId, date) => lockReason(closings, { id: currentUserId, role }, ownerId, date),
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
    addAbsence: async (a) => {
      if (mode === "api") {
        const res = await api<Absence>("/api/absences", { body: a });
        setData(await loadDataset());
        return res.status;
      }
      // Demo: same rules as the server.
      const lead = role !== "employee";
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
    setWorkSettings: async (w) => {
      if (mode === "api") {
        await api("/api/settings", { method: "PUT", body: w });
        setData(await loadDataset());
        return;
      }
      setData((d) => ({
        ...d,
        workModel: { weeklyHours: w.weeklyHours ?? d.workModel!.weeklyHours, holidays: w.holidays ?? d.workModel!.holidays },
        rates: { kmRate: w.kmRate ?? d.rates?.kmRate ?? 0.7, vatRate: w.vatRate ?? d.rates?.vatRate ?? 8.1 },
      }));
    },
    toast,
    notify: setToast,
  };
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("StoreProvider missing");
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
