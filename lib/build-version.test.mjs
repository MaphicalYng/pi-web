import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILD_VERSION,
  BUILD_VERSION_TAG,
  IS_DESKTOP_BUILD,
  WEB_BUILD_FLAVOR,
  buildVersionLabel,
  buildVersionTag,
} from "./build-version.ts";

test("a web build names the fork after pi-web's version", () => {
  assert.equal(WEB_BUILD_FLAVOR, "imp");
  assert.equal(buildVersionLabel({ appVersion: "0.15.0", commit: "5d8d631" }), "0.15.0-imp-5d8d631");
  assert.equal(buildVersionTag({ appVersion: "0.15.0", commit: "5d8d631" }), "web v0.15.0-imp-5d8d631");
});

test("a desktop build carries the shell's version before the commit", () => {
  const parts = { appVersion: "0.15.0", commit: "5d8d631", desktopVersion: "0.1.0" };
  assert.equal(buildVersionLabel(parts), "0.15.0-desktop-0.1.0-5d8d631");
  // The label already says "desktop": the brand line needs no word of its own.
  assert.equal(buildVersionTag(parts), "v0.15.0-desktop-0.1.0-5d8d631");
});

test("an empty desktop version is a web build, not a desktop one", () => {
  for (const desktopVersion of [undefined, null, "", "  "]) {
    assert.equal(
      buildVersionLabel({ appVersion: "0.15.0", commit: "5d8d631", desktopVersion }),
      "0.15.0-imp-5d8d631",
    );
  }
});

test("each missing part has one visible placeholder, never a guess", () => {
  assert.equal(buildVersionLabel({}), "0.0.0-imp-unknown");
  assert.equal(buildVersionLabel({ appVersion: "  ", commit: "  " }), "0.0.0-imp-unknown");
  assert.equal(buildVersionLabel({ appVersion: "0.15.0", desktopVersion: "0.1.0" }), "0.15.0-desktop-0.1.0-unknown");
  // Trimming keeps a copy-pasted value from breaking the line.
  assert.equal(buildVersionLabel({ appVersion: " 0.15.0 ", commit: " 5d8d631 " }), "0.15.0-imp-5d8d631");
});

test("a release version that already names the fork keeps it instead of gaining a second", () => {
  const release = { appVersion: "0.15.0-imp-0.1.0", commit: "28de0ed" };
  assert.equal(buildVersionLabel(release), "0.15.0-imp-0.1.0-28de0ed");
  assert.equal(buildVersionTag(release), "web v0.15.0-imp-0.1.0-28de0ed");

  // The shell's version would only repeat the fork's own release number.
  const desktop = { ...release, desktopVersion: "0.1.0" };
  assert.equal(buildVersionLabel(desktop), "0.15.0-imp-0.1.0-28de0ed");
  assert.equal(buildVersionTag(desktop), "v0.15.0-imp-0.1.0-28de0ed");
});

test("the page's baked constants agree with the builder", () => {
  // No `next build` ran for the test: the parts are the fallbacks, and the two
  // exports must still describe the same build.
  assert.equal(IS_DESKTOP_BUILD, Boolean((process.env.NEXT_PUBLIC_DESKTOP_VERSION ?? "").trim()));
  assert.equal(BUILD_VERSION_TAG, buildVersionTag({
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION,
    commit: process.env.NEXT_PUBLIC_APP_COMMIT,
    desktopVersion: process.env.NEXT_PUBLIC_DESKTOP_VERSION,
  }));
  assert.equal(BUILD_VERSION, buildVersionLabel({
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION,
    commit: process.env.NEXT_PUBLIC_APP_COMMIT,
    desktopVersion: process.env.NEXT_PUBLIC_DESKTOP_VERSION,
  }));
});
