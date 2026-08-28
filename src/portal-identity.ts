import type { IncomingHttpHeaders } from "node:http";

import type { IdentityResolution, IdentityResolver } from "./identity.js";
import {
  JwksKeyStore,
  SigningKeyUnavailableError,
  verifyIdToken,
  type JwtClaims,
  type SigningKeySource
} from "./oidc.js";
import { isActivePortalUser, type PortalUserIdentity, type PortalUsersStore } from "./portal-users.js";

/** How the portal learns who is knocking.
 *
 *  Pocket ID is the only human credential. oauth2-proxy terminates the OIDC
 *  flow and forwards the id token; the portal verifies that token's signature
 *  against Pocket ID's JWKS before believing a word of it. Nothing here trusts
 *  a bare header — a header is forgeable by anything that reaches the app port
 *  directly, which is precisely the case this design refuses to lose.
 *
 *  What the holder may DO is not decided here at all: the verified subject is
 *  looked up in `portal_users`, this app's own account table. Authentication
 *  is Pocket ID's; authorization is the portal's, and it lives in the database
 *  where an admin can change it — not in an env var that needs a redeploy. */
export type PortalIdentityConfig = {
  issuer: string;
  audiences: readonly string[];
  jwksUri: string | null;
  /** Header carrying the id token; `authorization` accepts a Bearer prefix. */
  tokenHeader: string;
};

const passwordRetired = "The portal has no password login.";
const headerRetired = "The portal trusts no identity header — only a signed Pocket ID token.";
const rosterRetired = "Roles live in the portal_users table, granted by an admin in the portal.";

/** Env vars from the deleted in-app credential system, and from the email
 *  roster that briefly replaced it. Their presence means an operator still
 *  believes a password, a header, or a list of people does something here, so
 *  the portal refuses to boot rather than run beside that belief. */
const retiredIdentityEnvVars: Readonly<Record<string, string>> = {
  PORTAL_ADMIN_ID: passwordRetired,
  PORTAL_ADMIN_USERNAME: passwordRetired,
  PORTAL_ADMIN_PASSWORD: passwordRetired,
  PORTAL_ADMIN_DISPLAY_NAME: passwordRetired,
  PORTAL_ADMIN_ROLE: passwordRetired,
  PORTAL_MANAGER_ID: passwordRetired,
  PORTAL_MANAGER_USERNAME: passwordRetired,
  PORTAL_MANAGER_PASSWORD: passwordRetired,
  PORTAL_MANAGER_DISPLAY_NAME: passwordRetired,
  PORTAL_MANAGER_ROLE: passwordRetired,
  PORTAL_VIEWER_ID: passwordRetired,
  PORTAL_VIEWER_USERNAME: passwordRetired,
  PORTAL_VIEWER_PASSWORD: passwordRetired,
  PORTAL_VIEWER_DISPLAY_NAME: passwordRetired,
  PORTAL_VIEWER_ROLE: passwordRetired,
  PORTAL_TRUSTED_PROXY_AUTH: headerRetired,
  PORTAL_TRUSTED_PROXY_IDENTITY: headerRetired,
  PORTAL_TRUSTED_PROXY_HEADER: headerRetired,
  PORTAL_ROLE_ADMINS: rosterRetired,
  PORTAL_ROLE_MANAGERS: rosterRetired,
  PORTAL_ROLE_VIEWERS: rosterRetired,
  PORTAL_ROLE_ADMINS_GROUP: rosterRetired,
  PORTAL_ROLE_MANAGERS_GROUP: rosterRetired,
  PORTAL_ROLE_VIEWERS_GROUP: rosterRetired
};

export function readPortalIdentityConfig(config: NodeJS.ProcessEnv): PortalIdentityConfig {
  assertNoRetiredIdentityConfig(config);

  const issuer = requiredValue(config, "PORTAL_OIDC_ISSUER").replace(/\/+$/u, "");

  if (!issuer.startsWith("https://")) {
    throw new Error("PORTAL_OIDC_ISSUER must be an https URL");
  }

  const audiences = splitList(config.PORTAL_OIDC_AUDIENCE, { lowerCase: false });

  if (audiences.length === 0) {
    throw new Error("PORTAL_OIDC_AUDIENCE is required — the OIDC client id tokens must be minted for");
  }

  return {
    issuer,
    audiences,
    jwksUri: config.PORTAL_OIDC_JWKS_URL?.trim() || null,
    tokenHeader: (config.PORTAL_OIDC_TOKEN_HEADER?.trim() || "authorization").toLowerCase()
  };
}

