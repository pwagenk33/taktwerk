import { describe, expect, it } from "vitest";
import { pack, unpack } from "../pack";

describe("pack", () => {
  it("round-trips objects, with optional fields and repeated strings", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: `id-${i}`,
      employeeId: i % 2 ? "anna" : "marco",
      hours: i / 2,
      billable: i % 3 === 0,
      ...(i === 4 ? { startTime: "08:30" } : {}),
    }));
    const p = pack(items);
    expect(p.dict[p.keys.indexOf("employeeId")]).toEqual(["marco", "anna"]);
    expect(p.dict[p.keys.indexOf("id")]).toBeNull();
    expect(unpack(JSON.parse(JSON.stringify(p)))).toEqual(items);
  });
  it("handles an empty list", () => {
    expect(unpack(pack([]))).toEqual([]);
  });
});
