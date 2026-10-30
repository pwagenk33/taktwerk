import { describe, expect, it } from "vitest";
import { calendarSuggestions, type CalendarEvent } from "../calendar";

const data = {
  customers: [{ id: "c1", name: "Alpenbank AG", rates: [] }, { id: "c2", name: "Apple Garten", rates: [] }],
  projects: [{ id: "p1", customerId: "c1", name: "Kundenportal", budget: 0 }, { id: "p2", customerId: "c2", name: "Shop", budget: 0 }],
  subProjects: [{ id: "s1", projectId: "p1", name: "Login", budget: 0 }, { id: "s2", projectId: "p1", name: "Betrieb", budget: 0 }, { id: "s3", projectId: "p2", name: "Design", budget: 0 }],
  timeEntries: [
    { id: "e1", employeeId: "u1", subProjectId: "s2", date: "2026-10-12", hours: 0.25, reason: "Daily Standup", billable: true, hourlyRate: 0, startTime: "09:00" },
    { id: "e2", employeeId: "u1", subProjectId: "s2", date: "2026-10-13", hours: 2, reason: "Betrieb", billable: true, hourlyRate: 0 },
    { id: "e3", employeeId: "u1", subProjectId: "s1", date: "2026-10-19", hours: 1, reason: "Login-Fehler", billable: true, hourlyRate: 0, startTime: "13:00" },
  ],
};
const ev = (id: string, title: string, date: string, start: string, end: string): CalendarEvent => ({ id, title, date, start, end });

describe("calendar suggestions", () => {
  it("guesses the sub-project from earlier bookings, then from names in the title", () => {
    const s = calendarSuggestions([
      ev("a", "Daily Standup", "2026-10-19", "09:00", "09:15"),
      ev("b", "Workshop Alpenbank", "2026-10-19", "14:00", "15:40"),
      ev("c", "Mittagessen", "2026-10-19", "12:00", "13:00"),
      ev("d", "App Review", "2026-10-20", "10:00", "11:00"),
    ], data, "u1");
    expect(s.map((x) => [x.event.id, x.hours, x.subProjectId, x.because])).toEqual([
      ["a", 0.25, "s2", "history"],
      ["c", 1, undefined, undefined],
      ["b", 1.75, "s2", "name"],
      ["d", 1, undefined, undefined],
    ]);
  });

  it("leaves out meetings that are already booked or too short", () => {
    const s = calendarSuggestions([ev("x", "Login", "2026-10-19", "13:30", "14:00"), ev("y", "Kurz", "2026-10-19", "16:00", "16:05")], data, "u1");
    expect(s).toEqual([]);
    expect(calendarSuggestions([ev("x", "Login", "2026-10-19", "13:30", "14:00")], data, "u2")[0]).toMatchObject({ subProjectId: "s1", because: "name" });
  });
});
