import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * LoadConfig's startup path is an ambient trap without this: Next's loadConfig
 * only short-circuits on __NEXT_PRIVATE_STANDALONE_CONFIG, otherwise it walks
 * upward (find-up) for a next.config.ts outside the app and transpiles it,
 * which pulls the SWC binding in at runtime. Next's generated standalone
 * server.js sets this variable from the staged config before startServer; our
 * bootstrap loads `initialize` directly and must do the same. The staged
 * config has already been validated and defaulted at build time, so loadConfig
 * must not re-read or re-apply anything.
 */
export function applyStandaloneConfigEnv(serverDir: string): boolean {
  if (process.env.__NEXT_PRIVATE_STANDALONE_CONFIG) return false;
  try {
    const manifest = JSON.parse(
      readFileSync(join(serverDir, ".next", "required-server-files.json"), "utf8"),
    );
    if (manifest === null || typeof manifest !== "object") return false;
    const config = (manifest as { config?: unknown }).config;
    if (config === null || typeof config !== "object") return false;
    process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
    return true;
  } catch {
    return false;
  }
}
