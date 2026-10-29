import { useState } from "react";
import { absenceDays, addMonths, fmt1, fmtCHF, fmtCHF2, fmtDate, fmtH, fmtMoney, fmtMonthLong, monthOf, vacationSummary, workBalance, type ProjectReport } from "@taktwerk/domain";
import { useStore } from "../store";

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
  actions?: Action[];
  report?: ProjectReport;
}
interface Group { label: string; items: Item[] }

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
const days = (n: number) => `${fmt1(n).replace(/[.,]0$/, "")} ${n === 1 ? "Tag" : "Tage"}`;
const range = (from: string, to: string) => (from === to ? fmtDate(from) : `${fmtDate(from).slice(0, 6)} bis ${fmtDate(to)}`);
const ago = (date: string, today: string) => {
  const d = Math.round((Date.parse(today) - Date.parse(date.slice(0, 10))) / 86_400_000);
  return d <= 0 ? "heute" : d === 1 ? "gestern" : `vor ${d} Tagen`;
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
        return { id: `b-${r.project.id}`, dot, report: r, title: r.status === "over" ? `${r.project.name} überzieht das Monatskontingent` : `${r.project.name}: Kontingent fast aufgebraucht`, meta: `${r.customer.name} · ${fmt1(peak)} von ${fmt1(r.retainer.hoursPerMonth)} h pro Monat` };
      }
      return r.status === "over"
        ? { id: `b-${r.project.id}`, dot: "over", report: r, title: `${r.project.name} läuft auf ${pct(r.forecastCost, r.budget)} % des Budgets`, meta: `${r.customer.name} · Prognose ${money(r.forecastCost)}` }
        : { id: `b-${r.project.id}`, dot: "risk", report: r, title: `${r.project.name} wird knapp`, meta: `${r.customer.name} · Reserve ${money(r.variance)}` };
    });
  if (budget.length) groups.push({ label: "Budget", items: budget });

  const approvals: Item[] = [];
  if (scope.managesPeople && !scope.readOnly) {
    const others = (id: string) => id !== currentUserId && scope.manages(id);
    for (const a of (data.absences ?? []).filter((x) => x.status === "requested" && others(x.employeeId)).sort((x, y) => x.startDate.localeCompare(y.startDate))) {
      const vac = a.type === "Ferien" ? vacationSummary(data, a.employeeId, Number(a.startDate.slice(0, 4))) : null;
      const n = absenceDays(data, a);
      approvals.push({
        id: `a-${a.id}`, dot: "ring",
        title: `${name(a.employeeId)}: ${a.type} ${range(a.startDate, a.endDate)}`,
        meta: [days(n), vac ? `danach ${days(vac.remaining - n)} Ferien übrig` : "", a.note ?? ""].filter(Boolean).join(" · "),
        actions: [
          { label: "Ablehnen", done: `${a.type} abgelehnt`, run: () => decideAbsence(a.id, false) },
          { label: "Bewilligen", primary: true, done: `${a.type} bewilligt`, run: () => decideAbsence(a.id, true) },
        ],
      });
    }
    const expenses = data.expenses.filter((x) => x.status === "requested" && others(x.employeeId)).sort((x, y) => x.date.localeCompare(y.date));
    for (const x of expenses.slice(0, MAX_EXPENSES)) {
      approvals.push({
        id: `x-${x.id}`, dot: "ring", when: ago(x.date, data.today),
        title: `${name(x.employeeId)}: ${x.category}, ${x.reason}`,
        meta: `${fmtCHF2(x.amount)} · ${x.receipt ? "Beleg vorhanden" : "ohne Beleg"}`,
        actions: [
          { label: "Ablehnen", done: "Spese abgelehnt", run: () => decideExpense(x.id, false) },
          { label: "Bewilligen", primary: true, done: "Spese bewilligt", run: () => decideExpense(x.id, true) },
        ],
      });
    }
    if (expenses.length > MAX_EXPENSES) {
      const rest = expenses.slice(MAX_EXPENSES);
      approvals.push({ id: "x-more", dot: "ring", href: "#abschluss", title: `${rest.length} weitere Spesen`, meta: `zusammen ${fmtCHF2(rest.reduce((s, x) => s + x.amount, 0))} · im Monatsabschluss` });
    }
    for (const c of closings.filter((c) => c.month === lastMonth && c.status === "submitted" && others(c.userId))) {
      approvals.push({
        id: `c-${c.userId}`, dot: "ring",
        title: `${name(c.userId)}: ${fmtMonthLong(lastMonth)} eingereicht`,
        meta: "Monatsabschluss wartet auf deine Freigabe",
        actions: [
          { label: "Zurückweisen", done: "Zur Korrektur zurückgegeben", run: () => closeMonth("reopen", lastMonth, c.userId) },
          { label: "Freigeben", primary: true, done: `${fmtMonthLong(lastMonth)} freigegeben`, run: () => closeMonth("approve", lastMonth, c.userId) },
        ],
      });
    }
  }
  if (approvals.length) groups.push({ label: "Freigaben", items: approvals });

  const own: Item[] = [];
  // People who started recording this month (e.g. a new company) have nothing to submit for last month.
  const myStart = data.employees.find((e) => e.id === currentUserId)?.trackingStart;
  if (role !== "auditor" && data.employees.some((e) => e.id === currentUserId) && (!myStart || myStart.slice(0, 7) <= lastMonth) && !closings.some((c) => c.userId === currentUserId && c.month === lastMonth)) {
    own.push({ id: "own-close", dot: "dashed", href: "#abschluss", title: `${fmtMonthLong(lastMonth)} noch nicht eingereicht`, meta: "Stunden prüfen und den Monat abschliessen" });
  }
  for (const q of questions) {
    const mine = q.ownerId === currentUserId;
    if (!mine && role === "employee") continue;
    own.push({
      id: `q-${q.entryId}`, dot: "dashed", href: `#zeit/e/${q.entryId}`, when: ago(q.createdAt, data.today),
      title: mine ? `Rückfrage zu deiner Buchung vom ${fmtDate(q.date)}` : `Rückfrage an ${name(q.ownerId)} noch offen`,
      meta: `«${q.text}» · ${q.reason}`,
    });
  }
  if (own.length) groups.push({ label: "Du", items: own });
  return groups;
}

