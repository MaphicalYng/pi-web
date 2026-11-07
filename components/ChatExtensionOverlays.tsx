"use client";

import { stripAnsi } from "@/lib/ansi";
import type { ExtensionStatusItem, ExtensionWidgetItem } from "@/lib/types";
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

/**
 * The two live widgets a chat session shows above its composer: background
 * tasks on top, rpiv-todos below. Read-only text through AnsiText, so an
 * extension's ANSI is kept and its HTML is escaped; nothing here sends a
 * command or writes anything back.
 */
export function ChatExtensionOverlays({
  backgroundTaskText,
  todos,
}: {
  backgroundTaskText?: string;
  todos?: ExtensionWidgetItem;
}) {
  if (!backgroundTaskText && !todos) return null;
  // The label and tooltip are plain text: an escape sequence belongs inside
  // AnsiText's rendering, not in what a tooltip or a screen reader reads.
  const backgroundLabel = backgroundTaskText
    ? stripAnsi(backgroundTaskText).replace(/\s+/g, " ").trim()
    : "";

  return (
    <div className="chat-extension-overlays">
      {backgroundTaskText ? (
        <div
          className="chat-extension-overlay"
          data-overlay="background-tasks"
          aria-label={backgroundLabel}
          title={backgroundLabel}
        >
          <AnsiText text={backgroundTaskText} />
        </div>
      ) : null}
      {todos ? (
        <div
          className="chat-extension-overlay chat-extension-overlay-pre"
          data-overlay="rpiv-todos"
        >
          <AnsiText text={todos.lines.join("\n")} />
        </div>
      ) : null}
    </div>
  );
}
