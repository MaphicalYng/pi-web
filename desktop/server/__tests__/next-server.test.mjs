import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { isAllowedTransportRequest } = await jiti.import("../next-server.ts");

const guard = Object.freeze({ authority: "127.0.0.1:49152", origin: "http://127.0.0.1:49152" });

test("only the exact loopback Host reaches Next", () => {
  assert.equal(isAllowedTransportRequest({ host: "127.0.0.1:49152" }, guard), true);
  assert.equal(isAllowedTransportRequest({ host: "127.0.0.1:49153" }, guard), false);
  assert.equal(isAllowedTransportRequest({ host: "localhost:49152" }, guard), false);
  assert.equal(isAllowedTransportRequest({ host: "evil.example:49152" }, guard), false);
  assert.equal(isAllowedTransportRequest({ host: "127.0.0.1:49152.evil.example" }, guard), false);
  assert.equal(isAllowedTransportRequest({}, guard), false);
});

test("a provided Origin must be this listener's origin; absent Origin passes to the CSRF layer", () => {
  assert.equal(isAllowedTransportRequest({ host: "127.0.0.1:49152" }, guard), true);
  assert.equal(
    isAllowedTransportRequest({ host: "127.0.0.1:49152", origin: "http://127.0.0.1:49152" }, guard),
    true,
  );
  assert.equal(isAllowedTransportRequest({ host: "127.0.0.1:49152", origin: "null" }, guard), false);
  assert.equal(
    isAllowedTransportRequest({ host: "127.0.0.1:49152", origin: "http://127.0.0.1:49153" }, guard),
    false,
  );
});

const { nextInitializeOptions, startDesktopHttpServer } = await jiti.import("../next-server.ts");

function fakeNext({ initialize } = {}) {
  const handlers = {
    requestHandler: () => {},
    upgradeHandler: () => {},
    server: { close: () => {} },
    closeUpgraded: () => {},
  };
  const calls = [];
  return {
    calls,
    handlers,
    module: {
      initialize: async (options) => {
        calls.push(options);
        if (initialize) return initialize(options);
        return handlers;
      },
    },
  };
}

test("initialize() receives the standalone dir, 127.0.0.1 and the listener's own port", () => {
  const server = { fake: true };
  assert.deepEqual(nextInitializeOptions("/standalone", 49200, server), {
    dir: "/standalone",
    dev: false,
    hostname: "127.0.0.1",
    port: 49200,
    server,
    quiet: true,
  });
});

test("the listener is not reported ready until initialize() resolves", async () => {
  let release;
  const fake = fakeNext({ initialize: () => new Promise((resolve) => { release = () => resolve(fake.handlers); }) });
  const starting = startDesktopHttpServer({
    dir: "/standalone",
    isShuttingDown: () => false,
    log: () => {},
    loadNext: () => fake.module,
  });
  const early = await Promise.race([
    starting.then(() => "resolved"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 100)),
  ]);
  assert.equal(early, "pending");
  assert.equal(fake.calls.length, 1);
  release();
  const started = await starting;
  assert.equal(fake.calls[0].dir, "/standalone");
  assert.equal(fake.calls[0].dev, false);
  assert.equal(fake.calls[0].hostname, "127.0.0.1");
  assert.equal(fake.calls[0].port, started.port);
  assert.equal(fake.calls[0].server, started.server);
  assert.equal(started.guard.origin, `http://127.0.0.1:${started.port}`);
  await started.close(100);
});

test("a failed initialize() closes the listener and rejects for `fatal`", async () => {
  const net = await import("node:net");
  let port = 0;
  const failing = {
    initialize: async (options) => {
      port = options.port;
      throw new Error("next refused to initialize");
    },
  };
  await assert.rejects(
    startDesktopHttpServer({
      dir: "/standalone",
      isShuttingDown: () => false,
      log: () => {},
      loadNext: () => failing,
    }),
    /next refused to initialize/,
  );
  assert.ok(port > 0);
  await assert.rejects(
    new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", reject);
    }),
    /ECONNREFUSED/,
  );
});
