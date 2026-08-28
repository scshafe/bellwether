import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { roles, type Role } from "./identity.js";

/** Portal accounts, linked to Pocket ID by the `sub` claim.
 *
 *  This table holds no credential. Pocket ID authenticates the human; this
 *  records what that human may do afterwards, and nothing here can admit
 *  anyone on its own — a row without a signed token is inert.
 *
 *  A verified identity with no row gets one, `pending`, so the person appears
 *  in the portal for an admin to grant. That is the whole enrolment story:
 *  nobody types an email or an opaque subject anywhere, and someone knocking
 *  is how they get on the list. */
export type PortalUserStatus = "pending" | "active" | "disabled";

export type PortalUserRecord = {
  id: string;
  subject: string;
  email: string | null;
  displayName: string | null;
  role: Role | null;
  status: PortalUserStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  grantedAt: string | null;
  grantedBy: string | null;
};

/** What a signed token says about its holder, before this app has an opinion. */
export type PortalUserIdentity = {
  subject: string;
  email: string | null;
  displayName: string | null;
};

export type PortalUserPatch = {
  role?: Role | null;
  status?: PortalUserStatus;
};

export class PortalUserNotFoundError extends Error {
  constructor(id: string) {
    super(`portal user ${id} not found`);
    this.name = "PortalUserNotFoundError";
  }
}

/** Refusing to remove the last way back in. An admin who demotes themselves
 *  out of a portal with no other admin has locked everyone out of role
 *  management for good — the only recovery would be hand-editing the table. */
export class LastAdminError extends Error {
  constructor() {
    super("refusing to leave the portal with no active admin");
    this.name = "LastAdminError";
  }
}

export interface PortalUsersStore {
  /** Called on every verified request: returns the caller's account, creating
   *  a pending one the first time that Pocket ID subject is seen. */
  recordSignIn(identity: PortalUserIdentity): Promise<PortalUserRecord>;
  listUsers(): Promise<PortalUserRecord[]>;
  updateUser(id: string, patch: PortalUserPatch, actorId: string): Promise<PortalUserRecord>;
}

/** True when this account may act at all. A role alone is not access, and
 *  neither is being active — the pair is. */
export function isActivePortalUser(user: PortalUserRecord): user is PortalUserRecord & { role: Role } {
  return user.status === "active" && user.role !== null;
}

export function isPortalUserStatus(value: unknown): value is PortalUserStatus {
  return value === "pending" || value === "active" || value === "disabled";
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (roles as readonly string[]).includes(value);
}

/** How often a sign-in refreshes `last_seen_at`. Every request would mean a
 *  write per request for a fact nobody reads that precisely. */
const lastSeenRefreshMs = 5 * 60 * 1000;

export class InMemoryPortalUsersStore implements PortalUsersStore {
  private readonly usersById = new Map<string, PortalUserRecord>();

  constructor(initialUsers: PortalUserRecord[] = []) {
    for (const user of initialUsers) {
      this.usersById.set(user.id, { ...user });
    }
  }

  async recordSignIn(identity: PortalUserIdentity): Promise<PortalUserRecord> {
    const existing = [...this.usersById.values()].find((user) => user.subject === identity.subject);
    const now = new Date().toISOString();

    if (existing) {
      existing.email = identity.email;
      existing.displayName = identity.displayName;
      existing.lastSeenAt = now;
      return { ...existing };
    }

    const bootstrap = !this.hasActiveAdmin();
    const created: PortalUserRecord = {
      id: randomUUID(),
      subject: identity.subject,
      email: identity.email,
      displayName: identity.displayName,
      role: bootstrap ? "admin" : null,
      status: bootstrap ? "active" : "pending",
      firstSeenAt: now,
      lastSeenAt: now,
      grantedAt: bootstrap ? now : null,
      grantedBy: null
    };

    this.usersById.set(created.id, created);

    return { ...created };
  }

  async listUsers(): Promise<PortalUserRecord[]> {
    return [...this.usersById.values()]
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .map((user) => ({ ...user }));
  }

  async updateUser(id: string, patch: PortalUserPatch, actorId: string): Promise<PortalUserRecord> {
    const user = this.usersById.get(id);

    if (!user) {
      throw new PortalUserNotFoundError(id);
    }

    const updated: PortalUserRecord = { ...user, ...normalizePatch(patch, user) };

    if (isActivePortalUser(user) && user.role === "admin" && !(isActivePortalUser(updated) && updated.role === "admin")) {
      const otherAdmins = [...this.usersById.values()].filter(
        (candidate) => candidate.id !== id && isActivePortalUser(candidate) && candidate.role === "admin"
      );

      if (otherAdmins.length === 0) {
        throw new LastAdminError();
      }
    }

    if (updated.role !== user.role || updated.status !== user.status) {
      updated.grantedAt = new Date().toISOString();
      updated.grantedBy = actorId;
    }

    this.usersById.set(id, updated);

    return { ...updated };
  }

  private hasActiveAdmin(): boolean {
    return [...this.usersById.values()].some((user) => isActivePortalUser(user) && user.role === "admin");
  }
}

type PortalUserRow = {
  id: string;
  subject: string;
  email: string | null;
  display_name: string | null;
  role: Role | null;
  status: PortalUserStatus;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  granted_at: Date | string | null;
  granted_by: string | null;
};

const userColumns =
  "id, subject, email, display_name, role, status, first_seen_at, last_seen_at, granted_at, granted_by";

export class PostgresPortalUsersStore implements PortalUsersStore {
  constructor(private readonly pool: Pool) {}

