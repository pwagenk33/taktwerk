import multipart from "@fastify/multipart";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { HttpError, requireRole, requireUser, type AppContext, type SessionUser } from "../app";
import { expenses, organizations, users } from "../db/schema";
import { actionMail } from "../mail/mailer";
import { assertBookable, audit } from "./billing";
import { tr } from "@taktwerk/domain";
import { withLocale } from "../i18n";

const RECEIPT_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
const MAX_RECEIPT = 10 * 1024 * 1024;
const isLead = (u: SessionUser) => u.role === "admin" || u.role === "consultant";

export const receiptPath = (ctx: AppContext, expenseId: string) => join(resolve(ctx.config.DATA_DIR), "receipts", expenseId);

export async function expenseRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  await app.register(multipart, { limits: { fileSize: MAX_RECEIPT, files: 1 } });

  const load = async (user: SessionUser, id: string) => {
    const [row] = await ctx.db.select().from(expenses).where(and(eq(expenses.id, id), eq(expenses.organizationId, user.organizationId))).limit(1);
    if (!row) throw new HttpError(404, tr("Spese nicht gefunden."));
    if (row.userId !== user.id && !isLead(user)) throw new HttpError(403, tr("Dafür fehlt dir die Berechtigung."));
    return row;
  };

  /** Upload (or replace) the receipt: multipart field «file», JPEG/PNG/WebP/PDF up to 10 MB. */
  app.post("/api/expenses/:id/receipt", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const row = await load(user, id);
    await assertBookable(ctx, user, row.userId, row.date);
    const file = await req.file();
    if (!file) throw new HttpError(400, tr("Keine Datei erhalten."));
    if (!RECEIPT_TYPES[file.mimetype]) throw new HttpError(400, tr("Erlaubt sind JPEG, PNG, WebP und PDF."));
    const buf = await file.toBuffer().catch(() => {
      throw new HttpError(400, tr("Die Datei ist grösser als 10 MB."));
    });
    await mkdir(join(resolve(ctx.config.DATA_DIR), "receipts"), { recursive: true });
    await writeFile(receiptPath(ctx, id), buf);
    const name = (file.filename || tr("Beleg.{0}", RECEIPT_TYPES[file.mimetype])).slice(0, 255);
    await ctx.db.update(expenses).set({ receiptName: name, receiptMime: file.mimetype, receiptSize: buf.length }).where(eq(expenses.id, id));
    await audit(ctx, user, "expense", id, "update", { receipt: row.receiptName }, { receipt: name });
    return { name, mime: file.mimetype, size: buf.length };
  });

  app.get("/api/expenses/:id/receipt", async (req, reply) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const row = await load(user, id);
    if (!row.receiptMime) throw new HttpError(404, tr("Kein Beleg vorhanden."));
    const data = await readFile(receiptPath(ctx, id)).catch(() => {
      throw new HttpError(404, tr("Die Belegdatei fehlt auf dem Server."));
    });
    return reply
      .header("content-type", row.receiptMime)
      .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(row.receiptName ?? tr("Beleg"))}`)
      .send(data);
  });

  app.delete("/api/expenses/:id/receipt", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const row = await load(user, id);
    await assertBookable(ctx, user, row.userId, row.date);
    await rm(receiptPath(ctx, id), { force: true });
    await ctx.db.update(expenses).set({ receiptName: null, receiptMime: null, receiptSize: null }).where(eq(expenses.id, id));
    return { ok: true };
  });

  /** Approve or reject an employee's expense. The person is told by e-mail when rejected. */
  app.post("/api/expenses/:id/decide", async (req) => {
    const lead = requireRole(req, "admin", "consultant");
    const { id } = req.params as { id: string };
    const { approve, comment } = z.object({ approve: z.boolean(), comment: z.string().trim().max(500).optional() }).parse(req.body);
    const row = await load(lead, id);
    await assertBookable(ctx, lead, row.userId, row.date);
    const status = approve ? "approved" : "rejected";
    if (row.status === status) throw new HttpError(409, tr("Diese Spese ist bereits {0}.", approve ? tr("bewilligt") : tr("abgelehnt")));
    await ctx.db.update(expenses).set({ status, decidedBy: lead.id, decidedAt: new Date() }).where(eq(expenses.id, id));
    await audit(ctx, lead, "expense", id, approve ? "approve" : "reject", { status: row.status }, { status, comment });

    if (!approve && row.userId !== lead.id) {
      const [owner] = await ctx.db.select().from(users).where(eq(users.id, row.userId)).limit(1);
      const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, lead.organizationId)).limit(1);
      if (owner && org) {
        await ctx.mailer.send(
          withLocale(owner.locale, () => actionMail(org.settings.branding, {
            to: owner.email,
            subject: tr("{0}: Spese abgelehnt", org.settings.branding.appName),
            greeting: tr("Hallo {0}", owner.name.split(" ")[0]),
            lines: [
              tr("{0} hat deine Spese «{1}: {2}» über CHF {3} vom {4} abgelehnt.", lead.name, tr(row.category), row.reason, row.amount.toFixed(2), row.date.split("-").reverse().join(".")),
              ...(comment ? [tr("Begründung: {0}", comment)] : []),
            ],
            action: tr("Zeiterfassung öffnen"),
            url: new URL("/#zeit", ctx.config.APP_URL).toString(),
            footer: tr("Du kannst die Spese korrigieren und erneut einreichen oder löschen."),
          })),
        );
      }
    }
    return { id, status };
  });

  /** Employees resubmit a rejected expense after correcting it. */
  app.post("/api/expenses/:id/resubmit", async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const row = await load(user, id);
    if (row.status !== "rejected") throw new HttpError(409, tr("Nur abgelehnte Spesen können erneut eingereicht werden."));
    await assertBookable(ctx, user, row.userId, row.date);
    await ctx.db.update(expenses).set({ status: "requested", decidedBy: null, decidedAt: null }).where(eq(expenses.id, id));
    await audit(ctx, user, "expense", id, "submit", { status: "rejected" }, { status: "requested" });
    return { id, status: "requested" };
  });
}
