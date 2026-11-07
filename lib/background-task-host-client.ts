// The session's read-only view of pi-background-tasks' Host API, and the inline
// extension that gives pi-web the one thing it needs to reach it: the session's
// public `pi.events` bus.
//
// The plugin is an optional install whose package exports do not expose these
// modules, so the wire is declared here and nowhere imported. Only three
// operations exist in this adapter: subscribe, list, and the unsubscribe that
// releases the lease when the wrapper goes away. Nothing here starts, stops,
// renames or re-runs a task, and nothing reads a task's log or result.

import { randomUUID } from "node:crypto";
import type { EventBus, InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  BACKGROUND_TASK_LIST_LIMIT,
  type BackgroundTaskOverlayData,
  type BackgroundTaskOverlayItem,
  type BackgroundTaskStatus,
} from "./background-task-host-types";

/** pi-background-tasks Host API v1, as its `core/host-protocol.ts` declares it. */
export const BACKGROUND_TASK_HOST_REQUEST_CHANNEL = "pi-background-tasks:host:request:v1";
export const BACKGROUND_TASK_HOST_RESPONSE_CHANNEL = "pi-background-tasks:host:response:v1";
export const BACKGROUND_TASK_HOST_CHANGED_CHANNEL = "pi-background-tasks:host:changed:v1";
export const BACKGROUND_TASK_HOST_REQUEST_SCHEMA = "pi-background-tasks.host-request.v1";
export const BACKGROUND_TASK_HOST_RESPONSE_SCHEMA = "pi-background-tasks.host-response.v1";
export const BACKGROUND_TASK_HOST_CHANGED_SCHEMA = "pi-background-tasks.host-changed.v1";

/** Below one poll interval: a host that is not there must not hold the request. */
export const BACKGROUND_TASK_HOST_TIMEOUT_MS = 750;

/** The inline extension's name in pi's startup Extensions list; it is hidden anyway. */
export const BACKGROUND_TASK_HOST_EXTENSION_NAME = "pi-web-background-task-host";

const FALLBACK_TASK_NAME = "后台任务";
const MAX_SUMMARY_NAME_CHARS = 48;
const STALE_LEASE_CODES = new Set(["LEASE_INVALID", "ACTIVATION_MISMATCH"]);

type HostOperation = "subscribe" | "list" | "unsubscribe";

// ---------------------------------------------------------------------------
// The wire, reduced to what this adapter reads
// ---------------------------------------------------------------------------

interface HostTaskCounts {
  total: number;
  running: number;
  completed: number;
  failed: number;
  killed: number;
}

/** The `BgTaskSnapshot` fields the panel shows; the rest (paths, facts) is never read. */
export interface HostTaskSnapshot {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  command?: unknown;
  status?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  exitCode?: unknown;
  bytesWritten?: unknown;
  model?: unknown;
  contextUsage?: unknown;
  tokenUsage?: unknown;
  toolUsage?: unknown;
}

export interface HostTaskView {
  task?: HostTaskSnapshot;
}

export interface HostListResult {
  activationId?: unknown;
  sessionId?: unknown;
  revision?: unknown;
  observedAt?: unknown;
  counts?: unknown;
  tasks?: unknown;
  nextCursor?: unknown;
}

/**
 * A typed Host failure: no host installed, an activation that closed, a lease
 * that expired, or no answer inside the timeout. Never a message to show.
 */
export class BackgroundTaskHostError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BackgroundTaskHostError";
  }
}

/** Every failure this adapter raises is an expected "no detail source" answer. */
export function isBackgroundTaskHostUnavailable(error: unknown): boolean {
  return error instanceof BackgroundTaskHostError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\s+/gu, " ");
  return trimmed.length > 0 ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

interface Lease {
  leaseId: string;
  activationId: string;
  sequence: number;
}

interface PendingRequest {
  operation: HostOperation;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BackgroundTaskHostClientOptions {
  /** How long one frame waits for its response; tests shorten it. */
  timeoutMs?: number;
  /** The Host's lease owner; unique per bridge, so two tabs never share one. */
  clientId?: string;
}

/**
 * One session's read-only Host client. `listTasks()` subscribes on first use and
 * then reuses the lease; a subscription lost to a reactivation is taken out
 * once per call, never in a retry loop.
 */
export class BackgroundTaskHostClient {
  private readonly events: EventBus;
  private readonly timeoutMs: number;
  private readonly clientId: string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listenerOffs: Array<() => void> = [];
  private lease: Lease | undefined;
  private subscribing: Promise<Lease> | undefined;
  private disposed = false;
  private broken: string | undefined;