  async recordSignIn(identity: PortalUserIdentity): Promise<PortalUserRecord> {
    const existing = await this.pool.query<PortalUserRow>(
      `SELECT ${userColumns} FROM portal_users WHERE subject = $1`,
      [identity.subject]
    );
    const current = existing.rows[0];

    if (current) {
      return this.refresh(current, identity);
    }

    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      // Serializes concurrent first sign-ins, so "the portal has no admin yet"
      // cannot be true for two callers at once.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('portal_users_bootstrap'))");

      const inserted = await client.query<PortalUserRow>(
        `
          INSERT INTO portal_users (subject, email, display_name, role, status, granted_at)
          SELECT $1, $2, $3,
                 CASE WHEN bootstrap.needed THEN 'admin' END,
                 CASE WHEN bootstrap.needed THEN 'active' ELSE 'pending' END,
                 CASE WHEN bootstrap.needed THEN now() END
          FROM (
            SELECT NOT EXISTS (
              SELECT 1 FROM portal_users WHERE role = 'admin' AND status = 'active'
            ) AS needed
          ) AS bootstrap
          ON CONFLICT (subject) DO NOTHING
          RETURNING ${userColumns}
        `,
        [identity.subject, identity.email, identity.displayName]
      );

      await client.query("COMMIT");

      const created = inserted.rows[0];

      if (created) {
        if (created.role === "admin") {
          console.warn(
            `portal bootstrap: ${created.email ?? created.subject} is the first account on an empty portal and was made admin`
          );
        }

        return rowToUser(created);
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    // Lost the insert race: the winner's row is authoritative.
    const raced = await this.pool.query<PortalUserRow>(
      `SELECT ${userColumns} FROM portal_users WHERE subject = $1`,
      [identity.subject]
    );
    const row = raced.rows[0];

    if (!row) {
      throw new Error(`portal user ${identity.subject} vanished during sign-in`);
    }

    return this.refresh(row, identity);
  }

  async listUsers(): Promise<PortalUserRecord[]> {
    const result = await this.pool.query<PortalUserRow>(
      `SELECT ${userColumns} FROM portal_users ORDER BY last_seen_at DESC`
    );

    return result.rows.map(rowToUser);
  }

  async updateUser(id: string, patch: PortalUserPatch, actorId: string): Promise<PortalUserRecord> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const locked = await client.query<PortalUserRow>(
        `SELECT ${userColumns} FROM portal_users WHERE id = $1 FOR UPDATE`,
        [id]
      );
      const current = locked.rows[0];

      if (!current) {
        throw new PortalUserNotFoundError(id);
      }

      const user = rowToUser(current);
      const next = { ...user, ...normalizePatch(patch, user) };

      if (isActivePortalUser(user) && user.role === "admin" && !(isActivePortalUser(next) && next.role === "admin")) {
        const others = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM portal_users WHERE id <> $1 AND role = 'admin' AND status = 'active'`,
          [id]
        );

        if (Number(others.rows[0]?.count ?? "0") === 0) {
          throw new LastAdminError();
        }
      }

      const changed = next.role !== user.role || next.status !== user.status;
      const updated = await client.query<PortalUserRow>(
        `
          UPDATE portal_users
          SET role = $2,
              status = $3,
              granted_at = CASE WHEN $4 THEN now() ELSE granted_at END,
              granted_by = CASE WHEN $4 THEN $5::uuid ELSE granted_by END
          WHERE id = $1
          RETURNING ${userColumns}
        `,
        [id, next.role, next.status, changed, actorId]
      );

      await client.query("COMMIT");

      const row = updated.rows[0];

      if (!row) {
        throw new PortalUserNotFoundError(id);
      }

      return rowToUser(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async refresh(row: PortalUserRow, identity: PortalUserIdentity): Promise<PortalUserRecord> {
    const user = rowToUser(row);
    const stale = Date.now() - new Date(user.lastSeenAt).getTime() >= lastSeenRefreshMs;

    if (!stale && user.email === identity.email && user.displayName === identity.displayName) {
      return user;
    }

    const updated = await this.pool.query<PortalUserRow>(
      `
        UPDATE portal_users
        SET email = $2, display_name = $3, last_seen_at = now()
        WHERE id = $1
        RETURNING ${userColumns}
      `,
      [user.id, identity.email, identity.displayName]
    );

    return rowToUser(updated.rows[0] ?? row);
  }
}

export async function ensurePortalUsersSchema(pool: Pool): Promise<void> {
  await pool.query(await readFile(new URL("../db/bootstrap/010_portal_users.sql", import.meta.url), "utf8"));
}

/** Granting a role activates the account; clearing it revokes access. Keeping
 *  those two in step is what stops a half-set row from meaning nothing. */
function normalizePatch(patch: PortalUserPatch, user: PortalUserRecord): Partial<PortalUserRecord> {
  const next: Partial<PortalUserRecord> = {};

  if (patch.role !== undefined) {
    next.role = patch.role;
    next.status = patch.role === null ? "disabled" : "active";
  }

  if (patch.status !== undefined) {
    next.status = patch.status;

    if (patch.status === "active" && (patch.role ?? user.role) === null) {
      throw new Error("cannot activate a portal user with no role");
    }
  }

  return next;
}

function rowToUser(row: PortalUserRow): PortalUserRecord {
  return {
    id: row.id,
    subject: row.subject,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    firstSeenAt: toIsoString(row.first_seen_at),
    lastSeenAt: toIsoString(row.last_seen_at),
    grantedAt: row.granted_at === null ? null : toIsoString(row.granted_at),
    grantedBy: row.granted_by
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
