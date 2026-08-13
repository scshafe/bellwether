import {
  adminBoundaryRoles,
  InMemoryIdentityProvider,
  type InMemoryIdentityRecord,
  type Role,
  type TrustedProxyAuthConfig
} from "./identity.js";

type PortalUserDefaults = {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  password: string;
};

export function createIdentityProvider(config: NodeJS.ProcessEnv): InMemoryIdentityProvider {
  const users = [
    configuredUser(config, "PORTAL_ADMIN", {
      id: "portal-admin",
      username: "admin",
      displayName: "Administrator",
      role: "admin",
      password: "change-me"
    })
  ];

  const managerUser = optionalConfiguredUser(config, "PORTAL_MANAGER", {
    id: "portal-manager",
    username: "manager",
    displayName: "Manager",
    role: "manager",
    password: "change-me"
  });

  if (managerUser) {
    users.push(managerUser);
  }

  const viewerUser = optionalConfiguredUser(config, "PORTAL_VIEWER", {
    id: "portal-viewer",
    username: "viewer",
    displayName: "Family Viewer",
    role: "viewer",
    password: "change-me"
  });

  if (viewerUser) {
    users.push(viewerUser);
  }

  if (!users.some((user) => adminBoundaryRoles.includes(user.role))) {
    throw new Error("portal identity configuration must seed at least one admin-or-manager user");
  }

  return new InMemoryIdentityProvider(users);
}

/** PORTAL_TRUSTED_PROXY_AUTH=1|true enables reverse-proxy identity mode.
 *  Fail-closed: enabling it without PORTAL_TRUSTED_PROXY_IDENTITY (the Pocket
 *  ID email oauth2-proxy will forward) refuses to boot — the alternative is a
 *  server that trusts an unvalidated header. The authenticated identity maps
 *  to the seeded admin portal user (same PORTAL_ADMIN_* envs, password inert). */
export function readTrustedProxyAuthConfig(config: NodeJS.ProcessEnv): TrustedProxyAuthConfig | null {
  const raw = config.PORTAL_TRUSTED_PROXY_AUTH?.trim().toLowerCase() ?? "";

  if (raw !== "1" && raw !== "true") {
    return null;
  }

  // Comma-separated identity allowlist — several humans, one shared portal
  // account. A literal "*" delegates the who-may-enter question entirely to
  // the IdP's per-client allowed-groups gate (explicit opt-in).
  const rawIdentities = config.PORTAL_TRUSTED_PROXY_IDENTITY?.trim() ?? "";
  const expectedIdentities = [
    ...new Set(
      rawIdentities
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry !== "")
    )
  ];

  if (expectedIdentities.length === 0) {
    throw new Error(
      "PORTAL_TRUSTED_PROXY_AUTH is enabled but PORTAL_TRUSTED_PROXY_IDENTITY is unset — refusing to trust an unvalidated header"
    );
  }

  const allowAnyIdentity = expectedIdentities.includes("*");
  const headerName = (config.PORTAL_TRUSTED_PROXY_HEADER?.trim() || "x-forwarded-email").toLowerCase();
  const admin = configuredUser(config, "PORTAL_ADMIN", {
    id: "portal-admin",
    username: "admin",
    displayName: "Administrator",
    role: "admin",
    password: "change-me"
  });

  return {
    headerName,
    expectedIdentities: allowAnyIdentity ? [] : expectedIdentities,
    allowAnyIdentity,
    user: { id: admin.id, username: admin.username, displayName: admin.displayName, role: admin.role }
  };
}

function optionalConfiguredUser(
  config: NodeJS.ProcessEnv,
  prefix: string,
  defaults: PortalUserDefaults
): InMemoryIdentityRecord | null {
  return hasConfiguredUser(config, prefix) ? configuredUser(config, prefix, defaults) : null;
}

function hasConfiguredUser(config: NodeJS.ProcessEnv, prefix: string): boolean {
  return ["ID", "USERNAME", "PASSWORD", "DISPLAY_NAME", "ROLE"].some((field) => {
    const value = config[`${prefix}_${field}`];
    return value !== undefined && value.trim() !== "";
  });
}

function configuredUser(config: NodeJS.ProcessEnv, prefix: string, defaults: PortalUserDefaults): InMemoryIdentityRecord {
  const roleConfigName = `${prefix}_ROLE`;

  return {
    id: readConfigValue(config, `${prefix}_ID`, defaults.id),
    username: readConfigValue(config, `${prefix}_USERNAME`, defaults.username),
    displayName: readConfigValue(config, `${prefix}_DISPLAY_NAME`, defaults.displayName),
    role: parseRole(config[roleConfigName] ?? defaults.role, roleConfigName),
    password: readConfigValue(config, `${prefix}_PASSWORD`, defaults.password)
  };
}

function readConfigValue(config: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = config[key];
  return value === undefined || value.trim() === "" ? fallback : value;
}

function parseRole(value: string, configName: string): Role {
  if (value === "admin" || value === "manager" || value === "viewer") {
    return value;
  }

  throw new Error(`unknown ${configName} ${value}`);
}
