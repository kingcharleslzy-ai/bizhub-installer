// Respect the host scheduler grant; other hosts retain Node's default concurrency.
import { homedir } from "node:os";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const inside = process.argv[2] === "--ci-slot-child";
const extraArgs = process.argv.slice(inside ? 3 : 2);
if (process.platform === "darwin" && homedir() === "/Users/cc" && !inside) {
  const result = spawnSync("/Users/cc/.local/bin/ci-slot", ["--test-workers", "4", "--test-min-workers", "1", "--", process.execPath, process.argv[1], "--ci-slot-child", ...extraArgs], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exit(result.status ?? 1);
}
const grant = process.env.CI_SLOT_WORKERS;
if (grant && !/^[1-9][0-9]*$/.test(grant)) throw new Error("Invalid CI_SLOT_WORKERS");
const args = ["--test", ...(grant ? [`--test-concurrency=${grant}`] : []), ...extraArgs, ...readdirSync("test").filter(name => name.endsWith(".test.mjs")).sort().map(name => `test/${name}`)];
const result = spawnSync(process.execPath, args, { stdio: "inherit" });
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exit(result.status ?? 1);
