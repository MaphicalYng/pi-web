export interface TerminalTab {
  id: string;
  cwd: string;
  restored?: boolean;
  closing?: "close" | "restart";
}

export const TERMINAL_TABS_KEY = "pi-web:terminal-tabs";
/** The `Ctrl+`` bottom dock's shell and whether it was open, in this tab. */
export const TERMINAL_DOCK_KEY = "pi-web:terminal-dock";

export function newTerminalTab(cwd: string): TerminalTab {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { id, cwd };
}

export function restoreTerminalTabs(raw: string | null): { tabs: TerminalTab[]; activeId: string | null; open: boolean } {
  try {
    const saved = JSON.parse(raw ?? "null");
    const tabs: TerminalTab[] = [];
    for (const tab of Array.isArray(saved?.tabs) ? saved.tabs : []) {
      if (tab && typeof tab.id === "string" && /^[a-f0-9]{32}$/.test(tab.id)
        && typeof tab.cwd === "string" && tab.cwd.trim()
        && !tabs.some((existing) => existing.id === tab.id || existing.cwd === tab.cwd)) {
        tabs.push({ id: tab.id, cwd: tab.cwd, restored: true });
      }
    }
    return { tabs, activeId: tabs.some((tab) => tab.id === saved.activeId) ? saved.activeId : null, open: saved?.open === true };
  } catch {
    return { tabs: [], activeId: null, open: false };
  }
}

export interface TerminalDockState {
  tab: TerminalTab | null;
  open: boolean;
}

/**
 * The bottom dock's saved shell and its open state. The dock keeps one shell
 * per page (its own, apart from the right panel's tabs), so a reload reattaches
 * to that PTY instead of starting a second one.
 */
export function restoreTerminalDock(raw: string | null): TerminalDockState {
  const saved = restoreTerminalTabs(raw);
  const tab = saved.tabs[0] ?? null;
  return { tab, open: tab !== null && saved.open };
}

export function serializeTerminalDock(tab: TerminalTab | null, open: boolean): string {
  return JSON.stringify({
    tabs: tab ? [{ id: tab.id, cwd: tab.cwd }] : [],
    activeId: tab?.id ?? null,
    open,
  });
}
