import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignedXml } from "xml-crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let anna: string;

/** A throw-away identity provider key pair (self-signed, like Entra ID's SAML signing certificate). */
function keyPair() {
  const dir = mkdtempSync(join(tmpdir(), "idp-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=Test IdP", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")], { stdio: "ignore" });
  const cert = readFileSync(join(dir, "c.pem"), "utf8");
  return { key: readFileSync(join(dir, "k.pem"), "utf8"), cert, certB64: cert.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "") };
}
const idp = keyPair();
const stranger = keyPair();

function samlResponse(opts: { acs: string; audience: string; email: string; name: string; key?: string; cert?: string }) {
  const now = new Date();
  const iso = (ms: number) => new Date(now.getTime() + ms).toISOString();
  const issuer = "https://sts.windows.net/test-tenant/";
  const id = `_${Math.random().toString(36).slice(2)}`;
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${id}" Version="2.0" IssueInstant="${iso(0)}" Destination="${opts.acs}">` +
    `<saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="_a${id}" Version="2.0" IssueInstant="${iso(0)}"><saml:Issuer>${issuer}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${opts.email}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(300_000)}" Recipient="${opts.acs}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${iso(300_000)}"><saml:AudienceRestriction><saml:Audience>${opts.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="_s${id}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement><saml:Attribute Name="http://schemas.microsoft.com/identity/claims/displayname"><saml:AttributeValue>${opts.name}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
    `</saml:Assertion></samlp:Response>`;
  const sig = new SignedXml({
    privateKey: opts.key ?? idp.key,
    publicCert: opts.cert ?? idp.cert,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  sig.addReference({ xpath: "//*[local-name(.)='Assertion']", digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256", transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"] });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: "after" } });
  return Buffer.from(sig.getSignedXml()).toString("base64");
}

beforeAll(async () => {
  t = await setup();
  anna = (await login(t.app, "anna.keller")).cookie;
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

const req = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object, headers: Record<string, string> = {}) =>
  t.app.inject({ method, url, payload, headers });
const sessionOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === "tw_session");
  return c ? `tw_session=${c.value}` : "";
};

describe("company sign-in (SAML) and SCIM provisioning", () => {
  let sp: { entityId: string; acs: string };

  it("signs a new person in through SAML, rejects foreign signatures and enforces SSO for non-admins", async () => {
    const saved = await req("PUT", "/api/sso", { saml: { enabled: true, entryPoint: "https://login.microsoftonline.com/test-tenant/saml2", cert: idp.cert }, domains: ["firma-sso.ch"], enforce: true }, { cookie: anna });
    expect(saved.statusCode).toBe(200);
    sp = saved.json().sp;
    expect(saved.json().saml.cert).toBe(idp.certB64);

    // Settings for everyone no longer carry SSO details.
    const settings = (await req("GET", "/api/settings", undefined, { cookie: anna })).json();
    expect(settings.sso).toBeUndefined();
    expect(settings.ssoActive).toBe(true);

    const found = await req("GET", "/api/auth/sso?email=neu@firma-sso.ch");
    expect(found.statusCode).toBe(200);
    expect((await req("GET", "/api/auth/sso?email=jemand@anderswo.ch")).statusCode).toBe(404);
    const start = await req("GET", found.json().url.replace(/^https?:\/\/[^/]+/, ""));
    expect(start.statusCode).toBe(302);
    expect(start.headers.location).toMatch(/^https:\/\/login\.microsoftonline\.com\/test-tenant\/saml2\?SAMLRequest=/);
    expect((await req("GET", sp.entityId.replace(/^https?:\/\/[^/]+/, ""))).body).toContain(sp.acs);

    const acsPath = sp.acs.replace(/^https?:\/\/[^/]+/, "");
    const post = (SAMLResponse: string) =>
      t.app.inject({ method: "POST", url: acsPath, payload: new URLSearchParams({ SAMLResponse }).toString(), headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://login.microsoftonline.com" } });

    const ok = await post(samlResponse({ acs: sp.acs, audience: sp.entityId, email: "neu@firma-sso.ch", name: "Nina Neu" }));
    expect(ok.statusCode).toBe(302);
    const nina = sessionOf(ok);
    expect(nina).not.toBe("");
    const me = (await req("GET", "/api/auth/me", undefined, { cookie: nina })).json();
    expect(me.user?.name ?? me.name).toBe("Nina Neu");

    const forged = await post(samlResponse({ acs: sp.acs, audience: sp.entityId, email: "anna.keller@example.ch", name: "Fake", key: stranger.key, cert: stranger.cert }));
    expect(forged.headers.location).toContain("anmeldung=fehlgeschlagen");
    expect(sessionOf(forged)).toBe("");
    const wrongAudience = await post(samlResponse({ acs: sp.acs, audience: "https://other.example/", email: "neu@firma-sso.ch", name: "Nina Neu" }));
    expect(wrongAudience.headers.location).toContain("anmeldung=fehlgeschlagen");
    const outsider = await post(samlResponse({ acs: sp.acs, audience: sp.entityId, email: "fremd@anderswo.ch", name: "Fremd" }));
    expect(outsider.headers.location).toContain("anmeldung=unbekannt");

    // Enforced: password sign-in stays open for admins only.
    expect((await login(t.app, "marco.brunner")).res.statusCode).toBe(403);
    expect((await login(t.app, "anna.keller")).res.statusCode).toBe(200);
  });

  it("provisions, updates and deactivates people over SCIM with a bearer token", async () => {
    const created = await req("POST", "/api/sso/scim-token", {}, { cookie: anna });
    const token = created.json().token as string;
    expect(token).toMatch(/^scim_/);
    expect(created.json().scim.active).toBe(true);
    const scim = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: object, tok = token) =>
      t.app.inject({ method, url, payload: body ? JSON.stringify(body) : undefined, headers: { authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/scim+json" } : {}) } });

    expect((await scim("GET", "/scim/v2/Users", undefined, "scim_wrong")).statusCode).toBe(401);
    const none = (await scim("GET", '/scim/v2/Users?filter=userName eq "sam.scim@firma-sso.ch"')).json();
    expect(none.totalResults).toBe(0);

    const post = await scim("POST", "/scim/v2/Users", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "sam.scim@firma-sso.ch",
      active: true,
      displayName: "Sam Scim",
      emails: [{ primary: true, type: "work", value: "sam.scim@firma-sso.ch" }],
      name: { givenName: "Sam", familyName: "Scim" },
    });
    expect(post.statusCode).toBe(201);
    const id = post.json().id as string;
    expect((await scim("POST", "/scim/v2/Users", { userName: "sam.scim@firma-sso.ch", emails: [{ value: "sam.scim@firma-sso.ch" }] })).statusCode).toBe(409);

    const found = (await scim("GET", '/scim/v2/Users?filter=userName eq "sam.scim@firma-sso.ch"')).json();
    expect(found.totalResults).toBe(1);
    expect(found.Resources[0].displayName).toBe("Sam Scim");

    // Entra ID style PATCH: path-based replace with the boolean as a string.
    const patched = await scim("PATCH", `/scim/v2/Users/${id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "Replace", path: "name.familyName", value: "Scim-Meier" }, { op: "Replace", path: "name.givenName", value: "Sam" }, { op: "Replace", path: "active", value: "False" }],
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().active).toBe(false);
    expect(patched.json().displayName).toBe("Sam Scim-Meier");

    const users = (await req("GET", "/api/users", undefined, { cookie: anna })).json() as { id: string; active: boolean }[];
    expect(users.find((u) => u.id === id)?.active).toBe(false);

    expect((await scim("DELETE", `/scim/v2/Users/${id}`)).statusCode).toBe(204);
    // Another company's people are invisible.
    expect((await scim("GET", "/scim/v2/Users/does-not-exist")).statusCode).toBe(404);

    // Revoking the token closes the door.
    await req("DELETE", "/api/sso/scim-token", undefined, { cookie: anna });
    expect((await scim("GET", "/scim/v2/Users")).statusCode).toBe(401);
  });
});
