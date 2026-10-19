import { describe, expect, it } from "vitest";
import { applyStamp, dayPresence, presenceIssues, requiredBreak, stampOptions, type WorkPeriod } from "../presence";

const D = "2026-10-19";
let n = 0;
const id = () => `p${++n}`;

describe("presence (Kommen/Gehen)", () => {
  it("stamps through a day and sums work and breaks", () => {
    let list: WorkPeriod[] = [];
    list = applyStamp(list, "in", "e1", D, "08:00", id);
    expect(stampOptions(dayPresence(list, D, "09:00").state)).toEqual(["break", "out"]);
    list = applyStamp(list, "break", "e1", D, "12:00", id);
    list = applyStamp(list, "resume", "e1", D, "12:45", id);
    list = applyStamp(list, "out", "e1", D, "17:15", id);
    const day = dayPresence(list, D);
    expect(day).toMatchObject({ work: 8.5 * 60, breaks: 45, first: "08:00", state: "off" });
    expect(presenceIssues(day)).toEqual([]);
    expect(() => applyStamp(list, "resume", "e1", D, "18:00", id)).toThrow();
  });

  it("counts an open period until now", () => {
    const list = applyStamp([], "in", "e1", D, "08:00", id);
    expect(dayPresence(list, D, "10:30").work).toBe(150);
    expect(dayPresence(list, D, "10:30").state).toBe("working");
  });

  it("knows the legal breaks and flags violations", () => {
    expect([5 * 60, 6 * 60, 8 * 60, 10 * 60].map(requiredBreak)).toEqual([0, 15, 30, 60]);
    const long: WorkPeriod[] = [{ id: "a", employeeId: "e1", date: D, kind: "work", start: "07:00", end: "16:30" }];
    const day = dayPresence(long, D);
    expect(presenceIssues(day)[0]).toMatch(/Pause zu kurz: 0 min statt mindestens 60 min/);
    const late: WorkPeriod[] = [{ id: "b", employeeId: "e1", date: D, kind: "work", start: "14:00", end: "23:30" }];
    expect(presenceIssues(dayPresence(late, D)).join(" ")).toMatch(/Nachtarbeit/);
    const early = dayPresence([{ id: "c", employeeId: "e1", date: D, kind: "work", start: "07:00", end: "11:00" }], D);
    expect(presenceIssues(early, "22:00")[0]).toMatch(/Ruhezeit nur 9.0 h/);
  });
});
