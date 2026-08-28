import type { IncomingHttpHeaders } from "node:http";

import type { PortalUserStatus } from "./portal-users.js";

export const roles = ["admin", "manager", "viewer"] as const;

export type Role = (typeof roles)[number];

export const adminBoundaryRoles: readonly Role[] = ["admin", "manager"];
export const familyBoundaryRoles: readonly Role[] = ["admin", "manager", "viewer"];
/** Granting access is the one thing a manager does not get: operating the
 *  runtime is reversible, handing someone a role is how the boundary moves. */
export const userAdminRoles: readonly Role[] = ["admin"];

export type AuthenticatedUser = {
  id: string;
  username: string;
  displayName: string;
  role: Role;
};

/** The verdict on one request's identity.
 *
 *  The portal holds no credential of its own — there is no password to check
 *  and no session to mint. A human is whoever Pocket ID says they are, proven
 *  by a signature over the forwarded id token, and *which* human decides the
 *  role. Authentication is the identity provider's; authorization is ours. */
export type IdentityResolution =
  | { status: "authenticated"; user: AuthenticatedUser }
  /** No token, or one the identity provider did not sign — answer 401. */
  | { status: "anonymous"; reason: "missing_token" | "invalid_token"; detail?: string }
  /** A real Pocket ID user whose portal account grants nothing yet — knocking
   *  enrols them as `pending`, but a valid login is not access: answer 403,
   *  never a session, until an admin grants a role. */
  | { status: "unprovisioned"; identity: string; accountStatus: PortalUserStatus }
  /** The identity provider's keys are unreachable, so no verdict is possible —
   *  answer 503. Never 401: an outage is not a failed login. */
  | { status: "unavailable"; detail: string };

export type IdentityResolver = (headers: IncomingHttpHeaders) => Promise<IdentityResolution>;

export function canAccessRole(user: AuthenticatedUser, allowedRoles: readonly Role[]): boolean {
  return allowedRoles.includes(user.role);
}
