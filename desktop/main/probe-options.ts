/**
 * Probe budgets for the two different surfaces. The production first page gets
 * the full 30 s start-up budget (a cold Next boot can be slow), while the dev
 * port identity check stays a quick 2 s look. Keeping these in one module makes
 * the distinction testable without importing Electron.
 */
import { DEV_PROBE_TIMEOUT_MS, FIRST_PAGE_TIMEOUT_MS } from "./constants";
import type { FetchLike, PageProbeOptions } from "./http-probes";

export function firstPageProbeOptions(fetch: FetchLike): PageProbeOptions {
  return { fetch, timeoutMs: FIRST_PAGE_TIMEOUT_MS };
}

export function developmentProbeOptions(fetch: FetchLike): PageProbeOptions {
  return { fetch, timeoutMs: DEV_PROBE_TIMEOUT_MS };
}
