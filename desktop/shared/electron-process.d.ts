/**
 * Electron's main process adds `resourcesPath` to the Node `process` object,
 * but `@types/node` does not declare it and Electron's own declaration only
 * augments `Electron.Process`. Declaring the single property globally lets the
 * shell and the backend config read it with a real type (optional outside
 * Electron) instead of `any` or an ignore comment.
 */
declare namespace NodeJS {
  interface Process {
    readonly resourcesPath?: string;
  }
}
