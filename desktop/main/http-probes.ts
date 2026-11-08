/**
 * Bounded HTTP helpers for the shell. Every request has an AbortSignal deadline
 * and consumes or cancels its body: headers alone never prove that Next has rendered.
 */
import { FIRST_PAGE_MAX_BYTES, FIRST_PAGE_TIMEOUT_MS } from "./constants";
import { isAllowedBackendUrl } from "../shared/urls";
import { nodeTimers, type TimerLike, type TimerToken } from "../shared/timers";

export interface ResponseBodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock?(): void;
}

export interface ReadableBodyLike {
  getReader(): ResponseBodyReader;
}

export interface HttpResponseLike {
  readonly status: number;
  readonly ok: boolean;
  readonly url: string;
  readonly headers?: { get(name: string): string | null };
  readonly body?: ReadableBodyLike | null;
  text(): Promise<string>;
}

export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  redirect?: "follow" | "manual" | "error";
  credentials?: "include" | "omit" | "same-origin";
  cache?: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init?: FetchInitLike) => Promise<HttpResponseLike>;

/** Opaque timer handle; only clearTimeout(handle) touches it. */
export type { TimerLike, TimerToken };

const realTimers: TimerLike = nodeTimers;

export interface TimeoutSignal {
  signal: AbortSignal;
  timedOut(): boolean;
  cancel(): void;
}

export function createTimeoutSignal(ms: number, timer: TimerLike = realTimers): TimeoutSignal {
  const controller = new AbortController();
  let timeoutHandle: TimerToken | null = null;
  let expired = false;
  timeoutHandle = timer.setTimeout(() => {
    expired = true;
    controller.abort();
  }, ms);
  return {
    signal: controller.signal,
    timedOut: () => expired,
    cancel: () => {
      if (timeoutHandle !== null) {
        timer.clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    },
  };
}

/** True when the HTML is Pi Web's own page (the password login page included). */
export function isPiWebHtml(html: string): boolean {
  if (typeof html !== "string" || html.length === 0) return false;
  if (/<title>\s*Pi\s*Web\s*<\/title>/i.test(html)) return true;
  return /Pi\s*Web/.test(html) && /\/_next\/static\//.test(html);
}

export type PageFailure = "network" | "timeout" | "http-status" | "redirect" | "not-pi-web" | "body";

export interface PageProbeResult {
  ok: boolean;
  /** Any HTTP response proves something listens on the port. */
  reachable: boolean;
  status?: number;
  failure?: PageFailure;
  finalUrl?: string;
}

export interface PageProbeOptions {
  fetch: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
  timer?: TimerLike;
}

async function readBoundedText(response: HttpResponseLike, maxBytes: number): Promise<string> {
  const body = response.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let text = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value = chunk.value;
        if (!value) continue;
        received += value.byteLength;
        text += decoder.decode(value, { stream: true });
        if (received >= maxBytes) {
          await reader.cancel();
          break;
        }
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock?.();
    }
    return text.slice(0, maxBytes);
  }
  const text = await response.text();
  return text.slice(0, maxBytes);
}

/**
 * Loads the page root, follows redirects but refuses to leave the backend
 * origin, requires a successful HTML response and a complete bounded body.
 */
export async function probeFirstPage(origin: string, options: PageProbeOptions): Promise<PageProbeResult> {
  const timeoutMs = options.timeoutMs ?? FIRST_PAGE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? FIRST_PAGE_MAX_BYTES;
  const timeout = createTimeoutSignal(timeoutMs, options.timer);
  try {
    let response: HttpResponseLike;
    try {
      response = await options.fetch(`${origin}/`, {
        method: "GET",
        redirect: "follow",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "text/html,application/xhtml+xml" },
        signal: timeout.signal,
      });
    } catch {
      return { ok: false, reachable: false, failure: timeout.timedOut() ? "timeout" : "network" };
    }

    const finalUrl = typeof response.url === "string" && response.url.length > 0 ? response.url : `${origin}/`;
    if (!isAllowedBackendUrl(finalUrl, origin)) {
      await response.body?.getReader().cancel().catch(() => undefined);
      return { ok: false, reachable: true, status: response.status, failure: "redirect", finalUrl };
    }
    if (!response.ok) {
      await response.body?.getReader().cancel().catch(() => undefined);
      return { ok: false, reachable: true, status: response.status, failure: "http-status", finalUrl };
    }
    const contentType = response.headers?.get("content-type");
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      await response.body?.getReader().cancel().catch(() => undefined);
      return { ok: false, reachable: true, status: response.status, failure: "not-pi-web", finalUrl };
    }
    let html: string;
    try {
      html = await readBoundedText(response, maxBytes);
    } catch {
      return { ok: false, reachable: true, status: response.status, failure: "body", finalUrl };
    }
    if (!isPiWebHtml(html)) {
      return { ok: false, reachable: true, status: response.status, failure: "not-pi-web", finalUrl };
    }
    return { ok: true, reachable: true, status: response.status, finalUrl };
  } finally {
    timeout.cancel();
  }
}

export interface DevelopmentProbeResult {
  reachable: boolean;
  isPiWeb: boolean;
  result: PageProbeResult;
}

export async function probeDevelopmentServer(origin: string, options: PageProbeOptions): Promise<DevelopmentProbeResult> {
  const result = await probeFirstPage(origin, options);
  return { reachable: result.reachable, isPiWeb: result.ok, result };
}
