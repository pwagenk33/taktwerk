import { useSyncExternalStore } from "react";
import { loadLocal, saveLocal } from "./store";

export type Theme = "system" | "light" | "dark";
const KEY = "rt.theme";
let current: Theme = loadLocal<Theme>(KEY, "system");
const listeners = new Set<() => void>();

function apply(t: Theme) {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}
apply(current);

export function setTheme(t: Theme) {
  current = t;
  apply(t);
  saveLocal(KEY, t);
  listeners.forEach((l) => l());
}

/** Light, dark or the system setting; kept per browser and applied before the first paint by index.html. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const t = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  return [t, setTheme];
}
