"use client";

import { useEffect, useRef, useState } from "react";
import { stripAnsi } from "@/lib/ansi";
import {
  formatRefreshTime,
  formatTaskCounts,
  formatTruncation,
  sortTaskItems,
  taskMetaSegments,
  taskStatusLabel,
} from "@/lib/background-task-display";
import type { BackgroundTaskOverlayData, BackgroundTaskOverlayItem } from "@/lib/background-task-host-types";
import type { ExtensionStatusItem, ExtensionWidgetItem } from "@/lib/types";
import { useBackgroundTaskList } from "@/hooks/useBackgroundTaskList";
import { useOverlayObscuresContent } from "@/hooks/useOverlayObscuresContent";
import { AnsiText } from "./AnsiText";
import { sanitizeExtensionStatusText } from "./ExtensionStatusBar";

/** The status key pi-background-tasks reports its task summary under. */
export const BACKGROUND_TASKS_STATUS_KEY = "background-tasks";
/** The widget key rpiv-todos reports its above-editor todo list under. */
export const TODOS_WIDGET_KEY = "rpiv-todos";

/**
 * A task summary carries a count and what it counts, as pi-background-tasks
 * writes it: "1 running", "0 running · 2 failed · 3 done". A lone "a new
 * version is available" has no such count and is deliberately not a task
 * summary, so it produces no overlay (fail closed: a future wording we do not
 * know hides the panel instead of showing an update notice as a task).
 */
const TASK_SUMMARY_RE = /(?:^|\s)\d+\s+(?:running|failed|stopped|done)(?=\s|$)/;

export interface ChatOverlaySelection {
  /** The background-task summary to show, when the status is an actual task report. */
  backgroundTaskText?: string;
  /** The rpiv-todos widget, when it asks to sit above the editor and has visible lines. */
  todos?: ExtensionWidgetItem;
  /** The statuses the shelf keeps: the background-task status is always taken out, visible or not. */
  remainingStatuses: ExtensionStatusItem[];
  /** The widgets the shelf keeps: rpiv-todos is always taken out, whatever its placement. */
  remainingWidgets: ExtensionWidgetItem[];
}

function hasVisibleLines(lines: string[]): boolean {
  return lines.some((line) => stripAnsi(line).trim().length > 0);
}

/**
 * Splits the extension surfaces into the two read-only overlays (a task
 * summary, the todo list) and what the extension status shelf still renders.
 * The target keys are removed from the shelf either way, so a hidden target
 * neither duplicates nor falls back to its old footer slot.
 */
export function selectChatOverlays(
  statuses: ExtensionStatusItem[],
  widgets: ExtensionWidgetItem[],
): ChatOverlaySelection {
  const backgroundStatus = statuses.find((item) => item.key === BACKGROUND_TASKS_STATUS_KEY);
  const backgroundText = backgroundStatus ? sanitizeExtensionStatusText(backgroundStatus.text) : "";
  const todosWidget = widgets.find((item) => item.key === TODOS_WIDGET_KEY);
  const visibleTodos = todosWidget
    && todosWidget.placement === "aboveEditor"
    && hasVisibleLines(todosWidget.lines)
    ? todosWidget
    : undefined;

  return {
    backgroundTaskText: TASK_SUMMARY_RE.test(stripAnsi(backgroundText)) ? backgroundText : undefined,
    todos: visibleTodos,
    remainingStatuses: statuses.filter((item) => item.key !== BACKGROUND_TASKS_STATUS_KEY),
    remainingWidgets: widgets.filter((item) => item.key !== TODOS_WIDGET_KEY),
  };
}