  constructor(events: EventBus, options: BackgroundTaskHostClientOptions = {}) {
    this.events = events;
    this.timeoutMs = options.timeoutMs ?? BACKGROUND_TASK_HOST_TIMEOUT_MS;
    this.clientId = options.clientId ?? `pi-web-${randomUUID()}`;
    // A bus that cannot be listened to (an SDK without EventBus) must not fail the
    // session: the panel falls back to the extension's own summary instead.
    try {
      this.listenerOffs.push(events.on(BACKGROUND_TASK_HOST_RESPONSE_CHANNEL, (data) => this.handleResponse(data)));
      this.listenerOffs.push(events.on(BACKGROUND_TASK_HOST_CHANGED_CHANNEL, (data) => this.handleChanged(data)));
    } catch (error) {
      this.broken = error instanceof Error ? error.message : String(error);
    }
  }

  /** The task list, newest first. The only query this adapter performs. */
  async listTasks(): Promise<HostListResult> {
    const lease = await this.ensureLease();
    try {
      return await this.listOn(lease);
    } catch (error) {
      // The activation changed under us (a plugin reload, a re-subscribe): one retry.
      if (!(error instanceof BackgroundTaskHostError) || !STALE_LEASE_CODES.has(error.code)) throw error;
      this.lease = undefined;
      return this.listOn(await this.ensureLease());
    }
  }

  /** Idempotent: releases the lease, drops the listeners and ends every pending request. */
  dispose(): void {
    if (this.disposed) return;
    const lease = this.lease;
    this.disposed = true;
    if (lease) this.releaseLease(lease);
    for (const off of this.listenerOffs.splice(0)) {
      try {
        off();
      } catch {
        // The bus is gone; nothing is left to unsubscribe.
      }
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new BackgroundTaskHostError("DISPOSED", "the background-task host client was disposed"));
    }
    this.pending.clear();
    this.lease = undefined;
    this.subscribing = undefined;
  }

  private async listOn(lease: Lease): Promise<HostListResult> {
    lease.sequence += 1;
    const result = await this.request("list", {
      leaseId: lease.leaseId,
      activationId: lease.activationId,
      sequence: lease.sequence,
      limit: BACKGROUND_TASK_LIST_LIMIT,
    });
    return requireListResult(result);
  }

  private async ensureLease(): Promise<Lease> {
    if (this.lease) return this.lease;
    if (!this.subscribing) {
      this.subscribing = this.request("subscribe", { clientId: this.clientId })
        .then((result) => {
          const leaseId = isRecord(result) ? text(result.leaseId) : undefined;
          const activationId = isRecord(result) ? text(result.activationId) : undefined;
          if (!leaseId || !activationId) {
            throw new BackgroundTaskHostError("UNAVAILABLE", "subscribe returned no lease");
          }
          const lease: Lease = { leaseId, activationId, sequence: 0 };
          this.lease = lease;
          return lease;
        })
        .finally(() => {
          this.subscribing = undefined;
        });
    }
    return this.subscribing;
  }

