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
