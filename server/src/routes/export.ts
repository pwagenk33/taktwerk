import { EXPORT_ENTITIES, exportRows, payrollAbacus, payrollRows, payrollTable, toCsv } from "@taktwerk/domain";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireRole, requireUser } from "../app";
import { invoices, organizations } from "../db/schema";
import { loadDataset } from "./data";
import { tr } from "@taktwerk/domain";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Complete data export as CSV (Excel, de-CH) or JSON for Power BI and friends; employees get their own data only. */
export async function exportRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  /** Payroll file for one month: hours, overtime, absence days and expenses per person with the company's wage types. */
  app.get("/api/export/payroll", async (req, reply) => {
    const user = requireRole(req, "admin");
    const q = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), format: z.enum(["csv", "json", "abacus"]).default("csv") }).parse(req.query);
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, user.organizationId)).limit(1);
    const rows = payrollRows(await loadDataset(ctx, user, { detailFrom: `${q.month}-01` }), q.month, org?.settings.payrollCodes ?? {});
    const name = `lohn-${q.month}`;
    if (q.format === "abacus") return reply.header("content-disposition", `attachment; filename="abacus-${name}.csv"`).type("text/csv; charset=utf-8").send(payrollAbacus(rows));
    if (q.format === "json") return reply.header("content-disposition", `attachment; filename="${name}.json"`).type("application/json").send(JSON.stringify(rows, null, 2));
    return reply.header("content-disposition", `attachment; filename="${name}.csv"`).type("text/csv; charset=utf-8").send(toCsv(payrollTable(rows)));
  });

  app.get("/api/export/:entity", async (req, reply) => {
    const user = requireUser(req);
    const { entity } = req.params as { entity: string };
    const q = z.object({ format: z.enum(["csv", "json"]).default("csv"), from: isoDate.optional(), to: isoDate.optional() }).parse(req.query);
    let rows: Record<string, unknown>[];
    if (entity === "invoices") {
      requireRole(req, "admin", "consultant");
      const data = await loadDataset(ctx, user);
      const list = await ctx.db.select().from(invoices).where(eq(invoices.organizationId, user.organizationId)).orderBy(desc(invoices.number));
      rows = list
        .filter((i) => (!q.from || i.issueDate >= q.from) && (!q.to || i.issueDate <= q.to))
        .map((i) => ({ nummer: i.number, kunde: data.customers.find((c) => c.id === i.customerId)?.name ?? "", monat: i.month, datum: i.issueDate, faellig: i.dueDate, status: i.status, netto: i.net, mwst_prozent: i.vatRate, mwst: i.vat, brutto: i.gross, waehrung: i.snapshot.currency ?? "CHF", bezahlt_am: i.paidAt?.toISOString().slice(0, 10) ?? "", id: i.id }));
    } else {
      const known = EXPORT_ENTITIES.find((e) => e.id === entity);
      if (!known) throw new HttpError(404, tr("Unbekannter Export."));
      if ((entity === "customers" || entity === "projects" || entity === "employees") && user.role === "employee") throw new HttpError(403, tr("Dafür fehlt dir die Berechtigung."));
      // With a start date only that period needs single bookings; older months come as totals and are filtered out.
      rows = exportRows(await loadDataset(ctx, user, { detailFrom: q.from }), known.id, q.from, q.to);
    }
    const stamp = new Date().toISOString().slice(0, 10);
    if (q.format === "json") {
      return reply.header("content-disposition", `attachment; filename="${entity}-${stamp}.json"`).type("application/json").send(JSON.stringify(rows, null, 2));
    }
    return reply.header("content-disposition", `attachment; filename="${entity}-${stamp}.csv"`).type("text/csv; charset=utf-8").send(toCsv(rows));
  });
}
