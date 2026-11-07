/**
 * Intentionally empty preload. The frozen interface gives the renderer zero
 * bridge capabilities: no `contextBridge`, no `ipcRenderer`, no globals, no
 * Node access. The file exists only because BrowserWindow's `preload` points at
 * a real compiled module; the packaged page is the unchanged web product.
 */
export {};
