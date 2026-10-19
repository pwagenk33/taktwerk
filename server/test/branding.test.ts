import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PASSWORD, login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let admin: string, lea: string;

beforeAll(async () => {
  t = await setup({ DATA_DIR: `/tmp/taktwerk-test-${process.pid}` });
  [admin, lea] = await Promise.all(["anna.keller", "lea.meier"].map(async (u) => (await login(t.app, u)).cookie));
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
const upload = (cookie: string, bytes: Uint8Array, type: string, name: string) => {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  return t.app.inject({ method: "POST", url: "/api/branding/logo", headers: { cookie }, payload: form });
};

describe("branding logo", () => {
  it("admins upload a logo, everyone can fetch it, admins remove it", async () => {
    const up = await upload(admin, png, "image/png", "logo.png");
    expect(up.statusCode).toBe(200);
    expect(up.json().logo).toMatch(/^\/api\/branding\/logo\?v=/);

    const pub = await t.app.inject({ method: "GET", url: "/api/branding/logo" });
    expect(pub.statusCode).toBe(200);
    expect(pub.headers["content-type"]).toBe("image/png");
    expect(pub.rawPayload.length).toBe(png.length);
    expect((await t.app.inject({ method: "GET", url: "/api/branding" })).json().logoMime).toBe("image/png");

    // saving colours keeps the logo
    await t.app.inject({ method: "PUT", url: "/api/settings", headers: { cookie: admin }, payload: { branding: { appName: "Taktwerk", primaryColor: "#1E5F99", showMotif: true } } });
    expect((await t.app.inject({ method: "GET", url: "/api/branding" })).json()).toMatchObject({ primaryColor: "#1E5F99", logoMime: "image/png" });

    const del = await t.app.inject({ method: "DELETE", url: "/api/branding/logo", headers: { cookie: admin } });
    expect(del.statusCode).toBe(200);
    expect(del.json().logo).toBeUndefined();
    expect((await t.app.inject({ method: "GET", url: "/api/branding/logo" })).statusCode).toBe(404);
  });

  it("rejects employees and wrong file types", async () => {
    expect((await upload(lea, png, "image/png", "logo.png")).statusCode).toBe(403);
    expect((await upload(admin, new TextEncoder().encode("hello"), "text/plain", "x.txt")).statusCode).toBe(400);
  });
});

describe("password change", () => {
  const change = (cookie: string, current: string, next: string) => t.app.inject({ method: "POST", url: "/api/auth/password/change", headers: { cookie }, payload: { current, next } });
  it("needs the current password and applies the rules", async () => {
    expect((await change(lea, "falsch", "Neues-Passwort-123")).statusCode).toBe(400);
    expect((await change(lea, PASSWORD, "kurz")).statusCode).toBe(400);
    expect((await change(lea, PASSWORD, "Neues-Passwort-123")).statusCode).toBe(200);
    expect((await login(t.app, "lea.meier", "Neues-Passwort-123")).res.statusCode).toBe(200);
    expect((await login(t.app, "lea.meier")).res.statusCode).toBe(401);
  });
});
