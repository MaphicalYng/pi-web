import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const {
  BACKGROUND_TASKS_STATUS_KEY,
  ChatExtensionOverlays,
  TODOS_WIDGET_KEY,
  railEntries,
  selectChatOverlays,
} = await jiti.import("./ChatExtensionOverlays.tsx");

function renderOverlays(props) {
  return renderToStaticMarkup(React.createElement(ChatExtensionOverlays, props));
}

const todos = (lines, placement = "aboveEditor") => ({
  key: TODOS_WIDGET_KEY,
  lines,
  placement,
});
const backgroundStatus = (text) => ({ key: BACKGROUND_TASKS_STATUS_KEY, text });

test("shows nothing when neither overlay has anything to show", () => {
  assert.deepEqual(selectChatOverlays([], []), {
    backgroundTaskText: undefined,
    todos: undefined,
    remainingStatuses: [],
    remainingWidgets: [],
  });
  assert.equal(renderOverlays({}), "");
  assert.equal(renderOverlays({ backgroundTaskText: undefined, todos: undefined }), "");
});

test("takes only its own keys out, leaving every other extension in place", () => {
  const statuses = [
    { key: "20-memory", text: "memory" },
    { key: "command:/mode toggle", text: "Build" },
  ];
  const widgets = [
    { key: "usage", lines: ["42%"], placement: "aboveEditor" },
    { key: "foot", lines: ["x"], placement: "belowEditor" },
  ];

  const selection = selectChatOverlays(statuses, widgets);

  assert.equal(selection.backgroundTaskText, undefined);
  assert.equal(selection.todos, undefined);
  assert.deepEqual(selection.remainingStatuses, statuses);
  assert.deepEqual(selection.remainingWidgets, widgets);
  // The shelf reads the same objects, in the same order.
  assert.equal(selection.remainingStatuses[0], statuses[0]);
  assert.equal(selection.remainingWidgets[1], widgets[1]);
});

test("renders a real rpiv-todos widget's lines, ANSI kept and HTML escaped", () => {
  const widget = todos(["\x1b[32m[ ] first\x1b[0m", "<b>not markup</b>"]);
  const selection = selectChatOverlays([], [widget]);
  const html = renderOverlays({ todos: selection.todos });

  assert.equal(selection.todos, widget);
  assert.deepEqual(selection.remainingWidgets, []);
  assert.match(html, /data-overlay="rpiv-todos"/);
  assert.match(html, /chat-extension-overlay-pre/);
  assert.match(html, /<span class="ansi-green-fg">\[ \] first<\/span>/);
  assert.match(html, /&lt;b&gt;not markup&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>not markup/);
  assert.doesNotMatch(html, /data-overlay="background-tasks"/);
  assert.doesNotMatch(html, /<button|<input/);
});

test("hides an empty, blank, ANSI-only or below-editor todo widget, and still filters it", () => {
  for (const widget of [
    todos([]),
    todos(["", "   "]),
    todos(["\x1b[0m", "\x1b[32m  \x1b[0m"]),
    todos(["- a real line"], "belowEditor"),
  ]) {
    const selection = selectChatOverlays([], [widget]);
    assert.equal(selection.todos, undefined, JSON.stringify(widget));
    assert.deepEqual(selection.remainingWidgets, [], JSON.stringify(widget));
    assert.equal(renderOverlays({ todos: selection.todos }), "");
  }
});

test("shows the background-task summary the plugin writes, task counts only", () => {
  const running = selectChatOverlays([backgroundStatus("\x1b[36m bg 1 running \x1b[0m")], []);
  assert.equal(running.backgroundTaskText, "\x1b[36m bg 1 running \x1b[0m");
  const html = renderOverlays({ backgroundTaskText: running.backgroundTaskText });
  assert.match(html, /data-overlay="background-tasks"/);
  assert.match(html, /ansi-.*-fg/);
  // The panel has a fixed Chinese title; the tooltip keeps the summary's plain text.
  assert.match(html, /aria-label="后台任务"/);
  assert.match(html, /title="bg 1 running"/);
  assert.match(html, />后台任务</);

  const several = selectChatOverlays([
    backgroundStatus("\x1b[36m bg 0 running · 2 failed · 3 done · focused \x1b[0m"),
  ], []);
  assert.equal(
    several.backgroundTaskText,
    "\x1b[36m bg 0 running · 2 failed · 3 done · focused \x1b[0m",
  );

  for (const text of [
    // Only the update notice: no task summary, no overlay.
    " bg ⬆ v9.9.9 is available · /bg-update ",
    " bg ⬆ v9.9.9 is available · /bg-update · focused ",
    "",
    "   ",
    // A word without a count is not the plugin's task summary.
    "All tasks done",
    "bg focused",
  ]) {
    const selection = selectChatOverlays([backgroundStatus(text)], []);
    assert.equal(selection.backgroundTaskText, undefined, text);
    assert.equal(renderOverlays({ backgroundTaskText: selection.backgroundTaskText }), "");
  }
});

