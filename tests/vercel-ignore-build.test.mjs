import assert from "node:assert/strict";
import test from "node:test";
import {
  affectsDeployment,
  deploymentChangingFiles,
  evaluateIgnoreBuild,
} from "../scripts/should-ignore-vercel-build.mjs";

test("detects files that affect the Vercel build output", () => {
  assert.equal(affectsDeployment("scripts/prototype-static-generator.mjs"), true);
  assert.equal(affectsDeployment("./scripts/resolved_cities.json"), true);
  assert.equal(affectsDeployment("public/logo.svg"), true);
  assert.equal(affectsDeployment("tailwind.config.ts"), true);
  assert.equal(affectsDeployment("components/Header.tsx"), false);
  assert.equal(affectsDeployment("README.md"), false);
  assert.equal(affectsDeployment("tests/static-generator.test.mjs"), false);
});

test("filters deployment-changing files from a mixed change set", () => {
  assert.deepEqual(
    deploymentChangingFiles([
      "README.md",
      "components/Header.tsx",
      "public/images/wetbulb-default.jpg",
      "scripts/static-tailwind.css",
    ]),
    ["public/images/wetbulb-default.jpg", "scripts/static-tailwind.css"],
  );
});

test("ignores Vercel builds when changed files do not affect output", () => {
  assert.deepEqual(
    evaluateIgnoreBuild({
      changedFiles: ["README.md", "components/Header.tsx"],
      env: {},
    }),
    {
      ignore: true,
      reason: "No deployment output inputs changed.",
      deploymentFiles: [],
    },
  );
});

test("runs Vercel builds when deployment inputs change", () => {
  assert.deepEqual(
    evaluateIgnoreBuild({
      changedFiles: ["README.md", "scripts/build-vercel-output.mjs"],
      env: {},
    }),
    {
      ignore: false,
      reason: "Deployment output inputs changed.",
      deploymentFiles: ["scripts/build-vercel-output.mjs"],
    },
  );
});

test("FORCE_VERCEL_BUILD bypasses the ignore decision", () => {
  assert.deepEqual(
    evaluateIgnoreBuild({
      changedFiles: ["README.md"],
      env: { FORCE_VERCEL_BUILD: "1" },
    }),
    {
      ignore: false,
      reason: "FORCE_VERCEL_BUILD is set.",
      deploymentFiles: [],
    },
  );
});
