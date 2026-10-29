import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
const BASE = "trackinsight.test";
const dir = mkdtempSync(join(tmpdir(), "website-"));

beforeAll(async () => {
  writeFileSync(join(dir, "index.html"), '<a href="%APP_URL%/registrieren">Testen</a>');
  writeFileSync(join(dir, "preise.html"), "<h1>Preise</h1>");
  writeFileSync(join(dir, "404.html"), "<h1>Nicht gefunden</h1>");
  writeFileSync(join(dir, "site.css"), "body{}");
  mkdirSync(join(dir, "img"));
  writeFileSync(join(dir, "img", "a.jpg"), "jpg");
  t = await setup({ SAAS: "true", SAAS_BASE_DOMAIN: BASE, APP_URL: `https://app.${BASE}`, WEBSITE_DIR: dir, OPERATOR_EMAIL: "betrieb@trackinsight.test" });
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
  rmSync(dir, { recursive: true, force: true });
});

const get = (url: string, host: string) => t.app.inject({ method: "GET", url, headers: { host } });

describe("Website", () => {
  it("serves the pages on the base domain with clean URLs and the app address filled in", async () => {
    const home = await get("/", BASE);
    expect(home.statusCode).toBe(200);
    expect(home.headers["content-type"]).toContain("text/html");
    expect(home.body).toBe(`<a href="https://app.${BASE}/registrieren">Testen</a>`);
    expect((await get("/preise", BASE)).body).toBe("<h1>Preise</h1>");
    expect((await get("/site.css", BASE)).headers["content-type"]).toContain("text/css");
    expect((await get("/img/a.jpg", BASE)).headers["cache-control"]).toContain("max-age=604800");
  });

  it("answers unknown paths and path tricks with the 404 page", async () => {
    for (const url of ["/gibt-es-nicht", "/../package.json", "/%2e%2e/package.json"]) {
      const res = await get(url, BASE);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe("<h1>Nicht gefunden</h1>");
    }
  });

  it("redirects www to the base domain", async () => {
    const res = await get("/preise", `www.${BASE}`);
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe(`https://${BASE}/preise`);
  });

  it("shows the website locally on website.localhost", async () => {
    const res = await get("/preise", "website.localhost:3000");
    expect(res.body).toBe("<h1>Preise</h1>");
  });

  it("leaves the app and company hosts alone", async () => {
    expect((await get("/", `app.${BASE}`)).body).not.toContain("Testen");
    expect((await get("/api/health", BASE)).json()).toEqual({ ok: true });
  });

  it("sends the contact form to the operator, ignores bots and limits repeats", async () => {
    const payload = { name: "Nina Huber", company: "Neu AG", email: "nina@neu.ch", size: "11 bis 50", message: "Wir möchten eine Demo." };
    const post = (p: object, ip = "10.0.0.1") => t.app.inject({ method: "POST", url: "/api/contact", headers: { host: BASE, origin: `https://${BASE}` }, payload: p, remoteAddress: ip });
    const res = await post(payload);
    expect(res.statusCode).toBe(200);
    const mail = t.mailer.outbox.find((m) => m.to === "betrieb@trackinsight.test" && m.subject === "Anfrage über die Website: Neu AG");
    expect(mail?.text).toContain("nina@neu.ch");
    expect(mail?.text).toContain("Wir möchten eine Demo.");

    const before = t.mailer.outbox.length;
    expect((await post({ ...payload, website: "http://spam" }, "10.0.0.2")).statusCode).toBe(200);
    expect(t.mailer.outbox.length).toBe(before);

    expect((await post({ ...payload, email: "kein-mail" }, "10.0.0.3")).statusCode).toBe(400);
    for (let i = 0; i < 4; i++) await post(payload, "10.0.0.4");
    expect((await post(payload, "10.0.0.4")).statusCode).toBe(200);
    expect((await post(payload, "10.0.0.4")).statusCode).toBe(429);
  });
});
