import { GettingStarted } from "../ui/Help";
import { useState } from "react";
import { absenceDays, addMonths, fmt1, fmtCHF, fmtCHF2, fmtDate, fmtH, fmtMoney, fmtMonthLong, monthOf, vacationSummary, workBalance, type ProjectReport } from "@taktwerk/domain";
import { useStore } from "../store";
import { Icon } from "../ui/components";
import { intlLocale, tr, trn } from "../i18n";

/* Start page «Eingang» (design A2, Tony 2026-10-29): everything that needs someone's attention as one grouped list,
   four figures on top, and the selected item explained on the right. */

interface Action { label: string; primary?: boolean; done: string; run: () => Promise<void> }
interface Item {
  id: string;
  /** Marker on the left: filled for budgets, ring for approvals, dashed ring for own to-dos. */
  dot: "over" | "risk" | "ring" | "dashed";
  title: string;
  meta: string;
  when?: string;
  href?: string;
  /** Person the item is about: shown as initials. */
  person?: string;
  /** Share of budget or contingent the forecast reaches, drawn as a ring. */
  ratio?: number;
  actions?: Action[];
  report?: ProjectReport;
}
interface Group { label: string; items: Item[] }

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
const days = (n: number) => trn(n, "{1} Tag", "{1} Tage", fmt1(n).replace(/[.,]0$/, ""));
const range = (from: string, to: string) => (from === to ? fmtDate(from) : tr("{0} bis {1}", fmtDate(from).slice(0, 6), fmtDate(to)));
const ago = (date: string, today: string) => {
  const d = Math.round((Date.parse(today) - Date.parse(date.slice(0, 10))) / 86_400_000);
  return d <= 0 ? tr("heute") : d === 1 ? tr("gestern") : tr("vor {0} Tagen", d);
};
/** Projects the signed-in person may see budgets for. */
export function useVisibleReports(): ProjectReport[] {
  const { reports, role, scope } = useStore();
  if (role === "employee") return [];
  return reports.filter((r) => scope.seesAll || scope.leadsProject(r.project.id));
}

const MAX_EXPENSES = 4;

