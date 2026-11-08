"use client";

import { useCallback, useRef, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import {
  TERMINAL_DOCK_HEIGHT_KEY,
  TERMINAL_DOCK_MIN_HEIGHT,
  terminalDockDefaultHeight,
  terminalDockMaxHeight,
} from "@/lib/terminal-dock";
import { TerminalPanel } from "./TerminalPanel";
import type { TerminalTab } from "./terminal-tab-state";

interface Props {
  tab: TerminalTab;
  open: boolean;
  /** The chat column's height in px: the dock's default (35%) and limit (85%) come from it. */
  getAvailableHeight: () => number;
  /** Collapse the dock without touching the shell. */
  onHide: () => void;
  /** End the shell: the dock forgets the tab once the PTY is gone. */
  onTerminate: () => void;
  onRestart: () => void;
  onClosed: () => void;
  onCloseError: () => void;
  /** The reader typed `exit`: the pane goes away, and the next Ctrl+` runs a new shell. */
  onExit: () => void;
}

/**
 * The bottom terminal (`Ctrl+``): a shell under the composer, above the
 * extension shelf, with the panel's own header. Hidden, it stays mounted so the
 * shell, its scrollback and its stream survive a collapse; its height is the
 * reader's, dragged from its top edge and kept per browser.
 */
export function TerminalDock({ tab, open, getAvailableHeight, onHide, onTerminate, onRestart, onClosed, onCloseError, onExit }: Props) {
  const { t } = useI18n();
  const heightRef = useRef(0);

  // Read once: the restore below measures the chat column right after mount,
  // and a default read on every render would force a layout each time.
  const initialHeight = useRef(terminalDockDefaultHeight(getAvailableHeight()));

  const defaultHeight = useCallback(() => terminalDockDefaultHeight(getAvailableHeight()), [getAvailableHeight]);
  const maxHeight = useCallback(() => terminalDockMaxHeight(getAvailableHeight()), [getAvailableHeight]);

  const { isResizing, panelRef, separatorProps, width } = useResizablePanel({
    ariaLabel: t("terminal.dockResize"),
    axis: "vertical",
    cssVariable: "--terminal-dock-height",
    defaultWidth: initialHeight.current,
    getDefaultWidth: defaultHeight,
    getMaxWidth: maxHeight,
    // The top edge is the handle: dragging it up grows the panel.
    growthDirection: "up",
    maxWidth: 4000,
    minWidth: TERMINAL_DOCK_MIN_HEIGHT,
    storageKey: TERMINAL_DOCK_HEIGHT_KEY,
    widthRef: heightRef,
  });

  return (
    <div
      ref={panelRef}
      className="terminal-dock"
      // Hidden rather than unmounted: `display` keeps the panel's own layout, and
      // xterm refits from its ResizeObserver when the dock gets its height back.
      style={{
        "--terminal-dock-height": `${width}px`,
        display: open ? "flex" : "none",
      } as CSSProperties}
      data-resizing={isResizing ? "true" : undefined}
    >
      <div
        {...separatorProps}
        className={`terminal-dock-resize-handle${isResizing ? " is-resizing" : ""}`}
      />
      <div className="terminal-dock-body">
        <TerminalPanel
          tab={tab}
          active={open}
          onRestart={onRestart}
          onClosed={onClosed}
          onCloseError={onCloseError}
          onHide={onHide}
          onTerminate={onTerminate}
          onExit={onExit}
        />
      </div>
    </div>
  );
}
