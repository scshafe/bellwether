export const roles = ["admin", "manager", "viewer"] as const;

export type Role = (typeof roles)[number];

export const adminBoundaryRoles: readonly Role[] = ["admin", "manager"];
export const familyBoundaryRoles: readonly Role[] = ["admin", "manager", "viewer"];

export type AuthenticatedUser = {
  id: string;
  username: string;
  displayName: string;
  role: Role;
};

export type AuthCredentials = {
  username: string;
  password: string;
};

export type AuthSession = {
  token: string;
  user: AuthenticatedUser;
};

export interface IdentityProvider {
  authenticate(credentials: AuthCredentials): Promise<AuthSession | null>;
  identifySession(token: string): Promise<AuthenticatedUser | null>;
}

/** Reverse-proxy identity mode: an OIDC-authenticating proxy (oauth2-proxy in
 *  front of the portal, same network namespace) is the only path to the
 *  listener and stamps the authenticated identity into a request header. When
 *  configured, the server trusts THAT header — matched against the one
 *  expected identity — and maps it to the seeded admin portal user; the
 *  password login route goes dark and Bearer tokens are ignored entirely. */
export type TrustedProxyAuthConfig = {
  /** Lower-cased header name carrying the identity (default x-forwarded-email). */
  headerName: string;
  /** The exact identity (Pocket ID email) the header must equal, case-insensitive. */
  expectedIdentity: string;
  /** The portal user every authenticated request acts as (the seeded admin). */
  user: AuthenticatedUser;
};

export type InMemoryIdentityRecord = AuthenticatedUser & {
  password: string;
};

export class InMemoryIdentityProvider implements IdentityProvider {
  readonly #usersByUsername = new Map<string, InMemoryIdentityRecord>();
  readonly #sessionsByToken = new Map<string, AuthenticatedUser>();

  constructor(users: InMemoryIdentityRecord[] = []) {
    for (const user of users) {
      this.#usersByUsername.set(user.username, user);
    }
  }

  async authenticate(credentials: AuthCredentials): Promise<AuthSession | null> {
    const record = this.#usersByUsername.get(credentials.username);

    if (!record || record.password !== credentials.password) {
      return null;
    }

    const user = toAuthenticatedUser(record);
    const token = `in-memory-session:${user.id}`;
    this.#sessionsByToken.set(token, user);

    return { token, user };
  }

  async identifySession(token: string): Promise<AuthenticatedUser | null> {
    return this.#sessionsByToken.get(token) ?? null;
  }
}

export function canAccessRole(user: AuthenticatedUser, allowedRoles: readonly Role[]): boolean {
  return allowedRoles.includes(user.role);
}

function toAuthenticatedUser(record: InMemoryIdentityRecord): AuthenticatedUser {
  return {
    id: record.id,
    username: record.username,
    displayName: record.displayName,
    role: record.role
  };
}
