import { Fragment, useEffect, useState } from "react";
import { PROJECT_KINDS, addMonths, currencyOf, fmt1, fmtCHF, fmtCHF2, fmtDate, fmtMoney, fmtMonth, fmtMonthLong, fmtNum, monthOf, type Currency, type Figures, type PostalAddress, type ProfitRow } from "@taktwerk/domain";
import { useBexio } from "./Bexio";
import { api, type Invoice, type InvoicePosition, type InvoiceStatus } from "../api";
import { useStore } from "../store";
import { BulletBars, BurnUpChart, Icon, Money, StatusPill, reportToBullet } from "../ui/components";
import { Select } from "../ui/Select";
import { Field, FieldRow, FormDialog } from "../ui/Dialog";
import { tr } from "../i18n";

/** PDF/Excel download, recipients and «send now» for one customer. */
function ReportExport({ customerId }: { customerId: string }) {
  const { data, mode, notify } = useStore();
  const current = monthOf(data.today);
  const months = [0, 1, 2, 3, 4, 5].map((n) => addMonths(current, -n));
  const [month, setMonth] = useState(addMonths(current, -1));
  const [recipients, setRecipients] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [reportDay, setReportDay] = useState(3);
  const [error, setError] = useState("");
  const demo = mode === "demo";

  useEffect(() => {
    setError("");
    if (demo) return;
    api<{ reportDay?: number }>("/api/settings").then((s) => setReportDay(s.reportDay ?? 3)).catch(() => {});
    api<{ recipients: string[] }>(`/api/customers/${customerId}/recipients`)
      .then((r) => {
        setRecipients(r.recipients.join(", "));
        setSaved(r.recipients.join(", "));
      })
      .catch((e) => setError((e as Error).message));
  }, [customerId, demo]);

  const list = recipients.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const saveRecipients = async () => {
    try {
      const r = await api<{ recipients: string[] }>(`/api/customers/${customerId}/recipients`, { method: "PUT", body: { recipients: list } });
      setRecipients(r.recipients.join(", "));
      setSaved(r.recipients.join(", "));
      setError("");
      notify(r.recipients.length ? tr("Empfänger gespeichert") : tr("Automatischer Versand ausgeschaltet"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const sendNow = async () => {
    setBusy(true);
    try {
      const r = await api<{ sentTo: string[] }>(`/api/customers/${customerId}/report/send`, { body: { month } });
      setError("");
      notify(tr("Report {0} an {1} Empfänger gesendet", fmtMonthLong(month), r.sentTo.length));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const href = (format: "pdf" | "xlsx") => `/api/customers/${customerId}/report?month=${month}&format=${format}`;

  return (
    <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="tree-row">
        <h2>{tr("Report exportieren und versenden")}</h2>
        {demo && <span className="muted" style={{ fontSize: "0.8rem" }}>{tr("Export und Versand funktionieren in der installierten Version.")}</span>}
      </div>
      <div className="export-bar">
        <label className="field">
          <span>{tr("Leistungsnachweis für")}</span>
          <Select id="r-month" value={month} onChange={setMonth} options={months.map((m) => ({ value: m, label: fmtMonthLong(m) }))} />
        </label>
        {demo ? (
          <>
            <button className="btn" disabled><Icon.download />{tr("PDF")}</button>
            <button className="btn" disabled><Icon.download />{tr("Excel")}</button>
          </>
        ) : (
          <>
            <a className="btn" href={href("pdf")} download><Icon.download />{tr("PDF")}</a>
            <a className="btn" href={href("xlsx")} download><Icon.download />{tr("Excel")}</a>
          </>
        )}
        <button className="btn primary" disabled={demo || busy || !saved} title={!saved ? tr("Zuerst Empfänger hinterlegen") : undefined} onClick={sendNow}>
          <Icon.mail />{busy ? tr("Sende …") : tr("Jetzt senden")}
        </button>
      </div>
      <div className="export-bar">
        <label className="field" style={{ flex: "1 1 320px" }}>
          <span>{tr("Empfänger beim Kunden (automatischer Versand am Monatsanfang)")}</span>
          <input id="r-recipients" className="input" placeholder={tr("z. B. einkauf@kunde.ch, projektleitung@kunde.ch")} value={recipients} disabled={demo} onChange={(e) => setRecipients(e.target.value)} />
        </label>
        <button className="btn" disabled={demo || recipients === saved} onClick={saveRecipients}>{tr("Empfänger speichern")}</button>
      </div>
      <p className="muted" style={{ fontSize: "0.8rem", margin: 0 }}>
        {saved
          ? tr("Der Report des Vormonats geht automatisch am {0}. des Monats ab 07:00 Uhr an {1}.", reportDay, saved)
          : tr("Ohne Empfänger wird dieser Kunde beim automatischen Versand übersprungen.")}
      </p>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

const INVOICE_STATUS: Record<InvoiceStatus, { label: string; cls: string }> = {
  draft: { label: tr("Entwurf"), cls: "neutral" },
  sent: { label: tr("Versendet"), cls: "risk" },
  paid: { label: tr("Bezahlt"), cls: "ok" },
  cancelled: { label: tr("Storniert"), cls: "over" },
};
const EMPTY_ADDRESS: PostalAddress = { name: "", street: "", zip: "", city: "", country: "CH" };

/** Invoices for one customer: billing address, preview and creation for a month, list with PDF, send and status. */
function Invoices({ customerId }: { customerId: string }) {
  const { data, mode, notify } = useStore();
  const current = monthOf(data.today);
  const months = [0, 1, 2, 3, 4, 5].map((n) => addMonths(current, -n));
  const [month, setMonth] = useState(addMonths(current, -1));
  const [rows, setRows] = useState<Invoice[]>([]);
  const [ready, setReady] = useState<string | null>(null);
  const [address, setAddress] = useState<PostalAddress>(EMPTY_ADDRESS);
  const [editAddress, setEditAddress] = useState(false);
  const [preview, setPreview] = useState<{ positions: InvoicePosition[]; net: number } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const bexio = useBexio();
  const [error, setError] = useState("");
  const demo = mode === "demo";

  const reload = async () => {
    const r = await api<{ invoices: Invoice[]; ready: string | null }>(`/api/invoices?customerId=${customerId}`);
    setRows(r.invoices);
    setReady(r.ready);
  };
  useEffect(() => {
    setError("");
    setShowPreview(false);
    if (demo) return;
    reload().catch((e) => setError((e as Error).message));
    api<PostalAddress>(`/api/customers/${customerId}/address`)
      .then((a) => {
        setAddress(a);
      })
      .catch(() => {});
  }, [customerId, demo]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (demo) return;
    setPreview(null);
    api<{ positions: InvoicePosition[]; net: number }>(`/api/invoices/preview?customerId=${customerId}&month=${month}`).then(setPreview).catch(() => {});
  }, [customerId, month, demo]);

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      await reload();
      setError("");
      notify(msg);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const create = () => run(() => api("/api/invoices", { body: { customerId, month } }), tr("Rechnung für {0} erstellt", fmtMonthLong(month)));
  const send = (i: Invoice) => run(() => api(`/api/invoices/${i.id}/send`, { body: {} }), tr("Rechnung {0} versendet", i.number));
  const status = (i: Invoice, status: InvoiceStatus, msg: string) => run(() => api(`/api/invoices/${i.id}/status`, { body: { status } }), msg);
  const toBexio = (i: Invoice) => run(async () => {
    const r = await api<{ url: string }>(`/api/invoices/${i.id}/bexio`, { body: {} });
    window.open(r.url, "_blank", "noopener");
  }, tr("{0} als Entwurf in bexio angelegt", i.number));
  const remove = (i: Invoice) => run(() => api(`/api/invoices/${i.id}`, { method: "DELETE" }), tr("Entwurf gelöscht"));
  const existing = rows.find((i) => i.month === month && i.status !== "cancelled");
  const addressOk = address.name.trim() && address.zip.trim() && address.city.trim();

  if (demo) {
    return (
      <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2>{tr("Rechnungen")}</h2>
        <p className="muted" style={{ margin: 0, fontSize: "0.86rem" }}>
          {tr("In der installierten Version erstellst du hier pro Monat eine Rechnung aus den verrechenbaren Stunden und bewilligten Spesen: PDF mit Schweizer QR-Rechnung, Versand per E-Mail, Status Entwurf → Versendet → Bezahlt.")}
        </p>
      </section>
    );
  }

  return (
    <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="tree-row">
        <h2>{tr("Rechnungen")}</h2>
        {ready && <span className="pill risk">{ready}</span>}
      </div>
      <div className="address-line">
        <span>{tr("Rechnungsadresse:")}{" "}{addressOk ? `${address.name}, ${address.street ? `${address.street}, ` : ""}${address.zip} ${address.city}` : <span className="neg">{tr("fehlt, für die QR-Rechnung nötig")}</span>}</span>
        <button id="i-edit-address" className="btn small" onClick={() => setEditAddress(true)}>{addressOk ? tr("Bearbeiten") : tr("Erfassen")}</button>
      </div>
      {editAddress && (
        <AddressDialog initial={address} onClose={() => setEditAddress(false)} onSave={async (a) => {
          const saved = await api<PostalAddress>(`/api/customers/${customerId}/address`, { method: "PUT", body: a });
          setAddress(saved);
          notify(tr("Rechnungsadresse gespeichert"));
        }} />
      )}
      <div className="export-bar">
        <label className="field">
          <span>{tr("Rechnung für")}</span>
          <Select id="i-month" value={month} onChange={setMonth} options={months.map((m) => ({ value: m, label: fmtMonthLong(m) }))} />
        </label>
        <span className="muted" style={{ fontSize: "0.82rem" }}>
          {preview ? (preview.positions.length ? tr("{0} Positionen · netto {1}", preview.positions.length, fmtCHF2(preview.net)) : tr("Keine verrechenbaren Stunden oder Spesen")) : "…"}
        </span>
        {preview && preview.positions.length > 0 && <button className="btn small ghost" onClick={() => setShowPreview(!showPreview)}>{showPreview ? tr("Vorschau ausblenden") : tr("Vorschau")}</button>}
        <button id="i-create" className="btn primary" disabled={busy || !!ready || !preview?.positions.length || !!existing || !addressOk} title={existing ? tr("Für {0} gibt es bereits {1}", fmtMonthLong(month), existing.number) : ready ?? undefined} onClick={create}>
          {tr("Rechnung erstellen")}
        </button>
      </div>
      {showPreview && preview && (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>{tr("Position")}</th><th className="r">{tr("Menge")}</th><th className="r">{tr("Ansatz")}</th><th className="r">{tr("Betrag")}</th></tr></thead>
            <tbody>
              {preview.positions.map((p, i) => (
                <tr key={i}><td>{p.text}{p.detail && <div className="muted" style={{ fontSize: "0.76rem" }}>{p.detail}</div>}</td><td className="r num">{fmtNum(p.quantity)} {p.unit}</td><td className="r num">{fmtCHF2(p.unitPrice)}</td><td className="r num">{fmtCHF2(p.amount)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>{tr("Nummer")}</th><th>{tr("Monat")}</th><th>{tr("Datum")}</th><th>{tr("Fällig")}</th><th className="r">{tr("Netto")}</th><th className="r">{tr("Brutto")}</th><th>{tr("Status")}</th><th className="r">{tr("Aktion")}</th></tr></thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td className="num">{i.number}</td>
                  <td>{fmtMonth(i.month)}</td>
                  <td className="num">{fmtDate(i.issueDate)}</td>
                  <td className="num">{fmtDate(i.dueDate)}</td>
                  <td className="r num">{fmtCHF2(i.net)}</td>
                  <td className="r num">{fmtCHF2(i.gross)}</td>
                  <td><span className={`pill ${INVOICE_STATUS[i.status].cls}`}>{INVOICE_STATUS[i.status].label}</span></td>
                  <td>
                    <div className="closing-actions">
                      <a className="btn small" href={`/api/invoices/${i.id}/pdf`} download title={tr("PDF mit QR-Rechnung")}><Icon.download />{tr("PDF")}</a>
                      {i.status !== "cancelled" && i.status !== "paid" && <button className="btn small" disabled={busy} onClick={() => send(i)}><Icon.mail />{i.status === "sent" ? tr("Erneut senden") : tr("Senden")}</button>}
                      {i.status === "sent" && <button className="btn small primary" disabled={busy} onClick={() => status(i, "paid", tr("{0} als bezahlt markiert", i.number))}>{tr("Bezahlt")}</button>}
                      {bexio && i.status !== "cancelled" && (i.bexioId
                        ? <a className="btn small ghost" href={`https://office.bexio.com/index.php/kb_invoice/show/id/${i.bexioId}`} target="_blank" rel="noreferrer">{tr("In bexio")}</a>
                        : <button className="btn small" disabled={busy} onClick={() => toBexio(i)}>{tr("An bexio")}</button>)}
                      {i.status === "draft" && <button className="btn small ghost" disabled={busy} onClick={() => remove(i)}>{tr("Löschen")}</button>}
                      {(i.status === "sent" || i.status === "paid") && <button className="btn small ghost" disabled={busy} onClick={() => status(i, "cancelled", tr("{0} storniert", i.number))}>{tr("Stornieren")}</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ fontSize: "0.8rem", margin: 0 }}>
        {tr("Die Rechnung fasst verrechenbare Stunden pro Subprojekt und Stundensatz sowie bewilligte, weiterverrechenbare Spesen zusammen. Das PDF enthält den Schweizer QR-Zahlteil; Nummern laufen pro Jahr fort, versendete Rechnungen werden storniert statt gelöscht.")}
      </p>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function Row({ f, name, sub, cls, onClick, open }: { f: Figures; name: React.ReactNode; sub?: string; cls: string; onClick?: () => void; open?: boolean }) {
  return (
    <tr className={cls} onClick={onClick}>
      <td>
        {onClick && <span className={`caret ${open ? "open" : ""}`}>▸</span>}
        {name}
        {sub && <div className="muted" style={{ fontSize: "0.76rem", fontWeight: 400 }}>{sub}</div>}
      </td>
      <td className="r">{fmtCHF(f.budget)}</td>
      <td className="r">{fmtCHF(f.actualCost)}</td>
      <td className="r"><Money v={f.remainingBudget} signed={f.remainingBudget < 0} /></td>
      <td className="r">{fmtNum(f.spOpen)}</td>
      <td className="r">{fmtNum(f.remainingHours)}{" "}{tr("h")}</td>
      <td className="r">
        {fmtCHF(f.forecastCost)}
        <div className="muted" style={{ fontSize: "0.72rem", fontWeight: 400 }}>{fmtCHF(f.forecastLow)} – {fmtCHF(f.forecastHigh)}</div>
      </td>
      <td className="r"><Money v={f.variance} signed /></td>
      <td style={{ whiteSpace: "nowrap" }}>{f.completionMonth ? fmtMonth(f.completionMonth) : tr("offen")}</td>
      <td><StatusPill status={f.status} /></td>
    </tr>
  );
}

const pct = (v: number | null) => (v === null ? "–" : `${fmt1(v * 100)} %`);
const marginCls = (v: number | null) => (v === null ? "" : v < 0 ? "neg" : v < 0.2 ? "warn" : "pos");

/** Leads: revenue against internal cost per project and customer, everything converted to CHF. */
function ProfitSection({ customerId }: { customerId: string }) {
  const { profit, data, scope } = useStore();
  const [by, setBy] = useState<"projects" | "customers">(customerId ? "projects" : "customers");
  if (!scope.seesAll) return null;
  const rows: ProfitRow[] = (by === "projects" ? profit.projects : profit.customers).filter((r) => !customerId || r.customerId === customerId);
  const sum = rows.reduce((t, r) => ({ hours: t.hours + r.hours, revenue: t.revenue + r.revenue, cost: t.cost + r.cost, margin: t.margin + r.margin }), { hours: 0, revenue: 0, cost: 0, margin: 0 });
  const estimated = rows.some((r) => r.estimated);
  const kindLabel = (k: ProfitRow["kind"]) => tr(PROJECT_KINDS.find((x) => x.id === k)?.label ?? k);
  return (
    <section className="card">
      <div className="card-head" style={{ paddingBottom: 8, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2>{tr("Profitabilität")}</h2>
          <span className="muted" style={{ fontSize: "0.8rem" }}>{tr("Umsatz zum Kundensatz gegen Stunden × Kostensatz plus Spesen, alles in CHF")}{profit.from ? tr(", seit {0}", fmtMonth(profit.from)) : ""}</span>
        </div>
        {!customerId && (
          <div className="seg" role="tablist">
            <button role="tab" className={by === "customers" ? "on" : ""} onClick={() => setBy("customers")}>{tr("Nach Kunde")}</button>
            <button role="tab" className={by === "projects" ? "on" : ""} onClick={() => setBy("projects")}>{tr("Nach Projekt")}</button>
          </div>
        )}
      </div>
      <div className="table-wrap">
        <table className="data profit">
          <thead>
            <tr>
              <th>{by === "projects" ? tr("Projekt") : tr("Kunde")}</th>
              {by === "projects" && <th>{tr("Art")}</th>}
              <th className="r">{tr("Stunden")}</th><th className="r">{tr("Umsatz")}</th><th className="r">{tr("Umsatz/h")}</th><th className="r">{tr("Kosten")}</th><th className="r">{tr("Marge")}</th><th className="r">{tr("Marge %")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}{by === "projects" && !customerId && <div className="muted" style={{ fontSize: "0.76rem" }}>{r.customerName}</div>}</td>
                {by === "projects" && <td><span className="pill neutral">{kindLabel(r.kind)}</span>{r.currency !== "CHF" && <span className="muted" style={{ marginLeft: 6, fontSize: "0.76rem" }}>{r.currency}</span>}</td>}
                <td className="r num">{fmt1(r.hours)}</td>
                <td className="r num">{fmtCHF(r.revenue)}</td>
                <td className="r num">{r.revenuePerHour === null ? "–" : fmtCHF(r.revenuePerHour)}</td>
                <td className="r num">{fmtCHF(r.cost)}</td>
                <td className={`r num ${r.margin < 0 ? "neg" : ""}`}>{fmtCHF(r.margin)}</td>
                <td className={`r num ${marginCls(r.marginPct)}`}><strong>{pct(r.marginPct)}</strong></td>
              </tr>
            ))}
            {rows.length > 1 && (
              <tr className="total">
                <td>{tr("Total")}</td>
                {by === "projects" && <td />}
                <td className="r num">{fmt1(sum.hours)}</td>
                <td className="r num">{fmtCHF(sum.revenue)}</td>
                <td className="r num">{sum.hours ? fmtCHF(sum.revenue / sum.hours) : "–"}</td>
                <td className="r num">{fmtCHF(sum.cost)}</td>
                <td className={`r num ${sum.margin < 0 ? "neg" : ""}`}>{fmtCHF(sum.margin)}</td>
                <td className={`r num ${marginCls(sum.revenue ? sum.margin / sum.revenue : null)}`}><strong>{pct(sum.revenue ? sum.margin / sum.revenue : null)}</strong></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted card-pad" style={{ fontSize: "0.8rem", paddingTop: 8 }}>
        {tr("Fixpreis zählt den Festpreis als Umsatz, Retainer das Kontingent pro Monat mit Buchungen, Zeit und Material die verrechenbaren Stunden. Fremdwährungen mit dem Kurs vom")}{" "}{data.fx ? fmtDate(data.fx.asOf) : tr("Tag")}.
        {!customerId && profit.internal.hours > 0 && tr(" Interne Arbeit ({0} h, {1}) bleibt aussen vor.", fmt1(profit.internal.hours), fmtCHF(profit.internal.cost))}
        {estimated && tr(" Für Personen ohne Kostensatz gilt der Standard von {0}/h (Einstellungen → Rechnung).", fmtCHF(data.rates?.costRate ?? 95))}
      </p>
    </section>
  );
}

export function Reports() {
  const { data, reports, factor, velocitySettings, scope } = useStore();
  // Project leads only see the customers of the projects they lead.
  const customers = data.customers.filter((c) => scope.seesAll || data.projects.some((p) => p.customerId === c.id && scope.leadsProject(p.id)));
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? "");
  const [open, setOpen] = useState<Set<string>>(() => new Set(reports.filter((r) => r.customer.id === customerId).map((r) => r.project.id)));
  const [selected, setSelected] = useState<string | null>(null);

  const rows = reports.filter((r) => (!customerId || r.customer.id === customerId) && (scope.seesAll || scope.leadsProject(r.project.id)));
  const sum = (k: keyof Figures) => rows.reduce((s, r) => s + (r[k] as number), 0);
  const total = { budget: sum("budget"), actual: sum("actualCost"), forecast: sum("forecastCost") };
  const chart = rows.find((r) => r.project.id === selected) ?? rows[0];
  const customer = data.customers.find((c) => c.id === customerId);
  const cur: Currency = customer ? currencyOf(customer) : "CHF";
  const m = (v: number) => fmtMoney(v, cur);
  const toggle = (id: string) => {
    const n = new Set(open);
    if (n.has(id)) n.delete(id); else n.add(id);
    setOpen(n);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{tr("Kundenreport")}{customer ? `: ${customer.name}` : ""}</h1>
          <p className="sub">
            {tr("Stand {0} · Forecast mit", data.today.split("-").reverse().join("."))}{" "}{factor ? `${fmt1(factor.current)} h/SP` : "–"} (
            {velocitySettings.method === "rolling" ? tr("gleitender Schnitt") : "EWMA"}{" "}{tr("über {0} Monate, Stand", velocitySettings.window)}{" "}{factor ? fmtMonthLong(factor.asOf) : "–"})
          </p>
        </div>
        <label className="field" style={{ minWidth: 220 }}>
          <span>{tr("Kunde")}</span>
          <Select
            id="r-customer"
            value={customerId}
            onChange={(v) => { setCustomerId(v); setSelected(null); setOpen(new Set(reports.filter((r) => r.customer.id === v).map((r) => r.project.id))); }}
            options={[{ value: "", label: tr("Alle Kunden") }, ...customers.map((c) => ({ value: c.id, label: c.name }))]}
          />
        </label>
      </div>

      {customerId && scope.lead && <ReportExport customerId={customerId} />}
      {customerId && scope.lead && <Invoices customerId={customerId} />}

      <div className="tiles">
        <div className="card tile"><span className="label">{tr("Gesamtbudget")}</span><span className="value num">{m(total.budget)}</span>{!customerId && data.customers.some((c) => currencyOf(c) !== "CHF") && <span className="delta">{tr("Fremdwährungen nominal addiert")}</span>}</div>
        <div className="card tile"><span className="label">{tr("Verbraucht")}</span><span className="value num">{m(total.actual)}</span><span className="delta num">{fmt1((total.actual / Math.max(1, total.budget)) * 100)}{" "}{tr("% des Budgets")}</span></div>
        <div className="card tile"><span className="label">{tr("Verbleibendes Budget")}</span><span className="value num"><Money v={total.budget - total.actual} signed={total.budget - total.actual < 0} currency={cur} /></span></div>
        <div className="card tile"><span className="label">{tr("Forecast gesamt")}</span><span className="value num">{m(total.forecast)}</span>
          <span className="delta">{tr("Abweichung")}{" "}<Money v={total.budget - total.forecast} signed currency={cur} /></span></div>
      </div>

      <ProfitSection customerId={customerId} />

      <section className="card">
        <div className="card-head" style={{ paddingBottom: 8 }}><h2>{tr("Projekte und Subprojekte")}</h2><span className="muted" style={{ fontSize: "0.8rem" }}>{tr("Zeile anklicken zum Auf- und Zuklappen")}</span></div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{tr("Projekt / Subprojekt")}</th><th className="r">{tr("Budget")}</th><th className="r">{tr("Verbraucht")}</th><th className="r">{tr("Verbleibend")}</th>
                <th className="r">{tr("Offene SP")}</th><th className="r">{tr("Restaufwand")}</th><th className="r">{tr("Forecast")}</th><th className="r">{tr("Abweichung")}</th><th>{tr("Fertig ca.")}</th><th>{tr("Status")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.project.id}>
                  <Row f={r} name={r.project.name} sub={customerId ? undefined : r.customer.name} cls="group clickable" open={open.has(r.project.id)} onClick={() => { toggle(r.project.id); setSelected(r.project.id); }} />
                  {open.has(r.project.id) && r.subs.map((s) => <Row key={s.subProject.id} f={s} name={s.subProject.name} cls="child" />)}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid-2" style={{ alignItems: "start" }}>
        <section className="card" style={{ display: "flex", flexDirection: "column" }}>
          <div className="card-head"><h2>{tr("Budget & Forecast")}</h2></div>
          <BulletBars items={rows.map(reportToBullet)} onSelect={setSelected} />
        </section>
        {chart && (
          <section className="card" style={{ display: "flex", flexDirection: "column", minHeight: 340 }}>
            <div className="card-head"><h2>{tr("Burn-up:")}{" "}{chart.project.name}</h2></div>
            <BurnUpChart report={chart} />
          </section>
        )}
      </div>

      <section className="card card-pad explain" style={{ maxWidth: "none" }}>
        <h3 style={{ marginBottom: 6 }}>{tr("So entsteht der Forecast")}</h3>
        <p>
          <strong>{tr("Forecast = verbrauchte Kosten + Restaufwand × aktueller Stundensatz.")}</strong>{" "}{tr("Restaufwand pro Subprojekt =")}{" "}
          <code>{tr("(offene SP × h/SP − bereits gebuchte h auf offenen Issues) × (1 + Overhead-Anteil)")}</code>{tr(". Der Overhead-Anteil sind Stunden ohne JIRA-Issue (Meetings, Projektleitung) im Verhältnis zu Issue-Stunden. Die Bandbreite rechnet mit dem tiefsten und höchsten Monatsfaktor im Fenster. «Fertig ca.» teilt die offenen SP durch den Durchsatz der letzten drei Monate.")}
        </p>
      </section>
    </>
  );
}

/** Billing address of a customer, required for the Swiss QR bill. */
function AddressDialog({ initial, onClose, onSave }: { initial: PostalAddress; onClose: () => void; onSave: (a: PostalAddress) => Promise<void> }) {
  const [a, setA] = useState(initial);
  const submit = async (): Promise<Record<string, string> | void> => {
    const e: Record<string, string> = {};
    if (!a.name.trim()) e.name = tr("Firma oder Name der Rechnungsempfängerin.");
    if (!a.zip.trim()) e.zip = tr("Für die QR-Rechnung braucht es die PLZ.");
    if (!a.city.trim()) e.city = tr("Für die QR-Rechnung braucht es den Ort.");
    if (!/^[A-Z]{2}$/.test(a.country.trim().toUpperCase())) e.country = tr("Zwei Buchstaben, z. B. CH.");
    if (Object.keys(e).length) return e;
    await onSave({ ...a, name: a.name.trim(), street: a.street.trim(), zip: a.zip.trim(), city: a.city.trim(), country: a.country.trim().toUpperCase() });
    onClose();
  };
  return (
    <FormDialog id="address-dialog" title={tr("Rechnungsadresse")} subtitle={tr("Steht auf der Rechnung und im Empfangsschein der QR-Rechnung.")} onClose={onClose} onSubmit={submit}>
      <Field label={tr("Firma oder Name")} name="name" required><input id="i-name" className="input" value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} /></Field>
      <Field label={tr("Strasse und Nummer")} name="street"><input id="i-street" className="input" value={a.street} onChange={(e) => setA({ ...a, street: e.target.value })} /></Field>
      <FieldRow>
        <Field label={tr("PLZ")} name="zip" required><input id="i-zip" className="input" value={a.zip} onChange={(e) => setA({ ...a, zip: e.target.value })} /></Field>
        <Field label={tr("Ort")} name="city" required><input id="i-city" className="input" value={a.city} onChange={(e) => setA({ ...a, city: e.target.value })} /></Field>
        <Field label={tr("Land")} name="country" required><input id="i-country" className="input" maxLength={2} value={a.country} onChange={(e) => setA({ ...a, country: e.target.value.toUpperCase() })} /></Field>
      </FieldRow>
    </FormDialog>
  );
}
