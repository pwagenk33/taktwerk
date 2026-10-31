/**
 * Compact wire format for long lists (bookings, expenses …): column names once, one array per row, and columns
 * whose strings repeat a lot (person and sub-project ids, «Monatssumme») as indexes into a list of their values.
 * The admin dataset of the load test shrinks to about a third. Optional fields travel as null and come back
 * missing, so only use it for objects without real null values.
 */
export interface Packed {
  keys: string[];
  /** Per column: the distinct values when the column is dictionary-encoded, otherwise null. */
  dict: (string[] | null)[];
  rows: unknown[][];
}

export function pack(items: readonly object[]): Packed {
  const keys = [...new Set(items.flatMap((o) => Object.keys(o)))];
  const dict = keys.map((k) => {
    const values = new Set<unknown>();
    for (const o of items) {
      const v = (o as Record<string, unknown>)[k];
      if (v !== undefined && typeof v !== "string") return null;
      values.add(v);
    }
    return values.size * 2 < items.length ? [...values].filter((v): v is string => typeof v === "string") : null;
  });
  const index = dict.map((d) => (d ? new Map(d.map((v, i) => [v, i])) : null));
  const rows = items.map((o) =>
    keys.map((k, c) => {
      const v = (o as Record<string, unknown>)[k];
      if (v === undefined) return null;
      return index[c] ? index[c]!.get(v as string) : v;
    }),
  );
  return { keys, dict, rows };
}

export function unpack<T>(p: Packed): T[] {
  return p.rows.map((row) => {
    const o: Record<string, unknown> = {};
    for (let c = 0; c < p.keys.length; c++) {
      const v = row[c];
      if (v === null || v === undefined) continue;
      o[p.keys[c]!] = p.dict[c] ? p.dict[c]![v as number] : v;
    }
    return o as T;
  });
}
