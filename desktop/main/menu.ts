/**
 * Native application menu. Only fixed actions exist — retry the backend, open
 * the fixed log directory, quit — and each calls a main-process callback; the
 * renderer cannot reach them and cannot supply arguments.
 *
 * The template is plain data so it can be asserted without Electron; `install`
 * is the only function that touches the Menu module.
 */

export type MenuAction = "retry-backend" | "open-logs" | "reload";

export interface MenuItemSpec {
  label?: string;
  role?: string;
  type?: "separator" | "normal";
  action?: MenuAction;
  accelerator?: string;
  click?: () => void;
  submenu?: MenuItemSpec[];
}

export interface MenuTemplateOptions {
  appName: string;
  isMac: boolean;
  /** Reload is offered outside packaged builds only. */
  devTools: boolean;
}

/** Roles only; no renderer-defined commands, no dynamic entries. */
export function buildMenuTemplate(options: MenuTemplateOptions): MenuItemSpec[] {
  const appMenu: MenuItemSpec[] = [
    { role: "about" },
    { type: "separator" },
    { label: "Retry Backend", action: "retry-backend" },
    { label: "Open Logs", action: "open-logs" },
    ...(options.devTools ? [{ label: "Reload Page", action: "reload" as MenuAction, accelerator: "CmdOrCtrl+R" }] : []),
    { type: "separator" },
    { role: "hide" },
    { role: "hideOthers" },
    { role: "unhide" },
    { type: "separator" },
    { role: "quit" },
  ];

  const editMenu: MenuItemSpec[] = [
    { role: "undo" },
    { role: "redo" },
    { type: "separator" },
    { role: "cut" },
    { role: "copy" },
    { role: "paste" },
    { role: "selectAll" },
  ];

  const windowMenu: MenuItemSpec[] = [
    { role: "minimize" },
    { role: "zoom" },
    { type: "separator" },
    { role: "front" },
  ];

  if (!options.isMac) {
    return [
      { label: "File", submenu: [{ role: "quit" }] },
      { label: "Edit", submenu: editMenu },
      { label: "View", submenu: [{ label: "Retry Backend", action: "retry-backend" }, { label: "Open Logs", action: "open-logs" }] },
      { label: "Window", submenu: windowMenu },
    ];
  }

  return [
    { label: options.appName, submenu: appMenu },
    { label: "Edit", submenu: editMenu },
    { label: "Window", submenu: windowMenu },
  ];
}

export interface MenuLike {
  readonly items: number;
}

export interface MenuModuleLike {
  buildFromTemplate(template: readonly MenuItemSpec[]): MenuLike;
  setApplicationMenu(menu: MenuLike | null): void;
}

/** Maps every `action` node to its main-process callback; unknown roles stay as-is. */
export function materializeMenu(
  template: MenuItemSpec[],
  actions: Record<MenuAction, () => void>,
): MenuItemSpec[] {
  return template.map((item) => {
    const next: MenuItemSpec = { ...item };
    if (item.action) {
      const action = item.action;
      next.click = () => actions[action]();
    }
    if (item.submenu) next.submenu = materializeMenu(item.submenu, actions);
    return next;
  });
}

export interface InstallMenuDeps {
  Menu: MenuModuleLike;
  appName: string;
  isMac: boolean;
  devTools: boolean;
  actions: Record<MenuAction, () => void>;
}

export function installApplicationMenu(deps: InstallMenuDeps): void {
  const template = buildMenuTemplate({ appName: deps.appName, isMac: deps.isMac, devTools: deps.devTools });
  const menu = deps.Menu.buildFromTemplate(materializeMenu(template, deps.actions));
  deps.Menu.setApplicationMenu(menu);
}
