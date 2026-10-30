import { and, desc, eq, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireRole } from "../app";
import { customers, invoices, organizations } from "../db/schema";
import { billingProblem, createInvoice, invoicePositions, renderInvoicePdf, sendInvoice } from "../reports/invoice";
import { todayZurich } from "./data";
import { tr } from "@taktwerk/domain";

const monthParam = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, tr("Monat im Format JJJJ-MM"));

export async function invoiceRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  const load = async (orgId: string, id: string) => {
    const [row] = await ctx.db.select().from(invoices).where(and(eq(invoices.id, id), eq(invoices.organizationId, orgId))).limit(1);
    if (!row) throw new HttpError(404, tr("Rechnung nicht gefunden."));
    return row;
  };
  const summary = (i: typeof invoices.$inferSelect) => ({
    id: i.id, number: i.number, customerId: i.customerId, month: i.month, issueDate: i.issueDate, dueDate: i.dueDate,
    status: i.status, net: i.net, vat: i.vat, vatRate: i.vatRate, gross: i.gross, positions: i.positions.length, sentAt: i.sentAt, paidAt: i.paidAt, bexioId: i.bexioId,
  });

  app.get("/api/invoices", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    // Paged newest first: `before` is the last invoice number of the previous page.
    const q = z.object({ customerId: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100), before: z.string().max(40).optional() }).parse(req.query);
    const rows = await ctx.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.organizationId, user.organizationId), ...(q.customerId ? [eq(invoices.customerId, q.customerId)] : []), ...(q.before ? [lt(invoices.number, q.before)] : [])))
      .orderBy(desc(invoices.number))
      .limit(q.limit + 1);
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, user.organizationId)).limit(1);
    const page = rows.slice(0, q.limit);
    return { invoices: page.map(summary), ready: billingProblem(org?.settings.billing), next: rows.length > q.limit ? page.at(-1)!.number : null };
  });

  /** What an invoice for this month would contain, before creating it. */
  app.get("/api/invoices/preview", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const q = z.object({ customerId: z.string(), month: monthParam }).parse(req.query);
    const { positions } = await invoicePositions(ctx, user.organizationId, q.customerId, q.month);
    return { positions, net: Math.round(positions.reduce((s, p) => s + p.amount, 0) * 100) / 100 };
  });

  app.post("/api/invoices", async (req, reply) => {
    const user = requireRole(req, "admin", "consultant");
    const body = z.object({ customerId: z.string(), month: monthParam }).parse(req.body);
    const inv = await createInvoice(ctx, user.organizationId, body.customerId, body.month, todayZurich());
    return reply.status(201).send(summary(inv));
  });

  app.get("/api/invoices/:id", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const inv = await load(user.organizationId, (req.params as { id: string }).id);
    return { ...summary(inv), positions: inv.positions, snapshot: inv.snapshot };
  });

  app.get("/api/invoices/:id/pdf", async (req, reply) => {
    const user = requireRole(req, "admin", "consultant");
    const inv = await load(user.organizationId, (req.params as { id: string }).id);
    const pdf = await renderInvoicePdf(inv);
    return reply.header("content-type", "application/pdf").header("content-disposition", `attachment; filename="Rechnung-${inv.number}.pdf"`).send(pdf);
  });

  /** Mails the PDF to the customer's report recipients and marks the invoice as sent. */
  app.post("/api/invoices/:id/send", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const inv = await load(user.organizationId, (req.params as { id: string }).id);
    if (inv.status === "cancelled") throw new HttpError(409, tr("Eine stornierte Rechnung kann nicht versendet werden."));
    const [c] = await ctx.db.select().from(customers).where(eq(customers.id, inv.customerId)).limit(1);
    const to = c?.reportRecipients ?? [];
    if (to.length === 0) throw new HttpError(400, tr("Für diesen Kunden sind keine Empfänger hinterlegt (Reports → Empfänger)."));
    await sendInvoice(ctx, inv, to);
    if (inv.status === "draft") await ctx.db.update(invoices).set({ status: "sent", sentAt: new Date() }).where(eq(invoices.id, inv.id));
    return { sentTo: to, status: inv.status === "draft" ? "sent" : inv.status };
  });

  app.post("/api/invoices/:id/status", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const inv = await load(user.organizationId, (req.params as { id: string }).id);
    const { status } = z.object({ status: z.enum(["sent", "paid", "cancelled", "draft"]) }).parse(req.body);
    if (inv.status === "paid" && status !== "cancelled" && status !== "paid") throw new HttpError(409, tr("Eine bezahlte Rechnung kann nur storniert werden."));
    if (status === "draft" && inv.status !== "sent") throw new HttpError(409, tr("Nur versendete Rechnungen können auf Entwurf zurückgesetzt werden."));
    await ctx.db
      .update(invoices)
      .set({ status, paidAt: status === "paid" ? new Date() : null, sentAt: status === "draft" ? null : inv.sentAt ?? (status === "sent" ? new Date() : null) })
      .where(eq(invoices.id, inv.id));
    return { id: inv.id, status };
  });

  /** Drafts can be deleted; everything else is cancelled so the numbering stays complete. */
  app.delete("/api/invoices/:id", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const inv = await load(user.organizationId, (req.params as { id: string }).id);
    if (inv.status !== "draft") throw new HttpError(409, tr("Nur Entwürfe können gelöscht werden; versendete Rechnungen werden storniert."));
    await ctx.db.delete(invoices).where(eq(invoices.id, inv.id));
    return { ok: true };
  });
}
