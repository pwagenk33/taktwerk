import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpCode, verifyTotp, base32Decode, base32Encode } from "../src/auth/totp";
import { describe as describeUa } from "../src/routes/security";
import { PASSWORD, login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let lea: string;

beforeAll(async () => {
  t = await setup();
  lea = (await login(t.app, "lea.meier")).cookie;
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

const get = (url: string, cookie: string) => t.app.inject({ method: "GET", url, headers: { cookie } });
const send = (method: "POST" | "DELETE", url: string, cookie: string, payload?: object) => t.app.inject({ method, url, headers: { cookie, "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0" }, payload });

describe("TOTP", () => {
  it("matches the RFC 6238 test vector and tolerates one step of drift", () => {
    // RFC 6238 vector: secret "12345678901234567890", T=59 → 287082 (8 digits 94287082)
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
    expect(totpCode(secret, 59_000)).toBe("287082");
    expect(verifyTotp(secret, "287082", 59_000 + 30_000)).toBe(true);
    expect(verifyTotp(secret, "287082", 59_000 + 90_000)).toBe(false);
    expect(verifyTotp(secret, "12 34 56", 59_000)).toBe(false);
  });
  it("names devices from user agents", () => {
    expect(describeUa("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1")).toBe("Safari auf iPhone");
    expect(describeUa("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36 Edg/130.0")).toBe("Edge auf Windows");
    expect(describeUa(null)).toBe("Unbekanntes Gerät");
  });
});

describe("second factor with an authenticator app", () => {
  let secret: string;
  let recovery: string[];
  it("is set up with a QR code and confirmed with a current code", async () => {
    const before = (await get("/api/me/security", lea)).json();
    expect(before).toMatchObject({ totp: false, passkeys: [], hasPassword: true });
    const setupRes = await send("POST", "/api/me/totp/setup", lea);
    expect(setupRes.statusCode).toBe(200);
    secret = setupRes.json().secret;
    expect(setupRes.json().qr).toMatch(/^data:image\/png/);
    expect(setupRes.json().url).toContain("otpauth://totp/");
    expect((await send("POST", "/api/me/totp/enable", lea, { code: "000000" })).statusCode).toBe(400);
    const on = await send("POST", "/api/me/totp/enable", lea, { code: totpCode(secret) });
    expect(on.statusCode).toBe(200);
    recovery = on.json().recoveryCodes;
    expect(recovery).toHaveLength(10);
    expect((await get("/api/me/security", lea)).json()).toMatchObject({ totp: true, recoveryCodesLeft: 10 });
  });

  it("the password alone no longer opens a session; code or recovery code completes the sign-in", async () => {
    const first = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "lea.meier", password: PASSWORD } });
    expect(first.statusCode).toBe(200);
    expect(first.json().ok).toBe(false);
    expect(first.json().second).toMatchObject({ totp: true, passkey: false });
    expect(first.cookies.find((c) => c.name === "tw_session")).toBeUndefined();
    const token = first.json().second.token;

    expect((await t.app.inject({ method: "POST", url: "/api/auth/2fa/totp", payload: { token, code: "123456" } })).statusCode).toBe(401);
    const ok = await t.app.inject({ method: "POST", url: "/api/auth/2fa/totp", payload: { token, code: totpCode(secret) } });
    expect(ok.statusCode).toBe(200);
    expect(ok.cookies.find((c) => c.name === "tw_session")).toBeTruthy();
    // The token is single use.
    expect((await t.app.inject({ method: "POST", url: "/api/auth/2fa/totp", payload: { token, code: totpCode(secret) } })).statusCode).toBe(401);

    const again = (await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "lea.meier", password: PASSWORD } })).json();
    const rec = await t.app.inject({ method: "POST", url: "/api/auth/2fa/totp", payload: { token: again.second.token, code: recovery[0].toUpperCase() } });
    expect(rec.statusCode).toBe(200);
    expect((await get("/api/me/security", lea)).json().recoveryCodesLeft).toBe(9);
    const third = (await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "lea.meier", password: PASSWORD } })).json();
    expect((await t.app.inject({ method: "POST", url: "/api/auth/2fa/totp", payload: { token: third.second.token, code: recovery[0] } })).statusCode).toBe(401);
  });

  it("lists sessions, signs out other devices and lets an admin reset the second factor", async () => {
    const list = (await get("/api/me/sessions", lea)).json();
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const others = await send("POST", "/api/me/sessions/logout-others", lea);
    expect(others.json().closed).toBeGreaterThanOrEqual(2);
    expect((await get("/api/me/sessions", lea)).json()).toHaveLength(1);
    expect(typeof (await get("/api/me/sessions", lea)).json()[0].device).toBe("string");

    expect((await send("DELETE", "/api/me/totp", lea, { password: "falsch" })).statusCode).toBe(400);
    const admin = (await login(t.app, "anna.keller")).cookie;
    const leaId = (await get("/api/auth/me", lea)).json().id;
    expect((await send("POST", `/api/users/${leaId}/security/reset`, (await login(t.app, "marco.brunner")).cookie)).statusCode).toBe(403);
    expect((await send("POST", `/api/users/${leaId}/security/reset`, admin)).statusCode).toBe(200);
    expect((await get("/api/auth/me", lea)).statusCode).toBe(401); // signed out everywhere
    const plain = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "lea.meier", password: PASSWORD } });
    expect(plain.json().ok).toBe(true);
  });

  it("offers passkey registration and sign-in options", async () => {
    const jonas = (await login(t.app, "jonas.weber")).cookie;
    const reg = await send("POST", "/api/me/passkeys/options", jonas);
    expect(reg.statusCode).toBe(200);
    expect(reg.json()).toMatchObject({ rp: { id: "localhost", name: "TrackInsight" }, user: { name: "jonas.weber" } });
    expect(reg.json().challenge).toBeTruthy();
    const auth = await t.app.inject({ method: "POST", url: "/api/auth/passkey/options", payload: {} });
    expect(auth.json()).toMatchObject({ rpId: "localhost", userVerification: "required" });
    expect(auth.json().allowCredentials ?? []).toEqual([]);
  });
});
