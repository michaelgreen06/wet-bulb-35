import { spawn } from "node:child_process";

const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const tracked = new Set();
const stopping = new WeakMap();
let signalHandlersInstalled = false;
let handlingSignal = false;

function waitForExit(child, timeoutMs = DEFAULT_STOP_TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); child.removeListener("exit", done); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    timer.unref();
    child.once("exit", done);
    if (child.exitCode !== null || child.signalCode !== null) done();
  });
}

function signalGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch { if (child.exitCode === null && child.signalCode === null) child.kill(signal); }
}

function groupExists(child) {
  if (!child?.pid) return false;
  try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

async function waitForGroupExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (groupExists(child) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  return !groupExists(child);
}

export function stopDetached(child, timeoutMs = DEFAULT_STOP_TIMEOUT_MS) {
  if (!child) return;
  if (stopping.has(child)) return stopping.get(child);
  const promise = (async () => {
    if (groupExists(child)) {
      signalGroup(child, "SIGTERM");
      await waitForExit(child, timeoutMs);
      await waitForGroupExit(child, timeoutMs);
    }
    if (groupExists(child)) {
      signalGroup(child, "SIGKILL");
      await waitForExit(child, timeoutMs);
      await waitForGroupExit(child, timeoutMs);
    }
    if (groupExists(child)) throw new Error(`Detached process group ${child.pid} did not terminate`);
    tracked.delete(child);
  })();
  stopping.set(child, promise);
  return promise;
}

export async function cleanupDetachedProcesses() {
  const children = [...tracked];
  const results = await Promise.allSettled(children.map((child) => stopDetached(child)));
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected) throw rejected.reason;
}

async function relaySignal(signal) {
  if (handlingSignal) return;
  handlingSignal = true;
  try { await cleanupDetachedProcesses(); }
  finally {
    for (const [name, handler] of installedHandlers) process.removeListener(name, handler);
    process.kill(process.pid, signal);
  }
}

const installedHandlers = new Map();
function installProcessCleanup() {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => { void relaySignal(signal); };
    installedHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  // `exit` cannot await. SIGKILL cannot be intercepted; this best-effort TERM
  // prevents ordinary Node exits from leaving a registered detached group behind.
  process.once("exit", () => { for (const child of tracked) signalGroup(child, "SIGTERM"); });
}

export function spawnDetached(command, args, options = {}) {
  installProcessCleanup();
  const child = spawn(command, args, { ...options, detached: true });
  tracked.add(child);
  return child;
}

export function attachDetachedCleanup(t) {
  const abort = () => { void cleanupDetachedProcesses(); };
  t.signal.addEventListener("abort", abort, { once: true });
  t.after(async () => {
    t.signal.removeEventListener("abort", abort);
    await cleanupDetachedProcesses();
  });
}
