export function requireEnv(name: string): string {
  return requireConfigValue(process.env, name);
}

export function requireConfigValue(config: NodeJS.ProcessEnv, name: string): string {
  const value = config[name];

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

export function isFeatureEnabled(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[featureEnvName(name)]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export function featureEnvName(name: string): string {
  return `BELLWETHER_FEATURE_${name.trim().replace(/[^a-z0-9]+/giu, "_").replace(/^_+|_+$/gu, "").toUpperCase()}`;
}