/** Items for the inbox; the rail shows their count. */
export function useInbox(): Group[] {
  const { data, role, scope, currentUserId, closings, questions, decideAbsence, decideExpense, closeMonth } = useStore();
  const reports = useVisibleReports();
  const name = (id: string) => data.employees.find((e) => e.id === id)?.name ?? "–";
  const lastMonth = addMonths(monthOf(data.today), -1);
  const groups: Group[] = [];

  const budget: Item[] = reports
    .filter((r) => r.status !== "ok")
    .sort((a, b) => (a.status === b.status ? a.variance - b.variance : a.status === "over" ? -1 : 1))
    .map((r): Item => {
      const money = (v: number) => fmtMoney(v, r.currency);
      const dot = r.status === "over" ? "over" : "risk";
      if (r.retainer) {
        const peak = Math.max(r.retainer.used, r.retainer.avg3);
        return { id: `b-${r.project.id}`, dot, report: r, ratio: peak / r.retainer.hoursPerMonth, title: r.status === "over" ? tr("{0} überzieht das Monatskontingent", r.project.name) : tr("{0}: Kontingent fast aufgebraucht", r.project.name), meta: tr("{0} · {1} von {2} h pro Monat", r.customer.name, fmt1(peak), fmt1(r.retainer.hoursPerMonth)) };
      }
      return r.status === "over"
        ? { id: `b-${r.project.id}`, dot: "over", report: r, ratio: r.forecastCost / r.budget, title: tr("{0} läuft auf {1} % des Budgets", r.project.name, pct(r.forecastCost, r.budget)), meta: tr("{0} · Prognose {1}", r.customer.name, money(r.forecastCost)) }
        : { id: `b-${r.project.id}`, dot: "risk", report: r, ratio: r.forecastCost / r.budget, title: tr("{0} wird knapp", r.project.name), meta: tr("{0} · Reserve {1}", r.customer.name, money(r.variance)) };
    });
  if (budget.length) groups.push({ label: tr("Budget"), items: budget });

  const approvals: Item[] = [];
  if (scope.managesPeople && !scope.readOnly) {
    const others = (id: string) => id !== currentUserId && scope.manages(id);
    for (const a of (data.absences ?? []).filter((x) => x.status === "requested" && others(x.employeeId)).sort((x, y) => x.startDate.localeCompare(y.startDate))) {
      const vac = a.type === "Ferien" ? vacationSummary(data, a.employeeId, Number(a.startDate.slice(0, 4))) : null;
      const n = absenceDays(data, a);
      approvals.push({
        id: `a-${a.id}`, dot: "ring", person: a.employeeId,
        title: `${name(a.employeeId)}: ${tr(a.type)} ${range(a.startDate, a.endDate)}`,
        meta: [days(n), vac ? tr("danach {0} Ferien übrig", days(vac.remaining - n)) : "", a.note ?? ""].filter(Boolean).join(" · "),
        actions: [
          { label: tr("Ablehnen"), done: tr("{0} abgelehnt", tr(a.type)), run: () => decideAbsence(a.id, false) },
          { label: tr("Bewilligen"), primary: true, done: tr("{0} bewilligt", tr(a.type)), run: () => decideAbsence(a.id, true) },
        ],
      });
    }
    const expenses = data.expenses.filter((x) => x.status === "requested" && others(x.employeeId)).sort((x, y) => x.date.localeCompare(y.date));
    for (const x of expenses.slice(0, MAX_EXPENSES)) {
      approvals.push({
        id: `x-${x.id}`, dot: "ring", person: x.employeeId, when: ago(x.date, data.today),
        title: `${name(x.employeeId)}: ${tr(x.category)}, ${x.reason}`,
        meta: `${fmtCHF2(x.amount)} · ${x.receipt ? tr("Beleg vorhanden") : tr("ohne Beleg")}`,
        actions: [
          { label: tr("Ablehnen"), done: tr("Spese abgelehnt"), run: () => decideExpense(x.id, false) },
          { label: tr("Bewilligen"), primary: true, done: tr("Spese bewilligt"), run: () => decideExpense(x.id, true) },
        ],
      });
    }
    if (expenses.length > MAX_EXPENSES) {
      const rest = expenses.slice(MAX_EXPENSES);
      approvals.push({ id: "x-more", dot: "ring", href: "#abschluss", title: tr("{0} weitere Spesen", rest.length), meta: tr("zusammen {0} · im Monatsabschluss", fmtCHF2(rest.reduce((s, x) => s + x.amount, 0))) });
    }
    for (const c of closings.filter((c) => c.month === lastMonth && c.status === "submitted" && others(c.userId))) {
      approvals.push({
        id: `c-${c.userId}`, dot: "ring", person: c.userId,
        title: tr("{0}: {1} eingereicht", name(c.userId), fmtMonthLong(lastMonth)),
        meta: tr("Monatsabschluss wartet auf deine Freigabe"),
        actions: [
          { label: tr("Zurückweisen"), done: tr("Zur Korrektur zurückgegeben"), run: () => closeMonth("reopen", lastMonth, c.userId) },
          { label: tr("Freigeben"), primary: true, done: tr("{0} freigegeben", fmtMonthLong(lastMonth)), run: () => closeMonth("approve", lastMonth, c.userId) },
        ],
      });
    }
  }
  if (approvals.length) groups.push({ label: tr("Freigaben"), items: approvals });

  const own: Item[] = [];
  // People who started recording this month (e.g. a new company) have nothing to submit for last month.
  const myStart = data.employees.find((e) => e.id === currentUserId)?.trackingStart;
  if (role !== "auditor" && data.employees.some((e) => e.id === currentUserId) && (!myStart || myStart.slice(0, 7) <= lastMonth) && !closings.some((c) => c.userId === currentUserId && c.month === lastMonth)) {
    own.push({ id: "own-close", dot: "dashed", href: "#abschluss", title: tr("{0} noch nicht eingereicht", fmtMonthLong(lastMonth)), meta: tr("Stunden prüfen und den Monat abschliessen") });
  }
  for (const q of questions) {
    const mine = q.ownerId === currentUserId;
    if (!mine && role === "employee") continue;
    own.push({
      id: `q-${q.entryId}`, dot: "dashed", href: `#zeit/e/${q.entryId}`, when: ago(q.createdAt, data.today),
      title: mine ? tr("Rückfrage zu deiner Buchung vom {0}", fmtDate(q.date)) : tr("Rückfrage an {0} noch offen", name(q.ownerId)),
      meta: `«${q.text}» · ${q.reason}`,
    });
  }
  if (own.length) groups.push({ label: tr("Du"), items: own });
  return groups;
}

