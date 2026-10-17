// Fail closed on this deliberately small, checked-in production configuration.
// Changes to its custom-domain syntax require updating/reviewing this guard too.
import { PUBLIC_ASSET_RUN_WORKER_FIRST } from "../lib/public-asset-routing.mjs";

export function validateProductionConfig(source) {
  const lines = source.split(/\r?\n/).map((line) => line.replace(/#.*$/, "").trim()).filter(Boolean);
  const names = lines.filter((line) => /^name\s*=/.test(line));
  if (names.length !== 1 || names[0] !== 'name = "wetbulb35-weather-production"') throw new Error("Wrong production Worker");
  const routes = lines.filter((line) => /^(?:routes?|\[\[?routes?\b)/.test(line));
  const approved = /^routes\s*=\s*\[\s*\{\s*pattern\s*=\s*"www\.wetbulb35\.com"\s*,\s*custom_domain\s*=\s*true\s*\}\s*\]$/;
  if (routes.length !== 1 || !approved.test(routes[0])) throw new Error("Production must have exactly the approved custom domain");
  if (lines.some((line) => /\bzone_name\s*=|\broute\s*=/.test(line))) throw new Error("Production routes are forbidden");
  // Only the exact public asset allowlist may skip the Worker; private metadata depends on Worker-first routing.
  const workerFirst = lines.filter((line) => /^run_worker_first\b/.test(line));
  let patterns = null;
  try { patterns = workerFirst.length === 1 ? JSON.parse(workerFirst[0].replace(/^run_worker_first\s*=\s*/, "")) : null; } catch {}
  if (!Array.isArray(patterns) || patterns.length !== PUBLIC_ASSET_RUN_WORKER_FIRST.length || patterns.some((pattern, index) => pattern !== PUBLIC_ASSET_RUN_WORKER_FIRST[index])) {
    throw new Error("Production run_worker_first must be the exact public asset allowlist");
  }
}