export type PortalIdentityResolverDeps = {
  keys?: SigningKeySource;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export function createPortalIdentityResolver(
  config: PortalIdentityConfig,
  users: PortalUsersStore,
  deps: PortalIdentityResolverDeps = {}
): IdentityResolver {
  const keys =
    deps.keys ??
    new JwksKeyStore({
      issuer: config.issuer,
      jwksUri: config.jwksUri,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.now ? { now: deps.now } : {})
    });

  return async (headers: IncomingHttpHeaders): Promise<IdentityResolution> => {
    const token = readForwardedToken(headers, config.tokenHeader);

    if (!token) {
      return { status: "anonymous", reason: "missing_token" };
    }

    let claims: JwtClaims;

    try {
      claims = await verifyIdToken(token, {
        issuer: config.issuer,
        audiences: config.audiences,
        keys,
        ...(deps.now ? { now: deps.now } : {})
      });
    } catch (error) {
      if (error instanceof SigningKeyUnavailableError) {
        return { status: "unavailable", detail: error.message };
      }

      return { status: "anonymous", reason: "invalid_token", detail: errorDetail(error) };
    }

    // The token said who; the account table says what. Knocking enrols the
    // subject as `pending` so an admin can see and grant them — nobody has to
    // transcribe an opaque subject to add a person.
    const account = await users.recordSignIn(readSignInIdentity(claims));

    if (!isActivePortalUser(account)) {
      return { status: "unprovisioned", identity: describe(account), accountStatus: account.status };
    }

    return {
      status: "authenticated",
      user: {
        id: account.id,
        username: account.email ?? account.subject,
        displayName: account.displayName ?? account.email ?? account.subject,
        role: account.role
      }
    };
  };
}

/** oauth2-proxy forwards the id token as `Authorization: Bearer <jwt>` when
 *  configured with pass_authorization_header; a deployment that forwards it in
 *  some other header names that header instead. Either way the bytes are only
 *  believed after the signature check. */
function readForwardedToken(headers: IncomingHttpHeaders, headerName: string): string | null {
  const raw = headers[headerName];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";

  if (value === "") {
    return null;
  }

  const [scheme, rest] = value.split(/\s+/u, 2);

  if (scheme && rest && scheme.toLowerCase() === "bearer") {
    return rest;
  }

  return headerName === "authorization" ? null : value;
}

/** The claims worth copying onto the account row. `sub` is the link — stable
 *  for the life of the Pocket ID account, unlike an email. */
function readSignInIdentity(claims: JwtClaims): PortalUserIdentity {
  return {
    subject: readStringClaim(claims, "sub") ?? "",
    email: readStringClaim(claims, "email"),
    displayName: readStringClaim(claims, "name") ?? readStringClaim(claims, "preferred_username")
  };
}

function readStringClaim(claims: JwtClaims, name: string): string | null {
  const value = claims[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function describe(account: { email: string | null; displayName: string | null; subject: string }): string {
  return account.email ?? account.displayName ?? account.subject;
}

function assertNoRetiredIdentityConfig(config: NodeJS.ProcessEnv): void {
  const present = Object.keys(retiredIdentityEnvVars).filter((name) => (config[name] ?? "").trim() !== "");

  if (present.length === 0) {
    return;
  }

  const reasons = [...new Set(present.map((name) => retiredIdentityEnvVars[name]))];

  throw new Error(
    `${present.join(", ")} no longer exist. ${reasons.join(" ")} ` +
      "Configure PORTAL_OIDC_ISSUER and PORTAL_OIDC_AUDIENCE; roles are granted in the portal."
  );
}

function requiredValue(config: NodeJS.ProcessEnv, name: string): string {
  const value = config[name]?.trim() ?? "";

  if (value === "") {
    throw new Error(`${name} is required`);
  }

  return value;
}

function splitList(raw: string | undefined, options: { lowerCase: boolean }): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((entry) => (options.lowerCase ? entry.trim().toLowerCase() : entry.trim()))
        .filter((entry) => entry !== "")
    )
  ];
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
