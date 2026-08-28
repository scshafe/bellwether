import { generateKeyPairSync, sign as signBuffer, type JsonWebKey, type KeyObject } from "node:crypto";

/** A stand-in for Pocket ID: a signing key, the JWKS and discovery document it
 *  would publish, and a token minter. Tests point the real verifier at this
 *  and exercise the whole path — discovery, key fetch, signature check —
 *  without a network or a live IdP.
 *
 *  It lives outside a *.test.ts file so both the verifier's own tests and the
 *  server's API tests can share one fake issuer. */

const defaultIssuer = "https://id.example.test";
const defaultAudience = "bellwether-portal";

export function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Assemble a JWS from parts, with the signature entirely up to the caller —
 *  the seam tests use to forge tokens the issuer would never mint. */
export function encodeJws(header: unknown, payload: unknown, sign: (signingInput: string) => Buffer): string {
  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;

  return `${signingInput}.${sign(signingInput).toString("base64url")}`;
}

export type TestSigningKey = {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
};

export function generateTestSigningKey(kid: string): TestSigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

  return { kid, privateKey, publicKey };
}

export type MintOptions = {
  /** Sign with this key instead of the issuer's published one. */
  signingKey?: TestSigningKey;
  /** Merged over the JWS header (to test alg substitution and stray kids). */
  header?: Record<string, unknown>;
};

export class TestOidcIssuer {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUri: string;
  /** Every URL this fake IdP has been asked for, so tests can assert caching. */
  readonly requests: string[] = [];
  #published: TestSigningKey[];

  constructor(options: { issuer?: string; audience?: string; kid?: string } = {}) {
    this.issuer = options.issuer ?? defaultIssuer;
    this.audience = options.audience ?? defaultAudience;
    this.jwksUri = `${this.issuer}/.well-known/jwks.json`;
    this.#published = [generateTestSigningKey(options.kid ?? "test-key-1")];
  }

  get signingKey(): TestSigningKey {
    return this.#published[0] as TestSigningKey;
  }

  /** Publish a fresh key and retire the old one, as key rotation does. */
  rotate(kid = `test-key-${Date.now()}`): TestSigningKey {
    this.#published = [generateTestSigningKey(kid)];

    return this.signingKey;
  }

  jwksDocument(): { keys: JsonWebKey[] } {
    return {
      keys: this.#published.map((key) => ({
        ...(key.publicKey.export({ format: "jwk" }) as JsonWebKey),
        kid: key.kid,
        use: "sig",
        alg: "RS256"
      }))
    };
  }

  /** A `fetch` that serves this issuer's discovery document and JWKS. */
  readonly fetch: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    this.requests.push(url);

    if (url === `${this.issuer}/.well-known/openid-configuration`) {
      return jsonResponse({ issuer: this.issuer, jwks_uri: this.jwksUri });
    }

    if (url === this.jwksUri) {
      return jsonResponse(this.jwksDocument());
    }

    return new Response("not found", { status: 404 });
  };

  /** An id token as Pocket ID would mint it, with claims overridable. */
  idToken(claims: Record<string, unknown> = {}, options: MintOptions = {}): string {
    const issuedAt = Math.floor(Date.now() / 1000);

    return this.mint(
      {
        iss: this.issuer,
        aud: this.audience,
        sub: "pocket-id-subject",
        iat: issuedAt,
        exp: issuedAt + 300,
        ...claims
      },
      options
    );
  }

  mint(payload: Record<string, unknown>, options: MintOptions = {}): string {
    const key = options.signingKey ?? this.signingKey;
    const header = { alg: "RS256", typ: "JWT", kid: key.kid, ...options.header };

    return encodeJws(header, payload, (signingInput) =>
      signBuffer("sha256", Buffer.from(signingInput, "ascii"), key.privateKey)
    );
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
