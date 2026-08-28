import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign as signBuffer } from "node:crypto";
import { describe, it } from "node:test";

import {
  encodeJws,
  encodeSegment,
  generateTestSigningKey,
  TestOidcIssuer,
  type TestSigningKey
} from "./oidc-test-issuer.js";
import { IdTokenError, JwksKeyStore, SigningKeyUnavailableError, verifyIdToken } from "./oidc.js";

function verifierOptions(issuer: TestOidcIssuer, overrides: { now?: () => number; jwksUri?: string } = {}) {
  return {
    issuer: issuer.issuer,
    audiences: [issuer.audience],
    keys: new JwksKeyStore({
      issuer: issuer.issuer,
      jwksUri: overrides.jwksUri ?? null,
      fetchImpl: issuer.fetch
    }),
    ...(overrides.now ? { now: overrides.now } : {})
  };
}

describe("id token verification", () => {
  it("accepts a token the issuer signed for this portal", async () => {
    const issuer = new TestOidcIssuer();
    const claims = await verifyIdToken(issuer.idToken({ email: "cole@example.com" }), verifierOptions(issuer));

    assert.equal(claims.email, "cole@example.com");
    assert.equal(claims.iss, issuer.issuer);
  });

  it("discovers the jwks_uri from the issuer, then caches both documents", async () => {
    const issuer = new TestOidcIssuer();
    const options = verifierOptions(issuer);

    await verifyIdToken(issuer.idToken(), options);
    await verifyIdToken(issuer.idToken(), options);

    assert.deepEqual(issuer.requests, [`${issuer.issuer}/.well-known/openid-configuration`, issuer.jwksUri]);
  });

  it("rejects a signature made with a key the issuer does not publish", async () => {
    const issuer = new TestOidcIssuer();
    // Same kid, different key: an attacker who copies the header learns nothing.
    const impostor: TestSigningKey = generateTestSigningKey(issuer.signingKey.kid);
    const forged = issuer.idToken({ email: "cole@example.com" }, { signingKey: impostor });

    await assert.rejects(verifyIdToken(forged, verifierOptions(issuer)), IdTokenError);
  });

  it("rejects a token whose payload was edited after signing", async () => {
    const issuer = new TestOidcIssuer();
    const [header, , signature] = issuer.idToken({ email: "family@example.com" }).split(".") as [string, string, string];
    const tampered = `${header}.${encodeSegment({ iss: issuer.issuer, aud: issuer.audience, sub: "x", email: "cole@example.com", exp: Math.floor(Date.now() / 1000) + 300 })}.${signature}`;

    await assert.rejects(verifyIdToken(tampered, verifierOptions(issuer)), IdTokenError);
  });

  it("rejects alg:none — an unsigned token is not a token", async () => {
    const issuer = new TestOidcIssuer();
    const unsigned = encodeJws(
      { alg: "none", typ: "JWT" },
      { iss: issuer.issuer, aud: issuer.audience, sub: "intruder", email: "cole@example.com", exp: Math.floor(Date.now() / 1000) + 300 },
      () => Buffer.alloc(0)
    );

    await assert.rejects(verifyIdToken(unsigned, verifierOptions(issuer)), IdTokenError);
  });

  it("rejects HMAC algorithms signed with the issuer's public key", async () => {
    // The classic alg-confusion attack: the public key is public, so if HS256
    // were honoured anyone could mint tokens with it.
    const issuer = new TestOidcIssuer();
    const publicPem = issuer.signingKey.publicKey.export({ type: "spki", format: "pem" }).toString();
    const confused = encodeJws(
      { alg: "HS256", typ: "JWT", kid: issuer.signingKey.kid },
      { iss: issuer.issuer, aud: issuer.audience, sub: "intruder", email: "cole@example.com", exp: Math.floor(Date.now() / 1000) + 300 },
      (signingInput) => createHmac("sha256", publicPem).update(signingInput).digest()
    );

    await assert.rejects(verifyIdToken(confused, verifierOptions(issuer)), IdTokenError);
  });

  it("rejects an RSA key presented for an EC algorithm", async () => {
    const issuer = new TestOidcIssuer();
    const mismatched = issuer.idToken({}, { header: { alg: "ES256" } });

    await assert.rejects(verifyIdToken(mismatched, verifierOptions(issuer)), IdTokenError);
  });

  it("rejects another issuer's token", async () => {
    const issuer = new TestOidcIssuer();
    const foreign = issuer.idToken({ iss: "https://id.attacker.test" });

    await assert.rejects(verifyIdToken(foreign, verifierOptions(issuer)), IdTokenError);
  });

  it("rejects a token minted for another client", async () => {
    const issuer = new TestOidcIssuer();

    await assert.rejects(verifyIdToken(issuer.idToken({ aud: "some-other-app" }), verifierOptions(issuer)), IdTokenError);
    await assert.rejects(
      verifyIdToken(issuer.idToken({ aud: [issuer.audience], azp: "some-other-app" }), verifierOptions(issuer)),
      IdTokenError
    );
  });

  it("accepts an aud array that includes this portal", async () => {
    const issuer = new TestOidcIssuer();
    const claims = await verifyIdToken(issuer.idToken({ aud: ["another-app", issuer.audience] }), verifierOptions(issuer));

    assert.deepEqual(claims.aud, ["another-app", issuer.audience]);
  });

  it("rejects an expired token past the clock tolerance", async () => {
    const issuer = new TestOidcIssuer();
    const now = Date.now();
    const token = issuer.idToken({ exp: Math.floor(now / 1000) + 30 });

    await assert.rejects(
      verifyIdToken(token, verifierOptions(issuer, { now: () => now + 120_000 })),
      IdTokenError
    );
  });

  it("rejects a token with no exp and one with no sub", async () => {
    const issuer = new TestOidcIssuer();
    const noExpiry = issuer.mint({ iss: issuer.issuer, aud: issuer.audience, sub: "cole" });
    const noSubject = issuer.idToken({ sub: undefined });

    await assert.rejects(verifyIdToken(noExpiry, verifierOptions(issuer)), IdTokenError);
    await assert.rejects(verifyIdToken(noSubject, verifierOptions(issuer)), IdTokenError);
  });

  it("rejects tokens that are not three-segment JWS", async () => {
    const issuer = new TestOidcIssuer();

    for (const malformed of ["", "not-a-token", "a.b", "a.b.c.d", `${encodeSegment({ alg: "RS256" })}.b.c`]) {
      await assert.rejects(verifyIdToken(malformed, verifierOptions(issuer)), IdTokenError);
    }
  });
});

