import * as RS from "@radix-ui/react-select";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

// Radix reserves the empty string for «nothing selected», so an empty option value travels under a sentinel.
const NONE = "__none__";

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

/** From this many options the dropdown gets a search field (overridable for tests via localStorage rt.searchMin). */
const SEARCH_MIN = (() => {
  try {
    return Number(localStorage.getItem("rt.searchMin")) || 20;
  } catch {
    return 20;
  }
})();

const text = (o: SelectOption) => (typeof o.label === "string" || typeof o.label === "number" ? String(o.label) : String(o.value));
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** Searchable dropdown for long lists: a trigger that looks like Select, a popover with a filter field. */
function Combobox({ id, value, onChange, options, placeholder = "Bitte wählen", disabled, small, ariaLabel, className }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean }>({ top: 0, left: 0, width: 0, up: false });
  const current = options.find((o) => o.value === value);
  const shown = useMemo(() => {
    const nq = norm(q.trim());
    const list = nq ? options.filter((o) => norm(text(o)).includes(nq)) : options;
    return list.slice(0, 200);
  }, [q, options]);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const place = () => {
      const r = btn.current!.getBoundingClientRect();
      const up = window.innerHeight - r.bottom < 320 && r.top > 320;
      setPos({ top: up ? r.top - 4 : r.bottom + 4, left: r.left, width: Math.max(r.width, 260), up });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setQ("");
    setCursor(Math.max(0, options.findIndex((o) => o.value === value)));
    setTimeout(() => input.current?.focus(), 0);
    const onDoc = (ev: PointerEvent) => {
      const t = ev.target as Node;
      if (!btn.current?.contains(t) && !document.getElementById(`${id ?? "cb"}-pop`)?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setCursor(0), [q]);

  const pick = (o: SelectOption) => {
    if (o.disabled) return;
    onChange(o.value);
    setOpen(false);
    btn.current?.focus();
  };
  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); setCursor((c) => Math.min(shown.length - 1, c + 1)); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (ev.key === "Enter") { ev.preventDefault(); if (shown[cursor]) pick(shown[cursor]); }
    else if (ev.key === "Escape") { ev.preventDefault(); setOpen(false); btn.current?.focus(); }
  };
  useEffect(() => {
    document.getElementById(`${id ?? "cb"}-opt-${cursor}`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <button
        ref={btn}
        id={id}
        type="button"
        className={`select ${small ? "small" : ""} ${className ?? ""}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(ev) => { if (ev.key === "ArrowDown" || ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setOpen(true); } }}
      >
        <span className={`select-value ${current ? "" : "placeholder"}`}>{current ? current.label : placeholder}</span>
        <span className="select-chevron">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
        </span>
      </button>
      {open && (
        <div id={`${id ?? "cb"}-pop`} className={`select-menu combo ${pos.up ? "up" : ""}`} style={{ position: "fixed", left: pos.left, width: pos.width, ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}>
          <div className="combo-search">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></svg>
            <input ref={input} value={q} onChange={(ev) => setQ(ev.target.value)} onKeyDown={onKey} placeholder={`${options.length} Einträge durchsuchen …`} aria-label="Suchen" autoComplete="off" />
          </div>
          <ul className="select-viewport combo-list" role="listbox" aria-activedescendant={`${id ?? "cb"}-opt-${cursor}`}>
            {shown.map((o, i) => (
              <li
                key={o.value || "__empty"}
                id={`${id ?? "cb"}-opt-${i}`}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled}
                className={`select-item ${i === cursor ? "active" : ""} ${o.value === value ? "selected" : ""} ${o.disabled ? "disabled" : ""}`}
                onMouseEnter={() => setCursor(i)}
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => pick(o)}
              >
                <span className="select-item-text">{o.label}</span>
                {o.value === value && <span className="select-check"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg></span>}
              </li>
            ))}
            {shown.length === 0 && <li className="combo-empty">Kein Treffer für «{q}».</li>}
            {shown.length === 200 && <li className="combo-empty">Weiter eingrenzen, um mehr zu sehen.</li>}
          </ul>
        </div>
      )}
    </>
  );
}

interface SelectProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  small?: boolean;
  ariaLabel?: string;
  className?: string;
  /** Force or suppress the search field; by default lists from 20 entries get one. */
  searchable?: boolean;
}

/** Styled dropdown (Radix Select): keyboard navigation, type-ahead, a list that follows the theme. Long lists become searchable. */
export function Select(props: SelectProps) {
  const searchable = props.searchable ?? props.options.length >= SEARCH_MIN;
  if (searchable) return <Combobox {...props} />;
  return <PlainSelect {...props} />;
}

function PlainSelect({
  id,
  value,
  onChange,
  options,
  placeholder = "Bitte wählen",
  disabled,
  small,
  ariaLabel,
  className,
}: SelectProps) {
  const hasEmpty = options.some((o) => o.value === "");
  const current = options.find((o) => o.value === value);
  const rsValue = value === "" ? (hasEmpty ? NONE : "") : current ? value : "";
  return (
    <RS.Root value={rsValue} onValueChange={(v) => onChange(v === NONE ? "" : v)} disabled={disabled}>
      <RS.Trigger id={id} className={`select ${small ? "small" : ""} ${className ?? ""}`} aria-label={ariaLabel}>
        <span className="select-value"><RS.Value placeholder={placeholder}>{current?.label}</RS.Value></span>
        <RS.Icon className="select-chevron">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
        </RS.Icon>
      </RS.Trigger>
      <RS.Portal>
        <RS.Content className="select-menu" position="popper" sideOffset={4} collisionPadding={8}>
          <RS.ScrollUpButton className="select-scroll">▲</RS.ScrollUpButton>
          <RS.Viewport className="select-viewport">
            {options.map((o) => (
              <RS.Item key={o.value} value={o.value === "" ? NONE : o.value} disabled={o.disabled} className="select-item">
                <RS.ItemText>{o.label}</RS.ItemText>
                <RS.ItemIndicator className="select-check">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg>
                </RS.ItemIndicator>
              </RS.Item>
            ))}
          </RS.Viewport>
          <RS.ScrollDownButton className="select-scroll">▼</RS.ScrollDownButton>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}
