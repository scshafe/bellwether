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
