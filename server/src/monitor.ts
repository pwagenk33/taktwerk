// Response times and errors for the operator console, kept in memory only (they start fresh after a restart).
// Error messages can mention data, so only platform admins see them, and nothing leaves the server.
export interface RequestSample { at: number; route: string; ms: number; status: number }
export interface ErrorRecord { at: string; source: "server" | "app"; route: string; message: string; detail?: string; orgId?: string; version?: string }

const SAMPLES = 20_000;
const ERRORS = 100;
const samples: RequestSample[] = [];
let next = 0;
const errors: ErrorRecord[] = [];

export function recordRequest(route: string, ms: number, status: number) {
  const s = { at: Date.now(), route, ms, status };
  if (samples.length < SAMPLES) samples.push(s);
  else samples[next] = s;
  next = (next + 1) % SAMPLES;
}

export function recordError(e: Omit<ErrorRecord, "at">) {
  errors.unshift({ ...e, at: new Date().toISOString(), message: e.message.slice(0, 500), detail: e.detail?.slice(0, 2000) });
  errors.length = Math.min(errors.length, ERRORS);
}

const quantile = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0);

/** Figures for the last `hours` hours: volume, server errors, median and 95th percentile, the slowest routes. */
export function monitorReport(hours = 24, now = Date.now()) {
  const from = now - hours * 3600_000;
  const recent = samples.filter((s) => s.at >= from);
  const ms = recent.map((s) => s.ms).sort((a, b) => a - b);
  const byRoute = new Map<string, number[]>();
  for (const s of recent) {
    const list = byRoute.get(s.route);
    if (list) list.push(s.ms);
    else byRoute.set(s.route, [s.ms]);
  }
  const slowest = [...byRoute.entries()]
    .filter(([, l]) => l.length >= 3)
    .map(([route, l]) => { l.sort((a, b) => a - b); return { route, count: l.length, p50: Math.round(quantile(l, 0.5)), p95: Math.round(quantile(l, 0.95)) }; })
    .sort((a, b) => b.p95 - a.p95)
    .slice(0, 8);
  // Requests per hour, oldest first, for a small bar chart.
  const perHour = Array.from({ length: hours }, (_, i) => ({ hour: new Date(from + i * 3600_000).toISOString(), requests: 0, errors: 0 }));
  for (const s of recent) {
    const bucket = perHour[Math.min(hours - 1, Math.floor((s.at - from) / 3600_000))]!;
    bucket.requests++;
    if (s.status >= 500) bucket.errors++;
  }
  return {
    hours,
    requests: recent.length,
    serverErrors: recent.filter((s) => s.status >= 500).length,
    p50: Math.round(quantile(ms, 0.5)),
    p95: Math.round(quantile(ms, 0.95)),
    slowest,
    perHour,
    errors: errors.filter((e) => new Date(e.at).getTime() >= from).slice(0, 50),
  };
}

/** For tests. */
export function resetMonitor() {
  samples.length = 0;
  next = 0;
  errors.length = 0;
}
