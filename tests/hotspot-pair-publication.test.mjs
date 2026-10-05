import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "..");
const initial = "2026-10-05T00:00:00Z";
const inhabited = (initialization) => ({ discovery: { initialization }, validFrom: "2026-10-05T10:00:00Z", validTo: "2026-10-06T10:00:00Z" });
const grid = (initialization) => ({ model: { initialization, steps: [9, 12], validTimeBounds: { start: "2026-10-05T09:00:00Z", end: "2026-10-06T12:00:00Z" } } });
const fakeCli = `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path');
const [,,...a]=process.argv, op=a[3], key=a[4].replace(/^bucket\\//,''), base=path.join(process.env.FAKE_R2,key);
const file=a.find(x=>x.startsWith('--file='))?.slice(7);
if (op==='get') { if (!fs.existsSync(base)) { console.error('not found 404'); process.exit(1); } fs.copyFileSync(base,file); }
else if (op==='put') {
 if (key==='global-grid-hotspots/v1/latest.json' && process.env.FAIL_SECOND_LATEST && !fs.existsSync(process.env.FAIL_SECOND_LATEST)) {
   fs.writeFileSync(process.env.FAIL_SECOND_LATEST,'failed'); console.error('simulated write failure'); process.exit(1);
 }
 fs.mkdirSync(path.dirname(base),{recursive:true}); fs.copyFileSync(file,base);
} else if (op==='delete') { fs.rmSync(base,{force:true}); } else process.exit(2);
`;
function setup(fail = false, previous = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hotspot-pair-"));
  fs.mkdirSync(path.join(root, ".hotspots"));
  fs.mkdirSync(path.join(root, "bin"));
  fs.mkdirSync(path.join(root, "r2"));
  fs.symlinkSync(path.join(repo, "scripts"), path.join(root, "scripts"), "dir");
  const executable = path.join(root, "bin", "npx");
  fs.writeFileSync(executable, fakeCli, { mode: 0o755 });
  const put = (name, obj, remoteKey) => {
    const contents = `${JSON.stringify(obj)}\n`;
    fs.writeFileSync(path.join(root, ".hotspots", name), contents);
    if (remoteKey) {
      const target = path.join(root, "r2", remoteKey);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
  };
  put("snapshot.json", inhabited(initial));
  put("global-grid-snapshot.json", grid(initial));
  if (previous) {
    const older = "2026-10-04T00:00:00Z";
    put("current-inhabited.json", inhabited(older), "inhabited-hotspots/v1/latest.json");
    put("current-global-grid.json", grid(older), "global-grid-hotspots/v1/latest.json");
  }
  const env = { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, FAKE_R2: path.join(root, "r2"), HOTSPOT_R2_BUCKET: "bucket", PUBLISH_INHABITED: "true", PUBLISH_GLOBAL_GRID: "true" };
  if (fail) env.FAIL_SECOND_LATEST = path.join(root, "failed-once");
  return { root, env };
}
function run({ root, env }) { return spawnSync("bash", [path.join(repo, "scripts/publish-hotspot-pair.sh")], { cwd: root, env, encoding: "utf8" }); }

test("publishes both verified immutable objects before either current alias", () => {
  const fixture = setup();
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);
    for (const [prefix, source] of [["inhabited-hotspots", "snapshot.json"], ["global-grid-hotspots", "global-grid-snapshot.json"]]) {
      assert.equal(fs.readFileSync(path.join(fixture.root, "r2", prefix, "v1/latest.json"), "utf8"), fs.readFileSync(path.join(fixture.root, ".hotspots", source), "utf8"));
      assert.equal(fs.readdirSync(path.join(fixture.root, "r2", prefix, "v1/snapshots")).length, 1);
    }
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("second alias failure restores the first and retains verified backups", () => {
  const fixture = setup(true, true);
  try {
    const prior = fs.readFileSync(path.join(fixture.root, "r2/inhabited-hotspots/v1/latest.json"), "utf8");
    const result = run(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restoring both aliases/);
    assert.equal(fs.readFileSync(path.join(fixture.root, "r2/inhabited-hotspots/v1/latest.json"), "utf8"), prior);
    assert.equal(fs.readFileSync(path.join(fixture.root, "r2/global-grid-hotspots/v1/latest.json"), "utf8"), fs.readFileSync(path.join(fixture.root, ".hotspots/current-global-grid.json"), "utf8"));
    for (const prefix of ["inhabited-hotspots", "global-grid-hotspots"]) assert.equal(fs.readdirSync(path.join(fixture.root, "r2", prefix, "v1/snapshots")).length, 2);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("first publication failure removes both newly-created aliases", () => {
  const fixture = setup(true);
  try {
    const result = run(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restoring both aliases/);
    for (const prefix of ["inhabited-hotspots", "global-grid-hotspots"]) {
      assert.equal(fs.existsSync(path.join(fixture.root, "r2", prefix, "v1/latest.json")), false);
      assert.equal(fs.readdirSync(path.join(fixture.root, "r2", prefix, "v1/snapshots")).length, 1);
    }
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});
