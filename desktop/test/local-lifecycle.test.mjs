import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createLocalRuntimeLifecycle } = require("../electron/local-lifecycle.cjs");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, reject, resolve };
}

test("concurrent local starts share one spawn and one runtime", async () => {
  const gate = deferred();
  const livePids = new Set();
  let spawnCount = 0;
  let maximumLive = 0;
  const lifecycle = createLocalRuntimeLifecycle({
    startRuntime: async () => {
      spawnCount += 1;
      const runtime = await gate.promise;
      livePids.add(runtime.pid);
      maximumLive = Math.max(maximumLive, livePids.size);
      return runtime;
    },
    stopRuntime: async (runtime) => { livePids.delete(runtime.pid); },
  });

  const first = lifecycle.start();
  const second = lifecycle.start();
  gate.resolve({ pid: 41001, origin: "http://127.0.0.1:41001" });
  const [firstRuntime, secondRuntime] = await Promise.all([first, second]);

  assert.equal(spawnCount, 1);
  assert.equal(firstRuntime, secondRuntime);
  assert.equal(lifecycle.current(), firstRuntime);
  assert.equal(lifecycle.state(), "running");
  assert.equal(maximumLive, 1);
  await lifecycle.stop();
  assert.equal(livePids.size, 0);
});

test("stop during start waits for the child and leaves no untracked runtime", async () => {
  const gate = deferred();
  const livePids = new Set();
  let spawnCount = 0;
  let stopCount = 0;
  const lifecycle = createLocalRuntimeLifecycle({
    startRuntime: async () => {
      spawnCount += 1;
      const runtime = await gate.promise;
      livePids.add(runtime.pid);
      return runtime;
    },
    stopRuntime: async (runtime) => {
      stopCount += 1;
      livePids.delete(runtime.pid);
    },
  });

  const starting = lifecycle.start();
  const stopping = lifecycle.stop();
  gate.resolve({ pid: 41002, origin: "http://127.0.0.1:41002" });

  await assert.rejects(starting, /desktop_local_runtime_start_cancelled/);
  await stopping;
  assert.equal(spawnCount, 1);
  assert.equal(stopCount, 1);
  assert.equal(livePids.size, 0);
  assert.equal(lifecycle.current(), null);
  assert.equal(lifecycle.state(), "stopped");
});

test("cloud switch serializes behind an in-flight local start", async () => {
  const gate = deferred();
  const livePids = new Set();
  let cloudOpened = false;
  const lifecycle = createLocalRuntimeLifecycle({
    startRuntime: async () => {
      const runtime = await gate.promise;
      livePids.add(runtime.pid);
      return runtime;
    },
    stopRuntime: async (runtime) => { livePids.delete(runtime.pid); },
  });

  const starting = lifecycle.start();
  const switching = (async () => {
    await lifecycle.stop();
    assert.equal(livePids.size, 0);
    cloudOpened = true;
  })();
  await assert.rejects(lifecycle.start(), /desktop_local_runtime_stopping/);
  gate.resolve({ pid: 41003, origin: "http://127.0.0.1:41003" });

  await assert.rejects(starting, /desktop_local_runtime_start_cancelled/);
  await switching;
  assert.equal(cloudOpened, true);
  assert.equal(livePids.size, 0);
  assert.equal(lifecycle.state(), "stopped");
});
