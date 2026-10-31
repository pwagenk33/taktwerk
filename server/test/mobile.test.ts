import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  t = await setup({ APP_IOS_TEAM_ID: "ABCDE12345", APP_ANDROID_SHA256: "AA:BB:CC, DD:EE:FF" });
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

describe("store apps", () => {
  it("publishes the files that let NFC links and mails open in the installed app", async () => {
    const ios = await t.app.inject({ method: "GET", url: "/.well-known/apple-app-site-association" });
    expect(ios.statusCode).toBe(200);
    expect(ios.json().applinks.details[0].appIDs).toEqual(["ABCDE12345.ch.trackinsight.app"]);
    const android = await t.app.inject({ method: "GET", url: "/.well-known/assetlinks.json" });
    expect(android.json()[0].target).toMatchObject({ package_name: "ch.trackinsight.app", sha256_cert_fingerprints: ["AA:BB:CC", "DD:EE:FF"] });
  });
});
