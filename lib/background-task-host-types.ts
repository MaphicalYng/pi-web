// Client-safe shape of GET /api/agent/[id]/background-tasks, and the one
// runtime check the page runs on it. The Host API's own wire types are NOT
// declared here: they live beside the client that speaks them
// (lib/background-task-host-client.ts), which maps every snapshot field
// explicitly so nothing else reaches the browser.

/** How often a visible page refreshes the task list. */
export const BACKGROUND_TASK_POLL_MS = 2_000;
/** What one request asks for: the Host API's page bound, and what the panel shows. */
export const BACKGROUND_TASK_LIST_LIMIT = 50;

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "killed";

/** The Host's own counts, across every task, not only the page it returned. */
export interface BackgroundTaskCounts {
  total: number;
  running: number;
  completed: number;
  failed: number;
  killed: number;
}

export interface BackgroundTaskOverlayItem {
  id: string;
  /** Derived on the server from name, description or command; never the full command. */
  name: string;
  status: BackgroundTaskStatus;
  startTime: number;
  endTime?: number;
  exitCode?: number;
  bytesWritten: number;
  model?: string;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
  tokenUsage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  };
  toolUsage?: { total: number; failed: number };
}

export interface BackgroundTaskOverlayData {
  available: true;
  revision: number;
  /** The Host's snapshot time: run times are measured against it, not the browser's clock. */
  observedAt: number;
  counts: BackgroundTaskCounts;
  /** Newest first, as the Host API orders it. */
  tasks: BackgroundTaskOverlayItem[];
  /** `nextCursor != null`: only the most recent page is shown. */
  hasMore: boolean;
}

/**
 * `available: false` never means "no tasks": it means no detail source answered,
 * and the panel falls back to the extension's own status summary.
 */
export type BackgroundTaskOverlayResponse = BackgroundTaskOverlayData | { available: false };

const STATUSES: readonly BackgroundTaskStatus[] = ["running", "completed", "failed", "killed"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalFinite(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : finite(value);
}

function count(value: unknown): number {
  const parsed = finite(value);
  return parsed !== undefined && parsed >= 0 ? parsed : 0;
}

function parseContextUsage(value: unknown): BackgroundTaskOverlayItem["contextUsage"] {
  if (!isRecord(value)) return undefined;
  const contextWindow = finite(value.contextWindow);
  if (contextWindow === undefined) return undefined;
  const tokens = value.tokens === null ? null : finite(value.tokens);
  const percent = value.percent === null ? null : finite(value.percent);
  if (tokens === undefined || percent === undefined) return undefined;
  return { tokens, contextWindow, percent };
}

function parseTokenUsage(value: unknown): BackgroundTaskOverlayItem["tokenUsage"] {
  if (!isRecord(value)) return undefined;
  const input = finite(value.input);
  const output = finite(value.output);
  const cacheRead = finite(value.cacheRead);
  const cacheWrite = finite(value.cacheWrite);
  const totalTokens = finite(value.totalTokens);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined || totalTokens === undefined) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, totalTokens };
}

function parseToolUsage(value: unknown): BackgroundTaskOverlayItem["toolUsage"] {
  if (!isRecord(value)) return undefined;
  const total = finite(value.total);
  const failed = finite(value.failed);
  if (total === undefined || failed === undefined) return undefined;
  return { total, failed };
}

function parseItem(value: unknown): BackgroundTaskOverlayItem | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : null;
  const name = typeof value.name === "string" ? value.name : "";
  const status = STATUSES.find((candidate) => candidate === value.status);
  const startTime = finite(value.startTime);
  if (id === null || status === undefined || startTime === undefined) return null;
  const item: BackgroundTaskOverlayItem = {
    id,
    name,
    status,
    startTime,
    bytesWritten: count(value.bytesWritten),
  };
  const endTime = optionalFinite(value.endTime);
  if (endTime !== undefined) item.endTime = endTime;
  const exitCode = optionalFinite(value.exitCode);
  if (exitCode !== undefined) item.exitCode = exitCode;
  if (typeof value.model === "string" && value.model.length > 0) item.model = value.model;
  const contextUsage = parseContextUsage(value.contextUsage);
  if (contextUsage) item.contextUsage = contextUsage;
  const tokenUsage = parseTokenUsage(value.tokenUsage);
  if (tokenUsage) item.tokenUsage = tokenUsage;
  const toolUsage = parseToolUsage(value.toolUsage);
  if (toolUsage) item.toolUsage = toolUsage;
  return item;
}

/**
 * The response as the page may use it, or null when it is not the shape this
 * build accepts: an old server, a proxy's error page, a hand-written value.
 * Only the fields the panel reads are checked; extra ones are ignored.
 */
export function parseBackgroundTaskOverlayResponse(value: unknown): BackgroundTaskOverlayResponse | null {
  if (!isRecord(value) || typeof value.available !== "boolean") return null;
  if (!value.available) return { available: false };
  if (!Array.isArray(value.tasks) || !isRecord(value.counts)) return null;
  const observedAt = finite(value.observedAt);
  if (observedAt === undefined) return null;
  const tasks: BackgroundTaskOverlayItem[] = [];
  for (const entry of value.tasks) {
    const item = parseItem(entry);
    if (item) tasks.push(item);
  }
  const counts = value.counts;
  return {
    available: true,
    revision: count(value.revision),
    observedAt,
    counts: {
      total: count(counts.total),
      running: count(counts.running),
      completed: count(counts.completed),
      failed: count(counts.failed),
      killed: count(counts.killed),
    },
    tasks,
    hasMore: value.hasMore === true,
  };
}
