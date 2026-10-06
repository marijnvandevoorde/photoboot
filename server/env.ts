// Reading settings from the environment (.env, see .env.example). An empty
// value counts as unset, so a blank line in .env falls back to the default
// instead of becoming "" or 0.

export function env(name: string, fallback = ''): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

export function envNumber(name: string, fallback: number): number {
  const value = Number(env(name));
  return env(name) !== '' && Number.isFinite(value) ? value : fallback;
}
