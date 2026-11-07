// The background-task panel's wording and numbers: durations, Chinese status
// labels, one compact meta line per task, and the header's counts and refresh
// time. Pure functions so the panel renders the same text for the same data.

import type {
  BackgroundTaskCounts,
  BackgroundTaskOverlayData,
  BackgroundTaskOverlayItem,
  BackgroundTaskStatus,
} from "./background-task-host-types";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "45秒", "1分05秒", "2小时03分", "3天02小时"; never negative, never NaN. */
export function formatTaskDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
  if (total < MINUTE) return `${String(Math.floor(total / SECOND))}秒`;
  if (total < HOUR) {
    const minutes = Math.floor(total / MINUTE);
    const seconds = Math.floor((total % MINUTE) / SECOND);
    return `${String(minutes)}分${seconds < 10 ? "0" : ""}${String(seconds)}秒`;
  }
  if (total < DAY) {
    const hours = Math.floor(total / HOUR);
    const minutes = Math.floor((total % HOUR) / MINUTE);
    return `${String(hours)}小时${minutes < 10 ? "0" : ""}${String(minutes)}分`;
  }
  const days = Math.floor(total / DAY);
  const hours = Math.floor((total % DAY) / HOUR);
  return `${String(days)}天${hours < 10 ? "0" : ""}${String(hours)}小时`;
}

/** A finished task counts until its end; a running one until `now`. */
export function taskDurationMs(item: BackgroundTaskOverlayItem, now: number): number {
  const end = item.status === "running" ? now : (item.endTime ?? now);
  return Math.max(0, end - item.startTime);
}

/** The colored status word plus its time: "运行中 12秒", "失败 1分05秒 · 退出码 1". */
export function taskStatusLabel(item: BackgroundTaskOverlayItem, now: number): string {
  const duration = formatTaskDuration(taskDurationMs(item, now));
  const labels: Record<BackgroundTaskStatus, string> = {
    running: `运行中 ${duration}`,
    completed: `完成 ${duration}`,
    failed: `失败 ${duration}`,
    killed: `已终止 ${duration}`,
  };
  const label = labels[item.status];
  if (item.status === "failed" && item.exitCode !== undefined) {
    return `${label} · 退出码 ${String(item.exitCode)}`;
  }
  return label;
}

/** 950, 12.3K, 1.2M: short enough for a one-line meta row. */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 1000) return String(Math.floor(count));
  if (count < 1_000_000) {
    const value = (count / 1000).toFixed(1);
    return `${value.endsWith(".0") ? value.slice(0, -2) : value}K`;
  }
  const value = (count / 1_000_000).toFixed(1);
  return `${value.endsWith(".0") ? value.slice(0, -2) : value}M`;
}

/**
 * The one-row facts a task carries: model, context use, tokens, tools. Each is a
 * separate segment so the panel can style them apart; all are optional.
 */
export function taskMetaSegments(item: BackgroundTaskOverlayItem): string[] {
  const segments: string[] = [];
  if (item.model) segments.push(item.model);
  if (item.contextUsage) {
    const { tokens, contextWindow, percent } = item.contextUsage;
    if (tokens === null || percent === null) {
      segments.push("上下文 统计中");
    } else {
      segments.push(`上下文 ${String(Math.round(percent))}% · ${formatTokenCount(tokens)} / ${formatTokenCount(contextWindow)}`);
    }
  }
  if (item.tokenUsage) {
    segments.push(`Token ${formatTokenCount(item.tokenUsage.input)} 入 / ${formatTokenCount(item.tokenUsage.output)} 出`);
  }
  if (item.toolUsage && item.toolUsage.total > 0) {
    const failed = item.toolUsage.failed > 0 ? ` · 失败 ${String(item.toolUsage.failed)}` : "";
    segments.push(`工具 ${String(item.toolUsage.total)}${failed}`);
  }
  return segments;
}

/** The same facts as one line, for a title or a test. */
export function taskMetaText(item: BackgroundTaskOverlayItem): string {
  return taskMetaSegments(item).join(" · ");
}

/** The panel header: what the Host counted across every task, not just this page. */
export function formatTaskCounts(counts: BackgroundTaskCounts): string {
  return `共 ${String(counts.total)} 项 · 运行中 ${String(counts.running)} · 失败 ${String(counts.failed)} · 完成 ${String(counts.completed)}`;
}

/** "刷新于 12:34:05" in the reader's own time zone. */
export function formatRefreshTime(observedAt: number): string {
  const date = new Date(observedAt);
  if (Number.isNaN(date.getTime())) return "刷新时间未知";
  const two = (value: number) => String(value).padStart(2, "0");
  return `刷新于 ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** "共 120 项，此处显示最近 50 项". */
export function formatTruncation(data: BackgroundTaskOverlayData): string {
  return `共 ${String(data.counts.total)} 项，此处显示最近 ${String(data.tasks.length)} 项`;
}

/** Running first, then newest started: the list is a live queue, not a log. */
export function sortTaskItems(tasks: readonly BackgroundTaskOverlayItem[]): BackgroundTaskOverlayItem[] {
  const rank = (item: BackgroundTaskOverlayItem) => (item.status === "running" ? 0 : 1);
  return [...tasks].sort((left, right) => rank(left) - rank(right) || right.startTime - left.startTime);
}

/** True when the panel shows a real list (available, with at least one task). */
export function hasTaskDetails(data: BackgroundTaskOverlayData | null): data is BackgroundTaskOverlayData {
  return data !== null && data.available && data.tasks.length > 0;
}