function Stats() {
  const { data, role, currentUserId, factor } = useStore();
  const reports = useVisibleReports();
  const month = monthOf(data.today);
  const entries = data.timeEntries.filter((e) => monthOf(e.date) === month && (role !== "employee" || e.employeeId === currentUserId));
  const hours = entries.reduce((s, e) => s + e.hours, 0);
  const billable = entries.filter((e) => e.billable).reduce((s, e) => s + e.hours * e.hourlyRate, 0);
  const monthName = fmtMonthLong(month).split(" ")[0];
  const stats: { label: string; value: string; tone?: string }[] = [
    { label: `Stunden ${monthName}`, value: fmt1(hours) },
    { label: "Verrechenbar CHF", value: fmtCHF(billable).replace(/^CHF\s*/, "") },
  ];
  if (role === "employee") {
    if (data.employees.some((e) => e.id === currentUserId)) {
      const b = workBalance(data, currentUserId).balance;
      stats.push({ label: "Überzeit", value: `${b >= 0 ? "+" : "−"}${fmtH(Math.abs(b))}`, tone: b < 0 ? "neg" : undefined });
      stats.push({ label: "Ferien übrig", value: days(vacationSummary(data, currentUserId).remaining) });
    }
  } else {
    const atRisk = reports.filter((r) => r.status !== "ok").length;
    stats.push({ label: "Velocity h/SP", value: factor ? fmt1(factor.current) : "–" });
    stats.push({ label: "Budgets in Gefahr", value: String(atRisk), tone: atRisk > 0 ? "alert" : undefined });
  }
  return (
    <div className="ib-stats">
      {stats.map((s) => (
        <div key={s.label}><span>{s.label}</span><strong className={`num ${s.tone ?? ""}`}>{s.value}</strong></div>
      ))}
    </div>
  );
}

