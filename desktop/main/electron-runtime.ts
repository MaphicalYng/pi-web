/**
 * The one place that loads Electron. The shell's modules are typed against the
 * narrow interfaces below (the same shapes they inject in tests), so no other
 * file imports `electron` and nothing here pulls pi's SDK into the main process.
 *
 * `require("electron")` resolves only inside an Electron main process; the
 * packaging module supplies the runtime dependency and its type declarations.
 */
import { createRequire } from "node:module";

import type { UtilityChildLike } from "./backend-supervisor";
import type { FetchLike } from "./http-probes";
import type { MenuModuleLike } from "./menu";
import type { BrowserWindowLike, CookieStoreLike, DialogLike, WindowOptionsLike } from "./window-manager";
import type { Logger } from "./logger";
import type { SessionLike } from "./navigation";

export interface ElectronDialogLike extends DialogLike {
  showErrorBox(title: string, content: string): void;
}

export interface ElectronAppLike {
  readonly isPackaged: boolean;
  requestSingleInstanceLock(): boolean;
  whenReady(): Promise<void>;
  quit(): void;
  exit(code?: number): void;
  getPath(name: string): string;
  getAppPath(): string;
  getVersion(): string;
  on(event: string, listener: (...args: never[]) => void): void;
}

export interface ElectronSpawnOptionsLike {
  cwd: string;
  env: Record<string, string>;
  serviceName: string;
  stdio: "pipe";
}

export interface ElectronUtilityProcessLike {
  fork(entry: string, args: readonly string[], options: ElectronSpawnOptionsLike): UtilityChildLike;
}

export interface ElectronShellLike {
  openExternal(url: string): Promise<void>;
  openPath(target: string): Promise<string>;
}

export interface ElectronSessionModuleLike {
  readonly defaultSession: { readonly cookies: CookieStoreLike } & SessionLike;
}

export interface ElectronBrowserWindowModuleLike {
  new (options: WindowOptionsLike): BrowserWindowLike;
}

export interface ElectronApi {
  readonly app: ElectronAppLike;
  readonly BrowserWindow: ElectronBrowserWindowModuleLike;
  readonly dialog: ElectronDialogLike;
  readonly Menu: MenuModuleLike;
  readonly net: { fetch: FetchLike };
  readonly session: ElectronSessionModuleLike;
  readonly shell: ElectronShellLike;
  readonly utilityProcess: ElectronUtilityProcessLike;
}

/** Loaded lazily so importing a controller module never requires Electron. */
export function loadElectron(): ElectronApi {
  // SAFETY: this process is Electron's main process; `electron` resolves to the
  // module implementing exactly the structural interfaces declared above.
  const electron = createRequire(__filename)("electron") as ElectronApi;
  return electron;
}

export type { Logger };