  private request(operation: HostOperation, payload: Record<string, unknown>): Promise<unknown> {
    if (this.disposed || this.broken !== undefined) {
      return Promise.reject(new BackgroundTaskHostError(
        "UNAVAILABLE",
        this.broken ?? "the background-task host client is disposed",
      ));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new BackgroundTaskHostError(
          "TIMEOUT",
          `no background-task host answered ${operation} within ${String(this.timeoutMs)} ms`,
        ));
      }, this.timeoutMs);
      // Registered before the emit: a host may answer synchronously.
      this.pending.set(requestId, { operation, resolve, reject, timer });
      try {
        this.events.emit(BACKGROUND_TASK_HOST_REQUEST_CHANNEL, {
          schema_version: BACKGROUND_TASK_HOST_REQUEST_SCHEMA,
          request_id: requestId,
          operation,
          payload,
        });
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(new BackgroundTaskHostError(
          "UNAVAILABLE",
          error instanceof Error ? error.message : String(error),
        ));
      }
    });
  }

  private releaseLease(lease: Lease): void {
    lease.sequence += 1;
    try {
      this.events.emit(BACKGROUND_TASK_HOST_REQUEST_CHANNEL, {
        schema_version: BACKGROUND_TASK_HOST_REQUEST_SCHEMA,
        request_id: randomUUID(),
        operation: "unsubscribe",
        payload: { leaseId: lease.leaseId, activationId: lease.activationId, sequence: lease.sequence },
      });
    } catch {
      // The activation is already gone; there is nothing left to release.
    }
  }

  private handleResponse(data: unknown): void {
    if (this.disposed || !isRecord(data)) return;
    if (data.schema_version !== BACKGROUND_TASK_HOST_RESPONSE_SCHEMA) return;
    const requestId = data.request_id;
    const operation = data.operation;
    if (typeof requestId !== "string" || typeof operation !== "string") return;
    const pending = this.pending.get(requestId);
    // Unknown ids, a different operation under one id, and late frames are ignored.
    if (!pending || pending.operation !== operation) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (data.ok === true) {
      pending.resolve(data.result);
      return;
    }
    const error = isRecord(data.error) ? data.error : {};
    pending.reject(new BackgroundTaskHostError(
      text(error.code) ?? "UNAVAILABLE",
      text(error.message) ?? "the background-task host refused the request",
    ));
  }

  private handleChanged(data: unknown): void {
    if (this.disposed || !isRecord(data)) return;
    if (data.schema_version !== BACKGROUND_TASK_HOST_CHANGED_SCHEMA) return;
    const lease = this.lease;
    if (!lease) return;
    if (data.kind === "closed") {
      this.lease = undefined;
      return;
    }
    // A frame from another activation means this lease no longer exists.
    if (typeof data.activationId === "string" && data.activationId !== lease.activationId) {
      this.lease = undefined;
    }
  }
}

function requireListResult(value: unknown): HostListResult {
  if (!isRecord(value) || !Array.isArray(value.tasks)) {
    throw new BackgroundTaskHostError("MALFORMED", "the background-task list response had no task array");
  }
  return {
    activationId: value.activationId,
    sessionId: value.sessionId,
    revision: value.revision,
    observedAt: value.observedAt,
    counts: value.counts,
    tasks: value.tasks,
    nextCursor: value.nextCursor,
  };
}

// ---------------------------------------------------------------------------
// The inline bridge
// ---------------------------------------------------------------------------

export interface BackgroundTaskHostBridge {
  /** Loaded as an ordinary inline extension of a normal session: it registers nothing. */
  extension: InlineExtension;
  /** The client of the load in progress; undefined before the factory ran or after a dispose. */
  getClient(): BackgroundTaskHostClient | undefined;
  dispose(): void;
}

/**
 * A stable bridge for one wrapper, as `McpHost` is: the extension factory swaps
 * the current client when extensions load again, and the wrapper keeps asking
 * the bridge, so it never holds a client the runner has replaced.
 */
