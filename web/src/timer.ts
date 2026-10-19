import { useSyncExternalStore } from "react";

/** Running stopwatch, shared by every page and surviving reloads (localStorage). Seconds are integers. */
export interface TimerState {
  /** Epoch ms when the current running stretch began; null while paused. */
  runningSince: number | null;
  /** Seconds accumulated by earlier stretches (before the current pause/run). */
  accumulated: number;
  /** Epoch ms of the very first start, used as the booking's start time. */
  startedAt: number;
}

const KEY = "rt.timer";
const listeners = new Set<() => void>();
let state: TimerState | null = read();

function read(): TimerState | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as TimerState) : null;
  } catch {
    return null;
  }
}
function write(next: TimerState | null) {
  state = next;
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the timer still works for this tab */
  }
  listeners.forEach((l) => l());
}

export const timer = {
  get: () => state,
  start: () => write({ runningSince: Date.now(), accumulated: 0, startedAt: Date.now() }),
  pause: () => state?.runningSince && write({ ...state, accumulated: elapsedOf(state), runningSince: null }),
  resume: () => state && !state.runningSince && write({ ...state, runningSince: Date.now() }),
  /** Clears the timer and returns what was measured. */
  stop: (): { seconds: number; startedAt: number } | null => {
    if (!state) return null;
    const out = { seconds: elapsedOf(state), startedAt: state.startedAt };
    write(null);
    return out;
  },
};

export function elapsedOf(s: TimerState | null, now = Date.now()) {
  if (!s) return 0;
  return s.accumulated + (s.runningSince ? Math.floor((now - s.runningSince) / 1000) : 0);
}

/** Stopwatch rounds up to the next quarter hour, at least 15 minutes. */
export const hoursFromSeconds = (sec: number) => Math.max(0.25, Math.ceil(sec / 900) / 4);

export function fmtTimer(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function useTimer() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      const onStorage = (ev: StorageEvent) => ev.key === KEY && (state = read(), cb());
      window.addEventListener("storage", onStorage);
      return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
    },
    () => state,
  );
}
