import { and, desc, eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import { z } from "zod";
import { rateOn, tr } from "@taktwerk/domain";
import { HttpError, requireRole, type AppContext } from "../app";
import { customerRates, customers, organizations, projects, quotes, subProjects, type QuotePosition } from "../db/schema";
import { currentLocale, withLocale } from "../i18n";
import { todayZurich } from "./data";

const positionIn = z.object({ name: z.string().trim().min(1).max(200), note: z.string().trim().max(500).optional(), hours: z.number().min(0).max(100000), rate: z.number().min(0).max(100000) });
const quoteIn = z.object({
  customerId: z.string(),
  title: z.string().trim().min(1).max(200),
  intro: z.string().trim().max(4000).optional(),
  kind: z.enum(["tm", "fixed", "retainer"]).default("tm"),
  retainerHours: z.number().min(0).max(10000).optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  positions: z.array(positionIn).min(1).max(100),
});

const round05 = (v: number) => Math.round(v * 20) / 20;
const priced = (ps: z.infer<typeof positionIn>[]): QuotePosition[] => ps.map((p) => ({ ...p, note: p.note || undefined, amount: round05(p.hours * p.rate) }));
const total = (ps: QuotePosition[]) => Math.round(ps.reduce((s, p) => s + p.amount, 0) * 100) / 100;

async function nextNumber(ctx: AppContext, orgId: string, year: string) {
  const [last] = await ctx.db.select({ number: quotes.number }).from(quotes).where(and(eq(quotes.organizationId, orgId), like(quotes.number, `O-${year}-%`))).orderBy(desc(quotes.number)).limit(1);
  const n = last ? Number(last.number.split("-")[2]) + 1 : 1;
  return `O-${year}-${String(n).padStart(4, "0")}`;
}

type Quote = typeof quotes.$inferSelect;
const summary = (q: Quote) => ({ ...q, retainerHours: q.retainerHours ?? undefined, intro: q.intro ?? "" });

/** Quotes: draft → sent → accepted (creates the project) or declined. */
export async function quoteRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const load = async (orgId: string, id: string) => {
    const [row] = await ctx.db.select().from(quotes).where(and(eq(quotes.id, id), eq(quotes.organizationId, orgId))).limit(1);
    if (!row) throw new HttpError(404, tr("Offerte nicht gefunden."));
    return row;
  };
  const customerOf = async (orgId: string, id: string) => {
    const [c] = await ctx.db.select().from(customers).where(and(eq(customers.id, id), eq(customers.organizationId, orgId))).limit(1);
    if (!c) throw new HttpError(404, tr("Kunde nicht gefunden."));
    return c;
  };

  app.get("/api/quotes", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const q = z.object({ customerId: z.string().optional() }).parse(req.query);
    const rows = await ctx.db.select().from(quotes).where(and(eq(quotes.organizationId, user.organizationId), ...(q.customerId ? [eq(quotes.customerId, q.customerId)] : []))).orderBy(desc(quotes.number)).limit(200);
    return { quotes: rows.map(summary) };
  });

  app.post("/api/quotes", async (req, reply) => {
    const user = requireRole(req, "admin", "consultant");
    const body = quoteIn.parse(req.body);
    await customerOf(user.organizationId, body.customerId);
    const positions = priced(body.positions);
    const id = randomUUID();
    const number = await nextNumber(ctx, user.organizationId, todayZurich().slice(0, 4));
    await ctx.db.insert(quotes).values({ id, organizationId: user.organizationId, ...body, intro: body.intro || null, retainerHours: body.kind === "retainer" ? body.retainerHours ?? null : null, positions, net: total(positions), number });
    return reply.status(201).send(summary(await load(user.organizationId, id)));
  });

  app.patch("/api/quotes/:id", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const q = await load(user.organizationId, (req.params as { id: string }).id);
    if (q.status === "accepted" || q.status === "declined") throw new HttpError(409, tr("Entschiedene Offerten lassen sich nicht mehr ändern."));
    const body = quoteIn.omit({ customerId: true }).partial().parse(req.body);
    const positions = body.positions ? priced(body.positions) : undefined;
    const kind = body.kind ?? q.kind;
    const { positions: _p, ...rest } = body;
    await ctx.db.update(quotes).set({
      ...rest,
      ...(body.intro !== undefined ? { intro: body.intro || null } : {}),
      ...(positions ? { positions, net: total(positions) } : {}),
      retainerHours: kind === "retainer" ? body.retainerHours ?? q.retainerHours : null,
    }).where(eq(quotes.id, q.id));
    return summary(await load(user.organizationId, q.id));
  });

  app.delete("/api/quotes/:id", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const q = await load(user.organizationId, (req.params as { id: string }).id);
    if (q.status !== "draft") throw new HttpError(409, tr("Nur Entwürfe lassen sich löschen."));
    await ctx.db.delete(quotes).where(eq(quotes.id, q.id));
    return { ok: true };
  });

  app.post("/api/quotes/:id/status", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const q = await load(user.organizationId, (req.params as { id: string }).id);
    const { status } = z.object({ status: z.enum(["draft", "sent", "declined"]) }).parse(req.body);
    if (q.status === "accepted") throw new HttpError(409, tr("Die Offerte ist schon angenommen."));
    await ctx.db.update(quotes).set({ status, decidedAt: status === "declined" ? new Date() : null }).where(eq(quotes.id, q.id));
    return summary(await load(user.organizationId, q.id));
  });

  /**
   * Accepting creates the project (kind and budget from the quote) and one sub-project per position with its amount as budget.
   * If the quoted rate differs from the customer's current rate, the customer's rate stays: bookings use the rate table.
   */
  app.post("/api/quotes/:id/accept", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const q = await load(user.organizationId, (req.params as { id: string }).id);
    if (q.status === "accepted") throw new HttpError(409, tr("Die Offerte ist schon angenommen."));
    const body = z.object({ name: z.string().trim().min(1).max(200).optional(), leadUserId: z.string().optional() }).parse(req.body ?? {});
    const projectId = randomUUID();
    await ctx.db.transaction(async (tx) => {
      await tx.insert(projects).values({ id: projectId, organizationId: user.organizationId, customerId: q.customerId, name: body.name ?? q.title, budget: q.net, kind: q.kind, retainerHours: q.kind === "retainer" ? q.retainerHours : null, leadUserId: body.leadUserId || null });
      if (q.positions.length) await tx.insert(subProjects).values(q.positions.map((p) => ({ id: randomUUID(), organizationId: user.organizationId, projectId, name: p.name, budget: p.amount })));
      await tx.update(quotes).set({ status: "accepted", projectId, decidedAt: new Date() }).where(eq(quotes.id, q.id));
    });
    return { ...summary(await load(user.organizationId, q.id)), projectId };
  });

  app.get("/api/quotes/:id/pdf", async (req, reply) => {
    const user = requireRole(req, "admin", "consultant");
    const q = await load(user.organizationId, (req.params as { id: string }).id);
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, user.organizationId)).limit(1);
    const c = await customerOf(user.organizationId, q.customerId);
    const pdf = await withLocale(c.locale, () => renderQuotePdf(q, { orgName: org!.name, settings: org!.settings, customer: c }));
    return reply.header("content-type", "application/pdf").header("content-disposition", `attachment; filename="Offerte-${q.number}.pdf"`).send(pdf);
  });

  /** Suggested rate for a new quote: the customer's current hourly rate. */
  app.get("/api/quotes/rate", async (req) => {
    const user = requireRole(req, "admin", "consultant");
    const { customerId } = z.object({ customerId: z.string() }).parse(req.query);
    await customerOf(user.organizationId, customerId);
    const rates = await ctx.db.select().from(customerRates).where(eq(customerRates.customerId, customerId));
    return { rate: rates.length ? rateOn({ id: customerId, name: "", rates }, todayZurich()) : 0 };
  });
}

