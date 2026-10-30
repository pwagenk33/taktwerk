import { describe, expect, it } from "vitest";
import { detectSource, guessMapping, importPlan, parseCsv, parseDate, parseHours, toRows } from "../import";

const TOGGL = `User,Email,Client,Project,Task,Description,Billable,Start date,Start time,End date,End time,Duration,Tags,Amount (CHF)
Anna Keller,anna@firma.ch,Rheinlogistik GmbH,Flottenmanagement,,"Workshop, Teil 1",Yes,2026-09-01,08:30:00,2026-09-01,10:00:00,01:30:00,,240.00
Marco Brunner,marco@firma.ch,Alpenbank AG,Kundenportal,,Review,No,2026-09-02,13:00:00,2026-09-02,13:45:00,00:45:00,,0
`;
const HARVEST = `Date,Client,Project,Project Code,Task,Notes,Hours,Hours Rounded,Billable?,Invoiced?,First Name,Last Name,Roles,Employee?
2026-09-03,Alpenbank AG,Kundenportal,,Entwicklung,Login gebaut,2.5,2.5,Yes,No,Lea,Meier,,Yes
`;
const CLOCKODO = `Datum;Mitarbeiter;Kunde;Projekt;Leistung;Beschreibung;Dauer;Abrechenbar
01.09.2026;Anna Keller;Medtech Basel AG;QMS;Beratung;Audit vorbereitet;3:15;ja
02.09.2026;Anna Keller;Medtech Basel AG;QMS;Beratung;;x;ja
`;

describe("import", () => {
  it("reads quoted CSV with commas, semicolons and a BOM", () => {
    expect(parseCsv('﻿a;b\n"x;y";"z ""q"""\n')).toEqual([["a", "b"], ["x;y", 'z "q"']]);
    expect(parseCsv("a,b\r\n1,2\r\n\r\n")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("recognises Toggl, Harvest and Clockodo by their columns", () => {
    expect(detectSource(parseCsv(TOGGL)[0]!)).toBe("toggl");
    expect(detectSource(parseCsv(HARVEST)[0]!)).toBe("harvest");
    expect(detectSource(parseCsv(CLOCKODO)[0]!)).toBe("clockodo");
    expect(detectSource(["Datum", "Stunden"])).toBe("generic");
  });

  it("turns a Toggl export into bookings with start time and billable flag", () => {
    const [h, ...d] = parseCsv(TOGGL);
    const { rows, problems } = toRows(h!, d, guessMapping(h!));
    expect(problems).toEqual([]);
    expect(rows[0]).toMatchObject({ date: "2026-09-01", person: "Anna Keller", email: "anna@firma.ch", customer: "Rheinlogistik GmbH", project: "Flottenmanagement", task: "Allgemein", reason: "Workshop, Teil 1", hours: 1.5, billable: true, startTime: "08:30" });
    expect(rows[1]).toMatchObject({ hours: 0.75, billable: false });
  });

  it("joins Harvest's first and last name", () => {
    const [h, ...d] = parseCsv(HARVEST);
    const { rows } = toRows(h!, d, guessMapping(h!));
    expect(rows[0]).toMatchObject({ person: "Lea Meier", task: "Entwicklung", reason: "Login gebaut", hours: 2.5 });
  });

  it("reads Clockodo and lists unreadable lines with their line number", () => {
    const [h, ...d] = parseCsv(CLOCKODO);
    const { rows, problems } = toRows(h!, d, guessMapping(h!));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: "2026-09-01", hours: 3.25, task: "Beratung", reason: "Audit vorbereitet" });
    expect(problems).toEqual([{ line: 3, message: "Dauer «x» nicht lesbar" }]);
  });

  it("parses Swiss, ISO, US and Excel dates and several duration formats", () => {
    expect(parseDate("31.12.25")).toBe("2025-12-31");
    expect(parseDate("12/31/2025")).toBe("2025-12-31");
    expect(parseDate("45657")).toBe("2024-12-31");
    expect(parseDate("31.02.2025")).toBeNull();
    expect(parseHours("1,5")).toBe(1.5);
    expect(parseHours("90 min")).toBe(1.5);
    expect(parseHours("01:30:00")).toBe(1.5);
  });

  it("plans new customers and projects and sums hours per person", () => {
    const [h, ...d] = parseCsv(TOGGL);
    const { rows } = toRows(h!, d, guessMapping(h!));
    const plan = importPlan(rows, { customers: [{ name: "alpenbank ag" }], projects: [{ name: "Kundenportal", customer: "Alpenbank AG" }] });
    expect(plan.newCustomers).toEqual(["Rheinlogistik GmbH"]);
    expect(plan.newProjects).toEqual([{ customer: "Rheinlogistik GmbH", project: "Flottenmanagement", hours: 1.5 }]);
    expect(plan.people.map((p) => p.key)).toEqual(["anna@firma.ch", "marco@firma.ch"]);
    expect(plan).toMatchObject({ entries: 2, hours: 2.25, from: "2026-09-01", to: "2026-09-02" });
  });
});