/** A task's id, short enough for a one-line row; the full id stays in the tooltip. */
function compactTaskId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 11)}…`;
}

function TaskRow({ item, now }: { item: BackgroundTaskOverlayItem; now: number }) {
  const meta = taskMetaSegments(item);
  const metaLine = meta.join(" · ");
  return (
    <li className="chat-extension-task" data-status={item.status}>
      <span className="chat-extension-task-line">
        <span className={`chat-extension-task-status chat-extension-task-status-${item.status}`}>
          {taskStatusLabel(item, now)}
        </span>
        <span className="chat-extension-task-name" title={item.name}>{item.name}</span>
        {item.exitCode === undefined || item.status === "running" ? null : (
          <span className="chat-extension-task-exit">退出码 {item.exitCode}</span>
        )}
        <span className="chat-extension-task-id" title={item.id}>{compactTaskId(item.id)}</span>
      </span>
      {metaLine.length > 0 ? (
        <span className="chat-extension-task-meta" title={metaLine}>{metaLine}</span>
      ) : null}
    </li>
  );
}

/**
 * One task list, as the panel draws it: counts, rows, the truncation line, and
 * the extension's own summary as the fallback text when no Host answered.
 * Presentational only, so a test can render it without a running session.
 */
export function BackgroundTasksPanel({
  details,
  summary,
}: {
  details: BackgroundTaskOverlayData | null;
  summary?: string;
}) {
  if (!details) {
    return summary ? (
      <div className="chat-extension-overlay-text">
        <AnsiText text={summary} />
      </div>
    ) : null;
  }
  const tasks = sortTaskItems(details.tasks);
  return (
    <>
      <div className="chat-extension-task-counts">
        <span>{formatTaskCounts(details.counts)}</span>
        <span className="chat-extension-task-refresh">{formatRefreshTime(details.observedAt)}</span>
      </div>
      {tasks.length === 0 ? (
        <div className="chat-extension-task-empty">暂无后台任务</div>
      ) : (
        <ul className="chat-extension-task-list">
          {tasks.map((item) => <TaskRow key={item.id} item={item} now={details.observedAt} />)}
        </ul>
      )}
      {details.hasMore ? (
        <div className="chat-extension-task-more">{formatTruncation(details)}</div>
      ) : null}
    </>
  );
}

/** How far left of the open panel the rail's area still counts as hovering it. */
const RAIL_HOT_ZONE_WIDTH = 28;
/** How far outside the panel the pointer may stray before the panel rails again. */
const POINTER_SLOP = 8;

/** One railed overlay's label: the panel's title, vertical beside the chat column. */
export interface RailEntry {
  label: string;
  count?: number;
}

/**
 * What the narrow rail shows while the open panel would cover messages:
 * one vertical entry per panel, the count folded into the label when known.
 */
export function railEntries(
  showBackground: boolean,
  todos: boolean,
  taskCount?: number,
): RailEntry[] {
  const entries: RailEntry[] = [];
  if (showBackground) entries.push({ label: "后台任务", count: taskCount });
  if (todos) entries.push({ label: "待办事项" });
  return entries;
}

/**
 * The two live widgets a chat session shows above its composer: background
 * tasks on top, rpiv-todos below. Read-only text through AnsiText, so an
 * extension's ANSI is kept and its HTML is escaped; nothing here sends a
 * command or writes anything back.
 *
 * The background panel adds the session's task list when the Host API answers
 * (GET /api/agent/[id]/background-tasks, refreshed every 2 s while visible);
 * without it the extension's own summary line stands alone, exactly as before.
 */
export function ChatExtensionOverlays({
  backgroundTaskText,
  todos,
  sessionId,
  scrollRootRef,
  messageColumnRef,
}: {
  backgroundTaskText?: string;
  todos?: ExtensionWidgetItem;
  /** The session whose task list is shown; a read-only request, never a command. */
  sessionId?: string;
  /** The chat scroller the overlay may cover; omitted means "never rail". */
  scrollRootRef?: React.RefObject<HTMLElement | null>;
  /** The centred column the messages are laid out in, so the panel is measured
      against the text's own width rather than the whole chat column. */
  messageColumnRef?: React.RefObject<HTMLElement | null>;
}) {
  const details = useBackgroundTaskList(sessionId, Boolean(backgroundTaskText));
  // The label and tooltip are plain text: an escape sequence belongs inside
  // AnsiText's rendering, not in what a tooltip or a screen reader reads.
  const backgroundLabel = backgroundTaskText
    ? stripAnsi(backgroundTaskText).replace(/\s+/g, " ").trim()
    : "";
  const showBackground = Boolean(backgroundTaskText) || details !== null;
  const hasOverlays = showBackground || Boolean(todos);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // A mouse over the rail (or keyboard focus on it) opens the panel again; a
  // touch opens it by tapping the rail, and tapping the panel's close button or
  // anywhere outside closes it. Either way the panel rails again as soon as
  // something still covers content and no one is looking at it.
  const [railHovered, setRailHovered] = useState(false);
  const [railPinned, setRailPinned] = useState(false);
  // The previous render's answer to "is the rail showing": the measurement needs
  // it to know whether the box on screen is the panel or the strip, and the
  // strip's own state is derived from that measurement.
  const railedRef = useRef(false);
  const coversContent = useOverlayObscuresContent(
    wrapperRef,
    scrollRootRef,
    hasOverlays,
    railedRef.current,
    messageColumnRef,
  );
  const railed = coversContent && !railHovered && !railPinned;
  railedRef.current = railed;

  useEffect(() => {
    if (!railPinned) return;
    const onPointerDown = (event: PointerEvent) => {
      const wrapper = wrapperRef.current;
      if (wrapper && event.target instanceof Node && wrapper.contains(event.target)) return;
      setRailPinned(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [railPinned]);

  // Opening from the rail swaps the strip for the wider panel under a pointer
  // that never entered it: no leave event will arrive, so a pointer sweep is
  // what closes the panel again. The strip's width is added on the left, since
  // the panel opens to the right of where the rail was.
  useEffect(() => {
    if (!railHovered || railPinned) return;
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const inside = event.clientX >= rect.left - RAIL_HOT_ZONE_WIDTH
        && event.clientX <= rect.right + POINTER_SLOP
        && event.clientY >= rect.top - POINTER_SLOP
        && event.clientY <= rect.bottom + POINTER_SLOP;
      if (!inside) setRailHovered(false);
    };
    document.addEventListener("pointermove", onPointerMove, true);
    return () => document.removeEventListener("pointermove", onPointerMove, true);
  }, [railHovered, railPinned]);

  if (!hasOverlays) return null;

  const hoverHandlers = railPinned ? {} : {
    onPointerEnter: (event: React.PointerEvent) => {
      if (event.pointerType === "mouse") setRailHovered(true);
    },
    onPointerLeave: (event: React.PointerEvent) => {
      if (event.pointerType === "mouse") setRailHovered(false);
    },
    onFocus: () => setRailHovered(true),
    onBlur: (event: React.FocusEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setRailHovered(false);
    },
  };

  if (railed) {
    const entries = railEntries(showBackground, Boolean(todos), details?.tasks.length);
    return (
      <div ref={wrapperRef} className="chat-extension-overlays chat-extension-overlays-rail">
        <button
          type="button"
          className="chat-extension-rail"
          aria-expanded={false}
          aria-label={entries.map((entry) => entry.label).join("、")}
          title="展开浮窗"
          onClick={() => setRailPinned(true)}
          onPointerEnter={hoverHandlers.onPointerEnter}
          onPointerLeave={hoverHandlers.onPointerLeave}
          onFocus={hoverHandlers.onFocus}
          onBlur={hoverHandlers.onBlur}
        >
          {entries.map((entry) => (
            <span key={entry.label} className="chat-extension-rail-item">
              {entry.label}
              {entry.count === undefined ? null : (
                <span className="chat-extension-rail-count">{entry.count}</span>
              )}
            </span>
          ))}
        </button>
      </div>
    );
  }

  return (
    <div
      ref={wrapperRef}
      className="chat-extension-overlays"
      onPointerEnter={hoverHandlers.onPointerEnter}
      onPointerLeave={hoverHandlers.onPointerLeave}
      onFocus={hoverHandlers.onFocus}
      onBlur={hoverHandlers.onBlur}
    >
      {railPinned ? (
        <button
          type="button"
          className="chat-extension-overlay-close"
          aria-label="收起浮窗"
          title="收起浮窗"
          onClick={() => setRailPinned(false)}
        >
          ×
        </button>
      ) : null}
      {showBackground ? (
        <section
          className="chat-extension-overlay"
          data-overlay="background-tasks"
          aria-label="后台任务"
          title={backgroundLabel || "后台任务"}
        >
          <div className="chat-extension-overlay-title">后台任务</div>
          <BackgroundTasksPanel details={details} summary={backgroundTaskText} />
        </section>
      ) : null}
      {todos ? (
        <section
          className="chat-extension-overlay chat-extension-overlay-pre"
          data-overlay="rpiv-todos"
          aria-label="待办事项"
        >
          <div className="chat-extension-overlay-title">待办事项</div>
          <AnsiText text={todos.lines.join("\n")} />
        </section>
      ) : null}
    </div>
  );
}