/** Hours per calendar week, oldest first, for the last `n` weeks up to today. */
function weeklyHours(entries: { date: string; hours: number }[], today: string, n = 10): number[] {
  const end = new Date(`${today}T12:00:00`);
  const monday = new Date(end);
  monday.setDate(end.getDate() - ((end.getDay() + 6) % 7));
  const starts = Array.from({ length: n }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() - 7 * (n - 1 - i)); return d.toISOString().slice(0, 10); });
  const out = starts.map(() => 0);
  for (const e of entries) {
    for (let i = n - 1; i >= 0; i--) if (e.date >= starts[i]) { if (e.date <= today) out[i] += e.hours; break; }
  }
  return out;
}

function Spark({ values }: { values: number[] }) {
  const w = 120, h = 34, max = Math.max(...values, 1), min = Math.min(...values);
  const span = Math.max(max - min, max * 0.15);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (w - 4) + 2, h - 4 - ((v - min) / span) * (h - 10)]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg className="ib-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      <path d={`${line} L${lx} ${h} L2 ${h} Z`} className="area" />
      <path d={line} className="line" />
      <circle cx={lx} cy={ly} r="2.5" className="dot" />
    </svg>
  );
}

function Stats() {
  const { data, role, currentUserId, factor } = useStore();
  const reports = useVisibleReports();
  const month = monthOf(data.today);
  const mine = role === "employee" ? data.timeEntries.filter((e) => e.employeeId === currentUserId) : data.timeEntries;
  const entries = mine.filter((e) => monthOf(e.date) === month);
  const prev = mine.filter((e) => monthOf(e.date) === addMonths(month, -1) && e.date.slice(8) <= data.today.slice(8));
  const hours = entries.reduce((s, e) => s + e.hours, 0);
  const before = prev.reduce((s, e) => s + e.hours, 0);
  const billable = entries.filter((e) => e.billable).reduce((s, e) => s + e.hours * e.hourlyRate, 0);
  const monthName = fmtMonthLong(month).split(" ")[0];
  const delta = before ? Math.round(((hours - before) / before) * 100) : 0;
  const stats: { label: string; value: string; tone?: string }[] = [{ label: tr("Verrechenbar"), value: fmtCHF(billable) }];
  if (role === "employee") {
    if (data.employees.some((e) => e.id === currentUserId)) {
      const b = workBalance(data, currentUserId).balance;
      stats.push({ label: tr("Überzeit"), value: `${b >= 0 ? "+" : "−"}${fmtH(Math.abs(b))}`, tone: b < 0 ? "neg" : undefined });
      stats.push({ label: tr("Ferien übrig"), value: days(vacationSummary(data, currentUserId).remaining) });
    }
  } else {
    const atRisk = reports.filter((r) => r.status !== "ok").length;
    stats.push({ label: tr("Velocity"), value: factor ? `${fmt1(factor.current)} h/SP` : "–" });
    stats.push({ label: tr("Budgets in Gefahr"), value: tr("{0} von {1}", atRisk, reports.length), tone: atRisk > 0 ? "alert" : undefined });
  }
  return (
    <div className="ib-stats">
      <div className="ib-hero">
        <div>
          <span>{tr("Stunden im")}{" "}{monthName}</span>
          <strong className="num">{fmt1(hours)}<small>{" "}{tr("h")}</small></strong>
          {before > 0 && <em className={delta < 0 ? "down" : "up"}>{delta >= 0 ? "+" : "−"}{Math.abs(delta)}{" "}{tr("% zum Vormonat")}</em>}
        </div>
        <Spark values={weeklyHours(mine, data.today)} />
      </div>
      <div className="ib-minor">
        {stats.map((s) => (
          <div key={s.label}><span>{s.label}</span><strong className={`num ${s.tone ?? ""}`}>{s.value}</strong></div>
        ))}
      </div>
    </div>
  );
}

/** Share of budget as a small ring; full and red when the forecast is over. */
export function BudgetRing({ ratio, status, size = 18 }: { ratio: number; status: "ok" | "risk" | "over"; size?: number }) {
  const r = 7, c = 2 * Math.PI * r, f = Math.min(1, Math.max(0, ratio));
  return (
    <svg className={`ib-ring ${status}`} viewBox="0 0 18 18" width={size} height={size} aria-hidden="true">
      <circle cx="9" cy="9" r={r} className="track" />
      {f > 0 && <circle cx="9" cy="9" r={r} className="arc" strokeDasharray={`${f * c} ${c}`} transform="rotate(-90 9 9)" />}
    </svg>
  );
}

function Marker({ item }: { item: Item }) {
  const { data } = useStore();
  if (item.person) {
    const e = data.employees.find((x) => x.id === item.person);
    return <span className="ib-av" aria-hidden="true">{e?.initials ?? "?"}</span>;
  }
  if (item.ratio !== undefined) return <BudgetRing ratio={item.ratio} status={item.dot === "over" ? "over" : "risk"} />;
  return <span className={`ib-dot ${item.dot}`} aria-hidden="true" />;
}

