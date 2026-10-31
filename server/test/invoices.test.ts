import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, setup } from "./helpers";
import { draftRetainerInvoices } from "../src/jobs";

let t: Awaited<ReturnType<typeof setup>>;
let admin: string, lead: string, lea: string;
let alpen: string, stadtwerke: string;

beforeAll(async () => {
  t = await setup();
  [admin, lead, lea] = await Promise.all(["anna.keller", "marco.brunner", "lea.meier"].map(async (u) => (await login(t.app, u)).cookie));
  const d = (await get("/api/dataset", admin)).json();
  alpen = d.customers.find((c: { name: string }) => c.name.startsWith("Alpenbank")).id;
  stadtwerke = d.customers.find((c: { name: string }) => c.name.startsWith("Stadtwerke")).id;
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

const get = (url: string, cookie: string) => t.app.inject({ method: "GET", url, headers: { cookie } });
const send = (method: "POST" | "PATCH" | "DELETE" | "PUT", url: string, cookie: string, payload: object = {}) =>
  t.app.inject({ method, url, headers: { cookie }, payload });

describe("billing settings", () => {
  it("validates and normalizes the IBAN", async () => {
    const billing = { address: { name: "Beispiel AG", street: "Weg 1", zip: "8000", city: "Zürich", country: "CH" }, iban: "ch93 0076 2011 6238 5295 7", paymentDays: 20 };
    const res = await send("PUT", "/api/settings", admin, { billing });
    expect(res.statusCode).toBe(200);
    expect(res.json().billing).toMatchObject({ iban: "CH9300762011623852957", paymentDays: 20 });
    expect((await send("PUT", "/api/settings", admin, { billing: { ...billing, iban: "DE89370400440532013000" } })).statusCode).toBe(400);
    expect((await send("PUT", "/api/settings", lead, { billing })).statusCode).toBe(403);
    expect((await send("PUT", "/api/settings", admin, { vatRate: 7.7 })).statusCode).toBe(400);
  });

  it("keeps a customer's billing address", async () => {
    expect((await get(`/api/customers/${stadtwerke}/address`, lead)).json()).toMatchObject({ name: "Stadtwerke Aarau", zip: "" });
    const res = await send("PUT", `/api/customers/${stadtwerke}/address`, lead, { name: "Stadtwerke Aarau", street: "Obere Vorstadt 37", zip: "5000", city: "Aarau" });
    expect(res.json()).toMatchObject({ zip: "5000", country: "CH" });
    expect((await send("PUT", `/api/customers/${stadtwerke}/address`, lea, { name: "x", street: "", zip: "1", city: "y" })).statusCode).toBe(403);
  });
});

describe("invoices", () => {
  it("creates one invoice per customer and month from billable hours and approved expenses", async () => {
    const preview = (await get(`/api/invoices/preview?customerId=${alpen}&month=2026-09`, lead)).json();
    expect(preview.positions.length).toBeGreaterThan(0);
    expect(preview.positions.some((p: { unit: string }) => p.unit === "h")).toBe(true);
    const created = await send("POST", "/api/invoices", lead, { customerId: alpen, month: "2026-09" });
    expect(created.statusCode).toBe(201);
    const inv = created.json();
    expect(inv).toMatchObject({ number: "2026-0001", status: "draft", month: "2026-09", vatRate: 8.1 });
    expect(inv.net).toBeCloseTo(Math.round(preview.net * 20) / 20, 1);
    expect(inv.gross).toBeCloseTo(inv.net + inv.vat, 1);
    expect(inv.dueDate > inv.issueDate).toBe(true);
    // A second draft for the same month is refused; a cancelled one does not block.
    expect((await send("POST", "/api/invoices", lead, { customerId: alpen, month: "2026-09" })).statusCode).toBe(409);
    const next = (await send("POST", "/api/invoices", lead, { customerId: alpen, month: "2026-08" })).json();
    expect(next.number).toBe("2026-0002");
    expect((await get(`/api/invoices?customerId=${alpen}`, lead)).json().invoices.map((i: { number: string }) => i.number)).toEqual(["2026-0002", "2026-0001"]);
    expect((await get("/api/invoices", lea)).statusCode).toBe(403);
  });

  it("renders a PDF with the QR bill and sends it to the report recipients", async () => {
    const inv = (await get(`/api/invoices?customerId=${alpen}`, lead)).json().invoices.find((i: { number: string }) => i.number === "2026-0001");
    const pdf = await get(`/api/invoices/${inv.id}/pdf`, lead);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.rawPayload.length).toBeGreaterThan(5000);
    const detail = (await get(`/api/invoices/${inv.id}`, lead)).json();
    expect(detail.snapshot.sender.iban).toBe("CH9300762011623852957");
    expect(detail.snapshot.recipient.city).toBe("Zürich");

    expect((await send("POST", `/api/invoices/${inv.id}/send`, lead)).statusCode).toBe(400); // no recipients yet
    await send("PUT", `/api/customers/${alpen}/recipients`, lead, { recipients: ["einkauf@alpenbank.example"] });
    t.mailer.outbox.length = 0;
    const sent = await send("POST", `/api/invoices/${inv.id}/send`, lead);
    expect(sent.json()).toMatchObject({ status: "sent", sentTo: ["einkauf@alpenbank.example"] });
    const mail = t.mailer.outbox[0]!;
    expect(mail.subject).toContain("2026-0001");
    expect(mail.attachments?.[0]?.filename).toBe("Rechnung-2026-0001.pdf");

    expect((await send("DELETE", `/api/invoices/${inv.id}`, lead)).statusCode).toBe(409);
    expect((await send("POST", `/api/invoices/${inv.id}/status`, lead, { status: "paid" })).json().status).toBe("paid");
    expect((await send("POST", `/api/invoices/${inv.id}/status`, lead, { status: "draft" })).statusCode).toBe(409);
    expect((await send("POST", `/api/invoices/${inv.id}/status`, lead, { status: "cancelled" })).json().status).toBe("cancelled");
    expect((await send("POST", `/api/invoices/${inv.id}/send`, lead)).statusCode).toBe(409);
  });

  it("deletes drafts and refuses customers without address or months without work", async () => {
    const draft = (await get(`/api/invoices?customerId=${alpen}`, lead)).json().invoices.find((i: { status: string }) => i.status === "draft");
    expect((await send("DELETE", `/api/invoices/${draft.id}`, lead)).statusCode).toBe(200);
    expect((await send("POST", "/api/invoices", lead, { customerId: alpen, month: "2020-01" })).statusCode).toBe(400);
    const d = (await get("/api/dataset", admin)).json();
    const medtech = d.customers.find((c: { name: string }) => c.name.startsWith("Medtech")).id;
    await send("PUT", `/api/customers/${medtech}/address`, admin, { name: "", street: "", zip: "", city: "" }).catch(() => {});
    const noAddress = (await send("POST", "/api/customers", admin, { name: "Neu AG", hourlyRate: 100, validFrom: "2026-01-01" })).json();
    expect((await send("POST", "/api/invoices", lead, { customerId: noAddress.id, month: "2026-09" })).statusCode).toBe(400);
  });
});

describe("project kinds", () => {
  type Pos = { text: string; quantity: number; unit: string; amount: number; share?: number };
  it("bills a retainer's contingent and the hours above it", async () => {
    const d = (await get("/api/dataset", admin)).json();
    const rhein = d.customers.find((c: { name: string }) => c.name.startsWith("Rheinlogistik")).id;
    const p = (await get(`/api/invoices/preview?customerId=${rhein}&month=2026-09`, lead)).json();
    const lines = p.positions.filter((x: Pos) => x.unit === "h") as Pos[];
    const contingent = lines.find((x) => x.text.startsWith("Retainer "))!;
    expect(contingent.quantity).toBe(120);
    const over = lines.filter((x) => x.text.includes("Mehraufwand"));
    const booked = d.timeEntries
      .filter((e: { subProjectId: string; date: string; billable: boolean }) => e.billable && e.date.startsWith("2026-09") && d.subProjects.find((s: { id: string }) => s.id === e.subProjectId)?.projectId === d.projects.find((x: { name: string }) => x.name === "Flottenmanagement").id)
      .reduce((s: number, e: { hours: number }) => s + e.hours, 0);
    expect(over.reduce((s, x) => s + x.quantity, 0)).toBeCloseTo(Math.max(0, booked - 120), 1);
    expect(lines.every((x) => x.text.startsWith("Retainer ") || x.text.includes("Mehraufwand"))).toBe(true);
  });

  it("stops bookings and retainer billing after a project is closed", async () => {
    const d = (await get("/api/dataset", admin)).json();
    const rhein = d.customers.find((c: { name: string }) => c.name.startsWith("Rheinlogistik")).id;
    const fleet = d.projects.find((x: { name: string }) => x.name === "Flottenmanagement");
    const sub = d.subProjects.find((s: { projectId: string }) => s.projectId === fleet.id);
    expect((await send("PATCH", `/api/projects/${fleet.id}`, lead, { closedOn: "2026-08-31" })).json().closedOn).toBe("2026-08-31");
    const late = await send("POST", "/api/time-entries", lead, { subProjectId: sub.id, date: "2026-09-02", hours: 1, reason: "Nachtrag" });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toContain("abgeschlossen");
    expect((await send("POST", "/api/time-entries", lead, { subProjectId: sub.id, date: "2026-08-31", hours: 1, reason: "Letzter Tag" })).statusCode).toBe(201);
    const p = (await get(`/api/invoices/preview?customerId=${rhein}&month=2026-09`, lead)).json();
    expect(p.positions.some((x: Pos) => x.text.startsWith("Retainer "))).toBe(false);
    expect((await get(`/api/invoices/preview?customerId=${rhein}&month=2026-08`, lead)).json().positions.some((x: Pos) => x.text.startsWith("Retainer "))).toBe(true);
    await send("PATCH", `/api/projects/${fleet.id}`, lead, { closedOn: null });
  });

  it("bills fixed prices in instalments up to 100 %", async () => {
    await send("PUT", `/api/customers/${stadtwerke}/address`, lead, { name: "Stadtwerke Aarau", street: "Obere Vorstadt 37", zip: "5000", city: "Aarau" });
    const p = (await get(`/api/invoices/preview?customerId=${stadtwerke}&month=2026-09`, lead)).json();
    expect(p.positions.some((x: Pos) => x.unit === "h")).toBe(false);
    const fixed = p.fixedProjects[0];
    expect(fixed).toMatchObject({ billedShare: 0 });
    expect(fixed.price).toBeGreaterThan(0);
    const withShare = (await get(`/api/invoices/preview?customerId=${stadtwerke}&month=2026-09&fixed=${encodeURIComponent(JSON.stringify({ [fixed.id]: 40 }))}`, lead)).json();
    const inst = withShare.positions.find((x: Pos) => x.unit === "%");
    expect(inst).toMatchObject({ quantity: 40, share: 40 });
    expect(inst.amount).toBeCloseTo(Math.round((fixed.price * 0.4) / 0.05) * 0.05, 2);

    expect((await send("POST", "/api/invoices", lead, { customerId: stadtwerke, month: "2026-09", fixed: { [fixed.id]: 70 } })).statusCode).toBe(201);
    expect((await send("POST", "/api/invoices", lead, { customerId: stadtwerke, month: "2026-10", fixed: { [fixed.id]: 40 } })).statusCode).toBe(400);
    expect((await get(`/api/invoices/preview?customerId=${stadtwerke}&month=2026-10`, lead)).json().fixedProjects[0].billedShare).toBe(70);
    expect((await send("POST", "/api/invoices", lead, { customerId: stadtwerke, month: "2026-10", fixed: { [fixed.id]: 30 } })).statusCode).toBe(201);
  });

  it("drafts retainer invoices on the 1st when switched on", async () => {
    const d = (await get("/api/dataset", admin)).json();
    const rhein = d.customers.find((c: { name: string }) => c.name.startsWith("Rheinlogistik")).id;
    await send("PUT", `/api/customers/${rhein}/address`, lead, { name: "Rheinlogistik AG", street: "Hafenstrasse 1", zip: "4057", city: "Basel" });
    expect(await draftRetainerInvoices(t.app.ctx, new Date("2026-10-01T08:00:00Z"))).toEqual([]);
    expect((await send("PUT", "/api/settings", admin, { autoRetainerInvoices: true })).statusCode).toBe(200);
    expect(await draftRetainerInvoices(t.app.ctx, new Date("2026-10-01T03:00:00Z"))).toEqual([]);
    const made = await draftRetainerInvoices(t.app.ctx, new Date("2026-10-01T08:00:00Z"));
    expect(made).toEqual([expect.objectContaining({ customerId: rhein })]);
    expect(await draftRetainerInvoices(t.app.ctx, new Date("2026-10-01T08:15:00Z"))).toEqual([]);
    const list = (await get(`/api/invoices?customerId=${rhein}`, lead)).json().invoices;
    expect(list.filter((i: { month: string }) => i.month === "2026-09")).toHaveLength(1);
  });
});
