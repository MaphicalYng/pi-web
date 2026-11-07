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
  // The tooltip and accessible name carry the text, not its escape sequences.
  assert.match(html, /aria-label="bg 1 running"/);
  assert.match(html, /title="bg 1 running"/);

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
    assert.doesNotMatch(source, /<button|<input|<select/);
    assert.doesNotMatch(source, /onClick|onChange|onSubmit/);
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  }

  // The branch label's data path reads the branch; it must never write Git.
  const changes = await readFile(new URL("../lib/git-changes.ts", import.meta.url), "utf8");
  assert.doesNotMatch(changes, /"(?:checkout|switch|reset|merge|rebase|stash)"/);
});
