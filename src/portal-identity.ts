import { adminBoundaryRoles, InMemoryIdentityProvider, type InMemoryIdentityRecord, type Role } from "./identity.js";

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
