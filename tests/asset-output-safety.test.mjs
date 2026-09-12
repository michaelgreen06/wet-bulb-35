import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildHonoBindingAssets, validateOutputDirectory } from "../scripts/build-hono-binding-assets.mjs";

test("asset builder refuses protected paths and unrelated nonempty directories", () => {
  for (const target of [".", "..", path.parse(process.cwd()).root, os.homedir()]) {
    assert.throws(() => validateOutputDirectory(target), /protected/);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "asset-output-safety-"));
  try {
    const unrelated = path.join(temporary, "unrelated");
    fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, "keep.txt"), "user data");
    assert.throws(() => buildHonoBindingAssets({ sourceCities: [], outDir: unrelated }), /nonempty/);
    assert.equal(fs.readFileSync(path.join(unrelated, "keep.txt"), "utf8"), "user data");
    const alias = path.join(temporary, "repo-alias");
    fs.symlinkSync(process.cwd(), alias, "dir");
    assert.throws(() => validateOutputDirectory(alias), /protected/);
    assert.throws(() => validateOutputDirectory(path.join(alias, "scripts")), /nonempty/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("asset builder replaces only its own generated output on repeat builds", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "asset-output-rebuild-"));
  try {
    buildHonoBindingAssets({ sourceCities: [], outDir: temporary });
    fs.writeFileSync(path.join(temporary, "obsolete-generated-file"), "old output");
    buildHonoBindingAssets({ sourceCities: [], outDir: temporary });
    assert.equal(fs.existsSync(path.join(temporary, "obsolete-generated-file")), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(temporary, "locations/route-manifest.json"))).generator, "wetbulb35-hono-assets");
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
