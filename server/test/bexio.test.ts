import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bexioConnections, customers, invoices } from "../src/db/schema";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let anna = "";
const calls: { url: string; method: string; body?: unknown }[] = [];

beforeAll(async () => {
  t = await setup({ BEXIO_CLIENT_ID: "bx-1", BEXIO_CLIENT_SECRET: "bx-secret" });
  anna = (await login(t.app, "anna.keller")).cookie;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (input instanceof Request ? input.method : init.method) ?? "GET";
    const raw = input instanceof Request ? await input.text() : String(init.body ?? "");
    const body = raw && raw.startsWith("[") || raw.startsWith("{") ? JSON.parse(raw) : raw;
    calls.push({ url, method, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url === "https://auth.bexio.com/realms/bexio/protocol/openid-connect/token") return json({ access_token: "bx-at", refresh_token: "bx-rt", expires_in: 3600, token_type: "Bearer" });
    if (url === "https://api.bexio.com/3.0/users/me") return json({ id: 7, email: "buchhaltung@firma.ch" });
    if (url === "https://api.bexio.com/2.0/contact/search") return json([]);
    if (url === "https://api.bexio.com/2.0/contact") return json({ id: 501 }, 201);
    if (url.startsWith("https://api.bexio.com/3.0/taxes")) return json([{ id: 3, value: "7.7", type: "sales_tax", is_active: true }, { id: 4, value: "8.1", type: "sales_tax", is_active: true }]);
    if (url === "https://api.bexio.com/3.0/currencies") return json([{ id: 1, name: "CHF" }, { id: 2, name: "EUR" }]);
    if (url === "https://api.bexio.com/2.0/kb_invoice") return json({ id: 9001, document_nr: "RE-00012" }, 201);
    return json({ error_code: 404, message: `unexpected ${url}` }, 404);
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await t.app.close();
  await t.pool.end();
});

describe("bexio", () => {
  it("connects with OAuth and remembers the bexio user", async () => {
    expect((await t.app.inject({ method: "GET", url: "/api/bexio", headers: { cookie: anna } })).json()).toEqual({ configured: true, connected: null });
    const start = await t.app.inject({ method: "GET", url: "/api/bexio/connect", headers: { cookie: anna } });
    const to = new URL(start.headers.location as string);
    expect(to.origin + to.pathname).toBe("https://auth.bexio.com/realms/bexio/protocol/openid-connect/auth");
    expect(to.searchParams.get("scope")).toBe("openid email offline_access contact_edit kb_invoice_edit");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    const back = await t.app.inject({ method: "GET", url: `/api/bexio/callback?code=c&state=${to.searchParams.get("state")}` });
    expect(back.headers.location).toBe("https://zeit.example.ch/?bexio=ok#einstellungen/billing");
    const [conn] = await t.db.select().from(bexioConnections);
    expect(conn).toMatchObject({ bexioUserId: 7, account: "buchhaltung@firma.ch", accessToken: "bx-at" });
  });

  it("transfers an invoice as draft with contact, tax and positions, once", async () => {
    const [c] = await t.db.select().from(customers).limit(1);
    const id = randomUUID();
    await t.db.insert(invoices).values({
      id, organizationId: c!.organizationId, customerId: c!.id, number: "2026-0042", month: "2026-09", issueDate: "2026-10-01", dueDate: "2026-10-31", status: "draft",
      positions: [{ text: "Entwicklung", detail: "Login", quantity: 12.5, unit: "h", unitPrice: 160, amount: 2000 }, { text: "Spesen Reise", quantity: 1, unit: "Stk.", unitPrice: 88.4, amount: 88.4 }],
      net: 2088.4, vatRate: 8.1, vat: 169.15, gross: 2257.55,
      snapshot: { sender: { address: { name: "A", street: "B", zip: "8000", city: "Zürich", country: "CH" }, iban: "CH9300762011623852957", paymentDays: 30 }, recipient: { name: "Alpenbank AG", street: "Bahnhofstrasse 1", zip: "8001", city: "Zürich", country: "CH" }, customerName: "Alpenbank AG", appName: "TrackInsight", primaryColor: "#6d4cf0", currency: "CHF" },
      createdAt: new Date(),
    });
    const res = await t.app.inject({ method: "POST", url: `/api/invoices/${id}/bexio`, headers: { cookie: anna } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ bexioId: "9001", url: "https://office.bexio.com/index.php/kb_invoice/show/id/9001" });

    const contact = calls.find((x) => x.url.endsWith("/2.0/contact"))!;
    expect(contact.body).toMatchObject({ contact_type_id: 1, name_1: "Alpenbank AG", user_id: 7, owner_id: 7, postcode: "8001" });
    const inv = calls.find((x) => x.url.endsWith("/2.0/kb_invoice"))!;
    expect(inv.body).toMatchObject({ contact_id: 501, user_id: 7, currency_id: 1, mwst_is_net: true, api_reference: "2026-0042", is_valid_from: "2026-10-01" });
    expect((inv.body as { positions: unknown[] }).positions).toEqual([
      { type: "KbPositionCustom", amount: "12.5", unit_price: "160.00", tax_id: 4, text: "Entwicklung\nLogin" },
      { type: "KbPositionCustom", amount: "1", unit_price: "88.40", tax_id: 4, text: "Spesen Reise" },
    ]);
    const [row] = await t.db.select().from(invoices).where(eq(invoices.id, id));
    expect(row!.bexioId).toBe("9001");
    expect((await t.app.inject({ method: "POST", url: `/api/invoices/${id}/bexio`, headers: { cookie: anna } })).statusCode).toBe(409);

    // The contact is remembered for the next invoice.
    const [conn] = await t.db.select().from(bexioConnections);
    expect(conn!.contacts[c!.id]).toBe(501);
  });

  it("is for admins and consultants; disconnects", async () => {
    const lea = (await login(t.app, "lea.meier")).cookie;
    expect((await t.app.inject({ method: "GET", url: "/api/bexio", headers: { cookie: lea } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: "DELETE", url: "/api/bexio", headers: { cookie: anna } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: "/api/bexio", headers: { cookie: anna } })).json().connected).toBeNull();
  });
});
