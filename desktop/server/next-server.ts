// The production HTTP surface: one Node listener on 127.0.0.1:0, Next's own
// `initialize()` mounted onto it, and a transport guard that rejects anything
// not addressed to this run's exact authority/origin.
//
// The guard runs before Next sees the request, so proxy.ts's Host/Origin/CSRF
// checks stay the second line rather than the only one. Next 16's
// `router-server` accepts `server` (our listener) and returns the request and
// upgrade handlers; it is a private entry point, so `initialize()` is typed
// structurally here and must be re-verified with every Next upgrade.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";

const HOST = "127.0.0.1" as const;

/** What `next/dist/server/lib/router-server.js` takes and returns, as used here. */
export interface NextRouterServer {
  initialize(options: {
    dir: string;
    dev: boolean;
    hostname: string;
    port: number;
    server: Server;
    quiet?: boolean;
  }): Promise<NextHandlers>;
}

export interface NextHandlers {
  requestHandler(req: IncomingMessage, res: ServerResponse): Promise<void> | void;
  upgradeHandler(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> | void;
  server: { close(): Promise<void> | void };
  closeUpgraded(): void;
}

/** The request handler Next installs after `initialize()` resolves. */
export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

export interface AuthorityGuard {
  /** `127.0.0.1:<port>` this listener owns. */
  readonly authority: string;
  /** `http://127.0.0.1:<port>`, the only accepted Origin. */
  readonly origin: string;
}

/** Exact Host and, when present, exact Origin. A missing Host or `Origin: null` fails. */
export function isAllowedTransportRequest(
  headers: { host?: string; origin?: string },
  guard: AuthorityGuard,
): boolean {
  const host = headers.host;
  if (typeof host !== "string" || host.toLowerCase() !== guard.authority) return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  return origin === guard.origin;
}

export interface DesktopHttpServerOptions {
  readonly dir: string;
  /** True once shutdown has started: new requests answer 503. */
  readonly isShuttingDown: () => boolean;
  readonly log: (line: string) => void;
  /** Tests replace Next's private module loader; production reads the standalone root. */
  readonly loadNext?: (dir: string) => NextRouterServer;
}

export interface DesktopHttpServer {
  /** The listener, already on 127.0.0.1 with an OS-assigned port. */
  readonly server: Server;
  readonly port: number;
  readonly guard: AuthorityGuard;
  readonly handlers: NextHandlers;
  /** Stops accepting, then resolves once every tracked connection is gone. */
  close(timeoutMs: number): Promise<void>;
  /** Force-closes every tracked HTTP/SSE/upgraded socket. */
  destroyConnections(): void;
}

function trackSockets(server: Server): Set<Socket> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return sockets;
}

function destroySockets(sockets: Set<Socket>): void {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
}

/** A plain 403/503 without a body that could leak anything. */
function refuse(res: ServerResponse, status: number, text: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "Cache-Control": "no-store", Connection: "close" });
  res.end(text);
}

function listen(server: Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("the desktop listener has no port"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, host);
  });
}

/** The exact `initialize()` argument object, kept separate so tests pin it. */
export function nextInitializeOptions(dir: string, port: number, server: Server): Parameters<NextRouterServer["initialize"]>[0] {
  return { dir, dev: false, hostname: HOST, port, server, quiet: true };
}

function loadNext(dir: string): NextRouterServer {
  // Next resolves its chunks relative to the standalone root, which is also the
  // process's working directory; requiring from its package.json keeps both in step.
  const requireNext = createRequire(join(dir, "package.json"));
  // SAFETY: the module is Next's private router-server entry; its published
  // typings do not describe it, so the shape this file calls is declared above.
  return requireNext("next/dist/server/lib/router-server.js") as NextRouterServer;
}

/**
 * Listens first (so the guard knows the real port), then initializes Next on
 * that listener. Any failure closes what was opened and rethrows for `fatal`.
 */
export async function startDesktopHttpServer(options: DesktopHttpServerOptions): Promise<DesktopHttpServer> {
  const gate: { handler: RequestHandler | null; resolve: ((handler: RequestHandler) => void) | null } = {
    handler: null,
    resolve: null,
  };
  const handlersReady = new Promise<RequestHandler>((resolve) => {
    gate.resolve = resolve;
  });
  // Filled in once the listener reports its port; every request is checked
  // against that exact authority.
  let guard: AuthorityGuard | null = null;
  const authorityAllows = (headers: { host?: string; origin?: string }): boolean =>
    guard !== null && isAllowedTransportRequest(headers, guard);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!authorityAllows(req.headers)) {
      refuse(res, 403, "Forbidden");
      return;
    }
    if (options.isShuttingDown()) {
      refuse(res, 503, "Shutting down");
      return;
    }
    if (gate.handler) {
      gate.handler(req, res);
      return;
    }
    void handlersReady.then((installed) => {
      if (options.isShuttingDown()) {
        refuse(res, 503, "Shutting down");
        return;
      }
      installed(req, res);
    });
  });
  const sockets = trackSockets(server);

  let port: number;
  try {
    port = await listen(server, HOST);
  } catch (error) {
    server.close();
    throw error;
  }

  const boundGuard: AuthorityGuard = { authority: `${HOST}:${port}`, origin: `http://${HOST}:${port}` };
  guard = boundGuard;

  let handlers: NextHandlers;
  try {
    handlers = await (options.loadNext ?? loadNext)(options.dir).initialize(
      nextInitializeOptions(options.dir, port, server),
    );
    const requestHandler: RequestHandler = (req, res) => {
      void Promise.resolve(handlers.requestHandler(req, res)).catch((error: unknown) => {
        options.log(`[desktop] Next request failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) refuse(res, 500, "Internal Server Error");
        else res.destroy();
      });
    };
    gate.handler = requestHandler;
    gate.resolve?.(requestHandler);
  } catch (error) {
    // Requests waiting on the handler get a 503 once the gate closes; the
    // listener is closed and the caller reports `fatal`.
    gate.resolve?.(() => {
      if (!options.isShuttingDown()) return;
    });
    destroySockets(sockets);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }

  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!authorityAllows(req.headers) || options.isShuttingDown()) {
      socket.destroy();
      return;
    }
    void Promise.resolve(handlers.upgradeHandler(req, socket, head)).catch(() => socket.destroy());
  });

  const close = async (timeoutMs: number): Promise<void> => {
    if (!server.listening) return;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => destroySockets(sockets), Math.max(1, timeoutMs));
    (timer as { unref?: () => void }).unref?.();
    await closed;
    clearTimeout(timer);
    destroySockets(sockets);
  };

  return { server, port, guard: boundGuard, handlers, close, destroyConnections: () => destroySockets(sockets) };
}
