function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
    .map((match) => [match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]]));
}

export function indexable(html, response) {
  const blocked = (value) => /(?:^|[\s,:;])(?:noindex|none)(?:$|[\s,;])/i.test(value || "");
  if (blocked(response.headers.get("x-robots-tag"))) return false;
  return ![...html.matchAll(/<meta\b[^>]*>/gi)].some(([tag]) => {
    const attrs = attributes(tag);
    return /^(robots|googlebot|bingbot)$/i.test(attrs.name || "") && blocked(attrs.content);
  });
}

export function robotsAllowPublicPages(text, paths) {
  const groups = [];
  let group = { agents: [], rules: [] };
  for (const line of text.split(/\r?\n/)) {
    const match = line.split("#")[0].trim().match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const [, rawKey, value] = match;
    const key = rawKey.toLowerCase();
    if (key === "user-agent") {
      if (group.rules.length) { groups.push(group); group = { agents: [], rules: [] }; }
      group.agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && group.agents.length && value) {
      group.rules.push({ allow: key === "allow", path: value });
    }
  }
  groups.push(group);
  return ["googlebot", "bingbot", "*"].every((agent) => {
    const specific = groups.filter((entry) => entry.agents.includes(agent));
    const selected = specific.length ? specific : groups.filter((entry) => entry.agents.includes("*"));
    return paths.every((path) => {
      const matching = selected.flatMap((entry) => entry.rules).filter((rule) => {
        const end = rule.path.endsWith("$") ? "$" : "";
        const value = end ? rule.path.slice(0, -1) : rule.path;
        const pattern = value.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
        return new RegExp(`^${pattern}${end}`).test(path);
      }).sort((a, b) => b.path.replaceAll("*", "").length - a.path.replaceAll("*", "").length || Number(b.allow) - Number(a.allow));
      return !matching.length || matching[0].allow;
    });
  });
}
