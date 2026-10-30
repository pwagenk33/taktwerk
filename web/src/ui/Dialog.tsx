import { cloneElement, createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { Icon } from "./components";
import { tr } from "../i18n";

/**
 * One pattern for every create and edit in the app: a popup with a title, a line saying what it is for,
 * labelled fields (required ones marked), a hint where a field needs explaining, and the errors next to the
 * field they belong to. Escape or a click outside closes it; Enter submits.
 */

type Errors = Record<string, string>;
const ErrorsCtx = createContext<Errors>({});

export function Dialog({ title, subtitle, onClose, children, footer, wide, id }: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
  id?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // First field gets the focus, so typing can start right away.
    const first = ref.current?.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), textarea, select, [role=combobox], button:not(.icon-btn)");
    first?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) onClose(); };
    window.addEventListener("keydown", onKey);
    document.body.classList.add("dialog-open");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("dialog-open");
      prev?.focus?.();
    };
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog form-dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} id={id}>
        <div className="dialog-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p className="dialog-sub">{subtitle}</p>}
          </div>
          <button type="button" className="icon-btn" aria-label={tr("Schliessen")} onClick={onClose}><Icon.close /></button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * A dialog with a form. `onSubmit` returns field errors ({ name: "…" }) to keep the dialog open,
 * or nothing when it saved; thrown errors are shown at the bottom.
 */
export function FormDialog({ title, subtitle, onClose, onSubmit, submitLabel = tr("Speichern"), children, wide, id, danger, readOnly }: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose: () => void;
  onSubmit: () => Promise<Errors | void> | Errors | void;
  submitLabel?: string;
  children: React.ReactNode;
  wide?: boolean;
  id?: string;
  /** Extra action on the left of the footer, e.g. «Löschen». */
  danger?: React.ReactNode;
  readOnly?: boolean;
}) {
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || readOnly) return;
    setBusy(true);
    setError("");
    try {
      const found = await onSubmit();
      if (found && Object.keys(found).length) {
        setErrors(found);
        // Jump to the first field with a problem.
        requestAnimationFrame(() => document.getElementById(formId)?.querySelector<HTMLElement>(".has-error input, .has-error textarea, .has-error [role=combobox], .has-error button")?.focus());
        return;
      }
      setErrors({});
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      wide={wide}
      id={id}
      footer={
        <>
          <div className="dialog-foot-left">
            {danger}
            {!readOnly && <span className="req-note"><span className="req" aria-hidden="true">*</span>{" "}{tr("Pflichtfeld")}</span>}
          </div>
          <div className="dialog-foot-right">
            <button type="button" className="btn ghost" onClick={onClose}>{readOnly ? tr("Schliessen") : tr("Abbrechen")}</button>
            {!readOnly && <button type="submit" form={formId} className="btn primary" disabled={busy}>{busy ? tr("Einen Moment …") : submitLabel}</button>}
          </div>
        </>
      }
    >
      <ErrorsCtx.Provider value={errors}>
        <form id={formId} className="dialog-form" onSubmit={submit} noValidate>
          {children}
          {/* Enter in a field submits even though the button sits in the footer. */}
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      </ErrorsCtx.Provider>
      {error && <p className="error dialog-error" role="alert">{error}</p>}
    </Dialog>
  );
}

/** A labelled field. `name` links it to the errors returned by FormDialog's onSubmit. */
export function Field({ label, name, required, hint, children, wide }: {
  label: React.ReactNode;
  name?: string;
  required?: boolean;
  hint?: React.ReactNode;
  children: React.ReactElement;
  wide?: boolean;
}) {
  const errors = useContext(ErrorsCtx);
  const error = name ? errors[name] : undefined;
  const hintId = useId();
  return (
    <div className={`field ${wide ? "wide" : ""} ${error ? "has-error" : ""}`} data-field={name}>
      <span className="field-label">{label}{required && <span className="req" aria-label={tr("Pflichtfeld")}> *</span>}</span>
      <FieldControl invalid={!!error} describedBy={error || hint ? hintId : undefined}>{children}</FieldControl>
      {error ? <span className="field-error" id={hintId}>{error}</span> : hint ? <span className="field-hint" id={hintId}>{hint}</span> : null}
    </div>
  );
}

/** Marks plain inputs as invalid and links them to their hint or error for screen readers. */
function FieldControl({ children, invalid, describedBy }: { children: React.ReactElement; invalid: boolean; describedBy?: string }) {
  const plain = typeof children.type === "string";
  return <div className="field-control">{plain ? cloneElement(children as React.ReactElement<Record<string, unknown>>, { "aria-invalid": invalid || undefined, "aria-describedby": describedBy }) : children}</div>;
}

/** A group of fields side by side; stacks on phones. */
export function FieldRow({ children }: { children: React.ReactNode }) {
  return <div className="field-row">{children}</div>;
}

/** A titled block inside a long dialog. */
export function FieldSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="field-section">
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}
