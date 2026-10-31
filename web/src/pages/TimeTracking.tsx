import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_RATES, projectOpenOn, EXPENSE_CATEGORIES, VAT_RATES, WorkCalendar, addDays, dayPresence, fmt1, fmtCHF, fmtCHF2, fmtDay, isoWeekKey, parseReceipt, presenceIssues, rateOn, reasonSuggestions, type ReasonSuggestion, stampOptions, type PeriodKind, type StampAction } from "@taktwerk/domain";
import { recognizeReceipt } from "../ocr";
import type { Expense, ExpenseCategory, TimeEntry } from "@taktwerk/domain";
import { api, type EntryComment } from "../api";
import { loadLocal, saveLocal, useStore } from "../store";
import { Icon } from "../ui/components";
import { TYPE_CLASS, WorkTiles, signedH } from "./WorkTime";
import { Select } from "../ui/Select";
import { Field, FieldRow, FormDialog } from "../ui/Dialog";
import { intlLocale, tr, trn } from "../i18n";
import { useCalendarSuggestions } from "../calendar";
import { WeekGrid } from "./WeekGrid";

const CATEGORIES = EXPENSE_CATEGORIES as readonly ExpenseCategory[];

/** A booking target the person uses often: sub-project plus activity, as it appears in the week grid. */
export interface Favorite {
  subProjectId: string;
  reason: string;
  jiraIssueKey?: string;
}
const favKey = (userId: string) => `rt.fav.${userId}`;
const sameFav = (a: Favorite, b: Favorite) => a.subProjectId === b.subProjectId && a.reason === b.reason && (a.jiraIssueKey ?? "") === (b.jiraIssueKey ?? "");

export function useFavorites(userId: string) {
  const [favorites, setFavorites] = useState<Favorite[]>(() => loadLocal<Favorite[]>(favKey(userId), []));
  useEffect(() => setFavorites(loadLocal<Favorite[]>(favKey(userId), [])), [userId]);
  const toggle = (f: Favorite) => {
    const next = favorites.some((x) => sameFav(x, f)) ? favorites.filter((x) => !sameFav(x, f)) : [...favorites, f].slice(-12);
    setFavorites(next);
    saveLocal(favKey(userId), next);
  };
  return { favorites, isFavorite: (f: Favorite) => favorites.some((x) => sameFav(x, f)), toggle };
}

/** Distinct targets of the person's bookings in the last 30 days, most recent first. */
function useRecent(userId: string, exclude: Favorite[]) {
  const { data } = useStore();
  return useMemo(() => {
    const since = addDays(data.today, -30);
    const seen: Favorite[] = [];
    for (const e of [...data.timeEntries].filter((e) => !e.summary && e.employeeId === userId && e.date >= since).sort((a, b) => b.date.localeCompare(a.date))) {
      const f: Favorite = { subProjectId: e.subProjectId, reason: e.reason, jiraIssueKey: e.jiraIssueKey };
      if (!seen.some((x) => sameFav(x, f)) && !exclude.some((x) => sameFav(x, f))) seen.push(f);
      if (seen.length >= 6) break;
    }
    return seen;
  }, [data, userId, exclude]);
}

function mondayOf(date: string) {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, wd === 0 ? -6 : 1 - wd);
}
function isoWeek(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - start) / 86400000 + 1) / 7);
}
const WEEKDAYS = [tr("Mo"), tr("Di"), tr("Mi"), tr("Do"), tr("Fr"), tr("Sa"), tr("So")];

