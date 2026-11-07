import { NextResponse } from "next/server";
import {
  isBackgroundTaskHostUnavailable,
  readBackgroundTaskOverlayData,
} from "@/lib/background-task-host-client";
import type { BackgroundTaskOverlayResponse } from "@/lib/background-task-host-types";
import { getRpcSession } from "@/lib/rpc-manager";

// GET /api/agent/[id]/background-tasks - the chat's background-task panel: the
// task list a session's pi-background-tasks Host API reports, read-only.
//
// Nothing is started and nothing is written: one `list` on the session's existing
// lease asks for the newest page, and the answer is reduced to the fields the panel
// shows (lib/background-task-host-client.ts). `available: false` is the honest
// answer whenever no detail source is there - the plugin is not installed, this
// build's own extension was not loaded, or the host did not answer in time - and
// the panel then keeps the extension's own summary line.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const unavailable: BackgroundTaskOverlayResponse = { available: false };
  const session = getRpcSession(id);
  // A wrapper built before a hot reload lacks the accessor; a dead one has no host.
  if (!session?.isAlive() || typeof session.getBackgroundTaskHostClient !== "function") {
    return json(unavailable);
  }
  const client = session.getBackgroundTaskHostClient();
  if (!client) return json(unavailable);
  try {
    return json(readBackgroundTaskOverlayData(await client.listTasks()));
  } catch (error) {
    // The panel's own request: its failure is an expected answer, not a server error.
    const message = error instanceof Error ? error.message : String(error);
    if (!isBackgroundTaskHostUnavailable(error)) {
      console.error("[pi-web] background task list failed:", message);
    }
    return json(unavailable);
  }
}

function json(body: BackgroundTaskOverlayResponse): NextResponse {
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
