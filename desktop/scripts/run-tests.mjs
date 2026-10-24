// Respect the host scheduler grant; other hosts retain Node's default concurrency.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const grant = process.env.CI_SLOT_WORKERS;
if (grant && !/^[1-9][0-9]*$/.test(grant)) throw new Error("Invalid CI_SLOT_WORKERS");
const args = ["--test", ...(grant ? [`--test-concurrency=${grant}`] : []), ...process.argv.slice(2), ...readdirSync("test").filter(name => name.endsWith(".test.mjs")).sort().map(name => `test/${name}`)];
const result = spawnSync(process.execPath, args, { stdio: "inherit" });
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exit(result.status ?? 1);
