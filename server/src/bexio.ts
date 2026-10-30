// bexio: a company connects its bexio account (OAuth 2.0 via auth.bexio.com) and transfers invoices
// there as drafts, with the customer as contact. Docs: https://docs.bexio.com/
import { OAuth2Client, type OAuth2Tokens } from "arctic";
import { and, eq } from "drizzle-orm";
import { HttpError, type AppContext } from "./app";
import { bexioConnections, invoices } from "./db/schema";
import { tr } from "@taktwerk/domain";

export const BEXIO_AUTH = "https://auth.bexio.com/realms/bexio/protocol/openid-connect";
export const BEXIO_API = "https://api.bexio.com";
/** Contacts and invoices, read access comes with the edit scopes; offline_access gives the refresh token. */
export const BEXIO_SCOPES = ["openid", "email", "offline_access", "contact_edit", "kb_invoice_edit"];

export type BexioConnection = typeof bexioConnections.$inferSelect;
export const bexioOn = (ctx: AppContext) => !!(ctx.config.BEXIO_CLIENT_ID && ctx.config.BEXIO_CLIENT_SECRET);
export const bexioClient = (ctx: AppContext) =>
  new OAuth2Client(ctx.config.BEXIO_CLIENT_ID!, ctx.config.BEXIO_CLIENT_SECRET!, `${new URL(ctx.config.APP_URL).origin}/api/bexio/callback`);
export const expiryOf = (t: OAuth2Tokens) => {
  try { return t.accessTokenExpiresAt(); } catch { return new Date(Date.now() + 3600_000); }
};

async function accessToken(ctx: AppContext, conn: BexioConnection) {
  if (conn.expiresAt.getTime() - 60_000 > Date.now()) return conn.accessToken;
  if (!conn.refreshToken) throw new HttpError(401, tr("Die Verbindung mit bexio ist abgelaufen. Bitte unter Einstellungen → Rechnung neu verbinden."));
  let t: OAuth2Tokens;
  try {
    t = await bexioClient(ctx).refreshAccessToken(`${BEXIO_AUTH}/token`, conn.refreshToken, BEXIO_SCOPES);
  } catch {
    throw new HttpError(401, tr("Die Verbindung mit bexio ist abgelaufen. Bitte unter Einstellungen → Rechnung neu verbinden."));
  }
  conn.accessToken = t.accessToken();
  if (t.hasRefreshToken()) conn.refreshToken = t.refreshToken();
  conn.expiresAt = expiryOf(t);
  await ctx.db.update(bexioConnections).set({ accessToken: conn.accessToken, refreshToken: conn.refreshToken, expiresAt: conn.expiresAt }).where(eq(bexioConnections.organizationId, conn.organizationId));
  return conn.accessToken;
}

/** Calls the bexio API with the company's token; errors carry bexio's own message. */
export async function bexioApi<T>(ctx: AppContext, conn: BexioConnection | { accessToken: string }, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = "organizationId" in conn ? await accessToken(ctx, conn) : conn.accessToken;
  const res = await fetch(`${BEXIO_API}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (res.status === 401) throw new HttpError(401, tr("Die Verbindung mit bexio ist abgelaufen. Bitte unter Einstellungen → Rechnung neu verbinden."));
  if (res.status === 403) throw new HttpError(403, tr("Dem bexio-Benutzer fehlt die Berechtigung dafür."));
  if (res.status === 429) throw new HttpError(429, tr("bexio nimmt gerade keine Anfragen an. Bitte in einer Minute nochmals versuchen."));
  if (!res.ok) {
    const detail = await res.json().then((j) => String((j as { message?: string }).message ?? "")).catch(() => "");
    throw new HttpError(502, tr("bexio antwortet mit Fehler {0}{1}", res.status, detail ? `: ${detail}` : "."));
  }
  return (await res.json()) as T;
}

interface Tax { id: number; value: number | string; type?: string; is_active?: boolean }
interface Currency { id: number; name: string }

/**
 * Creates the invoice in bexio as a draft: finds or creates the customer as contact, picks the sales tax
 * with the invoice's rate and sends the positions with net prices. Returns the bexio id and its address.
 */
export async function transferInvoice(ctx: AppContext, orgId: string, invoiceId: string) {
  const [conn] = await ctx.db.select().from(bexioConnections).where(eq(bexioConnections.organizationId, orgId)).limit(1);
  if (!conn) throw new HttpError(404, tr("Keine Verbindung mit bexio."));
  const [inv] = await ctx.db.select().from(invoices).where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, orgId))).limit(1);
  if (!inv) throw new HttpError(404, tr("Rechnung nicht gefunden."));
  if (inv.bexioId) throw new HttpError(409, tr("Rechnung {0} ist schon in bexio.", inv.number));
  if (inv.status === "cancelled") throw new HttpError(400, tr("Eine stornierte Rechnung wird nicht übertragen."));

  // Contact: remembered, else found by name, else created.
  let contactId = conn.contacts[inv.customerId];
  if (!contactId) {
    const name = inv.snapshot.recipient.name || inv.snapshot.customerName;
    const found = await bexioApi<{ id: number }[]>(ctx, conn, "/2.0/contact/search", { method: "POST", body: [{ field: "name_1", value: name, criteria: "=" }] });
    if (found[0]) contactId = found[0].id;
    else {
      const a = inv.snapshot.recipient;
      const created = await bexioApi<{ id: number }>(ctx, conn, "/2.0/contact", {
        method: "POST",
        body: { contact_type_id: 1, name_1: name, user_id: conn.bexioUserId, owner_id: conn.bexioUserId, street_name: a.street || null, postcode: a.zip || null, city: a.city || null },
      });
      contactId = created.id;
    }
    conn.contacts = { ...conn.contacts, [inv.customerId]: contactId };
    await ctx.db.update(bexioConnections).set({ contacts: conn.contacts }).where(eq(bexioConnections.organizationId, orgId));
  }

  const taxes = await bexioApi<Tax[]>(ctx, conn, "/3.0/taxes?scope=active&types=sales_tax");
  const tax = taxes.find((t) => Math.abs(Number(t.value) - inv.vatRate) < 0.001 && t.is_active !== false);
  if (!tax) throw new HttpError(422, tr("In bexio gibt es keinen aktiven Umsatzsteuersatz von {0} %.", inv.vatRate));
  const code = inv.snapshot.currency ?? "CHF";
  const currency = (await bexioApi<Currency[]>(ctx, conn, "/3.0/currencies")).find((c) => c.name === code);
  if (!currency) throw new HttpError(422, tr("In bexio ist die Währung {0} nicht eingerichtet.", code));

  const created = await bexioApi<{ id: number; document_nr?: string }>(ctx, conn, "/2.0/kb_invoice", {
    method: "POST",
    body: {
      title: tr("Rechnung {0}", inv.number),
      contact_id: contactId,
      user_id: conn.bexioUserId,
      currency_id: currency.id,
      mwst_type: 0,
      mwst_is_net: true,
      is_valid_from: inv.issueDate,
      is_valid_to: inv.dueDate,
      api_reference: inv.number,
      positions: inv.positions.map((p) => ({
        type: "KbPositionCustom",
        amount: String(p.quantity),
        unit_price: p.unitPrice.toFixed(2),
        tax_id: tax.id,
        text: p.detail ? `${p.text}\n${p.detail}` : p.text,
      })),
    },
  });
  await ctx.db.update(invoices).set({ bexioId: String(created.id) }).where(eq(invoices.id, inv.id));
  return { bexioId: String(created.id), url: `https://office.bexio.com/index.php/kb_invoice/show/id/${created.id}` };
}