export function createBackgroundTaskHostBridge(): BackgroundTaskHostBridge {
  let current: BackgroundTaskHostClient | undefined;
  return {
    extension: {
      name: BACKGROUND_TASK_HOST_EXTENSION_NAME,
      hidden: true,
      factory: (pi) => {
        // The one thing this extension does: keep the session's event bus.
        current?.dispose();
        current = pi?.events ? new BackgroundTaskHostClient(pi.events) : undefined;
      },
    },
    getClient: () => current,
    dispose: () => {
      current?.dispose();
      current = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Host result -> browser DTO
// ---------------------------------------------------------------------------

const STATUSES: readonly BackgroundTaskStatus[] = ["running", "completed", "failed", "killed"];

/** The plugin's own rule: the first words of the command, cut short. */
function summarizeCommand(command: string): string {
  const words = command.split(" ").slice(0, 5).join(" ");
  const source = words.length > 0 ? words : command;
  return source.length <= MAX_SUMMARY_NAME_CHARS ? source : `${source.slice(0, MAX_SUMMARY_NAME_CHARS - 1)}…`;
}

/**
 * A task's name as the panel shows it. The command is reduced to a short label so
 * the panel never carries a full command line, and its paths, to the page.
 */
export function backgroundTaskDisplayName(task: HostTaskSnapshot): string {
  const named = text(task.name);
  if (named) return named;
  const described = text(task.description);
  if (described) return described;
  const command = text(task.command);
  if (command) return summarizeCommand(command);
  return text(task.id) ?? FALLBACK_TASK_NAME;
}

function itemOf(view: unknown): BackgroundTaskOverlayItem | null {
  if (!isRecord(view) || !isRecord(view.task)) return null;
  const task = view.task;
  const id = text(task.id);
  const status = STATUSES.find((candidate) => candidate === task.status);
  const startTime = finite(task.startTime);
  if (!id || !status || startTime === undefined) return null;
  const item: BackgroundTaskOverlayItem = {
    id,
    name: backgroundTaskDisplayName(task),
    status,
    startTime,
    bytesWritten: Math.max(0, finite(task.bytesWritten) ?? 0),
  };
  const endTime = finite(task.endTime);
  if (endTime !== undefined) item.endTime = endTime;
  const exitCode = finite(task.exitCode);
  if (exitCode !== undefined) item.exitCode = exitCode;
  const model = text(task.model);
  if (model) item.model = model;
  if (isRecord(task.contextUsage)) {
    const contextWindow = finite(task.contextUsage.contextWindow);
    const tokens = task.contextUsage.tokens === null ? null : finite(task.contextUsage.tokens);
    const percent = task.contextUsage.percent === null ? null : finite(task.contextUsage.percent);
    if (contextWindow !== undefined && tokens !== undefined && percent !== undefined) {
      item.contextUsage = { tokens, contextWindow, percent };
    }
  }
  if (isRecord(task.tokenUsage)) {
    const input = finite(task.tokenUsage.input);
    const output = finite(task.tokenUsage.output);
    const cacheRead = finite(task.tokenUsage.cacheRead);
    const cacheWrite = finite(task.tokenUsage.cacheWrite);
    const totalTokens = finite(task.tokenUsage.totalTokens);
    if (input !== undefined && output !== undefined && cacheRead !== undefined && cacheWrite !== undefined && totalTokens !== undefined) {
      item.tokenUsage = { input, output, cacheRead, cacheWrite, totalTokens };
    }
  }
  if (isRecord(task.toolUsage)) {
    const total = finite(task.toolUsage.total);
    const failed = finite(task.toolUsage.failed);
    if (total !== undefined && failed !== undefined) item.toolUsage = { total, failed };
  }
  return item;
}

function countsOf(value: unknown): BackgroundTaskOverlayData["counts"] {
  const record = isRecord(value) ? value : {};
  const count = (field: unknown) => Math.max(0, finite(field) ?? 0);
  return {
    total: count(record.total),
    running: count(record.running),
    completed: count(record.completed),
    failed: count(record.failed),
    killed: count(record.killed),
  };
}

/**
 * The list as the page receives it: every field chosen here, one by one. The
 * snapshot itself (command, cwd, output and artifact paths, delegate and fusion
 * facts) never leaves the server.
 */
export function toBackgroundTaskOverlayData(result: HostListResult): BackgroundTaskOverlayData {
  const views = Array.isArray(result.tasks) ? result.tasks : [];
  const tasks: BackgroundTaskOverlayItem[] = [];
  for (const view of views) {
    const item = itemOf(view);
    if (item) tasks.push(item);
  }
  return {
    available: true,
    revision: Math.max(0, finite(result.revision) ?? 0),
    observedAt: finite(result.observedAt) ?? Date.now(),
    counts: countsOf(result.counts),
    tasks,
    hasMore: result.nextCursor !== null && result.nextCursor !== undefined,
  };
}

/** The panel's data from a Host result; the route's only way to build it. */
export function readBackgroundTaskOverlayData(result: HostListResult): BackgroundTaskOverlayData {
  return toBackgroundTaskOverlayData(result);
}

/** The Host's own counts type, for callers that build a result by hand (tests). */
export type { HostTaskCounts };
