/**
 * Small shared fakes for the shell's node:test suites: deterministic timers,
 * an EventEmitter-based utility process, and an HttpResponse factory. No real
 * ports, no real child processes, no Electron.
 */
import { EventEmitter } from "node:events";

/** Deterministic timer queue matching TimerLike. */
export class FakeTimers {
  constructor() {
    this.nowMs = 0;
    this.tasks = [];
    this.nextId = 1;
  }

  setTimeout(callback, ms) {
    const id = this.nextId++;
    this.tasks.push({ id, at: this.nowMs + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(id) {
    this.tasks = this.tasks.filter((task) => task.id !== id);
  }

  /** Runs every timer due within `ms`, in order, flushing microtasks between them. */
  async advance(ms) {
    const target = this.nowMs + ms;
    for (;;) {
      const due = this.tasks
        .filter((task) => task.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.nowMs = due.at;
      this.tasks = this.tasks.filter((task) => task !== due);
      due.callback();
      await flush();
    }
    this.nowMs = target;
    await flush();
  }

  get pending() {
    return this.tasks.length;
  }
}

export function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Minimal utility-process stand-in: records postMessage/kill and emits events. */
export class FakeChild extends EventEmitter {
  constructor({ pid = 4242 } = {}) {
    super();
    this.pid = pid;
    this.messages = [];
    this.killCalls = 0;
    this.stdout = null;
    this.stderr = null;
    this.killed = false;
  }

  postMessage(message) {
    this.messages.push(message);
  }

  kill() {
    this.killCalls += 1;
    this.killed = true;
  }

  /** Simulates the utility process exiting. */
  exit(code = 0, signal) {
    this.emit("exit", code, signal);
  }

  /** Simulates a backend -> main protocol message. */
  send(message) {
    this.emit("message", message);
  }
}

/** A fake `npm run dev` child. */
export class FakeDevChild extends EventEmitter {
  constructor({ pid = 5151 } = {}) {
    super();
    this.pid = pid;
    this.killSignals = [];
    this.stdout = null;
    this.stderr = null;
    this.exited = false;
  }

  kill(signal) {
    this.killSignals.push(signal ?? "SIGTERM");
    return true;
  }

  exit(code = 0) {
    this.exited = true;
    this.emit("exit", code, null);
  }
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** JSON response whose body is a real ReadableStream-like reader. */
export function jsonResponse(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    status,
    ok: status >= 200 && status < 300,
    url: "",
    headers: { get: () => "application/json" },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true };
          sent = true;
          return { done: false, value: bytes };
        },
        cancel: async () => undefined,
        releaseLock: () => undefined,
      }),
    },
    text: async () => text,
  };
}

/** HTML response matching the first-page probe's Pi Web detection. */
export function htmlResponse(status, html) {
  const response = jsonResponse(status, html);
  response.headers = { get: () => "text/html; charset=utf-8" };
  return response;
}