function RetainerDetail({ r }: { r: ProjectReport }) {
  const t = r.retainer!;
  const peak = Math.max(t.used, t.avg3);
  const scale = Math.max(t.hoursPerMonth, peak, 1);
  return (
    <>
      <div>
        <p className="ib-eyebrow">{r.customer.name}{" "}{tr("· Monatskontingent")}</p>
        <h2>{r.project.name}</h2>
      </div>
      <div className="ib-bar" role="img" aria-label={tr("{0} % des Kontingents", pct(peak, t.hoursPerMonth))}>
        <span className="act" style={{ width: `${(t.used / scale) * 100}%` }} />
        <span className={`fc ${r.status}`} style={{ width: `${(Math.max(0, t.avg3 - t.used) / scale) * 100}%` }} />
        <span className="bud" style={{ left: `${(t.hoursPerMonth / scale) * 100}%` }} />
      </div>
      <dl className="ib-figs">
        <div><dt>{tr("Kontingent pro Monat")}</dt><dd className="num">{fmtH(t.hoursPerMonth)}</dd></div>
        <div><dt>{tr("Gebucht diesen Monat")}</dt><dd className="num">{fmtH(t.used)}<small>{pct(t.used, t.hoursPerMonth)} %</small></dd></div>
        <div><dt>{tr("Schnitt der letzten 3 Monate")}</dt><dd className={`num ${t.avg3 > t.hoursPerMonth ? "alert" : ""}`}>{fmtH(t.avg3)}<small>{pct(t.avg3, t.hoursPerMonth)} %</small></dd></div>
      </dl>
      <p className="ib-explain">
        {t.avg3 > t.hoursPerMonth
          ? <>{tr("In den letzten drei Monaten wurden im Schnitt {0} mehr gebucht, als das Kontingent enthält. Das Kontingent oder die Abrechnung der Mehrstunden sollte mit dem Kunden besprochen werden.", fmtH(t.avg3 - t.hoursPerMonth))}</>
          : <>{tr("Das Kontingent ist zu über 95 % genutzt. Weitere Stunden in diesem Monat gehen über das Vereinbarte hinaus.")}</>}
      </p>
      <div className="ib-detail-actions">
        <a className="btn primary" href={`#projekte/p/${r.project.id}`}>{tr("Projekt öffnen")}</a>
        <a className="btn" href="#reports">{tr("Report")}</a>
      </div>
    </>
  );
}

function BudgetDetail({ r }: { r: ProjectReport }) {
  const { factor } = useStore();
  if (r.retainer) return <RetainerDetail r={r} />;
  const money = (v: number) => fmtMoney(v, r.currency);
  const scale = Math.max(r.budget, r.forecastCost, 1);
  const rows: [string, string, string?][] = [
    [tr("Budget"), money(r.budget)],
    [tr("Verbraucht"), money(r.actualCost), `${pct(r.actualCost, r.budget)} %`],
    [tr("Prognose"), money(r.forecastCost), `${pct(r.forecastCost, r.budget)} %`],
    [r.variance < 0 ? tr("Überschreitung") : tr("Reserve"), money(Math.abs(r.variance))],
    [tr("Story Points offen"), fmt1(r.spOpen).replace(/[.,]0$/, "")],
  ];
  return (
    <>
      <div>
        <p className="ib-eyebrow">{r.customer.name}</p>
        <h2>{r.project.name}</h2>
      </div>
      <div className="ib-bar" role="img" aria-label={tr("Verbraucht {0} %, Prognose {1} % des Budgets", pct(r.actualCost, r.budget), pct(r.forecastCost, r.budget))}>
        <span className="act" style={{ width: `${(r.actualCost / scale) * 100}%` }} />
        <span className={`fc ${r.status}`} style={{ width: `${(Math.max(0, r.forecastCost - r.actualCost) / scale) * 100}%` }} />
        <span className="bud" style={{ left: `${(r.budget / scale) * 100}%` }} />
      </div>
      <dl className="ib-figs">
        {rows.map(([k, v, p]) => (
          <div key={k}><dt>{k}</dt><dd className={`num ${k === tr("Überschreitung") ? "alert" : ""}`}>{v}{p && <small>{p}</small>}</dd></div>
        ))}
      </dl>
      <p className="ib-explain">
        {r.spOpen > 0 && factor
          ? <>{tr("Für die offenen {0} Story Points rechnet die Prognose mit {1} Stunden pro Story Point, also noch rund {2} Stunden.", fmt1(r.spOpen).replace(/[.,]0$/, ""), fmt1(factor.current), fmt1(r.remainingHours))}{" "}</>
          : <>{tr("Die Prognose stützt sich auf die gebuchten Stunden und den Restaufwand der Subprojekte.")}{" "}</>}
        {r.variance < 0 ? <>{tr("Damit überschreitet das Projekt sein Budget um {0}.", money(-r.variance))}</> : <>{tr("Danach bleiben {0} Reserve, das sind weniger als 5 % des Budgets.", money(r.variance))}</>}
      </p>
      <div className="ib-detail-actions">
        <a className="btn primary" href={`#projekte/p/${r.project.id}`}>{tr("Projekt öffnen")}</a>
        <a className="btn" href="#reports">{tr("Report")}</a>
      </div>
    </>
  );
}

