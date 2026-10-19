import multipart from "@fastify/multipart";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HttpError, organizationForHost, requireRole, type AppContext } from "../app";
import { organizations } from "../db/schema";

const MAX_LOGO = 1024 * 1024;
const LOGO_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" };
const logoPath = (ctx: AppContext, orgId: string) => join(resolve(ctx.config.DATA_DIR), "branding", `logo-${orgId}`);

/** Own logo for the navigation and the login page: upload (admins), serve (public), remove. */
export async function brandingRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  await app.register(multipart, { limits: { fileSize: MAX_LOGO, files: 1 } });

  const orgOf = async (id: string) => {
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
    if (!org) throw new HttpError(404, "Organisation nicht gefunden.");
    return org;
  };

  app.post("/api/branding/logo", async (req) => {
    const user = requireRole(req, "admin");
    const file = await req.file();
    if (!file) throw new HttpError(400, "Keine Datei erhalten.");
    if (!LOGO_TYPES[file.mimetype]) throw new HttpError(400, "Erlaubt sind PNG, JPEG, WebP und SVG.");
    const buf = await file.toBuffer().catch(() => {
      throw new HttpError(400, "Die Datei ist grösser als 1 MB.");
    });
    await mkdir(join(resolve(ctx.config.DATA_DIR), "branding"), { recursive: true });
    await writeFile(logoPath(ctx, user.organizationId), buf);
    const org = await orgOf(user.organizationId);
    const branding = { ...org.settings.branding, logo: `/api/branding/logo?v=${Date.now()}`, logoMime: file.mimetype };
    await ctx.db.update(organizations).set({ settings: { ...org.settings, branding } }).where(eq(organizations.id, org.id));
    return branding;
  });

  app.delete("/api/branding/logo", async (req) => {
    const user = requireRole(req, "admin");
    const org = await orgOf(user.organizationId);
    await rm(logoPath(ctx, user.organizationId), { force: true });
    const { logo: _logo, logoMime: _mime, ...rest } = org.settings.branding;
    await ctx.db.update(organizations).set({ settings: { ...org.settings, branding: rest } }).where(eq(organizations.id, org.id));
    return rest;
  });

  app.get("/api/branding/logo", async (req, reply) => {
    // The signed-in user's organization, else the organization of the host (login page).
    const org = req.user ? await orgOf(req.user.organizationId) : await organizationForHost(ctx.db, req.headers.host);
    const mime = org?.settings.branding.logoMime;
    if (!mime) throw new HttpError(404, "Kein Logo hinterlegt.");
    const data = await readFile(logoPath(ctx, org!.id)).catch(() => {
      throw new HttpError(404, "Die Logodatei fehlt auf dem Server.");
    });
    return reply.header("content-type", mime).header("cache-control", "public, max-age=86400").send(data);
  });
}
