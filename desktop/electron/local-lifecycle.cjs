function createLocalRuntimeLifecycle({ startRuntime, stopRuntime }) {
  if (typeof startRuntime !== "function" || typeof stopRuntime !== "function") {
    throw new TypeError("desktop_local_lifecycle_callbacks_invalid");
  }

  let currentRuntime = null;
  let lifecycleState = "stopped";
  let startPromise = null;
  let stopPromise = null;
  let cancelStarting = false;

  async function performStart() {
    let started = null;
    try {
      started = await startRuntime();
      currentRuntime = started;
      if (cancelStarting) {
        lifecycleState = "stopping";
        try {
          await stopRuntime(started);
        } catch (error) {
          lifecycleState = "running";
          throw error;
        }
        if (currentRuntime === started) currentRuntime = null;
        lifecycleState = "stopped";
        throw new Error("desktop_local_runtime_start_cancelled");
      }
      lifecycleState = "running";
      return started;
    } catch (error) {
      if (!currentRuntime) lifecycleState = "stopped";
      throw error;
    }
  }

  function start() {
    if (currentRuntime && lifecycleState === "running") {
      return Promise.resolve(currentRuntime);
    }
    if (stopPromise || lifecycleState === "stopping") {
      return Promise.reject(new Error("desktop_local_runtime_stopping"));
    }
    if (startPromise) return startPromise;

    cancelStarting = false;
    lifecycleState = "starting";
    const operation = performStart();
    startPromise = operation;
    void operation.finally(() => {
      if (startPromise === operation) startPromise = null;
    }).catch(() => {});
    return operation;
  }

  async function performStop() {
    cancelStarting = true;
    if (startPromise) {
      try {
        await startPromise;
      } catch {
        // A cancelled or failed start is completed before the stop readback below.
      }
    }
    const target = currentRuntime;
    if (!target) {
      lifecycleState = "stopped";
      return;
    }
    lifecycleState = "stopping";
    try {
      await stopRuntime(target);
    } catch (error) {
      lifecycleState = "running";
      throw error;
    }
    if (currentRuntime === target) currentRuntime = null;
    lifecycleState = "stopped";
  }

  function stop() {
    if (stopPromise) return stopPromise;
    const operation = performStop();
    stopPromise = operation;
    void operation.finally(() => {
      if (stopPromise === operation) stopPromise = null;
    }).catch(() => {});
    return operation;
  }

  function markExited(runtime) {
    if (currentRuntime !== runtime) return false;
    currentRuntime = null;
    if (lifecycleState !== "stopping") lifecycleState = "stopped";
    return true;
  }

  return Object.freeze({
    current: () => currentRuntime,
    markExited,
    start,
    state: () => lifecycleState,
    stop,
  });
}

module.exports = { createLocalRuntimeLifecycle };
