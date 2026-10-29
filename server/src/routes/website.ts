import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { z } from "zod";
import { HttpError, type AppContext } from "../app";
import { notifyOperator } from "./subscription";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

/** True when the request is for the public website: the SaaS base domain or www.<base>, unless the app itself runs there. */
export function isWebsiteHost(ctx: AppContext, host: string | undefined) {
  if (!ctx.config.WEBSITE_DIR) return false;
  const h = (host ?? "").split(":")[0]!.toLowerCase();
  // Local preview: browsers resolve *.localhost to this computer, so http://website.localhost:3000 shows the website.
  if (h === "website.localhost") return true;
  const base = ctx.config.SAAS_BASE_DOMAIN?.toLowerCase();
  if (!base) return false;
  if (h === new URL(ctx.config.APP_URL).hostname.toLowerCase()) return false;
  return h === base || h === `www.${base}`;
}

/**
 * The public website (website/ in the repository, built to WEBSITE_DIR) on trackinsight.ch, next to the app on
 * app.trackinsight.ch and the companies on <slug>.trackinsight.ch. Clean URLs: /preise serves preise.html.
 * %APP_URL% in the pages becomes APP_URL, so the sign-up buttons lead to the app; %SITE_URL% (canonical links,
 * sitemap, robots.txt) becomes the website's own address.
 */
export function serveWebsite(app: FastifyInstance, ctx: AppContext) {
  const dir = ctx.config.WEBSITE_DIR ? resolve(ctx.config.WEBSITE_DIR) : null;
  const cache = new Map<string, Buffer>();
  const read = (file: string) => {
    if (ctx.config.NODE_ENV !== "production") return readFileSync(file);
    let b = cache.get(file);
    if (!b) cache.set(file, (b = readFileSync(file)));
    return b;
  };
  const appUrl = ctx.config.APP_URL.replace(/\/$/, "");

  if (dir && existsSync(dir)) {
    app.addHook("onRequest", async (req, reply) => {
      if (req.url.startsWith("/api/") || !isWebsiteHost(ctx, req.headers.host)) return;
      const base = ctx.config.SAAS_BASE_DOMAIN?.toLowerCase();
      if (base && (req.headers.host ?? "").toLowerCase().startsWith("www.")) return reply.redirect(`https://${base}${req.url}`, 301);
      if (req.method !== "GET" && req.method !== "HEAD") return reply.status(405).send();
      const path = decodeURIComponent(req.url.split("?")[0]!);
      let rel = path === "/" ? "index.html" : normalize(path).replace(/^[/\\]+/, "");
      if (rel.includes("..")) rel = "404.html";
      if (!extname(rel)) rel += ".html";
      let file = join(dir, rel);
      let status = 200;
      if (!file.startsWith(dir) || !existsSync(file) || rel === "404.html") {
        file = join(dir, "404.html");
        status = 404;
      }
      const ext = extname(file);
      let body: Buffer | string = read(file);
      if (ext === ".html" || ext === ".xml" || ext === ".txt") {
        const siteUrl = base ? `https://${base}` : `http://${req.headers.host ?? "website.localhost"}`;
        body = body.toString("utf8").replaceAll("%APP_URL%", appUrl).replaceAll("%SITE_URL%", siteUrl);
      }
      const longCache = rel.startsWith("img/") || rel.startsWith("fonts/");
      return reply
        .status(status)
        .header("content-type", TYPES[ext] ?? "application/octet-stream")
        .header("cache-control", longCache ? "public, max-age=604800" : "public, max-age=300")
        .send(body);
    });
  }
}

/** Contact form on the website: goes to OPERATOR_EMAIL. Honeypot field «website» and five messages per hour and address. */
export async function contactRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const sent = new Map<string, { count: number; until: number }>();
  app.post("/api/contact", async (req) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(120),
        company: z.string().trim().max(120).optional().default(""),
        email: z.string().trim().email().max(200),
        phone: z.string().trim().max(40).optional().default(""),
        size: z.string().trim().max(40).optional().default(""),
        message: z.string().trim().min(1).max(4000),
        website: z.string().optional().default(""),
      })
      .parse(req.body);
    if (body.website) return { ok: true }; // bots fill the hidden field; pretend success
    const r = sent.get(req.ip);
    if (r && r.count >= 5 && r.until > Date.now()) throw new HttpError(429, "Zu viele Anfragen");
    sent.set(req.ip, { count: (r && r.until > Date.now() ? r.count : 0) + 1, until: Date.now() + 3600_000 });
    if (!ctx.config.OPERATOR_EMAIL) throw new HttpError(503, "Das Formular ist noch nicht eingerichtet");
    await notifyOperator(ctx, `Anfrage über die Website: ${body.company || body.name}`, [
      `Name: ${body.name}`,
      `Firma: ${body.company || "–"}`,
      `E-Mail: ${body.email}`,
      `Telefon: ${body.phone || "–"}`,
      `Personen: ${body.size || "–"}`,
      "",
      body.message,
    ]);
    return { ok: true };
  });
}
