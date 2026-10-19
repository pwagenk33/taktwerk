// Passkeys in the browser: converts the server's JSON options for navigator.credentials and the result back to JSON.
const toBuf = (b64url: string) => Uint8Array.from(atob(b64url.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const toB64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const passkeysSupported = () => typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;

/** Creates a new passkey from registration options (as returned by POST /api/me/passkeys/options). */
export async function createPasskey(options: Record<string, unknown>) {
  const pk = {
    ...options,
    challenge: toBuf(options.challenge as string),
    user: { ...(options.user as Record<string, unknown>), id: toBuf((options.user as { id: string }).id) },
    excludeCredentials: ((options.excludeCredentials as { id: string; transports?: string[] }[] | undefined) ?? []).map((c) => ({ ...c, id: toBuf(c.id), type: "public-key" })),
  } as unknown as PublicKeyCredentialCreationOptions;
  const cred = (await navigator.credentials.create({ publicKey: pk })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Es wurde kein Passkey erstellt.");
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: toB64(cred.rawId),
    type: cred.type,
    response: { clientDataJSON: toB64(r.clientDataJSON), attestationObject: toB64(r.attestationObject), transports: typeof r.getTransports === "function" ? r.getTransports() : [] },
    clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: (cred as PublicKeyCredential & { authenticatorAttachment?: string }).authenticatorAttachment,
  };
}

/** Signs a challenge with an existing passkey (options from POST /api/auth/passkey/options). */
export async function usePasskey(options: Record<string, unknown>) {
  const pk = {
    ...options,
    challenge: toBuf(options.challenge as string),
    allowCredentials: ((options.allowCredentials as { id: string; transports?: string[] }[] | undefined) ?? []).map((c) => ({ ...c, id: toBuf(c.id), type: "public-key" })),
  } as unknown as PublicKeyCredentialRequestOptions;
  const cred = (await navigator.credentials.get({ publicKey: pk })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Kein Passkey gewählt.");
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: toB64(cred.rawId),
    type: cred.type,
    response: { clientDataJSON: toB64(r.clientDataJSON), authenticatorData: toB64(r.authenticatorData), signature: toB64(r.signature), userHandle: r.userHandle ? toB64(r.userHandle) : undefined },
    clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: (cred as PublicKeyCredential & { authenticatorAttachment?: string }).authenticatorAttachment,
  };
}
