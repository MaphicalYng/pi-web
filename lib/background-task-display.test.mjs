import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  formatRefreshTime,
  formatTaskCounts,
  formatTaskDuration,
  formatTokenCount,
  formatTruncation,
  hasTaskDetails,
  sortTaskItems,
  taskDurationMs,
  taskMetaSegments,
  taskMetaText,
  taskStatusLabel,
} = await jiti.import("./background-task-display.ts");

const item = (overrides) => ({
  id: "task-1",
  name: "build",
  status: "completed",
  startTime: 1_000_000,
  endTime: 1_065_000,
  bytesWritten: 0,
  ...overrides,
});

test("a duration stays short and never goes below zero", () => {
  assert.equal(formatTaskDuration(0), "0秒");
  assert.equal(formatTaskDuration(-5000), "0秒");
  assert.equal(formatTaskDuration(Number.NaN), "0秒");
  assert.equal(formatTaskDuration(45_000), "45秒");
  assert.equal(formatTaskDuration(65_000), "1分05秒");
  assert.equal(formatTaskDuration(3_600_000), "1小时00分");
  assert.equal(formatTaskDuration(2 * 3_600_000 + 3 * 60_000), "2小时03分");
  assert.equal(formatTaskDuration(24 * 3_600_000), "1天00小时");
  assert.equal(formatTaskDuration(3 * 24 * 3_600_000 + 2 * 3_600_000), "3天02小时");
});

test("a running task counts to now, a finished one to its end", () => {
  const running = item({ status: "running", endTime: undefined, startTime: 1_000_000 });
  assert.equal(taskDurationMs(running, 1_012_000), 12_000);
  // A stale endTime on a running task is ignored.
  assert.equal(taskDurationMs({ ...running, endTime: 1_001_000 }, 1_012_000), 12_000);
  const done = item({ startTime: 1_000_000, endTime: 1_004_000 });
  assert.equal(taskDurationMs(done, 9_999_999), 4_000);
  // A finished task with no end time falls back to now rather than a negative span.
  assert.equal(taskDurationMs(item({ endTime: undefined }), 1_002_000), 2_000);
});

test("the status word is Chinese and carries the task's own time", () => {
  const now = 1_000_030_000;
  assert.equal(taskStatusLabel(item({ status: "running", startTime: 1_000_010_000 }), now), "运行中 20秒");
  assert.equal(taskStatusLabel(item({ status: "completed", startTime: now - 65_000, endTime: now }), now), "完成 1分05秒");
  assert.equal(taskStatusLabel(item({ status: "killed", startTime: now - 5_000, endTime: now }), now), "已终止 5秒");
  assert.equal(taskStatusLabel(item({ status: "failed", startTime: now - 5_000, endTime: now }), now), "失败 5秒");
  assert.equal(
    taskStatusLabel(item({ status: "failed", exitCode: 2, startTime: now - 5_000, endTime: now }), now),
    "失败 5秒 · 退出码 2",
  );
});

test("token counts stay compact", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(-3), "0");
  assert.equal(formatTokenCount(Number.NaN), "0");
  assert.equal(formatTokenCount(950), "950");
  assert.equal(formatTokenCount(1000), "1K");
  assert.equal(formatTokenCount(1234), "1.2K");
  assert.equal(formatTokenCount(999_949), "999.9K");
  assert.equal(formatTokenCount(1_000_000), "1M");
  assert.equal(formatTokenCount(1_250_000), "1.3M");
});

test("the meta row lists only the facts a task actually carries", () => {
  assert.deepEqual(taskMetaSegments(item({})), []);
  assert.equal(taskMetaText(item({})), "");

  const full = item({
    model: "anthropic/claude-sonnet-4-5",
    contextUsage: { tokens: 1200, contextWindow: 200_000, percent: 0.6 },
    tokenUsage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1500 },
    toolUsage: { total: 4, failed: 1 },
  });
  assert.deepEqual(taskMetaSegments(full), [
    "anthropic/claude-sonnet-4-5",
    "上下文 1% · 1.2K / 200K",
    "Token 1.2K 入 / 300 出",
    "工具 4 · 失败 1",
  ]);

  // A task that has not reported its context yet says so instead of "0%".
  const pending = item({ contextUsage: { tokens: null, contextWindow: 200_000, percent: null } });
  assert.deepEqual(taskMetaSegments(pending), ["上下文 统计中"]);

  // No failures: the tool count stands alone.
  assert.deepEqual(taskMetaSegments(item({ toolUsage: { total: 2, failed: 0 } })), ["工具 2"]);
});

test("counts, refresh time and the truncation line are the panel's own wording", () => {
  assert.equal(
    formatTaskCounts({ total: 5, running: 2, completed: 2, failed: 1, killed: 0 }),
    "共 5 项 · 运行中 2 · 失败 1 · 完成 2",
  );
  const at = new Date(2026, 0, 2, 3, 4, 5).getTime();
  assert.equal(formatRefreshTime(at), "刷新于 03:04:05");
  assert.equal(formatRefreshTime(Number.NaN), "刷新时间未知");
  assert.equal(
    formatTruncation({
      available: true,
      revision: 1,
      observedAt: at,
      counts: { total: 120, running: 1, completed: 0, failed: 0, killed: 0 },
      tasks: [item({}), item({ id: "task-2" })],
      hasMore: true,
    }),
    "共 120 项，此处显示最近 2 项",
  );
});

test("running tasks sort first, then the newest start; the input array is untouched", () => {
  const older = item({ id: "old", startTime: 1_000 });
  const newer = item({ id: "new", startTime: 3_000 });
  const runningOlder = item({ id: "run-old", status: "running", startTime: 2_000 });
  const runningNewer = item({ id: "run-new", status: "running", startTime: 4_000 });
  const input = [older, newer, runningOlder, runningNewer];

  assert.deepEqual(sortTaskItems(input).map((entry) => entry.id), ["run-new", "run-old", "new", "old"]);
  assert.deepEqual(input.map((entry) => entry.id), ["old", "new", "run-old", "run-new"]);
});

test("only an available list with tasks is a detail source", () => {
  const base = {
    available: true,
    revision: 0,
    observedAt: 1,
    counts: { total: 0, running: 0, completed: 0, failed: 0, killed: 0 },
    tasks: [],
    hasMore: false,
  };
  assert.equal(hasTaskDetails(null), false);
  assert.equal(hasTaskDetails(base), false);
  assert.equal(hasTaskDetails({ ...base, tasks: [item({})] }), true);
});
