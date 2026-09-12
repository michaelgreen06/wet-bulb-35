import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(25);
  }
  throw new Error(message);
}
function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.removeListener("exit", done); reject(new Error("owner did not terminate")); }, timeoutMs);
    const done = () => { clearTimeout(timer); resolve(); };
    child.once("exit", done);
  });
}
function groupExists(pid) {
  try { process.kill(-pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

// SIGKILL cannot be handled by the owner. This proves catchable SIGTERM cleans
// only the registered detached group before the owning process re-raises it.
test("SIGTERM cleans a registered detached process group", { timeout: 15_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "detached-registry-"));
  const pidFile = path.join(directory, "child.pid");
  const owner = spawn(process.execPath, [path.join(root, "tests/fixtures/detached-registry-owner.mjs"), pidFile], { stdio: "ignore" });
  let childPid;
  try {
    await waitFor(() => fs.existsSync(pidFile), 5_000, "owner did not register child");
    childPid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    assert.equal(groupExists(childPid), true);
    const ownerExit = waitForChildExit(owner, 5_000);
    owner.kill("SIGTERM");
    await ownerExit;
    await waitFor(() => !groupExists(childPid), 5_000, "registered detached group leaked after SIGTERM");
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGTERM");
      try { await waitForChildExit(owner, 5_000); } catch { owner.kill("SIGKILL"); }
    }
    if (Number.isInteger(childPid) && groupExists(childPid)) {
      try { process.kill(-childPid, "SIGKILL"); } catch {}
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
