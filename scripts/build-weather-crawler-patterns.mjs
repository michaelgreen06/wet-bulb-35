import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Source: monperrus/crawler-user-agents at a reviewed, immutable Git commit.
// Regenerate only after explicitly reviewing a new upstream snapshot and tests.
const sourceCommit = "9345a7ad9c49cd0fbd880eb5a84ed1f358fc6a97";
const sourceSha256 = "4218df91a9c2b87f94f1e16bbc71da38487247e8cec4f1df28eebe19d394bff3";
const expectedCount = 1456;
const output = path.resolve("lib/crawler-user-agent-patterns.mjs");

function main() {
  if (process.argv.length !== 3) throw new Error("Supply one pinned crawler-user-agents.json file");
  const input = fs.readFileSync(path.resolve(process.argv[2]));
  if (input.length > 1_000_000 || createHash("sha256").update(input).digest("hex") !== sourceSha256) {
    throw new Error("Crawler source does not match reviewed SHA-256");
  }
  const rows = JSON.parse(input.toString("utf8"));
  if (!Array.isArray(rows)) throw new Error("Expected crawler pattern array");
  // Generic HTTP clients are not necessarily crawlers; very short patterns can
  // overlap ordinary browser UAs. Keep those out of the weather-only denylist.
  // Google-Extended is a robots.txt control token, not an HTTP UA; the third-
  // party corpus incorrectly supplies a made-up HTTP agent instance for it.
  const patterns = rows.filter((row) => !row.tags?.includes("http-library")
      && row.pattern?.length >= 4 && row.pattern !== "Google-Extended")
    .map((row) => row.pattern);
  if (patterns.length !== expectedCount || new Set(patterns).size !== expectedCount) throw new Error("Unexpected crawler pattern count");
  for (const pattern of patterns) new RegExp(pattern, "i");
  const contents = `// Generated from monperrus/crawler-user-agents ${sourceCommit}\n`
    + `// Original MIT license: third_party/crawler-user-agents-LICENSE\n`
    + `// Names are user-agent CLAIMS. They do not verify the crawler operator.\n`
    + `export const CRAWLER_USER_AGENT_PATTERNS = Object.freeze(${JSON.stringify(patterns, null, 2)});\n`;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, contents);
  console.log(JSON.stringify({ sourceCommit, sourceSha256, included: patterns.length, excluded: rows.length - patterns.length, output }));
}

main();
