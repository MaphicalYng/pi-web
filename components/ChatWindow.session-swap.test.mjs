import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";
import { SESSION_SWAP_MS } from "../hooks/useSessionSwap.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [hookFile, chatFile, shellFile, globals] = await Promise.all([
  read("../hooks/useSessionSwap.ts"),
  read("./ChatWindow.tsx"),
  read("./AppShell.tsx"),
  read("../app/globals.css"),
]);

function parse(name, text, kind) {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, kind);
  const nodes = [];
  (function visit(node) { nodes.push(node); ts.forEachChild(node, visit); })(source);
  return { source, nodes };
}
const chat = parse("ChatWindow.tsx", chatFile, ts.ScriptKind.TSX);
const compile = ({ source }, node) => new Script(ts.transpileModule(`(${node.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);

// The effect that settles the switch once the transcript is on screen.
const settleNode = chat.nodes.find((node) => ts.isCallExpression(node)
  && node.expression.getText(chat.source) === "useEffect"
  && node.arguments[0].getText(chat.source).includes("onSwapSettled?.()"));
assert.ok(settleNode, "missing the effect that settles the switch");
const settleEffect = compile(chat, settleNode.arguments[0]);

// Runs the effect with the given chat state; timers are recorded, not run.
function run({ swapping = true, transcriptVisible = true, isEmptyNew = false, error = null } = {}) {
  const calls = { settled: 0, timers: [], cleared: [] };
  let timerId = 0;
  const context = createContext({
    swapping, transcriptVisible, isEmptyNew, error,
    onSwapSettled: () => { calls.settled += 1; },
    setTimeout: (callback, delay) => { timerId += 1; calls.timers.push({ id: timerId, delay, callback }); return timerId; },
    clearTimeout: (id) => { calls.cleared.push(id); },
    SESSION_SWAP_MS,
  });
  const cleanup = settleEffect.runInContext(context)();
  return { calls, cleanup: typeof cleanup === "function" ? cleanup : null };
}

test("a session still loading keeps the flag armed and starts nothing", () => {
  // The two regressions this replaced, both invisible in the browser: a timer
  // started at the click expired during the loading screen, and a timer started
  // when loading cleared ran while the scroll restore still hid the transcript.
  // Either way only the tail of the animation landed on screen.
  const { calls } = run({ transcriptVisible: false });
  assert.equal(calls.settled, 0);
  assert.deepEqual(calls.timers, []);
});

test("once the transcript is visible, the flag settles one animation later", () => {
  const { calls, cleanup } = run();
  assert.equal(calls.settled, 0);
  assert.equal(calls.timers.length, 1);
  assert.equal(calls.timers[0].delay, SESSION_SWAP_MS);
  calls.timers[0].callback();
  assert.equal(calls.settled, 1);
  assert.ok(cleanup, "the effect must clean up its timer");
  cleanup();
  assert.deepEqual(calls.cleared, [calls.timers[0].id]);
});

test("a fresh composer and an error settle at once - there is nothing to fade in", () => {
  assert.equal(run({ isEmptyNew: true }).calls.settled, 1);
  assert.equal(run({ error: { message: "boom" } }).calls.settled, 1);
});

test("an unarmed chat does nothing", () => {
  const { calls } = run({ swapping: false });
  assert.equal(calls.settled, 0);
  assert.deepEqual(calls.timers, []);
});

test("one condition drives both the class and the timer", () => {
  // Two separate conditions is exactly how the animation came to start while the
  // transcript was still hidden. Visibility means all four at once.
  const visible = chatFile.match(/const transcriptVisible = ([^;]+);/);
  assert.ok(visible, "missing transcriptVisible");
  assert.match(visible[1], /!loading/);
  assert.match(visible[1], /!pendingScrollRestore/);
  assert.match(visible[1], /!isEmptyNew/);
  assert.match(visible[1], /!error/);
  assert.match(chatFile, /\$\{swapping && transcriptVisible \? " is-swapping" : ""\}/);
  assert.match(chatFile, /if \(!transcriptVisible\) return;/);
});

test("AppShell arms a switch, never a restore, and hands the chat the settlement", () => {
  const start = shellFile.indexOf("const handleSelectSession = useCallback(");
  assert.ok(start > 0, "missing handleSelectSession");
  const end = shellFile.indexOf("}, [activeCwd, changeFileWorkspace", start);
  const handler = shellFile.slice(start, end > start ? end : start + 4000);
  const announceAt = handler.indexOf("if (!isRestore) announceSessionSwap();");
  const bumpAt = handler.indexOf("setSessionKey((k) => k + 1);");
  assert.ok(announceAt > 0, "the switch must arm the fade");
  assert.ok(bumpAt > announceAt, "the flag must be armed before the chat remounts, or its first paint misses it");
  // A re-click on the open session returns before either line.
  const reClickAt = handler.indexOf("selectedSession.id === session.id && sameProject");
  assert.ok(reClickAt > 0 && reClickAt < announceAt, "a re-click must not fade");
  assert.match(shellFile, /swapping=\{sessionSwapping\}\s+onSwapSettled=\{settleSessionSwap\}/);
});

test("the flag is not timed where it is armed - only the chat knows when it can start", () => {
  assert.doesNotMatch(hookFile, /setTimeout|clearTimeout/);
  assert.match(hookFile, /const settle = useCallback\(\(\) => setSwapping\(false\), \[\]\);/);
});

test("the transcript arrives from nothing, on the inner wrapper rather than the scroller", () => {
  const rule = globals.match(/\.chat-transcript\.is-swapping \.chat-transcript-inner \{\n  animation: chat-transcript-in (\d+)ms var\(--ease-out\);\n\}/);
  assert.ok(rule, "the transcript entrance rule");
  assert.equal(Number(rule[1]), SESSION_SWAP_MS);
  const frames = globals.match(/@keyframes chat-transcript-in \{([\s\S]*?)\n\}/)[1];
  // From 0: the placeholder already emptied the panel, so this is content
  // arriving, not two texts crossfading.
  assert.match(frames, /opacity: 0;/);
  assert.match(frames, /transform: translateY\(12px\);/);
  // A transform on the scroll container would become the containing block for
  // its sticky children, so the entrance belongs to the wrapper inside it.
  assert.match(chatFile, /className="chat-transcript-inner"/);
  assert.doesNotMatch(globals, /\.chat-transcript\.is-swapping \{\n  animation/);
});

test("the loading placeholder fades in and pulses, and nothing else", () => {
  assert.match(globals, /\.chat-loading \{\n  animation: chat-loading-in 140ms var\(--ease-out\);\n\}/);
  assert.match(globals, /\.chat-loading-text \{\n  color: var\(--text-muted\);\n  animation: chat-loading-pulse 1\.6s var\(--ease-in-out\) infinite;\n\}/);
  // 0.55 is the floor pi's running indicator uses: visible as motion without
  // turning into a blink on a slow load.
  const pulse = globals.match(/@keyframes chat-loading-pulse \{([\s\S]*?)\n\}/)[1];
  assert.match(pulse, /0%, 100% \{ opacity: 0\.55; \}/);
  assert.match(pulse, /50%      \{ opacity: 1; \}/);
  assert.match(chatFile, /className="chat-loading-text"/);
});

test("reduced motion keeps the placeholder legible and drops every entrance", () => {
  assert.match(globals, /@media \(prefers-reduced-motion: reduce\) \{\n  \.chat-transcript\.is-swapping \.chat-transcript-inner,\n  \.chat-loading,\n  \.chat-loading-text \{\n    animation: none;\n  \}\n\}/);
});
