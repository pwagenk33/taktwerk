import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { fmt1, rateOn } from "@taktwerk/domain";
import { useStore } from "../store";
import { Icon } from "./components";
import { tr } from "../i18n";

/** One entry in the palette: a page, a customer, a project, or a parsed quick booking. */
interface Item {
  id: string;
  group: "Buchen" | "Seiten" | "Kunden" | "Projekte";
  title: string;
  sub?: string;
  hint?: string;
  run: () => void | Promise<void>;
}

export interface PaletteProps {
  open: boolean;
  onClose: () => void;
  pages: { id: string; label: string }[];
  onNewEntry: () => void;
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * Parses "2h medtech sprint review", "45min alpina api" or "1.5 rheinlogistik workshop":
 * duration first, then words that pick the sub-project, the rest becomes the reason.
 */
function parseBooking(text: string): { hours: number; words: string[] } | null {
  const m = text.trim().match(/^(\d+(?:[.,:]\d+)?)\s*(h|std|stunden|m|min|minuten)?\b\s*(.*)$/i);
  if (!m) return null;
  const raw = m[1].replace(",", ".");
  let hours = raw.includes(":") ? Number(raw.split(":")[0]) + Number(raw.split(":")[1]) / 60 : Number(raw);
  if (m[2] && /^m/i.test(m[2])) hours = hours / 60;
  if (!(hours > 0 && hours <= 24)) return null;
  const words = m[3].split(/\s+/).filter(Boolean);
  return { hours, words };
}

export function CommandPalette({ open, onClose, pages, onNewEntry }: PaletteProps) {
  const { data, role, addTimeEntry, currentUserId, notify } = useStore();
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const lead = role !== "employee";

  useEffect(() => {
    if (open) {
      setQ("");
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const go = (hash: string) => {
    location.hash = hash;
    onClose();
  };

  const items = useMemo<Item[]>(() => {
    const nq = norm(q.trim());
    const out: Item[] = [];
    const custById = new Map(data.customers.map((c) => [c.id, c]));
    const projById = new Map(data.projects.map((p) => [p.id, p]));

    // Quick booking: "2h medtech sprint review"
    const booking = parseBooking(q);
    if (booking) {
      const labelled = data.subProjects.map((s) => {
        const p = projById.get(s.projectId);
        const c = p && custById.get(p.customerId);
        return { s, p, c, text: norm(`${c?.name ?? ""} ${p?.name ?? ""} ${s.name}`) };
      });
      const matched = new Set<number>();
      const scored = labelled
        .map((l) => {
          let score = 0;
          booking.words.forEach((w, i) => {
            if (l.text.includes(norm(w))) {
              score += 1;
              matched.add(i);
            }
          });
          return { ...l, score };
        })
        .filter((l) => l.score > 0)
        .sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (best && best.p && best.c) {
        const used = new Set<number>();
        booking.words.forEach((w, i) => best.text.includes(norm(w)) && used.add(i));
        const reason = booking.words.filter((_, i) => !used.has(i)).join(" ") || best.s.name;
        const label = `${best.c.name} · ${best.p.name} · ${best.s.name}`;
        const customer = best.c;
        const sub = best.s;
        out.push({
          id: "book",
          group: "Buchen",
          title: `${fmt1(booking.hours)} h · ${label}`,
          sub: tr("«{0}» heute buchen", reason),
          hint: "↵",
          run: async () => {
            await addTimeEntry({
              employeeId: currentUserId,
              subProjectId: sub.id,
              date: data.today,
              hours: Math.round(booking.hours * 100) / 100,
              reason,
              billable: true,
              hourlyRate: rateOn(customer, data.today),
            });
            notify(tr("{0} h gebucht: {1}", fmt1(booking.hours), reason));
            onClose();
          },
        });
      } else if (booking.words.length === 0) {
        out.push({ id: "book-hint", group: "Buchen", title: tr("{0} h buchen auf …", fmt1(booking.hours)), sub: tr("Kunde oder Projekt dahinter schreiben, z. B. «2h medtech review»"), run: () => { onNewEntry(); onClose(); } });
      }
    }

    out.push({ id: "new", group: "Buchen", title: tr("Neue Buchung"), sub: tr("Dialog mit Kalenderzeit öffnen"), hint: "N", run: () => { onNewEntry(); onClose(); } });

    for (const p of pages) out.push({ id: `page:${p.id}`, group: "Seiten", title: p.label, run: () => go(`#${p.id}`) });

    if (lead) {
      for (const c of data.customers) out.push({ id: `c:${c.id}`, group: "Kunden", title: c.name, sub: tr("{0} Projekte", data.projects.filter((p) => p.customerId === c.id).length), run: () => go(`#projekte/c/${c.id}`) });
      for (const p of data.projects) out.push({ id: `p:${p.id}`, group: "Projekte", title: p.name, sub: custById.get(p.customerId)?.name, run: () => go(`#projekte/p/${p.id}`) });
    }

    if (!nq) return out.filter((i) => i.group === "Buchen" || i.group === "Seiten").slice(0, 12);
    const hit = (i: Item) => i.group === "Buchen" || norm(`${i.title} ${i.sub ?? ""}`).includes(nq);
    return out.filter(hit).slice(0, 14);
  }, [q, data, pages, lead]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setCursor(0), [q]);

  if (!open) return null;

  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); setCursor((c) => Math.min(items.length - 1, c + 1)); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (ev.key === "Enter") { ev.preventDefault(); void items[cursor]?.run(); }
    else if (ev.key === "Escape") onClose();
  };

  let lastGroup = "";
  return (
    <div className="pal-overlay" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="pal" role="dialog" aria-modal="true" aria-label={tr("Befehle")}>
        <div className="pal-input">
          <Icon.search />
          <input ref={inputRef} id="pal-input" value={q} onChange={(ev) => setQ(ev.target.value)} onKeyDown={onKey} placeholder={tr("Buchen, springen, suchen … z. B. «2h medtech review»")} aria-label={tr("Befehl")} autoComplete="off" />
          <kbd>{tr("Esc")}</kbd>
        </div>
        <ul className="pal-list" role="listbox">
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? <li key={`g-${it.group}`} className="pal-group">{tr(it.group)}</li> : null;
            lastGroup = it.group;
            return (
              <Fragment key={it.id}>
                {head}
                <li role="option" aria-selected={i === cursor} className={`pal-item ${i === cursor ? "on" : ""}`} onMouseEnter={() => setCursor(i)} onMouseDown={(ev) => ev.preventDefault()} onClick={() => void it.run()}>
                  <span className="pal-title">{it.title}</span>
                  {it.sub && <span className="pal-sub">{it.sub}</span>}
                  {it.hint && <kbd>{it.hint}</kbd>}
                </li>
              </Fragment>
            );
          })}
          {items.length === 0 && <li className="pal-empty">{tr("Nichts gefunden.")}</li>}
        </ul>
      </div>
    </div>
  );
}
