import * as RS from "@radix-ui/react-select";
import type { ReactNode } from "react";

// Radix reserves the empty string for «nothing selected», so an empty option value travels under a sentinel.
const NONE = "__none__";

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

/** Styled dropdown (Radix Select): keyboard navigation, type-ahead, a list that follows the theme. */
export function Select({
  id,
  value,
  onChange,
  options,
  placeholder = "Bitte wählen",
  disabled,
  small,
  ariaLabel,
  className,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  small?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
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
