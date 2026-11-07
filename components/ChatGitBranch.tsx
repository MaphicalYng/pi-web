"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { GitStatusResponse } from "@/lib/git-types";

/**
 * The session's current Git branch, read-only: a label, never a picker. It is
 * read once per cwd (and again when a run starts or ends, or the window comes
 * back into focus, which is when a branch switched in a terminal shows up).
 * A non-repository, a detached HEAD, a refused cwd and a failed request all
 * render nothing, so the row never guesses or keeps a previous project's name.
 */
export function ChatGitBranch({ cwd, refreshKey }: { cwd?: string; refreshKey?: boolean | number }) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<{ cwd: string; branch: string | null } | null>(null);

  useEffect(() => {
    if (!cwd) {
      setLoaded(null);
      return;
    }
    let disposed = false;
    let latest = 0;
    let controller: AbortController | null = null;

    const load = () => {
      const id = ++latest;
      controller?.abort();
      const active = new AbortController();
      controller = active;
      void (async () => {
        let branch: string | null = null;
        try {
          const params = new URLSearchParams({ cwd });
          const res = await fetch(`/api/git/status?${params.toString()}`, { signal: active.signal });
          if (!res.ok) throw new Error(`Failed to load Git status (HTTP ${res.status})`);
          const status = await res.json() as GitStatusResponse;
          branch = status.isGitRepository ? status.branch : null;
        } catch {
          branch = null;
        }
        // A response that arrives after a newer one, or after the cwd changed,
        // belongs to a branch nobody is looking at any more.
        if (disposed || id !== latest) return;
        setLoaded({ cwd, branch });
      })();
    };

    load();
    const loadWhenVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    // No polling and no file watch: a branch changed elsewhere is picked up the
    // next time the operator comes back to this window.
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", loadWhenVisible);
    return () => {
      disposed = true;
      controller?.abort();
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", loadWhenVisible);
    };
  }, [cwd, refreshKey]);

  // While another cwd's answer is loading, its branch stays hidden rather than
  // showing the project the operator just left.
  if (!cwd || loaded?.cwd !== cwd || !loaded.branch) return null;

  return (
    <div className="chat-git-branch-row">
      <div
        className="chat-git-branch"
        title={loaded.branch}
        aria-label={`${t("session.gitBranch")}: ${loaded.branch}`}
      >
        <svg
          className="chat-git-branch-icon"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="4.5" cy="3.5" r="1.6" />
          <circle cx="4.5" cy="12.5" r="1.6" />
          <circle cx="11.5" cy="5.5" r="1.6" />
          <path d="M4.5 5.1v5.8M9.9 6.2c-1.6 1-3.4 1.2-5.4 1.2" />
        </svg>
        <span className="chat-git-branch-name">{loaded.branch}</span>
      </div>
    </div>
  );
}
