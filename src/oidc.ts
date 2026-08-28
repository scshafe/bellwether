import { constants, createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from "node:crypto";

/** OIDC id-token verification against the issuer's published JWKS.
 *
 *  The portal has no credential of its own: a human's identity arrives as a
 *  token minted by Pocket ID and forwarded by oauth2-proxy. A forwarded
 *  *header* would be forgeable by anything that reaches the app port directly;
 *  a forwarded *token* is not, because this module checks the issuer's
 *  signature over it. That is the whole reason this file exists. */

export type JwtClaims = Readonly<Record<string, unknown>>;

/** The token is unacceptable — malformed, unsigned by the issuer, expired, or
 *  minted for someone else. Always the caller's problem: answer 401. */
export class IdTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdTokenError";
  }
}

/** The issuer's signing keys could not be retrieved, so no verdict is possible.
 *  The portal's problem, not the caller's: answer 503, never 401 — a JWKS
 *  outage must not read as "your token is bad". */
export class SigningKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningKeyUnavailableError";
  }
}

export type SigningKey = {
  kid: string | null;
  key: KeyObject;
  /** `alg` as published in the JWK, when the issuer pins one. */
  alg: string | null;
};

export interface SigningKeySource {
  /** Resolve the key for a JWS header `kid` (null when the header omits one).
   *  Returns null when the issuer publishes no such key. Throws
   *  SigningKeyUnavailableError when the key set itself cannot be reached. */
  getKey(kid: string | null): Promise<SigningKey | null>;
}

type SignatureAlgorithm = {
  hash: string;
  keyTypes: readonly string[];
  namedCurve?: string;
  pss?: boolean;
  ieeeP1363?: boolean;
};

/** Asymmetric algorithms only. `none` and the HMAC family are absent by
 *  construction, which is what defeats alg-substitution: there is no branch
 *  that could treat the token's own bytes, or a public key, as a secret. */
const signatureAlgorithms: Readonly<Record<string, SignatureAlgorithm>> = {
  RS256: { hash: "sha256", keyTypes: ["rsa"] },
  RS384: { hash: "sha384", keyTypes: ["rsa"] },
  RS512: { hash: "sha512", keyTypes: ["rsa"] },
  PS256: { hash: "sha256", keyTypes: ["rsa", "rsa-pss"], pss: true },
  PS384: { hash: "sha384", keyTypes: ["rsa", "rsa-pss"], pss: true },
  PS512: { hash: "sha512", keyTypes: ["rsa", "rsa-pss"], pss: true },
  ES256: { hash: "sha256", keyTypes: ["ec"], namedCurve: "prime256v1", ieeeP1363: true },
  ES384: { hash: "sha384", keyTypes: ["ec"], namedCurve: "secp384r1", ieeeP1363: true },
  ES512: { hash: "sha512", keyTypes: ["ec"], namedCurve: "secp521r1", ieeeP1363: true }
};

export type VerifyIdTokenOptions = {
  /** Exact `iss` the token must carry. */
  issuer: string;
  /** The token's `aud` must include one of these (the OIDC client id). */
  audiences: readonly string[];
  keys: SigningKeySource;
  /** Slack on exp/nbf/iat for clock drift between the portal and the IdP. */
  clockToleranceSeconds?: number;
  now?: () => number;
};

/** Verify signature, then issuer, audience and lifetime. Returns the claims of
 *  a token this portal may act on; throws IdTokenError otherwise. */
