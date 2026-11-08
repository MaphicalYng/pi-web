# Release Checklist

This fork (`MaphicalYng/pi-web`) keeps upstream's version number and appends its own:

```
v<upstream version>-imp-<fork version>        e.g. v0.15.0-imp-0.1.0
package.json "version": "0.15.0-imp-0.1.0"    the tag without its "v"
```

A release here ships exactly one artifact: the macOS desktop DMG, attached to the GitHub Release. **No `v*` tag triggers any workflow.** `ci.yml` runs on `main` and pull requests, `demo-pages.yml` deploys the demo from `main` only, and this fork carries no publish workflow — nothing reaches npm or GHCR (upstream's `@agegr/pi-web` and `ghcr.io/agegr/pi-web` are not ours to publish).

## 0. Choosing the version

| Change | Bump |
| --- | --- |
| Fork-only work (UI, desktop shell, fixes) | the `-imp-<n>` part: `0.15.0-imp-0.1.0` → `0.15.0-imp-0.2.0` |
| A merged upstream release | both: take upstream's version, continue the fork counter (`0.16.0-imp-0.3.0`) |

`package.json` and `package-lock.json` must carry the same value, and the DMG copies it (`desktop/packaging/build-desktop.mjs` reads `package.json` and writes `desktop/packaging/app-package.json`).

One exception: macOS takes `CFBundleShortVersionString` and `CFBundleVersion` as 1-3 period-separated integers, so a pre-release suffix cannot go into the plist. `build-desktop.mjs` therefore passes the numeric base (`0.15.0`) to electron-builder, and the fork's own version lives in `package.json`, the baked constants the app's footer reads, and the tag. That is why step 3 checks both.

Do not run `npm run release` (`npm version patch`): it produces a plain `0.15.1`, which drops the fork's `-imp-<n>` marker and makes the DMG disagree with the tag. Edit both files by hand.

## 1. Preflight

```bash
git fetch origin
git status --short --branch
git log --oneline --decorate -5
node -e "const p=require('./package.json'); console.log(p.version)"
git tag --points-at HEAD        # expect nothing: the tag is created in step 3
git ls-remote --tags origin     # expect the tag to be absent
```

Expected: a clean tree; `package.json` already carrying the version you are about to tag; the tag free on origin.

Nothing runs on a tag, so nothing gates the release but you. Run what CI would run:

```bash
npm run lint
npx tsc --noEmit
npm test
```

CI's `e2e` job needs `npx playwright install --with-deps chromium` and a `next build`; run `npm run test:e2e` locally if the change touches the UI.

## 2. Commit the version

```bash
git commit -am "Release v<version>"
git push origin <branch>
```

Push the branch **before** the tag: a tag pointing at a commit no remote branch reaches is hard to inspect later.

## 3. Build and smoke the DMG

macOS arm64 only; the build is unsigned and not notarized.

Clear stale artifacts first. The build never deletes what an earlier run left in `release/`, and every command below matches `release/*.dmg` — a leftover DMG from a previous version makes that glob match two files, and `hdiutil attach` or `gh release upload` then acts on the wrong one.

```bash
rm -f release/*.dmg                 # your own earlier build products only
npm run build:desktop    # dist/desktop, then release/mac-arm64/Pi Web.app and release/*.dmg
npm run smoke:desktop    # launch the packaged app: layout, guards, shutdown
```

Do not go on unless `smoke:desktop` passes. Confirm exactly one DMG exists and that it is the new build:

```bash
ls -la release/*.dmg
hdiutil attach release/*.dmg -nobrowse   # /Volumes/Pi Web
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "/Volumes/Pi Web/Pi Web.app/Contents/Info.plist"
hdiutil detach "/Volumes/Pi Web"
```

The file must be named `Pi Web-<version>-arm64.dmg` with the whole `package.json` version in it (`Pi Web-0.15.0-imp-0.1.0-arm64.dmg`), and that printed string must be only the version's numeric base — the part before the first `-` — while the chat's footer line shows the whole thing (`0.15.0-imp-0.1.0-<commit>`). A DMG reporting the previous base is a stale artifact: rebuild, do not rename. A plist carrying the whole `-imp-…` suffix means the `bundleShortVersion` override in `build-desktop.mjs` was lost; fix that, do not ship it. A DMG named without the fork version means `artifactName` was dropped from `electron-builder.yml`, and it will collide with upstream's release.

That printed string must be the numeric base of `package.json`'s version — the part before the first `-` — and the chat's footer line must show the whole thing (`0.15.0-imp-0.1.0-<commit>`). A DMG reporting the previous base is a stale artifact: rebuild, do not rename. A plist carrying the whole `-imp-…` suffix means the `bundleShortVersion` override in `build-desktop.mjs` was lost; fix that, do not ship it.

Build products stay out of the repository (`dist/`, `release/` are ignored). `git status --short` must stay clean.

## 4. Tag and push the tag alone

```bash
git tag -a v<version> -m "Release v<version>"
git push origin "refs/tags/v<version>"
```

Never `git push --tags`. This checkout holds every tag fetched from upstream, and `--tags` publishes all of them — upstream once leaked a stray `v0.10.5` on a commit that is on no branch this way. Push the single ref, by name.

## 5. Release notes

Write them from the commits, not from memory, and keep the file outside the repository:

```bash
NOTES=$(mktemp)
git log --oneline --decorate v<previous>..v<version>
git log --format='%h%x09%s%n%b' v<previous>..v<version>
git diff --stat v<previous>..v<version>
```

Check every command, setting name and path you mention against `README.md` and the code before writing it down.

Suggested structure:

```markdown
## 中文

基于 `v<previous>..v<version>` 的提交整理。

### 新增

- ...

### 修复

- ...

### 改进

- ...

### 安装

- 下载附加的 DMG，把 **Pi Web** 拖入「应用程序」。未签名，首次启动需右键 → 打开，或执行
  `xattr -dr com.apple.quarantine "/Applications/Pi Web.app"`。

## English

Prepared from commits in `v<previous>..v<version>`.

### Added

- ...

### Fixed

- ...

### Improved

- ...

### Install

- Download the attached DMG and drag **Pi Web** into `Applications`. It is unsigned: right-click → Open on
  first launch, or run `xattr -dr com.apple.quarantine "/Applications/Pi Web.app"`.
```

## 6. Create the GitHub Release with the DMG

```bash
gh release create v<version> \
  --repo MaphicalYng/pi-web \
  --verify-tag \
  --title "v<version>" \
  --notes-file "$NOTES" \
  release/*.dmg
```

`--repo` is explicit on purpose: the `origin` remote is the fork, but the upstream tags live in the same checkout, so an implicit target is one mistake away from the wrong repository.

Only the notes need changing later:

```bash
gh release edit v<version> --repo MaphicalYng/pi-web --notes-file "$NOTES"
```

Upload the DMG afterwards, if it was missed:

```bash
gh release upload v<version> --repo MaphicalYng/pi-web release/*.dmg
```

## 7. Final verification

```bash
gh release view v<version> --repo MaphicalYng/pi-web --json assets --jq '.assets[].name'
git ls-remote --tags origin
git status --short --branch
git log --oneline --decorate -3
```

Expected:

- The DMG appears in the release's assets, together with GitHub's own `Source code (zip)` and `Source code (tar.gz)`.
- The release is not a draft.
- `git ls-remote --tags origin` shows only tags you meant to publish.
- The branch is aligned with its remote, and `HEAD` is the release commit the tag points at.

## What this fork does not publish

| Upstream publishes | Here |
| --- | --- |
| npm package `@agegr/pi-web`, by `publish.yml` on a `v*` tag | **Nothing.** `@agegr/pi-web` belongs to upstream; the fork's version can never match a version npm already holds, and Trusted Publishing is bound to `agegr/pi-web`. `publish.yml` is removed. |
| Docker image `ghcr.io/agegr/pi-web` | **Nothing prebuilt.** The `Dockerfile` still builds locally (see [docker.md](./docker.md)). |

A plain `git push --tags` therefore does nothing at all here — and that is the point: a tag is a marker, not a trigger.