function RetainerDetail({ r }: { r: ProjectReport }) {
  const t = r.retainer!;
  const peak = Math.max(t.used, t.avg3);
  const scale = Math.max(t.hoursPerMonth, peak, 1);
  return (
    <>
      <div>
        <p className="ib-eyebrow">{r.customer.name} · Monatskontingent</p>
        <h2>{r.project.name}</h2>
      </div>
      <div className="ib-bar" role="img" aria-label={`${pct(peak, t.hoursPerMonth)} % des Kontingents`}>
        <span className="act" style={{ width: `${(t.used / scale) * 100}%` }} />
        <span className={`fc ${r.status}`} style={{ width: `${(Math.max(0, t.avg3 - t.used) / scale) * 100}%` }} />
        <span className="bud" style={{ left: `${(t.hoursPerMonth / scale) * 100}%` }} />
      </div>
      <dl className="ib-figs">
        <div><dt>Kontingent pro Monat</dt><dd className="num">{fmtH(t.hoursPerMonth)}</dd></div>
        <div><dt>Gebucht diesen Monat</dt><dd className="num">{fmtH(t.used)}<small>{pct(t.used, t.hoursPerMonth)} %</small></dd></div>
        <div><dt>Schnitt der letzten 3 Monate</dt><dd className={`num ${t.avg3 > t.hoursPerMonth ? "alert" : ""}`}>{fmtH(t.avg3)}<small>{pct(t.avg3, t.hoursPerMonth)} %</small></dd></div>
      </dl>
      <p className="ib-explain">
        {t.avg3 > t.hoursPerMonth
          ? <>In den letzten drei Monaten wurden im Schnitt {fmtH(t.avg3 - t.hoursPerMonth)} mehr gebucht, als das Kontingent enthält. Das Kontingent oder die Abrechnung der Mehrstunden sollte mit dem Kunden besprochen werden.</>
          : <>Das Kontingent ist zu über 95 % genutzt. Weitere Stunden in diesem Monat gehen über das Vereinbarte hinaus.</>}
      </p>
      <div className="ib-detail-actions">
        <a className="btn primary" href={`#projekte/p/${r.project.id}`}>Projekt öffnen</a>
        <a className="btn" href="#reports">Report</a>
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
    ["Budget", money(r.budget)],
    ["Verbraucht", money(r.actualCost), `${pct(r.actualCost, r.budget)} %`],
    ["Prognose", money(r.forecastCost), `${pct(r.forecastCost, r.budget)} %`],
    [r.variance < 0 ? "Überschreitung" : "Reserve", money(Math.abs(r.variance))],
    ["Story Points offen", fmt1(r.spOpen).replace(/[.,]0$/, "")],
  ];
  return (
    <>
      <div>
        <p className="ib-eyebrow">{r.customer.name}</p>
        <h2>{r.project.name}</h2>
      </div>
      <div className="ib-bar" role="img" aria-label={`Verbraucht ${pct(r.actualCost, r.budget)} %, Prognose ${pct(r.forecastCost, r.budget)} % des Budgets`}>
        <span className="act" style={{ width: `${(r.actualCost / scale) * 100}%` }} />
        <span className={`fc ${r.status}`} style={{ width: `${(Math.max(0, r.forecastCost - r.actualCost) / scale) * 100}%` }} />
        <span className="bud" style={{ left: `${(r.budget / scale) * 100}%` }} />
      </div>
      <dl className="ib-figs">
        {rows.map(([k, v, p]) => (
          <div key={k}><dt>{k}</dt><dd className={`num ${k === "Überschreitung" ? "alert" : ""}`}>{v}{p && <small>{p}</small>}</dd></div>
        ))}
      </dl>
      <p className="ib-explain">
        {r.spOpen > 0 && factor
          ? <>Für die offenen {fmt1(r.spOpen).replace(/[.,]0$/, "")} Story Points rechnet die Prognose mit {fmt1(factor.current)} Stunden pro Story Point, also noch rund {fmt1(r.remainingHours)} Stunden. </>
          : <>Die Prognose stützt sich auf die gebuchten Stunden und den Restaufwand der Subprojekte. </>}
        {r.variance < 0 ? <>Damit überschreitet das Projekt sein Budget um {money(-r.variance)}.</> : <>Danach bleiben {money(r.variance)} Reserve, das sind weniger als 5 % des Budgets.</>}
      </p>
      <div className="ib-detail-actions">
        <a className="btn primary" href={`#projekte/p/${r.project.id}`}>Projekt öffnen</a>
        <a className="btn" href="#reports">Report</a>
      </div>
    </>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 11 ? "Guten Morgen" : h < 17 ? "Guten Tag" : "Guten Abend";
}

export function Inbox({ firstName }: { firstName: string }) {
  const { data, notify } = useStore();
  const groups = useInbox();
  const all = groups.flatMap((g) => g.items);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const current = all.find((i) => i.id === selected && i.report) ?? all.find((i) => i.report);
  const today = new Intl.DateTimeFormat("de-CH", { weekday: "long", day: "numeric", month: "long" }).format(new Date(`${data.today}T12:00:00`));

  const act = async (item: Item, a: Action) => {
    setBusy(item.id);
    try { await a.run(); notify(a.done); } catch (e) { notify((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <div className={`inbox ${current ? "with-detail" : ""}`}>
      <section className="ib-main" aria-label="Eingang">
        <div className="ib-head">
          <div>
            <h1>Eingang</h1>
            <p className="sub">{greeting()}, {firstName} · {today}</p>
          </div>
          <a className="btn" href="#dashboard">Dashboard</a>
        </div>
        <Stats />
        {all.length === 0 && (
          <div className="ib-empty">
            <strong>Alles erledigt.</strong>
            <span>Keine offenen Budgets, Freigaben oder Rückfragen.</span>
          </div>
        )}
        {groups.map((g) => (
          <div key={g.label} className="ib-group" role="list" aria-label={g.label}>
            <div className="ib-group-label">{g.label} · {g.items.length}</div>
            {g.items.map((it) => {
              const body = (
                <>
                  <span className={`ib-dot ${it.dot}`} aria-hidden />
                  <span className="ib-text"><span className="t">{it.title}</span> <span className="m">{it.meta}</span></span>
                  {it.actions ? (
                    <span className="ib-actions">
                      {it.actions.map((a) => (
                        <button key={a.label} className={`btn small ${a.primary ? "primary" : ""}`} disabled={busy === it.id} onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); void act(it, a); }}>{a.label}</button>
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
        <aside className="ib-detail" aria-label="Details">
          <div className="ib-detail-in"><BudgetDetail r={current.report} /></div>
        </aside>
      )}
    </div>
  );
}
