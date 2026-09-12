import fs from "node:fs";
import { spawnDetached } from "../helpers/detached-process-registry.mjs";

const pidFile = process.argv[2];
const child = spawnDetached(process.execPath, ["-e", "setInterval(() => {}, 1_000)"] , { stdio: "ignore" });
setImmediate(() => fs.writeFileSync(pidFile, String(child.pid)));
setInterval(() => {}, 1_000);
