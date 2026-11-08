/**
 * Test-only resolver: desktop sources are TypeScript with extensionless relative
 * imports (compiled to CommonJS by packaging), while Node's native type
 * stripping runs them as ESM. This hook maps `./x` to `./x.ts` (or
 * `./x/index.ts`) so `node --test` can import the sources directly.
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith(".") || !context.parentURL || !context.parentURL.startsWith("file:")) {
      return nextResolve(specifier, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.endsWith(".ts") || specifier.endsWith(".js") || specifier.endsWith(".json")) throw error;
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try {
          return nextResolve(candidate, context);
        } catch {
          // Try the next candidate.
        }
      }
      throw error;
    }
  },
});