/** One sentence on what is waiting, instead of a generic greeting. */
function summary(groups: Group[]): string {
  const n = (label: string) => groups.find((g) => g.label === label)?.items.length ?? 0;
  const parts = [
    n(tr("Budget")) && trn(n(tr("Budget")), "{0} Budget knapp", "{0} Budgets knapp"),
    n(tr("Freigaben")) && trn(n(tr("Freigaben")), "{0} Freigabe offen", "{0} Freigaben offen"),
    n(tr("Du")) && trn(n(tr("Du")), "{0} eigene Pendenz", "{0} eigene Pendenzen"),
  ].filter(Boolean) as string[];
  if (!parts.length) return tr("Nichts offen");
  return parts.length === 1 ? parts[0] : tr("{0} und {1}", parts.slice(0, -1).join(", "), parts[parts.length - 1]);
}

export function Inbox() {
  const { data, notify } = useStore();
  const groups = useInbox();
  const all = groups.flatMap((g) => g.items);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const current = all.find((i) => i.id === selected && i.report) ?? all.find((i) => i.report);
  const today = new Intl.DateTimeFormat(intlLocale, { weekday: "long", day: "numeric", month: "long" }).format(new Date(`${data.today}T12:00:00`));

  const act = async (item: Item, a: Action) => {
    setBusy(item.id);
    try { await a.run(); notify(a.done); } catch (e) { notify((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <div className={`inbox ${current ? "with-detail" : ""}`}>
      <section className="ib-main" aria-label={tr("Eingang")}>
        <div className="ib-head">
          <div>
            <h1>{tr("Eingang")}</h1>
            <p className="sub"><span className="ib-date">{today}</span>{summary(groups)}.</p>
          </div>
          <a className="btn" href="#dashboard">{tr("Dashboard")}</a>
        </div>
        <GettingStarted />
        <Stats />
        {all.length === 0 && (
          <div className="ib-empty">
            <strong>{tr("Alles erledigt.")}</strong>
            <span>{tr("Keine offenen Budgets, Freigaben oder Rückfragen.")}</span>
          </div>
        )}
        {groups.map((g) => (
          <div key={g.label} className="ib-group" role="list" aria-label={g.label}>
            <div className="ib-group-label">{g.label}<span>{g.items.length}</span></div>
            {g.items.map((it) => {
              const body = (
                <>
                  <Marker item={it} />
                  <span className="ib-text"><span className="t">{it.title}</span> <span className="m">{it.meta}</span></span>
                  {it.actions ? (
                    <span className="ib-actions">
                      {it.actions.map((a) => (
                        <button key={a.label} className={`btn small ${a.primary ? "ib-go" : "ghost"}`} disabled={busy === it.id} onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); void act(it, a); }}>{a.primary && <Icon.approve />}{a.label}</button>
                      ))}
                    </span>
                  ) : <span className="ib-when">{it.when ?? (it.href ? "→" : "")}</span>}
                </>
              );
              if (it.report) return <button key={it.id} role="listitem" className={`ib-row ${current?.id === it.id ? "on" : ""}`} onClick={() => setSelected(it.id)}>{body}</button>;
              if (it.href) return <a key={it.id} role="listitem" className="ib-row" href={it.href}>{body}</a>;
              return <div key={it.id} role="listitem" className="ib-row">{body}</div>;
            })}
          </div>
        ))}
      </section>
      {current?.report && (
        <aside className="ib-detail" aria-label={tr("Details")}>
          <div className="ib-detail-in"><BudgetDetail r={current.report} /></div>
        </aside>
      )}
    </div>
  );
}
