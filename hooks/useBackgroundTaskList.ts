"use client";

import { useEffect, useState } from "react";
import {
  BACKGROUND_TASK_POLL_MS,
  parseBackgroundTaskOverlayResponse,
  type BackgroundTaskOverlayData,
} from "@/lib/background-task-host-types";

/** Waiting a little after the page comes back keeps a visible tab's own first read first. */
const RESUME_REFRESH_MS = 400;

/**
 * One read of the panel's data: the session's task list, or null when no detail
 * source answered (the panel then shows the extension's own summary). A failure
 * is never thrown at the page: this panel is an addition, not the chat itself.
 */
export async function readBackgroundTaskDetails(
  sessionId: string,
  summaryVisible: boolean,
  signal?: AbortSignal,
): Promise<BackgroundTaskOverlayData | null> {
  try {
    const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/background-tasks`, {
      signal,
      cache: "no-store",
    });
    if (!response.ok) return null;
    const parsed = parseBackgroundTaskOverlayResponse(await response.json());
    if (!parsed || !parsed.available) return null;
    // An empty host list is only worth showing when the summary still is: a session
    // that never installed the plugin must not grow an empty panel.
    if (parsed.tasks.length === 0 && !summaryVisible) return null;
    return parsed;
  } catch {
    // Aborted, offline, or not JSON: the same quiet answer as an absent host.
    return null;
  }
}

/**
 * The background-task panel's data, refreshed every 2 s while the page is visible
 * (and once when it becomes visible again). `summaryVisible` is the extension's own
 * summary: a session with no summary and no tasks keeps no panel and makes no
 * request for one.
 */
export function useBackgroundTaskList(
  sessionId: string | undefined,
  summaryVisible: boolean,
): BackgroundTaskOverlayData | null {
  const [data, setData] = useState<BackgroundTaskOverlayData | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setData(null);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const read = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      const next = await readBackgroundTaskDetails(sessionId, summaryVisible, controller.signal);
      inFlight = false;
      if (!cancelled) setData(next);
    };

    void read();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void read();
    }, BACKGROUND_TASK_POLL_MS);

    // Coming back to a tab refreshes without waiting out a poll interval.
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => {
        void read();
      }, RESUME_REFRESH_MS);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      clearInterval(interval);
      clearTimeout(resumeTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      controller.abort();
    };
  }, [sessionId, summaryVisible]);

  return data;
}