describe("JWKS key store", () => {
  it("refetches on an unknown kid once the refresh floor elapses, so rotation needs no restart", async () => {
    const issuer = new TestOidcIssuer();
    const clock = { value: Date.now() };
    const options = {
      issuer: issuer.issuer,
      audiences: [issuer.audience],
      keys: new JwksKeyStore({
        issuer: issuer.issuer,
        jwksUri: issuer.jwksUri,
        fetchImpl: issuer.fetch,
        minRefreshIntervalMs: 10_000,
        now: () => clock.value
      })
    };

    await verifyIdToken(issuer.idToken(), options);
    issuer.rotate("test-key-2");

    await assert.rejects(verifyIdToken(issuer.idToken(), options), IdTokenError, "the floor holds off an instant refetch");

    clock.value += 10_000;
    const claims = await verifyIdToken(issuer.idToken({ email: "cole@example.com" }), options);

    assert.equal(claims.email, "cole@example.com");
    assert.deepEqual(issuer.requests, [issuer.jwksUri, issuer.jwksUri]);
  });

  it("does not refetch on a made-up kid inside the refresh floor", async () => {
    const issuer = new TestOidcIssuer();
    const keys = new JwksKeyStore({
      issuer: issuer.issuer,
      jwksUri: issuer.jwksUri,
      fetchImpl: issuer.fetch,
      minRefreshIntervalMs: 60_000
    });

    await keys.getKey(issuer.signingKey.kid);
    assert.equal(await keys.getKey("invented-kid"), null);
    assert.equal(await keys.getKey("another-invented-kid"), null);

    assert.equal(issuer.requests.length, 1, "unknown kids must not become a request amplifier");
  });

  it("reports unavailability rather than rejection when the key set cannot be reached", async () => {
    const issuer = new TestOidcIssuer();
    const keys = new JwksKeyStore({
      issuer: issuer.issuer,
      jwksUri: issuer.jwksUri,
      fetchImpl: async () => new Response("boom", { status: 500 })
    });

    await assert.rejects(
      verifyIdToken(issuer.idToken(), { issuer: issuer.issuer, audiences: [issuer.audience], keys }),
      SigningKeyUnavailableError
    );
  });

  it("keeps serving the last good key set when a refresh fails", async () => {
    const issuer = new TestOidcIssuer();
    let reachable = true;
    const clock = { value: Date.now() };
    const keys = new JwksKeyStore({
      issuer: issuer.issuer,
      jwksUri: issuer.jwksUri,
      cacheTtlMs: 1_000,
      fetchImpl: async (input) => (reachable ? issuer.fetch(input) : new Response("down", { status: 503 })),
      now: () => clock.value
    });

    assert.ok(await keys.getKey(issuer.signingKey.kid));

    reachable = false;
    clock.value += 60_000;

    assert.ok(await keys.getKey(issuer.signingKey.kid), "a JWKS outage must not lock out signed-in users");
  });

  it("refuses a discovery document that points jwks_uri at another origin", async () => {
    const issuer = new TestOidcIssuer();
    const keys = new JwksKeyStore({
      issuer: issuer.issuer,
      fetchImpl: async () => new Response(JSON.stringify({ jwks_uri: "https://attacker.test/keys" }), { status: 200 })
    });

    await assert.rejects(keys.getKey("test-key-1"), SigningKeyUnavailableError);
  });

  it("ignores non-signing and unreadable JWKs without losing the rest of the set", async () => {
    const issuer = new TestOidcIssuer();
    const good = issuer.jwksDocument().keys[0];
    const keys = new JwksKeyStore({
      issuer: issuer.issuer,
      jwksUri: issuer.jwksUri,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            keys: [{ kty: "oct", k: "c2hhcmVk", kid: "symmetric" }, { kty: "RSA", kid: "broken" }, good]
          }),
          { status: 200 }
        )
    });

    assert.equal(await keys.getKey("symmetric"), null);
    assert.equal(await keys.getKey("broken"), null);
    assert.ok(await keys.getKey(issuer.signingKey.kid));
  });

  it("resolves a kid-less token only when the issuer publishes a single key", async () => {
    const issuer = new TestOidcIssuer();
    const single = new JwksKeyStore({ issuer: issuer.issuer, jwksUri: issuer.jwksUri, fetchImpl: issuer.fetch });

    assert.ok(await single.getKey(null));

    const second = generateTestSigningKey("test-key-2");
    const ambiguous = new JwksKeyStore({
      issuer: issuer.issuer,
      jwksUri: issuer.jwksUri,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            keys: [
              ...issuer.jwksDocument().keys,
              { ...(second.publicKey.export({ format: "jwk" }) as object), kid: second.kid, use: "sig", alg: "RS256" }
            ]
          }),
          { status: 200 }
        )
    });

    assert.equal(await ambiguous.getKey(null), null);
  });

  it("verifies ES256 tokens against an EC key", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const issuer = new TestOidcIssuer();
    const jwk = { ...(publicKey.export({ format: "jwk" }) as object), kid: "ec-key", use: "sig", alg: "ES256" };
    const keys = new JwksKeyStore({
      issuer: issuer.issuer,
      jwksUri: issuer.jwksUri,
      fetchImpl: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })
    });
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = encodeJws(
      { alg: "ES256", typ: "JWT", kid: "ec-key" },
      { iss: issuer.issuer, aud: issuer.audience, sub: "cole", exp: issuedAt + 300 },
      (signingInput) =>
        signBuffer("sha256", Buffer.from(signingInput, "ascii"), { key: privateKey, dsaEncoding: "ieee-p1363" })
    );

    const claims = await verifyIdToken(token, { issuer: issuer.issuer, audiences: [issuer.audience], keys });

    assert.equal(claims.sub, "cole");
  });
});