export async function verifyIdToken(token: string, options: VerifyIdTokenOptions): Promise<JwtClaims> {
  const segments = token.split(".");

  if (segments.length !== 3) {
    throw new IdTokenError("token is not a three-segment JWS");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
  const header = decodeJsonSegment(encodedHeader, "header");
  const algorithm = readStringClaim(header, "alg");

  if (algorithm === null) {
    throw new IdTokenError("token header has no alg");
  }

  const specification = signatureAlgorithms[algorithm];

  if (!specification) {
    throw new IdTokenError(`unsupported token algorithm ${algorithm}`);
  }

  const signingKey = await options.keys.getKey(readStringClaim(header, "kid"));

  if (!signingKey) {
    throw new IdTokenError("no issuer signing key matches the token");
  }

  if (signingKey.alg !== null && signingKey.alg !== algorithm) {
    throw new IdTokenError(`signing key is published for ${signingKey.alg}, not ${algorithm}`);
  }

  assertKeyMatchesAlgorithm(signingKey.key, algorithm, specification);

  if (!isSignatureValid(`${encodedHeader}.${encodedPayload}`, encodedSignature, signingKey.key, specification)) {
    throw new IdTokenError("token signature does not verify against the issuer key");
  }

  const claims = decodeJsonSegment(encodedPayload, "payload");
  assertClaims(claims, options);

  return claims;
}

function isSignatureValid(
  signingInput: string,
  encodedSignature: string,
  key: KeyObject,
  specification: SignatureAlgorithm
): boolean {
  const signature = Buffer.from(encodedSignature, "base64url");

  if (signature.byteLength === 0) {
    return false;
  }

  try {
    return verifySignature(specification.hash, Buffer.from(signingInput, "ascii"), verifyKeyInput(key, specification), signature);
  } catch {
    // Malformed signature encodings surface as throws for some key types.
    return false;
  }
}

function verifyKeyInput(key: KeyObject, specification: SignatureAlgorithm): Parameters<typeof verifySignature>[2] {
  if (specification.pss) {
    return { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST };
  }

  if (specification.ieeeP1363) {
    // JWS carries r‖s; node defaults to DER for ECDSA.
    return { key, dsaEncoding: "ieee-p1363" };
  }

  return key;
}

function assertKeyMatchesAlgorithm(key: KeyObject, algorithm: string, specification: SignatureAlgorithm): void {
  const keyType = key.asymmetricKeyType ?? "";

  if (!specification.keyTypes.includes(keyType)) {
    throw new IdTokenError(`signing key type ${keyType || "unknown"} cannot verify ${algorithm}`);
  }

  const namedCurve = key.asymmetricKeyDetails?.namedCurve;

  if (specification.namedCurve && namedCurve && namedCurve !== specification.namedCurve) {
    throw new IdTokenError(`signing key curve ${namedCurve} cannot verify ${algorithm}`);
  }
}

function assertClaims(claims: JwtClaims, options: VerifyIdTokenOptions): void {
  const tolerance = options.clockToleranceSeconds ?? 60;
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);

  if (readStringClaim(claims, "iss") !== options.issuer) {
    throw new IdTokenError("token issuer is not the configured identity provider");
  }

  if (readStringClaim(claims, "sub") === null) {
    throw new IdTokenError("token has no sub claim");
  }

  const audiences = readAudienceClaim(claims);

  if (!audiences.some((audience) => options.audiences.includes(audience))) {
    throw new IdTokenError("token audience is not this portal");
  }

  const authorizedParty = readStringClaim(claims, "azp");

  if (authorizedParty !== null && !options.audiences.includes(authorizedParty)) {
    throw new IdTokenError("token was authorized for a different client");
  }

  const expiry = readNumericClaim(claims, "exp");

  if (expiry === null) {
    throw new IdTokenError("token has no exp claim");
  }

  if (nowSeconds >= expiry + tolerance) {
    throw new IdTokenError("token has expired");
  }

  const notBefore = readNumericClaim(claims, "nbf");

  if (notBefore !== null && nowSeconds + tolerance < notBefore) {
    throw new IdTokenError("token is not valid yet");
  }

  const issuedAt = readNumericClaim(claims, "iat");

  if (issuedAt !== null && nowSeconds + tolerance < issuedAt) {
    throw new IdTokenError("token was issued in the future");
  }
}

function decodeJsonSegment(segment: string, label: string): JwtClaims {
  let decoded: unknown;

  try {
    decoded = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new IdTokenError(`token ${label} is not valid JSON`);
  }

  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new IdTokenError(`token ${label} is not a JSON object`);
  }

  return decoded as JwtClaims;
}

function readStringClaim(claims: JwtClaims, name: string): string | null {
  const value = claims[name];
  return typeof value === "string" && value !== "" ? value : null;
}

