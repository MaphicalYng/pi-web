/**
 * Ad-hoc code-sign the packaged app.
 *
 * `electron-builder.yml` sets `identity: null`, so no Developer ID is used and
 * the bundle keeps the signature Electron itself shipped with: macOS then
 * reports its identifier as `Electron`, not `dev.piweb.desktop`. That breaks the
 * notification centre, which identifies an app by its signature — and since
 * Electron 42 a macOS notification goes through UNNotification, which only a
 * code-signed bundle may deliver. The result was a silent "no notification at
 * all" on a machine where the browser build notifies normally.
 *
 * There is no Developer ID on this machine, so the bundle gets an ad-hoc
 * signature whose identifier matches its Info.plist. That is enough for
 * notifications and for a stable app identity; it is not notarization, and the
 * app is still distributed outside the App Store.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    // A real identity is configured; electron-builder already signed the bundle.
    return;
  }

  const bundle = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "inherit" });

  // `codesign -dv` writes its report to stderr, not stdout.
  const report = spawnSync("codesign", ["-dv", bundle], { encoding: "utf8" });
  const identifier = /Identifier=(\S+)/.exec(String(report.stderr ?? ""))?.[1] ?? "?";
  process.stdout.write(`[build-desktop] ad-hoc signed ${bundle} (identifier ${identifier})\n`);
}