test("a task summary with an update notice stays; the update notice alone never does", () => {
  const withTasks = selectChatOverlays([
    backgroundStatus("\x1b[36m bg 2 running · focused · ⬆ v9.9.9 /bg-update \x1b[0m"),
  ], []);
  assert.equal(
    withTasks.backgroundTaskText,
    "\x1b[36m bg 2 running · focused · ⬆ v9.9.9 /bg-update \x1b[0m",
  );

  const updateOnly = selectChatOverlays([
    backgroundStatus("\x1b[36m bg ⬆ v9.9.9 /bg-update \x1b[0m"),
  ], []);
  assert.equal(updateOnly.backgroundTaskText, undefined);
  // The target key leaves the shelf even when its overlay is hidden.
  assert.deepEqual(updateOnly.remainingStatuses, []);
});

test("filters every background-tasks status, not just the shown one, and leaves other keys alone", () => {
  const first = backgroundStatus("1 running");
  const second = backgroundStatus("bg focused");
  const other = { key: "bg-tasks", text: "1 running" };
  const selection = selectChatOverlays([first, other, second], []);

  assert.equal(selection.backgroundTaskText, "1 running");
  assert.deepEqual(selection.remainingStatuses, [other]);
});

test("renders background tasks above rpiv-todos, and one item alone fills the box", () => {
  const selection = selectChatOverlays(
    [backgroundStatus(" bg 1 running · focused ")],
    [todos(["- a"])],
  );
  const both = renderOverlays({
    backgroundTaskText: selection.backgroundTaskText,
    todos: selection.todos,
  });
  const backgroundIndex = both.indexOf('data-overlay="background-tasks"');
  const todosIndex = both.indexOf('data-overlay="rpiv-todos"');
  assert.ok(backgroundIndex >= 0, both);
  assert.ok(todosIndex > backgroundIndex, both);
  assert.equal(both.match(/data-overlay="/g)?.length, 2);

  const tasksOnly = renderOverlays({ backgroundTaskText: selection.backgroundTaskText });
  assert.match(tasksOnly, /data-overlay="background-tasks"/);
  assert.doesNotMatch(tasksOnly, /data-overlay="rpiv-todos"/);

  const todosOnly = renderOverlays({ todos: selection.todos });
  assert.match(todosOnly, /data-overlay="rpiv-todos"/);
  assert.doesNotMatch(todosOnly, /data-overlay="background-tasks"/);
});

test("keeps the overlays and the branch label read-only", async () => {
  const overlays = await readFile(new URL("./ChatExtensionOverlays.tsx", import.meta.url), "utf8");
  const branch = await readFile(new URL("./ChatGitBranch.tsx", import.meta.url), "utf8");
  for (const source of [overlays, branch]) {
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  }
  // The overlays own two purely local controls (the rail's open toggle and the
  // tap-open panel's close button): neither leaves the page. What they may not
  // do is send anything — no session command, no writes, no form of its own.
  assert.doesNotMatch(overlays, /agent-client|sendCommand|\.prompt\(|<input|<select|<form/);
  // The branch label has no control at all: it only reads.
  assert.doesNotMatch(branch, /<button|<input|<select|onClick|onChange|onSubmit/);

  // The branch label's data path reads the branch; it must never write Git.
  const changes = await readFile(new URL("../lib/git-changes.ts", import.meta.url), "utf8");
  assert.doesNotMatch(changes, /"(?:checkout|switch|reset|merge|rebase|stash)"/);
});

// ---------------------------------------------------------------------------
// The task list itself: counts, rows, the fixed titles, the summary fallback
// ---------------------------------------------------------------------------

const { BackgroundTasksPanel } = await jiti.import("./ChatExtensionOverlays.tsx");

function renderPanel(props) {
  return renderToStaticMarkup(React.createElement(BackgroundTasksPanel, props));
}

const item = (overrides) => ({
  id: "task-1",
  name: "build",
  status: "completed",
  startTime: 1_000_000,
  bytesWritten: 0,
  ...overrides,
});

const data = (overrides) => ({
  available: true,
  revision: 7,
  observedAt: 1_000_120_000,
  counts: { total: 2, running: 1, completed: 1, failed: 0, killed: 0 },
  tasks: [
    item({ id: "done-1", name: "npm test", status: "completed", startTime: 1_000_000_000, endTime: 1_000_065_000 }),
    item({ id: "run-1", name: "npm run build", status: "running", startTime: 1_000_100_000 }),
  ],
  hasMore: false,
  ...overrides,
});

test("the task panel draws counts, a running-first list, and a fixed Chinese title", () => {
  const html = renderPanel({ details: data() });
  assert.match(html, /共 2 项 · 运行中 1 · 失败 0 · 完成 1/);
  assert.match(html, /运行中 20秒/);
  assert.match(html, /完成 1分05秒/);
  // Running sorts above a finished task even though it started later.
  assert.ok(html.indexOf("npm run build") < html.indexOf("npm test"), html);
  assert.doesNotMatch(html, /<button|<a |role="button"/);
});

test("a task row shows an exit code, meta facts and a shortened id, never a command", () => {
  const html = renderPanel({
    details: data({
      tasks: [item({
        id: "0123456789abcdef",
        name: "npm test",
        status: "failed",
        exitCode: 1,
        startTime: 1_000_000_000,
        endTime: 1_000_030_000,
        model: "anthropic/claude-sonnet-4-5",
        contextUsage: { tokens: 1200, contextWindow: 200_000, percent: 0.6 },
        tokenUsage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1500 },
        toolUsage: { total: 4, failed: 1 },
      }), item({ id: "ok-1", name: "ok" })],
    }),
  });
  assert.match(html, /失败 30秒 · 退出码 1/);
  assert.match(html, /0123456789a…/);
  assert.match(html, /title="0123456789abcdef"/);
  assert.match(html, /anthropic\/claude-sonnet-4-5/);
  assert.match(html, /上下文 1% · 1\.2K \/ 200K/);
  assert.match(html, /Token 1\.2K 入 \/ 300 出/);
  assert.match(html, /工具 4 · 失败 1/);
});

test("an empty host list still shows the panel with 暂无后台任务 and the counts", () => {
  const html = renderPanel({
    details: data({ tasks: [], counts: { total: 0, running: 0, completed: 0, failed: 0, killed: 0 } }),
  });
  assert.match(html, /暂无后台任务/);
  assert.match(html, /共 0 项/);
  assert.doesNotMatch(html, /chat-extension-task-list/);
});

test("a truncated page says how many were left out, and sends no next-page control", () => {
  const html = renderPanel({
    details: data({ hasMore: true, counts: { total: 120, running: 1, completed: 2, failed: 0, killed: 0 } }),
  });
  assert.match(html, /共 120 项，此处显示最近 2 项/);
  assert.doesNotMatch(html, /<button/);
});

test("without a Host the panel keeps the extension's own summary, ANSI kept and HTML escaped", () => {
  const html = renderPanel({ details: null, summary: "\x1b[36m bg 1 running \x1b[0m <b>x</b>" });
  assert.match(html, /chat-extension-overlay-text/);
  assert.match(html, /ansi-.*-fg/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(html, /chat-extension-task-list/);
  assert.equal(renderPanel({ details: null }), "");
});

test("the todo overlay carries its own fixed Chinese title", () => {
  const html = renderOverlays({ todos: todos(["- a"]) });
  assert.match(html, /aria-label="待办事项"/);
  assert.match(html, />待办事项</);
});

test("the rail lists one vertical entry per panel, its count when known", () => {
  assert.deepEqual(railEntries(true, true, 3), [
    { label: "后台任务", count: 3 },
    { label: "待办事项" },
  ]);
  assert.deepEqual(railEntries(true, false), [{ label: "后台任务", count: undefined }]);
  assert.deepEqual(railEntries(false, true), [{ label: "待办事项" }]);
  assert.deepEqual(railEntries(false, false), []);
});

test("without a scroller to measure the panels stay open, never railed", () => {
  const html = renderOverlays({ backgroundTaskText: "1 running", todos: todos(["- a"]) });
  assert.match(html, /class="chat-extension-overlays"/);
  assert.doesNotMatch(html, /chat-extension-overlays-rail/);
  assert.doesNotMatch(html, /chat-extension-rail-item/);
});
