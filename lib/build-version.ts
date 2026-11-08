/**
 * The build in use: pi-web's version, what it was built as, and the commit it
 * came from. The chat's footer line and a fresh composer's brand show it.
 *
 * `next.config.ts` bakes the parts in at build time (`env`), so nothing here is
 * a request and nothing differs between the server and the page. A desktop
 * build carries the shell's own version; a web build carries this fork's tag
 * instead. A build with no commit id says `unknown` rather than inventing one.
 */

/** What a web build calls itself after pi-web's version: this fork's tag. */
export const WEB_BUILD_FLAVOR = "imp";

export interface BuildVersionParts {
  /** pi-web's own version (`package.json`). */
  appVersion?: string | null;
  /** The short commit the build came from. */
  commit?: string | null;
  /** The desktop shell's version (`desktop/version.json`); empty or absent on a web build. */
  desktopVersion?: string | null;
}

/**
 * `0.15.0-desktop-0.1.0-5d8d631` on a desktop build,
 * `0.15.0-imp-5d8d631` on a web one.
 *
 * A release version that already names the fork and its own release number
 * (`0.15.0-imp-0.1.0`, the value this fork tags) keeps that suffix as it
 * stands: `0.15.0-imp-0.1.0-5d8d631` on either build, never a second `-imp`
 * and never the shell's version repeated.
 */
export function buildVersionLabel(parts: BuildVersionParts): string {
  const version = parts.appVersion?.trim() || "0.0.0";
  const commit = parts.commit?.trim() || "unknown";
  const desktopVersion = parts.desktopVersion?.trim();
  if (version.includes(`-${WEB_BUILD_FLAVOR}`)) return `${version}-${commit}`;
  return desktopVersion
    ? `${version}-desktop-${desktopVersion}-${commit}`
    : `${version}-${WEB_BUILD_FLAVOR}-${commit}`;
}

/**
 * The same string for the brand line under a fresh composer, which names the
 * flavor first: `web v0.15.0-imp-5d8d631`. A desktop build's label already says
 * `desktop`, so its line is only `v0.15.0-desktop-0.1.0-5d8d631`.
 */
export function buildVersionTag(parts: BuildVersionParts): string {
  const label = buildVersionLabel(parts);
  return parts.desktopVersion?.trim() ? `v${label}` : `web v${label}`;
}

const PARTS: BuildVersionParts = {
  appVersion: process.env.NEXT_PUBLIC_APP_VERSION,
  commit: process.env.NEXT_PUBLIC_APP_COMMIT,
  desktopVersion: process.env.NEXT_PUBLIC_DESKTOP_VERSION,
};

/** The footer's line (the status row's right end), and the build the page is. */
export const BUILD_VERSION = buildVersionLabel(PARTS);

/** The brand line under a fresh composer. */
export const BUILD_VERSION_TAG = buildVersionTag(PARTS);

/** True in the packaged desktop app's build: the label names the shell then. */
export const IS_DESKTOP_BUILD = Boolean(PARTS.desktopVersion?.trim());
