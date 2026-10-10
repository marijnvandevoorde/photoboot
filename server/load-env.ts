// Loads .env into process.env for local runs (Vite dev server). Import it
// before any other server module: they read their settings at import.
// Production gets the same file through Docker Compose's env_file.

try {
  process.loadEnvFile();
} catch {
  // No .env: defaults apply.
}
