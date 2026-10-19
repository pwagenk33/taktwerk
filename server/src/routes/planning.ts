// Resource planning: leads reserve hours of a person for a project per ISO week. The grid itself is computed in the browser
// from the dataset (allocations, absences, work models), so this file only stores the reservations.
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError, requireRole } from "../app";
import { allocations, projects, users } from "../db/schema";

const weekKey = z.string().regex(/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/, "Woche im Format JJJJ-Www");

export async function planningRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  /** Sets (or with 0 hours removes) one reservation. Returns the stored allocation. */
  app.put("/api/planning", async (req) => {
    const lead = requireRole(req, "admin", "consultant");
    const body = z
      .object({ employeeId: z.string(), projectId: z.string(), week: weekKey, hours: z.number().min(0).max(100), note: z.string().trim().max(200).optional() })
      .parse(req.body);
    const org = lead.organizationId;
    const [person] = await ctx.db.select({ id: users.id, role: users.role }).from(users).where(and(eq(users.id, body.employeeId), eq(users.organizationId, org), eq(users.active, true))).limit(1);
    if (!person || person.role === "customer") throw new HttpError(404, "Mitarbeitende Person nicht gefunden.");
    const [project] = await ctx.db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, body.projectId), eq(projects.organizationId, org))).limit(1);
    if (!project) throw new HttpError(404, "Projekt nicht gefunden.");

    const hours = Math.round(body.hours * 2) / 2;
    const where = and(eq(allocations.userId, body.employeeId), eq(allocations.projectId, body.projectId), eq(allocations.week, body.week));
    const [existing] = await ctx.db.select().from(allocations).where(where).limit(1);
    if (hours === 0) {
      if (existing) await ctx.db.delete(allocations).where(eq(allocations.id, existing.id));
      return { removed: true, id: existing?.id ?? null };
    }
    const id = existing?.id ?? randomUUID();
    if (existing) await ctx.db.update(allocations).set({ hours, note: body.note ?? null, updatedAt: new Date() }).where(eq(allocations.id, id));
    else await ctx.db.insert(allocations).values({ id, organizationId: org, userId: body.employeeId, projectId: body.projectId, week: body.week, hours, note: body.note ?? null });
    return { id, employeeId: body.employeeId, projectId: body.projectId, week: body.week, hours, note: body.note };
  });
}
