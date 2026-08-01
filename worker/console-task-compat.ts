type ConsoleTask = {
  run<Result, Args extends unknown[]>(
    callback: (...args: Args) => Result,
    ...args: Args
  ): Result;
};

type ConsoleWithTask = {
  createTask?: (name: string) => ConsoleTask;
};

const fallbackCreateTask = (): ConsoleTask => ({
  run: (callback, ...args) => callback(...args),
});

/**
 * React 19 uses console.createTask for development stack traces when a runtime
 * advertises it. Some workerd emulators currently expose a throwing stub,
 * which prevents every app-page request from rendering. Keep a working native
 * implementation and replace only an unusable one.
 */
export function ensureUsableConsoleCreateTask(target: ConsoleWithTask): boolean {
  let createTask: ConsoleWithTask["createTask"];

  try {
    createTask = target.createTask;
  } catch {
    createTask = fallbackCreateTask;
  }

  if (typeof createTask !== "function") {
    return false;
  }

  try {
    const task = createTask.call(target, "rivet-runtime-check");
    if (task && typeof task.run === "function") {
      return false;
    }
  } catch {
    // Replace the runtime's advertised-but-unimplemented method below.
  }

  Object.defineProperty(target, "createTask", {
    configurable: true,
    value: fallbackCreateTask,
    writable: true,
  });

  return true;
}

ensureUsableConsoleCreateTask(
  globalThis.console as typeof globalThis.console & ConsoleWithTask,
);
