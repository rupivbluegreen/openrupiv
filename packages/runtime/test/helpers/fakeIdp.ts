/**
 * Offline fake OIDC identity provider for callback-flow tests.
 *
 * Builds an openid-client Configuration directly (no discovery) and wires
 * its customFetch to in-process handlers for the token endpoint and JWKS,
 * signing real RS256 ID tokens with a throwaway RSA key. openid-client then
 * performs its full validation (issuer, audience, expiry, signature, nonce)
 * against these tokens — the same code path production traffic takes.
 */

import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import * as oidc from "openid-client";
import type { OidcProvider } from "../../src/auth";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const KID = "test-key-1";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signIdToken(
  claims: Record<string, unknown>,
  key: KeyObject = privateKey,
): string {
  const header = base64url(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(key).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

export interface FakeIdp {
  provider: OidcProvider;
  issuer: string;
  /** The nonce the relying party sent; extracted from the login redirect. */
  setNonce(nonce: string): void;
  /** Extra claims merged into the next ID token. */
  setClaims(claims: Record<string, unknown>): void;
  /** Raw bodies received at the token endpoint. */
  tokenRequests: URLSearchParams[];
}

export function makeFakeIdp(options: {
  issuer?: string;
  clientId: string;
  clientSecret: string;
  claims?: Record<string, unknown>;
}): FakeIdp {
  const issuer = options.issuer ?? "https://idp.test";
  let nonce: string | undefined;
  let extraClaims: Record<string, unknown> = options.claims ?? {};
  const tokenRequests: URLSearchParams[] = [];

  const serverMetadata: oidc.ServerMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/auth`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/keys`,
  };

  const configuration = new oidc.Configuration(
    serverMetadata,
    options.clientId,
    options.clientSecret,
  );

  configuration[oidc.customFetch] = async (url, fetchOptions) => {
    if (url === serverMetadata.token_endpoint) {
      const body = new URLSearchParams(String(fetchOptions.body ?? ""));
      tokenRequests.push(body);
      const now = Math.floor(Date.now() / 1000);
      const idToken = signIdToken({
        iss: issuer,
        aud: options.clientId,
        sub: "fake-idp-user",
        iat: now,
        exp: now + 300,
        ...(nonce !== undefined ? { nonce } : {}),
        ...extraClaims,
      });
      return new Response(
        JSON.stringify({
          access_token: "fake-access-token",
          token_type: "bearer",
          expires_in: 3600,
          id_token: idToken,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === serverMetadata.jwks_uri) {
      const jwk = publicKey.export({ format: "jwk" });
      return new Response(
        JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`fakeIdp: unexpected fetch to ${url}`);
  };

  return {
    provider: {
      getConfiguration: async () => configuration,
    },
    issuer,
    setNonce(value: string) {
      nonce = value;
    },
    setClaims(claims: Record<string, unknown>) {
      extraClaims = claims;
    },
    tokenRequests,
  };
}