const swissDate = (d: string) => d.split("-").reverse().join(".");

function renderQuotePdf(q: Quote, o: { orgName: string; settings: typeof organizations.$inferSelect["settings"]; customer: typeof customers.$inferSelect }): Promise<Buffer> {
  const money2 = (v: number) => v.toLocaleString(`${currentLocale()}-CH`, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/'/g, "’");
  const qty = (v: number) => v.toLocaleString(`${currentLocale()}-CH`, { maximumFractionDigits: 2 }).replace(/'/g, "’");
  const sender = o.settings.billing?.address;
  const color = o.settings.branding?.primaryColor ?? "#1D1D1F";
  const currency = o.customer.currency ?? "CHF";
  const doc = new PDFDocument({ size: "A4", margins: { top: 50, bottom: 60, left: 50, right: 50 }, info: { Title: tr("Offerte {0}", q.number), Author: sender?.name ?? o.orgName } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  const W = doc.page.width - 100;
  const INK = "#1D1D1F";
  const MUTED = "#6E6E73";

  doc.fillColor(color).font("Helvetica-Bold").fontSize(16).text(sender?.name ?? o.orgName, 50, 50);
  if (sender) doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(`${sender.street} · ${sender.zip} ${sender.city}`);
  const a = o.customer.billingAddress;
  doc.fillColor(INK).font("Helvetica").fontSize(10).text([a?.name || o.customer.name, a?.street, a ? `${a.zip} ${a.city}` : ""].filter(Boolean).join("\n"), 50, 130);
  const meta: [string, string][] = [[tr("Offerte"), q.number], [tr("Datum"), swissDate(q.createdAt.toISOString().slice(0, 10))], [tr("Gültig bis"), swissDate(q.validUntil)]];
  doc.fontSize(9);
  meta.forEach(([k, v], i) => {
    doc.fillColor(MUTED).text(k, 350, 130 + i * 13, { width: 100, lineBreak: false });
    doc.fillColor(INK).text(v, 450, 130 + i * 13, { width: 95, align: "right", lineBreak: false });
  });
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(14).text(q.title, 50, 215, { width: W });
  let y = doc.y + 6;
  if (q.intro) {
    doc.font("Helvetica").fontSize(9.5).fillColor(INK).text(q.intro, 50, y, { width: W });
    y = doc.y + 10;
  }
  const kindNote = q.kind === "fixed" ? tr("Fixpreis: Verrechnet wird der offerierte Betrag, unabhängig vom effektiven Aufwand.") : q.kind === "retainer" ? tr("Monatliches Kontingent von {0} h; Stunden darüber werden nach Aufwand verrechnet.", qty(q.retainerHours ?? 0)) : tr("Verrechnung nach effektivem Aufwand; die Stunden sind eine Schätzung.");
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(kindNote, 50, y, { width: W });
  y = doc.y + 12;

  const cols = [{ label: tr("Position"), w: W * 0.5 }, { label: tr("Stunden"), w: W * 0.13, r: true }, { label: tr("Ansatz"), w: W * 0.17, r: true }, { label: tr("Betrag {0}", currency), w: W * 0.2, r: true }];
  const header = () => {
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
    let x = 50;
    for (const c of cols) {
      doc.text(c.label, x + 3, y, { width: c.w - 6, align: c.r ? "right" : "left", lineBreak: false });
      x += c.w;
    }
    doc.moveTo(50, y + 12).lineTo(50 + W, y + 12).lineWidth(0.8).stroke(INK);
    y += 16;
  };
  header();
  for (const p of q.positions) {
    doc.font("Helvetica").fontSize(9);
    const h = doc.heightOfString(p.name, { width: cols[0]!.w - 6 }) + (p.note ? doc.heightOfString(p.note, { width: cols[0]!.w - 6 }) * 0.85 + 2 : 0) + 8;
    if (y + h > doc.page.height - 120) {
      doc.addPage();
      y = 50;
      header();
    }
    doc.fillColor(INK).fontSize(9).text(p.name, 53, y + 3, { width: cols[0]!.w - 6 });
    if (p.note) doc.fillColor(MUTED).fontSize(7.5).text(p.note, 53, doc.y, { width: cols[0]!.w - 6 });
    doc.fillColor(INK).fontSize(9);
    doc.text(qty(p.hours), 50 + cols[0]!.w + 3, y + 3, { width: cols[1]!.w - 6, align: "right", lineBreak: false });
    doc.text(money2(p.rate), 50 + cols[0]!.w + cols[1]!.w + 3, y + 3, { width: cols[2]!.w - 6, align: "right", lineBreak: false });
    doc.text(money2(p.amount), 50 + cols[0]!.w + cols[1]!.w + cols[2]!.w + 3, y + 3, { width: cols[3]!.w - 6, align: "right", lineBreak: false });
    y += h;
    doc.moveTo(50, y).lineTo(50 + W, y).lineWidth(0.4).stroke("#E3E3E6");
  }
  y += 8;
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK);
  doc.text(tr("Total {0} exkl. MwSt", currency), 50 + W * 0.4, y, { width: W * 0.4 - 6, align: "right", lineBreak: false });
  doc.text(money2(q.net), 50 + W * 0.8, y, { width: W * 0.2 - 3, align: "right", lineBreak: false });
  y += 30;
  doc.font("Helvetica").fontSize(9).fillColor(INK).text(tr("Wir freuen uns auf Ihren Auftrag. Bei Fragen sind wir gerne für Sie da."), 50, y, { width: W });
  doc.end();
  return done;
}
