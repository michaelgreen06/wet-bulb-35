// Fail closed on this deliberately small, checked-in production configuration.
// Changes to its routing syntax require updating/reviewing this guard too.
export function validateProductionConfig(source) {
  const lines = source.split(/\r?\n/).map((line) => line.replace(/#.*$/, "").trim()).filter(Boolean);
  const names = lines.filter((line) => /^name\s*=/.test(line));
  if (names.length !== 1 || names[0] !== 'name = "wetbulb35-weather-production"') throw new Error("Wrong production Worker");
  const routes = lines.filter((line) => /^(?:routes?|\[\[?routes?\b)/.test(line));
  const approved = /^routes\s*=\s*\[\s*\{\s*pattern\s*=\s*"www\.wetbulb35\.com\/\*"\s*,\s*zone_name\s*=\s*"wetbulb35\.com"\s*\}\s*\]$/;
  if (routes.length !== 1 || !approved.test(routes[0])) throw new Error("Production must have exactly the approved route");
  if (lines.some((line) => /\bcustom_domain\s*=/.test(line))) throw new Error("Custom domains are forbidden");
}
