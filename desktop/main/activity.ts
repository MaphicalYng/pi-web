/**
 * `/api/agent/running` is the only business signal the shell reads. It decides
 * whether closing the window may silently stop work, so anything unexpected is
 * reported as `unknown` and treated conservatively by the quit coordinator.
 */
import { ACTIVITY_TIMEOUT_MS } from "./constants";
import { createTimeoutSignal, type FetchLike } from "./http-probes";

export type Activity = "idle" | "active" | "unknown";

export interface ActivitySnapshot {
  activity: Activity;
  running: number;
  subagentsActive: number;
  awaitingInput: number;
}

const UNKNOWN: ActivitySnapshot = { activity: "unknown", running: 0, subagentsActive: 0, awaitingInput: 0 };

function idArray(record: Record<string, unknown>, keys: readonly string[]): string[] | null {
  let sawField = false;
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) continue;
    sawField = true;
    const value = record[key];
    if (!Array.isArray(value)) return null;
    if (!value.every((entry) => typeof entry === "string")) return null;
    return value as string[];
  }
  return sawField ? [] : null;
}

export function countActivityPayload(payload: unknown): ActivitySnapshot {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { ...UNKNOWN };
  const record = payload as Record<string, unknown>;

  const running = idArray(record, ["running", "runningSessionIds"]);
  const subagents = idArray(record, ["subagentsActive", "subagentsActiveSessionIds"]);
  const awaitingInput = idArray(record, ["awaitingInput", "awaitingInputSessionIds"]);
  if (!running || !subagents || !awaitingInput) return { ...UNKNOWN };

  const active = new Set<string>([...running, ...subagents]);
  return {
    activity: active.size > 0 ? "active" : "idle",
    running: running.length,
    subagentsActive: subagents.length,
    awaitingInput: awaitingInput.length,
  };
}

export interface ActivityOptions {
  fetch: FetchLike;
  timeoutMs?: number;
  timer?: Parameters<typeof createTimeoutSignal>[1];
}

export async function fetchActivity(origin: string, options: ActivityOptions): Promise<ActivitySnapshot> {
  const timeout = createTimeoutSignal(options.timeoutMs ?? ACTIVITY_TIMEOUT_MS, options.timer);
  try {
    const response = await options.fetch(`${origin}/api/agent/running`, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "include",
      cache: "no-store",
      signal: timeout.signal,
    });
    if (!response.ok) {
      await response.body?.getReader().cancel().catch(() => undefined);
      return { ...UNKNOWN };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      return { ...UNKNOWN };
    }
    return countActivityPayload(payload);
  } catch {
    return { ...UNKNOWN };
  } finally {
    timeout.cancel();
  }
}