function readNumericClaim(claims: JwtClaims, name: string): number | null {
  const value = claims[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readAudienceClaim(claims: JwtClaims): string[] {
  const value = claims.aud;

  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  return [];
}

export type JwksKeyStoreOptions = {
  /** The issuer, used for discovery when jwksUri is not pinned. */
  issuer: string;
  /** Skips discovery when set. */
  jwksUri?: string | null;
  fetchImpl?: typeof fetch;
  /** Age at which the cached key set is refreshed before the next use. */
  cacheTtlMs?: number;
  /** Floor between fetches triggered by an unrecognised kid, so an attacker
   *  cannot turn made-up kids into a request amplifier against the IdP. Also
   *  the worst-case lag before a rotated signing key is picked up. */
  minRefreshIntervalMs?: number;
  now?: () => number;
};

/** Caching JWKS reader. Refreshes on age, and once on an unknown `kid` so key
 *  rotation needs no restart; serves the last good key set when a refresh
 *  fails, and only reports unavailability when it has nothing at all. */
export class JwksKeyStore implements SigningKeySource {
  readonly #issuer: string;
  readonly #fetchImpl: typeof fetch;
  readonly #cacheTtlMs: number;
  readonly #minRefreshIntervalMs: number;
  readonly #now: () => number;
  #jwksUri: string | null;
  #keysByKid = new Map<string, SigningKey>();
  #soleKey: SigningKey | null = null;
  #loadedAt = 0;
  #attemptedAt = 0;
  #inFlight: Promise<void> | null = null;

  constructor(options: JwksKeyStoreOptions) {
    this.#issuer = options.issuer.replace(/\/+$/u, "");
    this.#jwksUri = options.jwksUri ?? null;
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.#cacheTtlMs = options.cacheTtlMs ?? 10 * 60 * 1000;
    this.#minRefreshIntervalMs = options.minRefreshIntervalMs ?? 10 * 1000;
    this.#now = options.now ?? Date.now;
  }

  async getKey(kid: string | null): Promise<SigningKey | null> {
    if (this.#loadedAt === 0 || this.#now() - this.#loadedAt >= this.#cacheTtlMs) {
      await this.#refresh(this.#loadedAt !== 0);
    }

    const cached = this.#lookup(kid);

    if (cached) {
      return cached;
    }

    if (this.#now() - this.#attemptedAt >= this.#minRefreshIntervalMs) {
      await this.#refresh(this.#loadedAt !== 0);
    }

    return this.#lookup(kid);
  }

  #lookup(kid: string | null): SigningKey | null {
    if (kid === null) {
      return this.#soleKey;
    }

    return this.#keysByKid.get(kid) ?? null;
  }

  async #refresh(toleratesFailure: boolean): Promise<void> {
    if (!this.#inFlight) {
      this.#attemptedAt = this.#now();
      this.#inFlight = this.#load().finally(() => {
        this.#inFlight = null;
      });
    }

    try {
      await this.#inFlight;
    } catch (error) {
      if (!toleratesFailure) {
        throw error;
      }
    }
  }

  async #load(): Promise<void> {
    const uri = await this.#resolveJwksUri();
    const document = await this.#fetchJson(uri, "jwks");
    const keys = Array.isArray(document.keys) ? document.keys : [];
    const keysByKid = new Map<string, SigningKey>();
    const imported: SigningKey[] = [];

    for (const entry of keys) {
      const signingKey = importJwk(entry);

      if (!signingKey) {
        continue;
      }

      imported.push(signingKey);

      if (signingKey.kid !== null) {
        keysByKid.set(signingKey.kid, signingKey);
      }
    }

    if (imported.length === 0) {
      throw new SigningKeyUnavailableError(`${uri} published no usable signing keys`);
    }

    this.#keysByKid = keysByKid;
    // A kid-less token is only resolvable when the choice is unambiguous.
    this.#soleKey = imported.length === 1 ? (imported[0] as SigningKey) : null;
    this.#loadedAt = this.#now();
  }

  async #resolveJwksUri(): Promise<string> {
    if (this.#jwksUri) {
      return this.#jwksUri;
    }

    const discovery = await this.#fetchJson(`${this.#issuer}/.well-known/openid-configuration`, "discovery document");
    const jwksUri = typeof discovery.jwks_uri === "string" ? discovery.jwks_uri : "";

    if (!jwksUri) {
      throw new SigningKeyUnavailableError("issuer discovery document has no jwks_uri");
    }

    if (!isSameOrigin(jwksUri, this.#issuer)) {
      throw new SigningKeyUnavailableError("issuer discovery document points jwks_uri at another origin");
    }

    this.#jwksUri = jwksUri;

    return jwksUri;
  }

  async #fetchJson(url: string, label: string): Promise<Record<string, unknown>> {
    let response: Response;

    try {
      response = await this.#fetchImpl(url, { headers: { accept: "application/json" } });
    } catch (error) {
      throw new SigningKeyUnavailableError(`${label} request to ${url} failed: ${String(error)}`);
    }

    if (!response.ok) {
      throw new SigningKeyUnavailableError(`${label} request to ${url} returned ${response.status}`);
    }

    let body: unknown;

    try {
      body = await response.json();
    } catch {
      throw new SigningKeyUnavailableError(`${label} at ${url} is not JSON`);
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new SigningKeyUnavailableError(`${label} at ${url} is not a JSON object`);
    }

    return body as Record<string, unknown>;
  }
}

function importJwk(entry: unknown): SigningKey | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  const jwk = entry as Record<string, unknown>;

  if (typeof jwk.kty !== "string" || jwk.kty === "oct") {
    return null;
  }

  if (typeof jwk.use === "string" && jwk.use !== "sig") {
    return null;
  }

  if (Array.isArray(jwk.key_ops) && !jwk.key_ops.includes("verify")) {
    return null;
  }

  try {
    return {
      kid: typeof jwk.kid === "string" && jwk.kid !== "" ? jwk.kid : null,
      key: createPublicKey({ key: jwk as JsonWebKey, format: "jwk" }),
      alg: typeof jwk.alg === "string" && jwk.alg !== "" ? jwk.alg : null
    };
  } catch {
    // One unreadable JWK must not blind the portal to the rest of the set.
    return null;
  }
}

function isSameOrigin(candidate: string, issuer: string): boolean {
  try {
    return new URL(candidate).origin === new URL(issuer).origin;
  } catch {
    return false;
  }
}
