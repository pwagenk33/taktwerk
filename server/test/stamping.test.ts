import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let anna: string;
let marco: string;

beforeAll(async () => {
  t = await setup();
  anna = (await login(t.app, "anna.keller")).cookie;
  marco = (await login(t.app, "marco.brunner")).cookie;
  await t.app.inject({ method: "PUT", url: "/api/settings", headers: { cookie: anna }, payload: { timeModel: "full" } });
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, cookie: string, payload?: object) => t.app.inject({ method, url, headers: { cookie }, payload });
// Zurich main station and a place about 2 km away.
const HB = { lat: 47.3779, lng: 8.5403 };
const FAR = { lat: 47.3962, lng: 8.5236 };

describe("stamping with NFC tags, QR codes and the location", () => {
  it("stamps through a point's link, checks the location when required and never shares the links with everyone", async () => {
    const made = await call("POST", "/api/presence/points", anna, { name: "Eingang Werkstatt", ...HB, radius: 100 });
    expect(made.statusCode).toBe(201);
    const point = made.json().points[0] as { id: string; url: string };
    const token = point.url.split("#stempeln/")[1]!;
    expect(point.url).toMatch(/^https:\/\/zeit\.example\.ch\/#stempeln\//);
    expect((await call("GET", "/api/presence/points", marco)).statusCode).toBe(403);
    const settings = JSON.stringify((await call("GET", "/api/settings", marco)).json());
    expect(settings).not.toContain(token);

    // NFC/QR: the landing page tells what can be stamped, the stamp remembers the point.
    const landing = (await call("GET", `/api/presence/point/${token}`, marco)).json();
    expect(landing).toMatchObject({ name: "Eingang Werkstatt", state: "off", options: ["in"] });
    expect((await call("POST", "/api/presence/stamp", marco, { action: "in", point: token })).statusCode).toBe(200);
    expect((await call("POST", "/api/presence/stamp", marco, { action: "out", point: "falsch" })).statusCode).toBe(404);
    const [rows] = (await t.pool.query("select source, point_id from work_periods where point_id is not null")) as unknown as [{ source: string; point_id: string }[]];
    expect(rows[0]).toEqual({ source: "nfc", point_id: point.id });

    // Geofence on: app stamps need the location, near a point.
    expect((await call("PUT", "/api/presence/geofence", anna, { on: true })).json().geofence).toBe(true);
    expect((await call("POST", "/api/presence/stamp", marco, { action: "break" })).statusCode).toBe(428);
    expect((await call("POST", "/api/presence/stamp", marco, { action: "break", ...FAR, accuracy: 30 })).statusCode).toBe(409);
    const near = await call("POST", "/api/presence/stamp", marco, { action: "break", lat: HB.lat + 0.0005, lng: HB.lng, accuracy: 20 });
    expect(near.statusCode).toBe(200);
    expect(near.json().state).toBe("break");

    const qr = await call("GET", `/api/presence/points/${point.id}/qr.svg`, anna);
    expect(qr.headers["content-type"]).toContain("image/svg+xml");
    expect(qr.payload).toContain("<svg");

    // A new link makes old tags useless.
    await call("PATCH", `/api/presence/points/${point.id}`, anna, { renewToken: true });
    expect((await call("GET", `/api/presence/point/${token}`, marco)).statusCode).toBe(404);
  });
});
