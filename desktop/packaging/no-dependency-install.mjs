/**
 * electron-builder `beforeBuild` hook (SIZE-1).
 *
 * Returning false tells electron-builder that node_modules is handled outside
 * of it (the backend carries its own tree inside the Next standalone, shipped
 * as extraResources). Two things stop:
 *
 *   1. dependency install/rebuild (what `npmRebuild: false` used to do — that
 *      option must stay unset here, because it early-returns before this hook
 *      runs and so never sets the "handled externally" flag);
 *   2. the node-module collection that otherwise climbs from `dist/desktop/app`
 *      to the repo root and packs the whole hoisted production tree (hundreds
 *      of MB) into app.asar/node_modules — the shell needs none of it.
 */
export default async function beforeBuild() {
  return false;
}