/** Cascading customer → project → sub-project selection, shared by time and expense forms. */
function useTarget() {
  const { data } = useStore();
  const [customerId, setCustomerId] = useState(data.customers[0]?.id ?? "");
  const projects = data.projects.filter((p) => p.customerId === customerId && projectOpenOn(p, data.today));
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const subs = data.subProjects.filter((s) => s.projectId === projectId);
  const [subProjectId, setSubProjectId] = useState(subs[0]?.id ?? "");

  useEffect(() => {
    if (!projects.some((p) => p.id === projectId)) setProjectId(projects[0]?.id ?? "");
  }, [customerId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!subs.some((s) => s.id === subProjectId)) setSubProjectId(subs[0]?.id ?? "");
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Jumps to a sub-project, setting customer and project with it. */
  const select = (subId: string) => {
    const sp = data.subProjects.find((x) => x.id === subId);
    const p = sp && data.projects.find((x) => x.id === sp.projectId);
    if (!sp || !p) return;
    setCustomerId(p.customerId);
    setProjectId(p.id);
    setSubProjectId(sp.id);
  };

  const fields = (prefix: string) => (
    <>
      <label className="field">
        <span>{tr("Kunde")}</span>
        <Select id={`${prefix}-customer`} value={customerId} onChange={setCustomerId} options={data.customers.map((c) => ({ value: c.id, label: c.name }))} />
      </label>
      <label className="field">
        <span>{tr("Projekt")}</span>
        <Select id={`${prefix}-project`} value={projectId} onChange={setProjectId} options={projects.map((p) => ({ value: p.id, label: p.name }))} placeholder={tr("Kein Projekt")} />
      </label>
      <label className="field">
        <span>{tr("Subprojekt")}</span>
        <Select id={`${prefix}-sub`} value={subProjectId} onChange={setSubProjectId} options={subs.map((s) => ({ value: s.id, label: s.name }))} placeholder={tr("Kein Subprojekt")} />
      </label>
    </>
  );
  return { customerId, subProjectId, select, fields };
}

/** Short «Kunde · Subprojekt» label for a sub-project id. */
export function useLabels() {
  const { data } = useStore();
  const sub = new Map(data.subProjects.map((s) => [s.id, s]));
  const proj = new Map(data.projects.map((p) => [p.id, p]));
  const cust = new Map(data.customers.map((c) => [c.id, c]));
  return {
    short: (subId: string) => {
      const s = sub.get(subId);
      const p = s && proj.get(s.projectId);
      return s && p ? `${cust.get(p.customerId)?.name} · ${s.name}` : "–";
    },
    long: (subId: string) => {
      const s = sub.get(subId);
      const p = s && proj.get(s.projectId);
      return s && p ? `${cust.get(p.customerId)?.name} · ${p.name} · ${s.name}` : "–";
    },
    customerOf: (subId: string) => {
      const s = sub.get(subId);
      const p = s && proj.get(s.projectId);
      return p ? cust.get(p.customerId) : undefined;
    },
  };
}

/** One search field over favourites and recent bookings; a pick fills customer, project, sub-project and activity. */
function QuickPicks({ userId, onPick, fav }: { userId: string; onPick: (f: Favorite) => void; fav: ReturnType<typeof useFavorites> }) {
  const labels = useLabels();
  const recent = useRecent(userId, fav.favorites);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: PointerEvent) => {
      if (!wrapRef.current?.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [open]);
  if (fav.favorites.length === 0 && recent.length === 0) return null;
  const needle = q.trim().toLowerCase();
  const match = (f: Favorite) => !needle || `${f.reason} ${labels.long(f.subProjectId)} ${f.jiraIssueKey ?? ""}`.toLowerCase().includes(needle);
  const rows = [...fav.favorites.filter(match).map((f) => ({ f, star: true })), ...recent.filter(match).map((f) => ({ f, star: false }))].slice(0, 8);
  const choose = (f: Favorite) => {
    onPick(f);
    setQ("");
    setOpen(false);
  };
  const onKey = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setOpen(true);
      setCursor((c) => Math.min(rows.length - 1, c + 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (ev.key === "Enter" && open && rows[cursor]) {
      ev.preventDefault();
      choose(rows[cursor].f);
    } else if (ev.key === "Escape" && open) {
      ev.stopPropagation();
      setOpen(false);
    }
  };
  return (
    <div className="pick" ref={wrapRef}>
      <span className="pick-icon"><Icon.search /></span>
      <input
        id="pick-search"
        className="input pick-input"
        placeholder={tr("Schnellwahl: Favoriten und letzte Buchungen durchsuchen …")}
        value={q}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls="pick-list"
        onChange={(ev) => {
          setQ(ev.target.value);
          setOpen(true);
          setCursor(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
      />
      {open && (
        <div className="pick-list" id="pick-list" role="listbox">
          {rows.length === 0 && <div className="pick-empty">{tr("Keine Treffer")}</div>}
          {rows.map((r, i) => (
            <div
              key={`${r.f.subProjectId}|${r.f.reason}|${r.f.jiraIssueKey ?? ""}`}
              role="option"
              aria-selected={i === cursor}
              className={`pick-row ${i === cursor ? "on" : ""}`}
              onMouseEnter={() => setCursor(i)}
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => choose(r.f)}
            >
              <button
                type="button"
                className={`star ${r.star ? "on" : ""}`}
                aria-label={r.star ? tr("Favorit entfernen") : tr("Als Favorit merken")}
                title={r.star ? tr("Favorit entfernen") : tr("Als Favorit merken")}
                onClick={(ev) => {
                  ev.stopPropagation();
                  fav.toggle(r.f);
                }}
              >★</button>
              <span className="pick-main">{r.f.reason}</span>
              <span className="pick-sub">{labels.short(r.f.subProjectId)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function fmtClock(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function TimeForm() {
  const { data, addTimeEntry, currentUserId, notify } = useStore();
  const target = useTarget();
  const fav = useFavorites(currentUserId);
  const [mode, setMode] = useState<"timer" | "manual">("manual");
  const [date, setDate] = useState(data.today);
  const [hours, setHours] = useState("2");
  const [reason, setReason] = useState("");
  const [issueKey, setIssueKey] = useState("");
  const [billable, setBillable] = useState(true);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState("");

  useEffect(() => {
    if (startedAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  const openIssues = data.issues.filter((i) => i.subProjectId === target.subProjectId && i.status !== "Done");
  const customer = data.customers.find((c) => c.id === target.customerId);
  const rate = customer ? rateOn(customer, date) : 0;
  // Internal work (customer without rate) is not billable by default.
  useEffect(() => setBillable(rate > 0), [target.customerId]); // eslint-disable-line react-hooks/exhaustive-deps
  const elapsed = startedAt ? Math.floor((now - startedAt) / 1000) : 0;
  const pick = (f: Favorite) => {
    target.select(f.subProjectId);
    setIssueKey(f.jiraIssueKey ?? "");
    setReason(f.jiraIssueKey && f.reason.startsWith(`${f.jiraIssueKey} `) ? f.reason.slice(f.jiraIssueKey.length + 1) : f.reason);
  };
  const current: Favorite | null = reason.trim() && target.subProjectId
    ? { subProjectId: target.subProjectId, reason: issueKey ? `${issueKey} ${reason.trim()}` : reason.trim(), jiraIssueKey: issueKey || undefined }
    : null;

  const save = async (h: number) => {
    if (!reason.trim()) return setError(tr("Bitte einen Grund angeben, er erscheint im Kundenreport."));
    if (!target.subProjectId) return setError(tr("Bitte ein Subprojekt wählen."));
    if (!(h > 0 && h <= 24)) return setError(tr("Dauer muss zwischen 0 und 24 Stunden liegen."));
    const issue = data.issues.find((i) => i.key === issueKey);
    try {
      await addTimeEntry({
      employeeId: currentUserId,
      subProjectId: target.subProjectId,
      date,
      hours: Math.round(h * 100) / 100,
      reason: issue ? `${issue.key} ${reason.trim()}` : reason.trim(),
      billable,
      hourlyRate: rate,
      jiraIssueKey: issueKey || undefined,
      });
    } catch (e) {
      return setError((e as Error).message);
    }
    setError("");
    setReason("");
    notify(tr("{0} h gebucht", fmt1(h)));
  };

  return (
    <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="tree-row">
        <h2>{tr("Zeit erfassen")}</h2>
        <div className="seg" role="tablist">
          <button className={mode === "manual" ? "on" : ""} onClick={() => setMode("manual")}>{tr("Manuell")}</button>
          <button className={mode === "timer" ? "on" : ""} onClick={() => setMode("timer")}>{tr("Stoppuhr")}</button>
        </div>
      </div>
      <QuickPicks userId={currentUserId} onPick={pick} fav={fav} />
      <div className="form-grid">
        {target.fields("t")}
        <label className="field">
          <span>{tr("JIRA-Issue (optional)")}</span>
          <Select id="t-issue" value={issueKey} onChange={setIssueKey} options={[{ value: "", label: tr("Ohne Issue (z. B. Meeting)") }, ...openIssues.map((i) => ({ value: i.key, label: `${i.key} · ${i.summary} · ${i.storyPoints} SP` }))]} />
        </label>
      </div>
      <label className="field">
        <span className="tree-row" style={{ display: "flex" }}>
          {tr("Grund / Tätigkeit")}
          <button type="button" id="t-fav" className={`star ${current && fav.isFavorite(current) ? "on" : ""}`} disabled={!current} title={tr("Diese Kombination als Favorit merken")} onClick={() => current && fav.toggle(current)}>
            ★ <span style={{ fontSize: "0.75rem" }}>{current && fav.isFavorite(current) ? tr("Favorit") : tr("Als Favorit merken")}</span>
          </button>
        </span>
        <textarea id="t-reason" className="input" placeholder={tr("z. B. Abnahme-Workshop mit Fachbereich vorbereitet")} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <ReasonHints id="t-hints" subProjectId={target.subProjectId} date={date} typed={reason} onPick={(x) => { setReason(x.text); if (x.issueKey && openIssues.some((i) => i.key === x.issueKey)) setIssueKey(x.issueKey); }} />
      {mode === "manual" ? (
        <div className="form-grid" style={{ alignItems: "end" }}>
          <label className="field"><span>{tr("Datum")}</span><input id="t-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="field"><span>{tr("Dauer (h)")}</span><input id="t-hours" type="number" step="0.25" min="0" className="input num" value={hours} onChange={(e) => setHours(e.target.value)} /></label>
          <label className="check"><input id="t-billable" type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} />{tr("Verrechenbar · {0}/h", fmtCHF(rate))}</label>
          <button className="btn primary" onClick={() => save(Number(hours))}>{tr("Buchen")}</button>
        </div>
      ) : (
        <div className="timer">
          <div>
            <div className={`timer-clock ${startedAt ? "running" : ""}`}>{fmtClock(elapsed)}</div>
            <label className="check"><input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} />{tr("Verrechenbar · {0}/h", fmtCHF(rate))}</label>
          </div>
          {startedAt ? (
            <button className="btn primary" onClick={() => { save(Math.max(0.25, Math.ceil(elapsed / 900) / 4)); setStartedAt(null); }}>{tr("Stoppen & buchen")}</button>
          ) : (
            <button className="btn primary" onClick={() => { setStartedAt(Date.now()); setNow(Date.now()); }}>{tr("Start")}</button>
          )}
        </div>
      )}
      {mode === "timer" && <p className="muted" style={{ fontSize: "0.8rem" }}>{tr("Die Stoppuhr rundet auf die nächste Viertelstunde auf.")}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function ExpenseForm({ compact = false, initialDate, onDone }: { compact?: boolean; initialDate?: string; onDone?: () => void } = {}) {
  const { data, addExpenseWithReceipt, currentUserId, notify, mode, scope } = useStore();
  const target = useTarget();
  const kmRate = data.rates?.kmRate ?? DEFAULT_RATES.kmRate;
  const [date, setDate] = useState(initialDate ?? data.today);
  const [amount, setAmount] = useState("");
  const [km, setKm] = useState("");
  const [category, setCategory] = useState<ExpenseCategory>("Reise");
  const [vatRate, setVatRate] = useState(data.rates?.vatRate ?? DEFAULT_RATES.vatRate);
  const [reason, setReason] = useState("");
  const [billable, setBillable] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const scanInput = useRef<HTMLInputElement>(null);
  const [scan, setScan] = useState<{ progress: number; step: string } | null>(null);
  const [scanned, setScanned] = useState<string[]>([]);
  const phone = usePhone();
  const isKm = category === "Kilometer";
  const kmAmount = Math.round(Number(km) * kmRate * 20) / 20;

  /** Reads a receipt photo and fills amount, date, VAT, category and reason; every value stays editable. */
  const readReceipt = async (f: File) => {
    setScan({ progress: 0, step: tr("Texterkennung laden") });
    setScanned([]);
    try {
      const { text } = await recognizeReceipt(f, (progress, step) => setScan({ progress, step }));
      const g = parseReceipt(text, data.today);
      const found: string[] = [];
      if (g.amount !== undefined) { setAmount(g.amount.toFixed(2)); found.push(tr("Betrag {0}", fmtCHF2(g.amount))); }
      if (g.date) { setDate(g.date); found.push(tr("Datum {0}", g.date.split("-").reverse().join("."))); }
      if (g.vatRate !== undefined) { setVatRate(g.vatRate); found.push(tr("MwSt {0} %", fmt1(g.vatRate))); }
      if (g.category) { setCategory(g.category); found.push(g.category); }
      if (g.merchant && !reason.trim()) { setReason(g.merchant); found.push(`«${g.merchant}»`); }
      setScanned(found.length ? found : [tr("Nichts Brauchbares erkannt, bitte von Hand ausfüllen.")]);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScan(null);
    }
  };
  const onScanFile = (f: File | null) => {
    if (!f) return;
    setFile(f);
    if (fileInput.current) fileInput.current.value = "";
    void readReceipt(f);
  };

  const save = async () => {
    const a = isKm ? kmAmount : Number(amount);
    if (isKm && !(Number(km) > 0)) return setError(tr("Bitte die gefahrenen Kilometer eingeben."));
    if (!(a > 0)) return setError(tr("Bitte einen Betrag grösser als 0 eingeben."));
    if (!reason.trim()) return setError(tr("Bitte einen Grund angeben."));
    try {
      await addExpenseWithReceipt(
        { employeeId: currentUserId, subProjectId: target.subProjectId, date, amount: a, category, reason: reason.trim(), billable, vatRate: isKm ? 0 : vatRate, km: isKm ? Number(km) : undefined },
        file,
      );
    } catch (e) {
      return setError((e as Error).message);
    }
    setError("");
    setAmount("");
    setKm("");
    setReason("");
    setFile(null);
    if (fileInput.current) fileInput.current.value = "";
    notify(!scope.lead ? tr("Spesen über {0} eingereicht", fmtCHF2(a)) : tr("Spesen über {0} erfasst", fmtCHF2(a)));
    onDone?.();
  };

  return (
    <section className={compact ? "" : "card card-pad"} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {!compact && <h2>{tr("Spesen erfassen")}</h2>}
      <div className="form-grid">
        {target.fields("x")}
        <label className="field">
          <span>{tr("Kategorie")}</span>
          <Select id="x-cat" value={category} onChange={(v) => setCategory(v as ExpenseCategory)} options={CATEGORIES.map((c) => ({ value: c, label: tr(c) }))} />
        </label>
        <label className="field"><span>{tr("Datum")}</span><input id="x-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        {isKm ? (
          <>
            <label className="field"><span>{tr("Kilometer")}</span><input id="x-km" type="number" step="1" min="0" className="input num" placeholder="0" value={km} onChange={(e) => setKm(e.target.value)} /></label>
            <label className="field"><span>{tr("Betrag (CHF)")}</span><input className="input num" value={km ? fmtCHF2(kmAmount) : "–"} readOnly title={tr("{0} pro Kilometer", fmtCHF2(kmRate))} /></label>
          </>
        ) : (
          <>
            <label className="field"><span>{tr("Betrag brutto (CHF)")}</span><input id="x-amount" type="number" step="0.05" min="0" className="input num" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            <label className="field">
              <span>{tr("MwSt enthalten")}</span>
              <Select id="x-vat" value={String(vatRate)} onChange={(v) => setVatRate(Number(v))} options={VAT_RATES.map((v) => ({ value: String(v), label: v === 0 ? tr("keine") : `${fmt1(v)} %` }))} />
            </label>
          </>
        )}
      </div>
      <label className="field">
        <span>{tr("Grund")}</span>
        <input id="x-reason" className="input" placeholder={isKm ? tr("z. B. Fahrt zum Workshop beim Kunden") : tr("z. B. SBB Basel–Zürich für Sprint Review")} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="export-bar">
        <label className="field" style={{ flex: "1 1 240px" }}>
          <span>{tr("Beleg (Foto oder PDF, max. 10 MB)")}</span>
          <input id="x-file" ref={fileInput} type="file" className="input" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <input id="x-scan-file" ref={scanInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onScanFile(e.target.files?.[0] ?? null)} />
        <button id="x-scan" type="button" className="btn" disabled={Boolean(scan)} title={tr("Foto des Belegs auslesen und Betrag, Datum und MwSt vorschlagen")} onClick={() => (file && file.type.startsWith("image/") ? void readReceipt(file) : scanInput.current?.click())}>
          <Icon.camera />{scan ? scan.step : file && file.type.startsWith("image/") ? tr("Beleg auslesen") : phone ? tr("Beleg fotografieren") : tr("Beleg scannen")}
        </button>
        <label className="check"><input id="x-billable" type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} />{tr("An Kunden weiterverrechnen")}</label>
        <button className="btn primary" onClick={save}>{!scope.lead ? tr("Spesen einreichen") : tr("Spesen speichern")}</button>
      </div>
      {scan && <div className="scan-bar" role="progressbar" aria-valuenow={Math.round(scan.progress * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${Math.round(scan.progress * 100)}%` }} /></div>}
      {scanned.length > 0 && <p id="x-scanned" className="notice" style={{ margin: 0 }}>{tr("Aus dem Beleg gelesen: {0}. Bitte kurz prüfen.", scanned.join(" · "))}</p>}
      <p className="muted" style={{ fontSize: "0.8rem", margin: 0 }}>
        {isKm ? tr("Kilometerpauschale {0} pro km, ohne MwSt. ", fmtCHF2(kmRate)) : ""}
        {!scope.lead ? tr("Spesen werden von Consultants oder Admins bewilligt, bevor sie in Report und Rechnung erscheinen.") : tr("Als Consultant oder Admin erfasste Spesen gelten als bewilligt.")}
        {mode === "demo" && file ? tr(" Im Prototyp bleibt der Beleg nur im Browser.") : ""}
      </p>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function WeekList() {
  const { data, currentUserId, role } = useStore();
  const sub = new Map(data.subProjects.map((s) => [s.id, s]));
  const proj = new Map(data.projects.map((p) => [p.id, p]));
  const cust = new Map(data.customers.map((c) => [c.id, c]));
  const mine = role !== "admin";
  const days = useMemo(() => {
    const from = new Date(`${data.today}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - (mine ? 13 : 6));
    const since = from.toISOString().slice(0, 10);
    const entries = data.timeEntries.filter((e) => !e.summary && e.date >= since && (!mine || e.employeeId === currentUserId));
    const expenses = data.expenses.filter((e) => e.date >= since && (!mine || e.employeeId === currentUserId));
    const byDay = new Map<string, { time: typeof entries; exp: typeof expenses }>();
    for (const e of entries) {
      const d = byDay.get(e.date) ?? { time: [], exp: [] };
      d.time.push(e);
      byDay.set(e.date, d);
    }
    for (const e of expenses) {
      const d = byDay.get(e.date) ?? { time: [], exp: [] };
      d.exp.push(e);
      byDay.set(e.date, d);
    }
    return [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [data, currentUserId, mine]);
  const label = (subId: string) => {
    const s = sub.get(subId)!;
    const p = proj.get(s.projectId)!;
    return `${cust.get(p.customerId)?.name} · ${p.name} · ${s.name}`;
  };
  const emp = new Map(data.employees.map((e) => [e.id, e]));

  return (
    <section className="card" style={{ maxHeight: "calc(100vh - 140px)", overflow: "auto" }}>
      <div className="card-head" style={{ paddingBottom: 12 }}>
        <h2>{mine ? tr("Meine Buchungen · letzte 14 Tage") : tr("Alle Buchungen · letzte 7 Tage")}</h2>
      </div>
      {days.length === 0 && <p className="card-pad muted">{tr("Noch keine Buchungen in diesem Zeitraum.")}</p>}
      {days.map(([day, { time, exp }]) => (
        <div className="day-group" key={day}>
          <div className="day-head"><span>{fmtDay(day)}</span><span className="num">{fmt1(time.reduce((s, e) => s + e.hours, 0))}{" "}{tr("h")}</span></div>
          {time.map((e) => (
            <EntryRow key={e.id} kind="time" item={e} who={emp.get(e.employeeId)} title={e.reason} meta={`${label(e.subProjectId)}${e.billable ? "" : tr(" · nicht verrechenbar")}`} value={`${fmt1(e.hours)} h`} />
          ))}
          {exp.map((x) => (
            <EntryRow
              key={x.id}
              kind="expense"
              item={x}
              who={mine ? undefined : emp.get(x.employeeId)}
              title={`${tr(x.category)}: ${x.reason}`}
              meta={`${label(x.subProjectId)}${x.km ? ` · ${x.km} km` : ""}${x.vatRate ? tr(" · inkl. {0} % MwSt", fmt1(x.vatRate)) : ""}${x.billable ? "" : tr(" · nicht verrechenbar")}`}
              value={fmtCHF2(x.amount)}
            />
          ))}
        </div>
      ))}
    </section>
  );
}

interface AuditRow {
  id: string;
  action: string;
  actorName: string | null;
  createdAt: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

const FIELD_LABEL: Record<string, string> = { date: tr("Datum"), hours: tr("Stunden"), reason: tr("Grund"), billable: tr("Verrechenbar"), amount: tr("Betrag"), category: tr("Kategorie"), subProjectId: tr("Subprojekt"), hourlyRate: tr("Satz"), jiraIssueKey: "JIRA-Issue", vatRate: "MwSt", km: tr("Kilometer"), receipt: tr("Beleg"), status: "Status", comment: tr("Begründung") };
const ACTION_LABEL: Record<string, string> = { create: tr("erfasst"), update: tr("geändert"), delete: tr("gelöscht"), submit: tr("eingereicht"), approve: tr("bewilligt"), reject: tr("abgelehnt"), reopen: tr("wieder geöffnet") };
const EXPENSE_STATUS = { requested: { label: tr("Offen"), cls: "risk" }, approved: { label: tr("Bewilligt"), cls: "ok" }, rejected: { label: tr("Abgelehnt"), cls: "over" } } as const;
const show = (v: unknown) => (typeof v === "boolean" ? (v ? "ja" : "nein") : v === null || v === undefined || v === "" ? "–" : String(v));

function History({ id }: { id: string }) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<AuditRow[]>(`/api/audit/${id}`).then(setRows).catch((e) => setError((e as Error).message));
  }, [id]);
  if (error) return <p className="error">{error}</p>;
  if (!rows) return <p className="muted">{tr("Lade Verlauf …")}</p>;
  if (rows.length === 0) return <p className="muted">{tr("Kein Verlauf vorhanden (vor der Einführung des Änderungsprotokolls erfasst).")}</p>;
  return (
    <ul className="history">
      {rows.map((r) => {
        const changes = r.action === "update" && r.before && r.after
          ? Object.keys(FIELD_LABEL).filter((k) => show(r.before![k]) !== show(r.after![k])).map((k) => `${FIELD_LABEL[k]}: ${show(r.before![k])} → ${show(r.after![k])}`)
          : [];
        return (
          <li key={r.id}>
            <span className="muted">{new Date(r.createdAt).toLocaleString(intlLocale, { dateStyle: "short", timeStyle: "short" })}</span> {tr("{0} durch {1}", ACTION_LABEL[r.action] ?? r.action, r.actorName ?? tr("unbekannt"))}
            {changes.length > 0 && <div className="muted">{changes.join(" · ")}</div>}
            {r.action === "reject" && r.after?.comment ? <div className="muted">{tr("Begründung:")}{" "}{String(r.after.comment)}</div> : null}
          </li>
        );
      })}
    </ul>
  );
}

type EntryProps =
  | { kind: "time"; item: TimeEntry; who?: { name: string; initials: string }; title: string; meta: string; value: string }
  | { kind: "expense"; item: Expense; who?: { name: string; initials: string }; title: string; meta: string; value: string };

/** One booking in the list, with inline edit, delete and change history. */
function EntryRow(props: EntryProps) {
  const { lockOf, updateTimeEntry, deleteTimeEntry, updateExpense, deleteExpense, uploadReceipt, deleteReceipt, resubmitExpense, notify, mode, currentUserId, scope } = useStore();
  const { item, kind } = props;
  const expense = kind === "expense" ? props.item : null;
  const status = expense ? expense.status ?? "approved" : null;
  const [vatRate, setVatRate] = useState(expense?.vatRate ?? DEFAULT_RATES.vatRate);
  const [state, setState] = useState<"view" | "edit" | "confirm">("view");
  const [date, setDate] = useState(item.date);
  const [amount, setAmount] = useState(String(kind === "time" ? props.item.hours : props.item.category === "Kilometer" ? props.item.km ?? 0 : props.item.amount));
  const [reason, setReason] = useState(item.reason);
  const [billable, setBillable] = useState(item.billable);
  const [history, setHistory] = useState(false);
  const [error, setError] = useState("");
  const lock = lockOf(item.employeeId, item.date);

  const run = async (fn: () => Promise<void>, msg: string) => {
    try {
      await fn();
      setError("");
      setState("view");
      setHistory(false);
      notify(msg);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const save = async (): Promise<Record<string, string> | void> => {
    const n = Number(amount.replace(",", "."));
    const e: Record<string, string> = {};
    if (!date) e.date = tr("Bitte ein Datum wählen.");
    if (!reason.trim()) e.reason = tr("Bitte einen Grund angeben.");
    if (kind === "time" && !(n > 0 && n <= 24)) e.amount = tr("Zwischen 0 und 24 Stunden.");
    if (kind === "expense" && !(n > 0)) e.amount = tr("Bitte einen Betrag grösser als 0 eingeben.");
    if (Object.keys(e).length) return e;
    const base = { date, reason: reason.trim(), billable };
    if (kind === "time") await updateTimeEntry(item.id, { ...base, hours: Math.round(n * 100) / 100 });
    else await updateExpense(item.id, expense?.category === "Kilometer" ? { ...base, km: n } : { ...base, amount: n, vatRate });
    setError("");
    setState("view");
    setHistory(false);
    notify(tr("Änderung gespeichert"));
  };
  const remove = () => run(() => (kind === "time" ? deleteTimeEntry(item.id) : deleteExpense(item.id)), kind === "time" ? tr("Buchung gelöscht") : tr("Spese gelöscht"));

  return (
    <div className={`entry-wrap ${state === "edit" ? "editing-entry" : ""}`}>
      <div className="entry">
        {kind === "time" || props.who ? (
          <span className="who" title={props.who?.name} style={kind === "expense" ? { background: "var(--surface-2)", color: "var(--ink-2)" } : undefined}>{props.who?.initials}</span>
        ) : (
          <span className="who" style={{ background: "var(--surface-2)", color: "var(--ink-2)" }} title={tr("Spesen")}>{tr("CHF")}</span>
        )}
        <div className="what">
          <div className="tree-row" style={{ justifyContent: "flex-start", gap: 8 }}>
            <span>{props.title}</span>
            {expense && status !== "approved" && <span className={`pill ${EXPENSE_STATUS[status!].cls}`}>{EXPENSE_STATUS[status!].label}</span>}
            {expense?.receipt && (mode === "api"
              ? <a className="receipt-link" href={`/api/expenses/${expense.id}/receipt`} target="_blank" rel="noreferrer" title={expense.receipt.name}><Icon.report />{tr("Beleg")}</a>
              : <span className="receipt-link" title={expense.receipt.name}><Icon.report />{tr("Beleg")}</span>)}
          </div>
          <div className="meta">{props.meta}</div>
        </div>
        <strong className="num">{props.value}</strong>
        <div className="entry-actions">
          {lock ? (
            <span className="lock" title={lock} aria-label={lock}><Icon.lock /></span>
          ) : state === "confirm" ? (
            <>
              <button className="btn small primary" onClick={remove}>{tr("Löschen")}</button>
              <button className="btn small ghost" onClick={() => setState("view")}>{tr("Nein")}</button>
            </>
          ) : (
            <>
              <button className="icon-btn" title={tr("Bearbeiten")} aria-label={tr("Bearbeiten")} onClick={() => setState("edit")}><Icon.edit /></button>
              <button className="icon-btn" title={tr("Löschen")} aria-label={tr("Löschen")} onClick={() => setState("confirm")}><Icon.trash /></button>
            </>
          )}
        </div>
      </div>
      {state === "edit" && (
        <FormDialog
          id="entry-edit-dialog"
          title={kind === "time" ? tr("Buchung bearbeiten") : tr("Spese bearbeiten")}
          subtitle={props.title}
          onClose={() => { setState("view"); setHistory(false); setError(""); }}
          onSubmit={save}
          danger={mode === "api" ? <button type="button" className="btn ghost" onClick={() => setHistory(!history)}>{history ? tr("Verlauf ausblenden") : tr("Verlauf")}</button> : undefined}
        >
          <FieldRow>
            <Field label={tr("Datum")} name="date" required><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label={kind === "time" ? tr("Dauer (h)") : expense?.category === "Kilometer" ? tr("Kilometer") : tr("Betrag brutto (CHF)")} name="amount" required hint={kind === "time" ? tr("z. B. 1.5 für 1 h 30 min") : undefined}>
              <input inputMode="decimal" className="input num" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            {expense && expense.category !== "Kilometer" && (
              <Field label={tr("MwSt enthalten")}>
                <Select value={String(vatRate)} onChange={(v) => setVatRate(Number(v))} options={VAT_RATES.map((v) => ({ value: String(v), label: v === 0 ? tr("keine") : `${fmt1(v)} %` }))} />
              </Field>
            )}
          </FieldRow>
          <Field label={tr("Grund")} name="reason" required hint={tr("Erscheint im Report und auf der Rechnung.")}><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <label className="check-field">
            <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} />
            <span><strong>{tr("Verrechenbar")}</strong><br /><span className="muted">{tr("Nicht verrechenbare Einträge zählen zum Aufwand, aber nicht auf die Rechnung.")}</span></span>
          </label>
          {expense && (
            <Field label={expense.receipt ? tr("Beleg ({0})", expense.receipt.name) : tr("Beleg")} hint={tr("Bild oder PDF. Wird sofort gespeichert.")}>
              <input type="file" className="input" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadReceipt(expense.id, f).then(() => notify(tr("Beleg gespeichert"))).catch((err: Error) => setError(err.message));
              }} />
            </Field>
          )}
          {(expense?.receipt || (expense && status === "rejected" && (expense.employeeId === currentUserId || scope.lead))) && (
            <div className="toolbar" style={{ gap: 8 }}>
              {expense?.receipt && <button type="button" className="btn small ghost" onClick={() => run(() => deleteReceipt(expense.id), tr("Beleg entfernt"))}>{tr("Beleg entfernen")}</button>}
              {expense && status === "rejected" && (expense.employeeId === currentUserId || scope.lead) && (
                <button type="button" className="btn small" onClick={() => run(() => resubmitExpense(expense.id), tr("Spese erneut eingereicht"))}>{tr("Erneut einreichen")}</button>
              )}
            </div>
          )}
          {error && <p className="error">{error}</p>}
          {history && <History id={item.id} />}
        </FormDialog>
      )}
      {error && state !== "edit" && <p className="error" style={{ padding: "0 16px 10px" }}>{error}</p>}
    </div>
  );
}

// ---------- week calendar ----------

const DAY_START = 6 * 60;
const DAY_END = 20 * 60;
const PX_PER_MIN = 0.8; // 48 px per hour
const SNAP = 15;
/** Distinct, calm colours for customers; internal work (no hourly rate) stays grey. */
const PALETTE = ["#2a78d6", "#1baf7a", "#8b5cf6", "#eda100", "#e05d8a", "#0ea5b7", "#eb6834", "#5b7a99"];
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const toClock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const snap = (min: number) => Math.round(min / SNAP) * SNAP;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Placed {
  entry: TimeEntry;
  start: number;
  end: number;
  col: number;
  cols: number;
}

/** Side-by-side layout for overlapping blocks of one day. */
function layoutDay(entries: TimeEntry[]): Placed[] {
  const timed = entries
    .filter((e) => e.startTime)
    .map((e) => ({ entry: e, start: toMin(e.startTime!), end: toMin(e.startTime!) + Math.max(SNAP, Math.round(e.hours * 60)), col: 0, cols: 1 }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let cluster: Placed[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((p) => p.col + 1));
    for (const p of cluster) p.cols = cols;
    cluster = [];
  };
  for (const p of timed) {
    if (p.start >= clusterEnd) flush();
    const taken = new Set(cluster.filter((c) => c.end > p.start).map((c) => c.col));
    let col = 0;
    while (taken.has(col)) col++;
    p.col = col;
    cluster.push(p);
    clusterEnd = Math.max(clusterEnd, p.end);
  }
  flush();
  return timed;
}

/** Thread of comments under a booking; leads can ask a question that stays open until the owner answers. */
function Comments({ entry }: { entry: TimeEntry }) {
  const { comments, addComment, currentUserId, scope, notify } = useStore();
  const [rows, setRows] = useState<EntryComment[] | null>(null);
  const [text, setText] = useState("");
  const [question, setQuestion] = useState(false);
  const [error, setError] = useState("");
  const owner = entry.employeeId === currentUserId;
  const canAsk = !owner && scope.managesPeople;
  const load = () => comments(entry.id).then(setRows).catch((e) => setError((e as Error).message));
  useEffect(() => { void load(); }, [entry.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = rows?.some((c) => c.kind === "question" && !c.resolvedAt) ?? false;
  const submit = async () => {
    if (!text.trim()) return;
    try {
      await addComment(entry.id, text.trim(), question);
      setText("");
      setQuestion(false);
      notify(question && canAsk ? tr("Rückfrage gestellt, die Person wird benachrichtigt") : owner && open ? tr("Antwort gespeichert, Rückfrage erledigt") : tr("Kommentar gespeichert"));
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="comments">
      <div className="tree-row"><span className="label">{tr("Kommentare")}</span>{open && <span className="pill risk">{tr("Rückfrage offen")}</span>}</div>
      {rows === null && !error && <p className="muted" style={{ fontSize: "0.82rem" }}>{tr("Lade …")}</p>}
      {rows && rows.length === 0 && <p className="muted" style={{ fontSize: "0.82rem" }}>{tr("Noch keine Kommentare.")}</p>}
      {rows && rows.length > 0 && (
        <ul className="comment-list">
          {rows.map((c) => (
            <li key={c.id} className={`comment ${c.kind} ${c.authorId === currentUserId ? "mine" : ""}`}>
              <div className="comment-head"><strong>{c.authorName ?? tr("Unbekannt")}</strong>{c.kind === "question" && <span className={`pill ${c.resolvedAt ? "ok" : "risk"}`}>{c.resolvedAt ? tr("Beantwortet") : tr("Rückfrage")}</span>}<span className="muted">{new Date(c.createdAt).toLocaleString(intlLocale, { dateStyle: "short", timeStyle: "short" })}</span></div>
              <div>{c.text}</div>
            </li>
          ))}
        </ul>
      )}
      <div className="comment-form">
        <input id="c-text" className="input" placeholder={owner && open ? tr("Antwort schreiben …") : canAsk ? tr("Kommentar oder Rückfrage …") : tr("Kommentar …")} value={text} onChange={(ev) => setText(ev.target.value)} onKeyDown={(ev) => ev.key === "Enter" && void submit()} />
        {canAsk && <label className="check" title={tr("Die Person bekommt eine Mail und sieht die Rückfrage, bis sie antwortet.")}><input id="c-question" type="checkbox" checked={question} onChange={(ev) => setQuestion(ev.target.checked)} />{tr("Als Rückfrage")}</label>}
        <button id="c-send" className="btn small" disabled={!text.trim()} onClick={() => void submit()}>{tr("Senden")}</button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

interface DialogState {
  entry?: TimeEntry;
  date: string;
  startTime?: string;
  hours: number;
  /** Prefill for a new booking, e.g. from a calendar suggestion. */
  reason?: string;
  subProjectId?: string;
}

/** Popup to create or change one booking (or to record an expense for that day). */
function EntryDialog({ state, onClose }: { state: DialogState; onClose: () => void }) {
  const { data, currentUserId, addTimeEntry, updateTimeEntry, deleteTimeEntry, notify, lockOf, mode } = useStore();
  const target = useTarget();
  const fav = useFavorites(currentUserId);
  const e = state.entry;
  const [kind, setKind] = useState<"time" | "expense">("time");
  const [date, setDate] = useState(state.date);
  const [startTime, setStartTime] = useState(e?.startTime ?? state.startTime ?? "");
  const [hours, setHours] = useState(String(e?.hours ?? state.hours));
  const [reason, setReason] = useState(state.reason ?? "");
  const [issueKey, setIssueKey] = useState(e?.jiraIssueKey ?? "");
  const [billable, setBillable] = useState(e?.billable ?? true);
  const [confirm, setConfirm] = useState(false);
  const [history, setHistory] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = lockOf(e?.employeeId ?? currentUserId, date);

  // Prefill from the existing entry once the target picker is mounted.
  useEffect(() => {
    if (!e && state.subProjectId) target.select(state.subProjectId);
    if (!e) return;
    target.select(e.subProjectId);
    setReason(e.jiraIssueKey && e.reason.startsWith(`${e.jiraIssueKey} `) ? e.reason.slice(e.jiraIssueKey.length + 1) : e.reason);
  }, [e?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => ev.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const customer = data.customers.find((c) => c.id === target.customerId);
  const rate = customer ? rateOn(customer, date) : 0;
  useEffect(() => {
    if (!e) setBillable(rate > 0);
  }, [target.customerId]); // eslint-disable-line react-hooks/exhaustive-deps
  const openIssues = data.issues.filter((i) => i.subProjectId === target.subProjectId && i.status !== "Done");
  const pick = (f: Favorite) => {
    target.select(f.subProjectId);
    setIssueKey(f.jiraIssueKey ?? "");
    setReason(f.jiraIssueKey && f.reason.startsWith(`${f.jiraIssueKey} `) ? f.reason.slice(f.jiraIssueKey.length + 1) : f.reason);
  };
  const current: Favorite | null = reason.trim() && target.subProjectId
    ? { subProjectId: target.subProjectId, reason: issueKey ? `${issueKey} ${reason.trim()}` : reason.trim(), jiraIssueKey: issueKey || undefined }
    : null;
  const h = Number(String(hours).replace(",", "."));
  const endTime = startTime && h > 0 ? toClock(Math.min(24 * 60 - 1, toMin(startTime) + Math.round(h * 60))) : "";

  const run = async (fn: () => Promise<void>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      notify(msg);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    if (!reason.trim()) return setError(tr("Bitte einen Grund angeben, er erscheint im Kundenreport."));
    if (!target.subProjectId) return setError(tr("Bitte ein Subprojekt wählen."));
    if (!(h > 0 && h <= 24)) return setError(tr("Dauer muss zwischen 0 und 24 Stunden liegen."));
    const issue = data.issues.find((i) => i.key === issueKey);
    const text = issue ? `${issue.key} ${reason.trim()}` : reason.trim();
    const body = { subProjectId: target.subProjectId, date, hours: Math.round(h * 100) / 100, reason: text, billable, jiraIssueKey: issueKey || undefined, startTime: startTime || undefined };
    return run(
      () => (e ? updateTimeEntry(e.id, { ...body, jiraIssueKey: issueKey || null } as Partial<TimeEntry>) : addTimeEntry({ employeeId: currentUserId, hourlyRate: rate, ...body })),
      e ? tr("Buchung gespeichert") : tr("{0} h gebucht", fmt1(h)),
    );
  };

  return (
    <div className="overlay" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={e ? tr("Buchung bearbeiten") : tr("Neue Buchung")}>
        <div className="dialog-head">
          {e ? <h2>{tr("Buchung bearbeiten")}</h2> : (
            <div className="seg" role="tablist">
              <button className={kind === "time" ? "on" : ""} onClick={() => setKind("time")}>{tr("Zeit")}</button>
              <button className={kind === "expense" ? "on" : ""} onClick={() => setKind("expense")}>{tr("Spese")}</button>
            </div>
          )}
          <button className="icon-btn" aria-label={tr("Schliessen")} onClick={onClose}><Icon.close /></button>
        </div>
        {kind === "expense" ? (
          <ExpenseForm compact initialDate={date} onDone={onClose} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {lock && <p className="notice">{lock}{tr(". Die Buchung kann nur angesehen werden.")}</p>}
            <QuickPicks userId={currentUserId} onPick={pick} fav={fav} />
            <div className="form-grid">{target.fields("d")}</div>
            <div className="form-grid">
              <label className="field"><span>{tr("Datum")}</span><input id="d-date" type="date" className="input" value={date} onChange={(ev) => setDate(ev.target.value)} /></label>
              <label className="field"><span>{tr("Von")}</span><input id="d-start" type="time" step={900} className="input" value={startTime} onChange={(ev) => setStartTime(ev.target.value)} /></label>
              <label className="field">
                <span>{tr("Dauer (h)")}{endTime ? tr(" · bis {0}", endTime) : ""}</span>
                <input id="d-hours" type="number" step="0.25" min="0.25" max="24" className="input num" value={hours} onChange={(ev) => setHours(ev.target.value)} />
              </label>
              <label className="field">
                <span>{tr("JIRA-Issue (optional)")}</span>
                <Select
                  id="d-issue"
                  value={issueKey}
                  onChange={setIssueKey}
                  options={[
                    { value: "", label: tr("Ohne Issue") },
                    ...openIssues.map((i) => ({ value: i.key, label: `${i.key} · ${i.summary}` })),
                    ...(e?.jiraIssueKey && !openIssues.some((i) => i.key === e.jiraIssueKey) ? [{ value: e.jiraIssueKey, label: e.jiraIssueKey }] : []),
                  ]}
                />
              </label>
            </div>
            <label className="field">
              <span className="tree-row" style={{ display: "flex" }}>
                {tr("Grund / Tätigkeit")}
                <button type="button" id="d-fav" className={`star ${current && fav.isFavorite(current) ? "on" : ""}`} disabled={!current} title={tr("Diese Kombination als Favorit merken")} onClick={() => current && fav.toggle(current)}>
                  ★ <span style={{ fontSize: "0.75rem" }}>{current && fav.isFavorite(current) ? tr("Favorit") : tr("Als Favorit merken")}</span>
                </button>
              </span>
              <input id="d-reason" className="input" placeholder={tr("z. B. Abnahme-Workshop vorbereitet")} value={reason} autoFocus={!e} onChange={(ev) => setReason(ev.target.value)} onKeyDown={(ev) => ev.key === "Enter" && save()} />
            </label>
            {!lock && <ReasonHints id="d-hints" subProjectId={target.subProjectId} date={date} typed={reason} onPick={(x) => { setReason(x.text); if (x.issueKey && openIssues.some((i) => i.key === x.issueKey)) setIssueKey(x.issueKey); }} />}
            {error && <p className="error">{error}</p>}
            {e && <Comments entry={e} />}
            {history && e && <History id={e.id} />}
            <div className="tree-row" style={{ flexWrap: "wrap", gap: 8 }}>
              <label className="check"><input id="d-billable" type="checkbox" checked={billable} onChange={(ev) => setBillable(ev.target.checked)} />{tr("Verrechenbar · {0}/h", fmtCHF(rate))}</label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {e && mode === "api" && <button className="btn small ghost" onClick={() => setHistory(!history)}>{tr("Verlauf")}</button>}
                {e && !lock && (confirm ? (
                  <>
                    <button className="btn small primary" disabled={busy} onClick={() => run(() => deleteTimeEntry(e.id), tr("Buchung gelöscht"))}>{tr("Wirklich löschen")}</button>
                    <button className="btn small ghost" onClick={() => setConfirm(false)}>{tr("Nein")}</button>
                  </>
                ) : (
                  <button className="btn small ghost" onClick={() => setConfirm(true)}><Icon.trash />{tr("Löschen")}</button>
                ))}
                <button className="btn small ghost" onClick={onClose}>{tr("Abbrechen")}</button>
                {!lock && <button id="d-save" className="btn small primary" disabled={busy} onClick={save}>{e ? tr("Speichern") : tr("Buchen")}</button>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type Drag =
  | { kind: "create"; date: string; from: number; to: number }
  | { kind: "move"; entry: TimeEntry; date: string; start: number; offset: number; moved: boolean }
  | { kind: "resize"; entry: TimeEntry; date: string; end: number };

/** True below 700 px; the calendar then shows one day at a time. */
function usePhone() {
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 700px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 700px)");
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

/** Week calendar: columns are days, the vertical axis is the time of day. Drag on empty space to book. */
function WeekCalendar() {
  const { data, currentUserId, addTimeEntry, updateTimeEntry, lockOf, notify, questions, weeks, submitWeek, withdrawWeek, loadFrom } = useStore();
  const asked = useMemo(() => new Set(questions.map((q) => q.entryId)), [questions]);
  const labels = useLabels();
  const [monday, setMonday] = useState(() => mondayOf(data.today));
  const phone = usePhone();
  // On phones the calendar shows one day; `dayIdx` is the weekday offset inside the current week.
  const [dayIdx, setDayIdx] = useState(() => Math.max(0, Math.min(6, Math.round((new Date(data.today).getTime() - new Date(mondayOf(data.today)).getTime()) / 86400000))));
  const stepDay = (delta: number) => {
    const next = dayIdx + delta;
    if (next < 0) { setMonday(addDays(monday, -7)); setDayIdx(6); }
    else if (next > 6) { setMonday(addDays(monday, 7)); setDayIdx(0); }
    else setDayIdx(next);
  };
  const goToday = () => { setMonday(mondayOf(data.today)); setDayIdx(Math.round((new Date(data.today).getTime() - new Date(mondayOf(data.today)).getTime()) / 86400000)); };
  const swipe = useRef<number | null>(null);
  const onTouchStart = (ev: React.TouchEvent) => { swipe.current = ev.touches[0].clientX; };
  const onTouchEnd = (ev: React.TouchEvent) => {
    if (swipe.current === null) return;
    const dx = ev.changedTouches[0].clientX - swipe.current;
    swipe.current = null;
    if (Math.abs(dx) > 60) stepDay(dx < 0 ? 1 : -1);
  };
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [hover, setHover] = useState<TimeEntry | null>(null);
  useEffect(() => {
    const openFromHash = () => {
      const [, kind, id] = location.hash.replace("#", "").split("/");
      if (kind !== "e" || !id) return;
      const e = data.timeEntries.find((x) => x.id === id);
      if (!e) return;
      setMonday(mondayOf(e.date));
      setDialog({ entry: e, date: e.date, hours: e.hours });
      history.replaceState(null, "", "#zeit");
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, [data.timeEntries]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const open = (ev: Event) => {
      const d = (ev as CustomEvent<{ date?: string; startTime?: string; hours?: number }>).detail ?? {};
      if (d.date && !week.includes(d.date)) setMonday(mondayOf(d.date));
      setDialog({ date: d.date ?? (days.includes(data.today) ? data.today : days[0]), startTime: d.startTime, hours: d.hours ?? 1 });
    };
    window.addEventListener("ti:new-entry", open);
    return () => window.removeEventListener("ti:new-entry", open);
  }); // re-bound each render so it sees the current week

  /** Copies the person's bookings of `from` to `to` (only when `to` has none and is not locked). */
  const copyDay = async (from: string, to: string) => {
    if (lockOf(currentUserId, to) || (byDay.get(to) ?? []).length > 0) return 0;
    const src = data.timeEntries.filter((e) => e.employeeId === currentUserId && e.date === from);
    for (const e of src) {
      const { id: _id, ...rest } = e;
      await addTimeEntry({ ...rest, date: to });
    }
    return src.length;
  };
  const copyFromLastWeek = async (scope: "day" | "week") => {
    const targets = scope === "day" ? [days[0]] : week;
    let n = 0;
    try {
      for (const d of targets) n += await copyDay(addDays(d, -7), d);
      notify(n === 0 ? tr("Nichts kopiert: Zieltage sind belegt, gesperrt oder die Vorwoche ist leer.") : trn(n, "{0} Buchung von letzter Woche übernommen", "{0} Buchungen von letzter Woche übernommen"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const duplicate = async (e: TimeEntry) => {
    if (lockOf(currentUserId, e.date)) return;
    const { id: _id, startTime, ...rest } = e;
    const next = startTime ? toClock(Math.min(DAY_END - 15, toMin(startTime) + Math.round(e.hours * 60))) : undefined;
    try {
      await addTimeEntry({ ...rest, startTime: next });
      notify(tr("{0} h dupliziert", fmt1(e.hours)));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Keyboard: ← → week (day on phones), T today, D duplicate the booking under the pointer.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      if (dialog || ev.metaKey || ev.ctrlKey || ev.altKey || (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable || el.closest("[role=dialog]")))) return;
      if (ev.key === "ArrowLeft") { ev.preventDefault(); phone ? stepDay(-1) : setMonday(addDays(monday, -7)); }
      else if (ev.key === "ArrowRight") { ev.preventDefault(); phone ? stepDay(1) : setMonday(addDays(monday, 7)); }
      else if (ev.key === "t" || ev.key === "T") { ev.preventDefault(); goToday(); }
      else if ((ev.key === "d" || ev.key === "D") && hover) { ev.preventDefault(); void duplicate(hover); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [error, setError] = useState("");
  const gridRef = useRef<HTMLDivElement>(null);
  const week = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  const days = useMemo(() => (phone ? [week[dayIdx]] : week), [week, phone, dayIdx]);
  const calendar = useCalendarSuggestions(days);
  const employee = data.employees.find((e) => e.id === currentUserId);
  const cal = useMemo(() => (employee ? new WorkCalendar(data, employee) : null), [data, employee]);
  // Weeks before the loaded window: fetch their single bookings on demand.
  useEffect(() => {
    if (data.detailFrom && monday < data.detailFrom) void loadFrom(monday);
  }, [monday]); // eslint-disable-line react-hooks/exhaustive-deps
  const byDay = useMemo(() => {
    const m = new Map<string, TimeEntry[]>(week.map((d) => [d, []]));
    for (const e of data.timeEntries) if (!e.summary && e.employeeId === currentUserId && m.has(e.date)) m.get(e.date)!.push(e);
    return m;
  }, [data, currentUserId, week]);
  const hoursOf = (d: string) => (byDay.get(d) ?? []).reduce((s, e) => s + e.hours, 0);
  const targetOf = (d: string) => (cal ? Math.max(0, cal.target(d) - cal.credit(d)) : 0);
  const absenceOn = (d: string) => (data.absences ?? []).find((a) => a.employeeId === currentUserId && a.status !== "rejected" && a.startDate <= d && a.endDate >= d);
  const holidayOn = (d: string) => cal?.holidays.get(d);
  const weekWorked = week.reduce((s, d) => s + hoursOf(d), 0);
  const weekTarget = week.reduce((s, d) => s + targetOf(d), 0);
  const weekKey = isoWeekKey(monday);
  const submission = weeks.find((w) => w.userId === currentUserId && w.week === weekKey);
  const canSubmit = monday <= mondayOf(data.today) && !lockOf(currentUserId, monday);
  const toggleWeek = async () => {
    try {
      if (submission) {
        await withdrawWeek(weekKey);
        notify(tr("KW {0} zurückgezogen", isoWeek(monday)));
      } else {
        await submitWeek(weekKey);
        notify(tr("KW {0} eingereicht: {1} h", isoWeek(monday), fmt1(weekWorked)));
      }
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const height = (DAY_END - DAY_START) * PX_PER_MIN;
  const colorOf = (subId: string) => {
    const c = labels.customerOf(subId);
    if (!c || rateOn(c, data.today) === 0) return undefined;
    return PALETTE[Math.max(0, data.customers.findIndex((x) => x.id === c.id)) % PALETTE.length];
  };
  const [nowMin, setNowMin] = useState(() => new Date().getHours() * 60 + new Date().getMinutes());
  useEffect(() => {
    const t = setInterval(() => setNowMin(new Date().getHours() * 60 + new Date().getMinutes()), 60_000);
    return () => clearInterval(t);
  }, []);
  const hoursAxis = Array.from({ length: (DAY_END - DAY_START) / 60 }, (_, i) => DAY_START + i * 60);

  // Scroll the day columns to the working hours on first render.
  useEffect(() => {
    gridRef.current?.scrollTo({ top: (6.75 * 60 - DAY_START) * PX_PER_MIN });
  }, []);

  const minutesAt = (clientY: number) => {
    const col = gridRef.current?.querySelector<HTMLElement>(".cal-col");
    if (!col) return DAY_START;
    const rect = col.getBoundingClientRect();
    return clamp(snap(DAY_START + (clientY - rect.top) / PX_PER_MIN), DAY_START, DAY_END);
  };
  const dateAt = (clientX: number) => {
    const cols = gridRef.current?.querySelectorAll<HTMLElement>(".cal-col") ?? [];
    for (const c of cols) {
      const r = c.getBoundingClientRect();
      if (clientX >= r.left && clientX < r.right) return c.dataset.date!;
    }
    return null;
  };

  const startCreate = (ev: React.PointerEvent<HTMLDivElement>, date: string) => {
    if (ev.button !== 0 || (ev.target as HTMLElement).closest(".cal-block") || lockOf(currentUserId, date)) return;
    ev.preventDefault();
    const from = minutesAt(ev.clientY);
    setDrag({ kind: "create", date, from, to: from + SNAP });
  };
  const startMove = (ev: React.PointerEvent<HTMLDivElement>, entry: TimeEntry, date: string) => {
    if (ev.button !== 0 || lockOf(currentUserId, date) || !entry.startTime) return;
    ev.stopPropagation();
    ev.preventDefault();
    const at = minutesAt(ev.clientY);
    setDrag({ kind: "move", entry, date, start: toMin(entry.startTime), offset: at - toMin(entry.startTime), moved: false });
  };
  const startResize = (ev: React.PointerEvent<HTMLSpanElement>, entry: TimeEntry, date: string) => {
    if (ev.button !== 0 || lockOf(currentUserId, date) || !entry.startTime) return;
    ev.stopPropagation();
    ev.preventDefault();
    setDrag({ kind: "resize", entry, date, end: toMin(entry.startTime) + Math.round(entry.hours * 60) });
  };

  // While a drag runs, the whole window reports pointer moves, so the block follows even outside the column or grid.
  useEffect(() => {
    if (!drag) return;
    const onMove = (ev: PointerEvent) => {
      const at = minutesAt(ev.clientY);
      if (drag.kind === "create") setDrag({ ...drag, to: Math.max(drag.from + SNAP, at) });
      if (drag.kind === "move") {
        const start = clamp(at - drag.offset, DAY_START, DAY_END - SNAP);
        const date = dateAt(ev.clientX) ?? drag.date;
        setDrag({ ...drag, start, date, moved: drag.moved || start !== toMin(drag.entry.startTime!) || date !== drag.entry.date });
      }
      if (drag.kind === "resize") setDrag({ ...drag, end: Math.max(toMin(drag.entry.startTime!) + SNAP, at) });
    };
    const onUp = async () => {
      const d = drag;
      setDrag(null);
      try {
        if (d.kind === "create") {
          setDialog({ date: d.date, startTime: toClock(d.from), hours: (d.to - d.from) / 60 });
        } else if (d.kind === "move") {
          if (!d.moved) return setDialog({ entry: d.entry, date: d.entry.date, hours: d.entry.hours });
          if (lockOf(currentUserId, d.date)) throw new Error(lockOf(currentUserId, d.date)!);
          await updateTimeEntry(d.entry.id, { startTime: toClock(d.start), date: d.date });
          notify(tr("Verschoben auf {0} {1}", fmtDay(d.date), toClock(d.start)));
        } else {
          const hours = Math.round(((d.end - toMin(d.entry.startTime!)) / 60) * 100) / 100;
          if (hours !== d.entry.hours) {
            await updateTimeEntry(d.entry.id, { hours });
            notify(tr("Dauer: {0} h", fmt1(hours)));
          }
        }
        setError("");
      } catch (err) {
        setError((err as Error).message);
      }
    };
    const onCancel = () => setDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [drag]); // eslint-disable-line react-hooks/exhaustive-deps

  const block = (p: Placed, date: string, preview = false) => {
    const e = p.entry;
    const top = (p.start - DAY_START) * PX_PER_MIN;
    const h = Math.max(18, (p.end - p.start) * PX_PER_MIN);
    const lock = lockOf(currentUserId, date);
    const color = colorOf(e.subProjectId);
    return (
      <div
        key={preview ? "preview" : e.id}
        className={`cal-block ${color ? "" : "internal"} ${preview ? "cal-preview" : ""} ${lock ? "locked" : ""}`}
        style={{ top, height: h, left: `calc(${(p.col / p.cols) * 100}% + 2px)`, width: `calc(${100 / p.cols}% - 4px)`, ...(color ? ({ "--ev": color } as React.CSSProperties) : {}) }}
        title={`${e.reason}\n${labels.long(e.subProjectId)} · ${fmt1(e.hours)} h${lock ? `\n${lock}` : ""}`}
        onPointerDown={(ev) => !preview && startMove(ev, e, date)}
        onPointerEnter={() => !preview && setHover(e)}
        onPointerLeave={() => setHover((h) => (h?.id === e.id ? null : h))}
      >
        <div className="cal-block-title">{asked.has(e.id) && <span className="q-badge" title={tr("Rückfrage offen")}>?</span>}{e.reason}</div>
        {h >= 34 && <div className="cal-block-meta">{labels.short(e.subProjectId)}</div>}
        <div className="cal-block-time">{toClock(p.start)}{tr("–{0} · {1} h", toClock(p.end), fmt1((p.end - p.start) / 60))}</div>
        {preview && <span className="cal-badge top">{toClock(p.start)}</span>}
        {preview && <span className="cal-badge bottom">{toClock(p.end)}{" "}{tr("· {0} h", fmt1((p.end - p.start) / 60))}</span>}
        {!lock && !preview && <span className="cal-resize" title={tr("Ziehen, um die Dauer zu ändern")} onPointerDown={(ev) => startResize(ev, e, date)} />}
      </div>
    );
  };

  return (
    <section className="card cal">
      <div className="card-head cal-toolbar">
        {phone ? (
          <div className="tree-row" style={{ gap: 6 }}>
            <button className="btn small ghost step" aria-label={tr("Vorheriger Tag")} onClick={() => stepDay(-1)}>‹</button>
            <h2 style={{ margin: 0 }}>{fmtDay(days[0])}</h2>
            <button className="btn small ghost step" aria-label={tr("Nächster Tag")} onClick={() => stepDay(1)}>›</button>
            {days[0] !== data.today && <button className="btn small ghost" onClick={goToday}>{tr("Heute")}</button>}
          </div>
        ) : (
          <div className="tree-row" style={{ gap: 8 }}>
            <button className="btn small ghost step" aria-label={tr("Vorherige Woche")} onClick={() => setMonday(addDays(monday, -7))}>‹</button>
            <h2 style={{ margin: 0 }}>{tr("KW {0} · {1} –", isoWeek(monday), fmtDay(week[0]).split(",")[1]?.trim())}{" "}{fmtDay(week[6]).split(",")[1]?.trim()}</h2>
            <button className="btn small ghost step" aria-label={tr("Nächste Woche")} onClick={() => setMonday(addDays(monday, 7))}>›</button>
            {monday !== mondayOf(data.today) && <button className="btn small ghost" onClick={() => setMonday(mondayOf(data.today))}>{tr("Heute")}</button>}
          </div>
        )}
        <div className="tree-row" style={{ gap: 12 }}>
          <span className="muted cal-week-sum" style={{ fontSize: "0.82rem" }}>
            {phone ? tr("Woche") : tr("{0} h von {1} h Soll", fmt1(weekWorked), fmt1(weekTarget))}{" "}{tr("· Saldo")}{" "}<strong className={weekWorked - weekTarget < 0 ? "neg" : ""}>{signedH(weekWorked - weekTarget)}</strong>
          </span>
          <details className="menu">
            <summary className="btn small" title={tr("Buchungen von letzter Woche übernehmen")}>{tr("Kopieren ▾")}</summary>
            <div className="menu-list">
              <button onClick={(ev) => { (ev.currentTarget.closest("details") as HTMLDetailsElement).open = false; void copyFromLastWeek("day"); }}>{phone ? tr("Diesen Tag") : tr("Heute")}{" "}{tr("wie vor einer Woche")}</button>
              <button onClick={(ev) => { (ev.currentTarget.closest("details") as HTMLDetailsElement).open = false; void copyFromLastWeek("week"); }}>{tr("Ganze Woche wie letzte Woche")}</button>
              <span className="menu-hint">{tr("Nur leere, nicht gesperrte Tage werden gefüllt.")}</span>
            </div>
          </details>
          {canSubmit && !phone && (
            submission ? (
              <details className="menu">
                <summary id="cal-week-submitted" className="btn small ghost week-ok" title={tr("Eingereicht am {0}", new Date(submission.submittedAt).toLocaleDateString(intlLocale))}>{tr("✓ Eingereicht")}</summary>
                <div className="menu-list">
                  <button onClick={(ev) => { (ev.currentTarget.closest("details") as HTMLDetailsElement).open = false; void toggleWeek(); }}>{tr("Woche zurückziehen")}</button>
                  <span className="menu-hint">{tr("Zum Nachtragen einer vergessenen Buchung.")}</span>
                </div>
              </details>
            ) : (
              <button id="cal-week-submit" className="btn small ghost" title={tr("Bestätigt, dass die Woche vollständig gebucht ist")} onClick={() => void toggleWeek()}>{tr("Woche einreichen")}</button>
            )
          )}
          <button id="cal-new" className="btn small" onClick={() => setDialog({ date: days.includes(data.today) ? data.today : days[0], hours: 1 })}>{tr("+ Eintrag")}</button>
        </div>
      </div>
      <div className="cal-scroll" style={{ "--cal-cols": days.length } as React.CSSProperties} onTouchStart={phone ? onTouchStart : undefined} onTouchEnd={phone ? onTouchEnd : undefined}>
        <div className="cal-head">
          <div className="cal-gutter" />
          {days.map((d, i) => {
            const off = cal ? cal.workShare(d) === 0 : false;
            const lock = lockOf(currentUserId, d);
            return (
              <div key={d} className={`cal-day-head ${d === data.today ? "today" : ""} ${off ? "off" : ""}`}>
                <div className="cal-day-name">{WEEKDAYS[phone ? dayIdx : i]} <span>{d.slice(8, 10)}.{d.slice(5, 7)}.</span>{lock && <span className="lock" title={lock}><Icon.lock /></span>}</div>
                <div className="cal-day-sum num">{fmt1(hoursOf(d))}{" "}{tr("/ {0} h", fmt1(targetOf(d)))}</div>
                <div className="cal-allday">
                  {holidayOn(d) && <span className="cal-chip holiday" title={tr("Feiertag")}>{holidayOn(d)!.name}</span>}
                  {absenceOn(d) && (
                    <span className={`cal-chip absence ${TYPE_CLASS[absenceOn(d)!.type]}`} title={absenceOn(d)!.status === "requested" ? tr("beantragt") : tr("bewilligt")}>
                      {tr(absenceOn(d)!.type)}{absenceOn(d)!.halfDay ? " (½)" : ""}{absenceOn(d)!.status === "requested" ? tr(" · beantragt") : ""}
                    </span>
                  )}
                  {(byDay.get(d) ?? []).filter((e) => !e.startTime).map((e) => (
                    <button key={e.id} className={`cal-chip ${e.billable ? "" : "internal"}`} title={tr("{0} · ohne Uhrzeit", e.reason)} onClick={() => setDialog({ entry: e, date: d, hours: e.hours })}>
                      {fmt1(e.hours)}{" "}{tr("h")}{" "}{e.reason}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="cal-grid" ref={gridRef}>
          <div className="cal-gutter" style={{ height }}>
            {hoursAxis.map((m) => <div key={m} className="cal-hour" style={{ top: (m - DAY_START) * PX_PER_MIN }}>{toClock(m)}</div>)}
          </div>
          {days.map((d) => {
            const placed = layoutDay(byDay.get(d) ?? []);
            const off = cal ? cal.workShare(d) === 0 : false;
            const lock = lockOf(currentUserId, d);
            return (
              <div
                key={d}
                data-date={d}
                className={`cal-col ${d === data.today ? "today" : ""} ${off ? "off" : ""} ${lock ? "locked" : ""} ${drag ? "dragging" : ""}`}
                style={{ height }}
                onPointerDown={(ev) => startCreate(ev, d)}
              >
                {hoursAxis.map((m) => <div key={m} className="cal-line" style={{ top: (m - DAY_START) * PX_PER_MIN }} />)}
                {d === data.today && nowMin >= DAY_START && nowMin <= DAY_END && <div className="cal-now" style={{ top: (nowMin - DAY_START) * PX_PER_MIN }} />}
                {!lock && calendar.suggestions.filter((x) => x.event.date === d && !(drag && drag.date === d)).map((x) => {
                  const from = Math.max(DAY_START, toMin(x.event.start));
                  const to = Math.min(DAY_END, Math.max(from + 15, toMin(x.event.end)));
                  if (to <= DAY_START || from >= DAY_END) return null;
                  const h = Math.max(18, (to - from) * PX_PER_MIN);
                  return (
                    <div
                      key={x.event.id}
                      className="cal-block cal-suggest"
                      role="button"
                      tabIndex={0}
                      style={{ top: (from - DAY_START) * PX_PER_MIN, height: h, left: 2, right: 2 }}
                      title={tr("Termin aus deinem Kalender. Klicken, um ihn zu buchen.")}
                      onPointerDown={(ev) => ev.stopPropagation()}
                      onClick={() => setDialog({ date: d, startTime: x.event.start, hours: x.hours, reason: x.event.title, subProjectId: x.subProjectId })}
                      onKeyDown={(ev) => ev.key === "Enter" && setDialog({ date: d, startTime: x.event.start, hours: x.hours, reason: x.event.title, subProjectId: x.subProjectId })}
                    >
                      <div className="cal-block-title">{x.event.title}</div>
                      {h >= 34 && <div className="cal-block-meta">{x.subProjectId ? labels.short(x.subProjectId) : tr("Vorschlag aus dem Kalender")}</div>}
                      <div className="cal-block-time">{x.event.start}{tr("–{0} · {1} h", x.event.end, fmt1(x.hours))}</div>
                      <button className="cal-suggest-x" aria-label={tr("Vorschlag ausblenden")} title={tr("Vorschlag ausblenden")} onClick={(ev) => { ev.stopPropagation(); calendar.hide(x.event.id); }}>×</button>
                    </div>
                  );
                })}
                {placed.filter((p) => !(drag && drag.kind !== "create" && drag.entry.id === p.entry.id)).map((p) => block(p, d))}
                {drag?.kind === "create" && drag.date === d && (
                  <div className="cal-block cal-preview creating" style={{ top: (drag.from - DAY_START) * PX_PER_MIN, height: (drag.to - drag.from) * PX_PER_MIN, left: 2, right: 2 }}>
                    <div className="cal-block-title">{tr("Neue Buchung")}</div>
                    <span className="cal-badge top">{toClock(drag.from)}</span>
                    <span className="cal-badge bottom">{toClock(drag.to)}{" "}{tr("· {0} h", fmt1((drag.to - drag.from) / 60))}</span>
                  </div>
                )}
                {drag?.kind === "move" && drag.date === d && block({ entry: drag.entry, start: drag.start, end: drag.start + Math.round(drag.entry.hours * 60), col: 0, cols: 1 }, d, true)}
                {drag?.kind === "resize" && drag.date === d && block({ entry: drag.entry, start: toMin(drag.entry.startTime!), end: drag.end, col: 0, cols: 1 }, d, true)}
              </div>
            );
          })}
        </div>
      </div>
      <div className="card-pad" style={{ paddingTop: 8, display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        {calendar.suggestions.length > 0 && <span className="muted" style={{ fontSize: "0.78rem", width: "100%" }}>{tr("Gestrichelt: Termine aus deinem Kalender, die noch nicht gebucht sind. Ein Klick öffnet die Buchung mit Zeit, Dauer und Titel.")}</span>}
        <span className="muted" style={{ fontSize: "0.78rem" }}>{tr("Ziehen bucht (15-Minuten-Raster), Einträge lassen sich verschieben und unten verlängern. Tasten: N neu, S Stoppuhr, ← → Woche, T heute, D dupliziert den Eintrag unter der Maus. Buchungen ohne Uhrzeit stehen oben im Tag.")}</span>
        {error && <span className="error">{error}</span>}
      </div>
      {dialog && <EntryDialog key={`${dialog.entry?.id ?? "new"}|${dialog.date}|${dialog.startTime ?? ""}`} state={dialog} onClose={() => setDialog(null)} />}
    </section>
  );
}

const STAMP_LABEL: Record<StampAction, string> = { in: tr("Kommen"), break: tr("Pause"), resume: tr("Weiter"), out: tr("Gehen") };
/** Clock time in Zurich, like the server stamps it, whatever time zone the device is in. */
const clockZurich = () => new Intl.DateTimeFormat(intlLocale, { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()).replace(".", ":");

/** Come/go bar (time model «full»): stamp, see presence against booked hours, fix forgotten stamps. */
function StampBar() {
  const { data, currentUserId, stamp, addWorkPeriod, updateWorkPeriod, deleteWorkPeriod, notify, scope } = useStore();
  const [now, setNow] = useState(clockZurich);
  useEffect(() => {
    const t = setInterval(() => setNow(clockZurich()), 30_000);
    return () => clearInterval(t);
  }, []);
  const [more, setMore] = useState(false);
  const [draft, setDraft] = useState<{ date: string; start: string; end: string; kind: PeriodKind }>({ date: data.today, start: "08:00", end: "12:00", kind: "work" });
  const [error, setError] = useState("");
  const mine = (data.workPeriods ?? []).filter((p) => p.employeeId === currentUserId);
  const day = dayPresence(mine, data.today, now);
  const yesterday = dayPresence(mine, addDays(data.today, -1));
  const issues = presenceIssues(day, yesterday.last);
  const booked = data.timeEntries.filter((e) => e.employeeId === currentUserId && e.date === data.today).reduce((s, e) => s + e.hours, 0);
  const run = (f: () => Promise<void>, msg?: string) => f().then(() => { setError(""); if (msg) notify(msg); }).catch((e: Error) => setError(e.message));
  const h = (min: number) => `${(min / 60).toFixed(2).replace(/\.?0+$/, "")} h`;
  const stateText = day.state === "working" ? tr("Am Arbeiten seit {0}", day.open!.start) : day.state === "break" ? tr("Pause seit {0}", day.open!.start) : day.periods.length ? tr("Gegangen um {0}", day.last ?? "–") : tr("Noch nicht gestempelt");
  if (scope.readOnly) return null;
  return (
    <section className="card stamp" id="stamp-bar">
      <div className="stamp-row">
        <div className="stamp-state">
          <span className={`stamp-dot ${day.state}`} />
          <div>
            <strong>{stateText}</strong>
            <div className="muted num" style={{ fontSize: "0.82rem" }}>{tr("Anwesend {0} · Pausen {1} min · Gebucht {2} h", h(day.work), day.breaks, fmt1(booked))}{day.work > 0 && Math.abs(day.work / 60 - booked) >= 0.25 ? tr(" · Differenz {0} h", fmt1(day.work / 60 - booked)) : ""}</div>
          </div>
        </div>
        <div className="toolbar">
          {stampOptions(day.state).map((a) => (
            <button key={a} id={`stamp-${a}`} className={`btn ${a === "in" || a === "resume" ? "primary" : ""}`} onClick={() => void run(() => stamp(a), `${STAMP_LABEL[a]} ${now}`)}>{STAMP_LABEL[a]}</button>
          ))}
          <button className="btn small ghost" onClick={() => setMore(!more)} aria-expanded={more}>{more ? tr("Weniger") : tr("Abschnitte")}</button>
        </div>
      </div>
      {issues.length > 0 && <ul className="stamp-issues">{issues.map((i) => <li key={i}>{i}</li>)}</ul>}
      {more && (
        <div className="stamp-more">
          {day.periods.length === 0 ? <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>{tr("Heute noch keine Abschnitte.")}</p> : (
            <ul className="stamp-list">
              {day.periods.map((p) => (
                <li key={p.id}>
                  <span className={`pill ${p.kind === "work" ? "ok" : "neutral"}`}>{p.kind === "work" ? tr("Arbeit") : tr("Pause")}</span>
                  <input className="input num" type="time" value={p.start} aria-label={tr("Beginn")} onChange={(e) => void run(() => updateWorkPeriod(p.id, { start: e.target.value }))} />
                  <span className="muted">{tr("bis")}</span>
                  <input className="input num" type="time" value={p.end ?? ""} aria-label={tr("Ende")} placeholder={tr("offen")} onChange={(e) => void run(() => updateWorkPeriod(p.id, { end: e.target.value || null }))} />
                  <span className="muted num">{p.end ? h(Math.max(0, (Number(p.end.slice(0, 2)) * 60 + Number(p.end.slice(3))) - (Number(p.start.slice(0, 2)) * 60 + Number(p.start.slice(3))))) : tr("läuft")}</span>
                  <button className="btn small ghost" aria-label={tr("Abschnitt löschen")} onClick={() => void run(() => deleteWorkPeriod(p.id), tr("Abschnitt entfernt"))}>{tr("×")}</button>
                </li>
              ))}
            </ul>
          )}
          <div className="stamp-add">
            <span className="muted" style={{ fontSize: "0.85rem" }}>{tr("Vergessen zu stempeln?")}</span>
            <input id="pp-date" className="input" type="date" value={draft.date} max={data.today} onChange={(e) => setDraft({ ...draft, date: e.target.value })} aria-label={tr("Datum")} />
            <input id="pp-start" className="input num" type="time" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} aria-label={tr("Beginn")} />
            <input id="pp-end" className="input num" type="time" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} aria-label={tr("Ende")} />
            <div className="seg" role="radiogroup" aria-label={tr("Art")}>
              <button role="radio" aria-checked={draft.kind === "work"} className={draft.kind === "work" ? "on" : ""} onClick={() => setDraft({ ...draft, kind: "work" })}>{tr("Arbeit")}</button>
              <button role="radio" aria-checked={draft.kind === "break"} className={draft.kind === "break" ? "on" : ""} onClick={() => setDraft({ ...draft, kind: "break" })}>{tr("Pause")}</button>
            </div>
            <button id="pp-add" className="btn small" onClick={() => void run(() => addWorkPeriod(draft), tr("Abschnitt nachgetragen"))}>{tr("Nachtragen")}</button>
          </div>
          {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
          <p className="muted" style={{ margin: 0, fontSize: "0.78rem" }}>{tr("Jetzt {0}. Gesetzliche Pausen: 15 min ab 5½ h, 30 min ab 7 h, 60 min ab 9 h Arbeit; 11 h Ruhezeit zwischen zwei Arbeitstagen.", now)}</p>
        </div>
      )}
      {error && !more && <p className="error" style={{ margin: "8px 0 0" }}>{error}</p>}
    </section>
  );
}

export function TimeTracking() {
  const { data, currentUserId } = useStore();
  const stamping = data.workModel?.timeModel === "full";
  const me = data.employees.find((e) => e.id === currentUserId);
  const [view, setView] = useState<"day" | "week" | "grid">(() => loadLocal<"day" | "week" | "grid">("rt.view", "week"));
  const switchTo = (v: "day" | "week" | "grid") => {
    setView(v);
    saveLocal("rt.view", v);
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{tr("Zeiterfassung")}</h1>
          <p className="sub">{tr("Zeit und Spesen auf Kunde, Projekt und Subprojekt buchen.")}</p>
        </div>
        <div className="seg" role="tablist" aria-label={tr("Ansicht")}>
          <button id="view-week" className={view === "week" ? "on" : ""} onClick={() => switchTo("week")}>{tr("Kalender")}</button>
          <button id="view-grid" className={view === "grid" ? "on" : ""} onClick={() => switchTo("grid")}>{tr("Wochenraster")}</button>
          <button id="view-day" className={view === "day" ? "on" : ""} onClick={() => switchTo("day")}>{tr("Liste")}</button>
        </div>
      </div>
      {stamping && <StampBar />}
      {view === "week" ? (
        <>
          {me && <WorkTiles employee={me} />}
          <WeekCalendar />
        </>
      ) : view === "grid" ? (
        <WeekGrid />
      ) : (
        <div className="grid-2" style={{ alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
            <TimeForm />
            <ExpenseForm />
          </div>
          <WeekList />
        </div>
      )}
    </>
  );
}

/** Suggestions for the booking text from open Jira issues, own earlier bookings and the team's texts on the sub-project. */
function ReasonHints({ id, subProjectId, date, typed, onPick }: { id: string; subProjectId: string; date: string; typed: string; onPick: (s: ReasonSuggestion) => void }) {
  const { data, currentUserId } = useStore();
  const list = useMemo(() => (subProjectId ? reasonSuggestions(data, { employeeId: currentUserId, subProjectId, date: date || data.today, typed: typed.length >= 2 ? typed : "" }) : []), [data, currentUserId, subProjectId, date, typed]);
  if (!list.length) return null;
  const label = { jira: tr("Issue in Arbeit"), mine: tr("Von dir zuletzt gebucht"), team: tr("Im Team gebucht") };
  return (
    <div className="reason-hints" id={id}>
      <span className="muted">{tr("Vorschläge")}</span>
      {list.map((x) => (
        <button type="button" key={`${x.source}:${x.text}`} className="reason-hint" title={label[x.source]} onClick={() => onPick(x)}>
          {x.issueKey && <span className="mono">{x.issueKey}</span>}{x.text}
        </button>
      ))}
    </div>
  );
}
