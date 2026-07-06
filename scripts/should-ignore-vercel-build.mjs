import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const FORCE_BUILD_VALUES = new Set(["1", "true", "yes"]);

export const DEPLOYMENT_INPUTS = [
  { kind: "file", path: ".vercelignore" },
  { kind: "file", path: "package-lock.json" },
  { kind: "file", path: "package.json" },
  { kind: "file", path: "postcss.config.mjs" },
  { kind: "file", path: "scripts/build-vercel-output.mjs" },
  { kind: "file", path: "scripts/prototype-static-generator.mjs" },
  { kind: "file", path: "scripts/resolved_cities.json" },
  { kind: "file", path: "scripts/static-tailwind.css" },
  { kind: "file", path: "tailwind.config.ts" },
  { kind: "file", path: "vercel.json" },
  { kind: "dir", path: "public/" },
];

function normalizePath(filePath) {
  return String(filePath ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

export function affectsDeployment(filePath) {
  const normalized = normalizePath(filePath);

  return DEPLOYMENT_INPUTS.some((input) => {
    if (input.kind === "file") {
      return normalized === input.path;
    }

    return normalized.startsWith(input.path);
  });
}

export function deploymentChangingFiles(changedFiles) {
  return changedFiles.map(normalizePath).filter(affectsDeployment);
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function commitExists(ref) {
  try {
    git(["cat-file", "-e", `${ref}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function fetchCommit(ref) {
  try {
    git(["fetch", "--quiet", "--depth=1", "origin", ref], {
      stdio: "ignore",
    });
  } catch {
    // Missing refs should make the deployment build, not skip.
  }
}

function changedFilesBetween(fromRef, toRef) {
  const output = git(["diff", "--name-only", "--diff-filter=ACMRTUXB", fromRef, toRef]);
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

function shouldForceBuild(env) {
  return FORCE_BUILD_VALUES.has(String(env.FORCE_VERCEL_BUILD ?? "").toLowerCase());
}

export function evaluateIgnoreBuild({ changedFiles, env = process.env }) {
  if (shouldForceBuild(env)) {
    return {
      ignore: false,
      reason: "FORCE_VERCEL_BUILD is set.",
      deploymentFiles: [],
    };
  }

  const deploymentFiles = deploymentChangingFiles(changedFiles);

  if (deploymentFiles.length > 0) {
    return {
      ignore: false,
      reason: "Deployment output inputs changed.",
      deploymentFiles,
    };
  }

  return {
    ignore: true,
    reason: "No deployment output inputs changed.",
    deploymentFiles,
  };
}

function currentCommit() {
  return process.env.VERCEL_GIT_COMMIT_SHA || git(["rev-parse", "HEAD"]).trim();
}

export function main() {
  const previous = process.env.VERCEL_GIT_PREVIOUS_SHA;
  const current = currentCommit();

  if (shouldForceBuild(process.env)) {
    console.log("Vercel build will run because FORCE_VERCEL_BUILD is set.");
    return 1;
  }

  if (!previous) {
    console.log("Vercel build will run because VERCEL_GIT_PREVIOUS_SHA is unavailable.");
    return 1;
  }

  if (!commitExists(previous)) {
    fetchCommit(previous);
  }

  if (!commitExists(previous)) {
    console.log(`Vercel build will run because previous commit is unavailable: ${previous}`);
    return 1;
  }

  let changedFiles;
  try {
    changedFiles = changedFilesBetween(previous, current);
  } catch (error) {
    console.log(`Vercel build will run because changed files could not be read: ${error.message}`);
    return 1;
  }

  const result = evaluateIgnoreBuild({ changedFiles });

  if (!result.ignore) {
    console.log(result.reason);
    for (const filePath of result.deploymentFiles) {
      console.log(`- ${filePath}`);
    }
    return 1;
  }

  console.log(result.reason);
  console.log(`Checked ${changedFiles.length} changed file(s) since ${previous}.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
