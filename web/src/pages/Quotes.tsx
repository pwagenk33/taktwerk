import { useEffect, useState } from "react";
import { PROJECT_KINDS, addDays, fmtDate, fmtMoney, fmtQty, type Customer, type ProjectKind } from "@taktwerk/domain";
import { api } from "../api";
import { useStore } from "../store";
import { Icon } from "../ui/components";
import { Field, FieldRow, FormDialog } from "../ui/Dialog";
import { Select } from "../ui/Select";
import { tr } from "../i18n";

type QuoteStatus = "draft" | "sent" | "accepted" | "declined";
interface QuotePosition { name: string; note?: string; hours: number; rate: number; amount: number }
interface Quote {
  id: string; number: string; customerId: string; title: string; intro: string; kind: ProjectKind; retainerHours?: number;
  validUntil: string; status: QuoteStatus; positions: QuotePosition[]; net: number; projectId: string | null; createdAt: string;
}

const STATUS: Record<QuoteStatus, { label: string; cls: string }> = {
  draft: { label: tr("Entwurf"), cls: "neutral" },
  sent: { label: tr("Versendet"), cls: "risk" },
  accepted: { label: tr("Angenommen"), cls: "ok" },
  declined: { label: tr("Abgelehnt"), cls: "over" },
};

/** Quotes for one customer: write, send as PDF, and on acceptance turn into a project with sub-projects and budgets. */
export function Quotes({ customer, onOpenProject }: { customer: Customer; onOpenProject: (id: string) => void }) {
  const { mode, notify, reload: reloadData } = useStore();
  const [rows, setRows] = useState<Quote[] | null>(null);
  const [editing, setEditing] = useState<Quote | "new" | null>(null);
  const [error, setError] = useState("");
  const m = (v: number) => fmtMoney(v, customer.currency ?? "CHF");
  const load = () => api<{ quotes: Quote[] }>(`/api/quotes?customerId=${customer.id}`).then((r) => setRows(r.quotes)).catch((e) => setError((e as Error).message));
  useEffect(() => { if (mode === "api") void load(); }, [customer.id, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  if (mode === "demo") {
    return (
      <section className="card card-pad" style={{ marginTop: 16 }}>
        <h2>{tr("Offerten")}</h2>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: "0.86rem" }}>{tr("In der installierten Version schreibst du hier Offerten mit Positionen, Stunden und Ansatz, versendest sie als PDF und machst aus einer angenommenen Offerte mit einem Klick das Projekt: jede Position wird ein Subprojekt mit ihrem Betrag als Budget.")}</p>
      </section>
    );
  }

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      setError("");
      notify(msg);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const accept = (q: Quote) => act(async () => {
    const r = await api<{ projectId: string }>(`/api/quotes/${q.id}/accept`, { body: {} });
    await reloadData();
    onOpenProject(r.projectId);
  }, tr("Projekt «{0}» aus Offerte {1} angelegt", q.title, q.number));

  return (
    <section className="card" style={{ marginTop: 16 }} id="quotes">
      <div className="card-head">
        <h2>{tr("Offerten")}</h2>
        <button className="btn small" id="q-new" onClick={() => setEditing("new")}>{tr("+ Offerte")}</button>
      </div>
      <div className="card-pad" style={{ paddingTop: 10 }}>
        {editing && <QuoteDialog customer={customer} quote={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => void load()} />}
        {error && <p className="error">{error}</p>}
        {rows === null && !error && <p className="muted">{tr("Lade …")}</p>}
        {rows?.length === 0 && <p className="muted" style={{ margin: 0 }}>{tr("Noch keine Offerte. Wird eine angenommen, entsteht daraus das Projekt mit Subprojekten und Budgets.")}</p>}
        {rows && rows.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{tr("Nummer")}</th><th>{tr("Titel")}</th><th>{tr("Art")}</th><th>{tr("Gültig bis")}</th><th className="r">{tr("Betrag")}</th><th>{tr("Status")}</th><th className="r">{tr("Aktion")}</th></tr></thead>
              <tbody>
                {rows.map((q) => {
                  const open = q.status === "draft" || q.status === "sent";
                  return (
                    <tr key={q.id}>
                      <td className="num">{q.number}</td>
                      <td>{open ? <button className="link-btn" onClick={() => setEditing(q)}>{q.title}</button> : q.title}</td>
                      <td>{PROJECT_KINDS.find((k) => k.id === q.kind)?.label}</td>
                      <td className="num">{fmtDate(q.validUntil)}</td>
                      <td className="r num">{m(q.net)}</td>
                      <td><span className={`pill ${STATUS[q.status].cls}`}>{STATUS[q.status].label}</span></td>
                      <td>
                        <div className="closing-actions">
                          <a className="btn small" href={`/api/quotes/${q.id}/pdf`} download><Icon.download />{tr("PDF")}</a>
                          {q.status === "draft" && <button className="btn small" onClick={() => act(() => api(`/api/quotes/${q.id}/status`, { body: { status: "sent" } }), tr("Als versendet markiert"))}>{tr("Versendet")}</button>}
                          {open && <button className="btn small primary" onClick={() => void accept(q)}>{tr("Angenommen")}</button>}
                          {q.status === "sent" && <button className="btn small ghost" onClick={() => act(() => api(`/api/quotes/${q.id}/status`, { body: { status: "declined" } }), tr("Als abgelehnt markiert"))}>{tr("Abgelehnt")}</button>}
                          {q.status === "draft" && <button className="btn small ghost" aria-label={tr("Entwurf löschen")} title={tr("Entwurf löschen")} onClick={() => confirm(tr("Entwurf {0} löschen?", q.number)) && act(() => api(`/api/quotes/${q.id}`, { method: "DELETE" }), tr("Entwurf gelöscht"))}><Icon.trash /></button>}
                          {q.projectId && <button className="btn small ghost" onClick={() => onOpenProject(q.projectId!)}>{tr("Zum Projekt")}</button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

type Row = { name: string; note: string; hours: string; rate: string };
const num = (v: string) => Number(v.replace(",", ".").replace(/[’']/g, ""));

function QuoteDialog({ customer, quote, onClose, onSaved }: { customer: Customer; quote: Quote | null; onClose: () => void; onSaved: () => void }) {
  const { data, notify } = useStore();
  const [title, setTitle] = useState(quote?.title ?? "");
  const [intro, setIntro] = useState(quote?.intro ?? "");
  const [kind, setKind] = useState<ProjectKind>(quote?.kind ?? "tm");
  const [retainerHours, setRetainerHours] = useState(String(quote?.retainerHours ?? ""));
  const [validUntil, setValidUntil] = useState(quote?.validUntil ?? addDays(data.today, 30));
  const [rows, setRows] = useState<Row[]>(quote?.positions.map((p) => ({ name: p.name, note: p.note ?? "", hours: String(p.hours), rate: String(p.rate) })) ?? [{ name: "", note: "", hours: "", rate: "" }]);
  useEffect(() => {
    if (quote) return;
    api<{ rate: number }>(`/api/quotes/rate?customerId=${customer.id}`).then((r) => setRows((rs) => rs.map((x) => (x.rate ? x : { ...x, rate: String(r.rate) })))).catch(() => {});
  }, [customer.id, quote]);
  const set = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const filled = rows.filter((r) => r.name.trim() || r.hours.trim());
  const total = filled.reduce((s, r) => s + (Number.isFinite(num(r.hours) * num(r.rate)) ? Math.round(num(r.hours) * num(r.rate) * 20) / 20 : 0), 0);
  const cur = customer.currency ?? "CHF";

  const submit = async () => {
    const errors: Record<string, string> = {};
    if (!title.trim()) errors.title = tr("Titel fehlt");
    if (!filled.length) errors.positions = tr("Mindestens eine Position erfassen");
    filled.forEach((r, i) => {
      if (!r.name.trim() || !(num(r.hours) >= 0) || !(num(r.rate) >= 0) || r.hours.trim() === "" || r.rate.trim() === "") errors.positions = tr("Zeile {0}: Bezeichnung, Stunden und Ansatz ausfüllen", i + 1);
    });
    if (kind === "retainer" && !(num(retainerHours) > 0)) errors.retainerHours = tr("Stunden pro Monat angeben");
    if (Object.keys(errors).length) return errors;
    const body = {
      title: title.trim(), intro: intro.trim(), kind, validUntil,
      ...(kind === "retainer" ? { retainerHours: num(retainerHours) } : {}),
      positions: filled.map((r) => ({ name: r.name.trim(), ...(r.note.trim() ? { note: r.note.trim() } : {}), hours: num(r.hours), rate: num(r.rate) })),
    };
    if (quote) await api(`/api/quotes/${quote.id}`, { method: "PATCH", body });
    else await api("/api/quotes", { body: { ...body, customerId: customer.id } });
    notify(quote ? tr("Offerte gespeichert") : tr("Offerte erstellt"));
    onSaved();
    onClose();
  };

  return (
    <FormDialog title={quote ? tr("Offerte {0}", quote.number) : tr("Neue Offerte")} subtitle={customer.name} onClose={onClose} onSubmit={submit} submitLabel={quote ? tr("Speichern") : tr("Offerte erstellen")} wide id="quote-dialog">
      <Field label={tr("Titel")} name="title" required wide><input id="q-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tr("z. B. Relaunch Website")} /></Field>
      <FieldRow>
        <Field label={tr("Projektart")}><Select id="q-kind" value={kind} onChange={(v) => setKind(v as ProjectKind)} options={PROJECT_KINDS.map((k) => ({ value: k.id, label: k.label }))} /></Field>
        {kind === "retainer" && <Field label={tr("Stunden pro Monat")} name="retainerHours" required><input id="q-retainer" className="input num" inputMode="decimal" value={retainerHours} onChange={(e) => setRetainerHours(e.target.value)} /></Field>}
        <Field label={tr("Gültig bis")} required><input id="q-valid" type="date" className="input" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></Field>
      </FieldRow>
      <Field label={tr("Einleitung")} wide hint={tr("Erscheint im PDF über den Positionen.")}><textarea id="q-intro" className="input" rows={3} value={intro} onChange={(e) => setIntro(e.target.value)} /></Field>
      <Field label={tr("Positionen")} name="positions" required wide hint={tr("Jede Position wird beim Annehmen ein Subprojekt; ihr Betrag ist dessen Budget.")}>
        <div className="quote-rows">
          <div className="quote-row head"><span>{tr("Bezeichnung")}</span><span>{tr("Stunden")}</span><span>{tr("Ansatz")}</span><span className="r">{tr("Betrag")}</span><span /></div>
          {rows.map((r, i) => {
            const amount = num(r.hours) * num(r.rate);
            return (
              <div className="quote-row" key={i}>
                <span className="quote-name">
                  <input className="input" aria-label={tr("Bezeichnung")} data-q={`name-${i}`} value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
                  <input className="input quote-note" aria-label={tr("Notiz")} placeholder={tr("Notiz (optional)")} value={r.note} onChange={(e) => set(i, { note: e.target.value })} />
                </span>
                <input className="input num" aria-label={tr("Stunden")} data-q={`hours-${i}`} inputMode="decimal" value={r.hours} onChange={(e) => set(i, { hours: e.target.value })} />
                <input className="input num" aria-label={tr("Ansatz")} data-q={`rate-${i}`} inputMode="decimal" value={r.rate} onChange={(e) => set(i, { rate: e.target.value })} />
                <span className="r num">{Number.isFinite(amount) && amount > 0 ? fmtMoney(Math.round(amount * 20) / 20, cur) : "–"}</span>
                <button type="button" className="btn small ghost" aria-label={tr("Zeile entfernen")} disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Icon.trash /></button>
              </div>
            );
          })}
          <div className="quote-row foot">
            <button type="button" className="btn small ghost" id="q-add-row" onClick={() => setRows([...rows, { name: "", note: "", hours: "", rate: rows.at(-1)?.rate ?? "" }])}>{tr("+ Position")}</button>
            <span className="muted num">{tr("{0} h", fmtQty(filled.reduce((s, r) => s + (num(r.hours) || 0), 0)))}</span>
            <span />
            <strong className="r num">{fmtMoney(total, cur)}</strong>
            <span />
          </div>
        </div>
      </Field>
    </FormDialog>
  );
}
