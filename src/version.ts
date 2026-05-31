// Reads package.json once to expose the canonical CLI version. Works for
// both `node dist/index.js` (compiled) and `tsx src/index.ts` (dev).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

export function getCliVersion(): string {
  if (cached) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // walk up to find package.json (works from src/, dist/, dist/...)
    let dir = here;
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as { version?: string };
        if (pkg.version) {
          cached = pkg.version;
          return cached;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* ignore */
  }
  cached = "0.0.0-unknown";
  return cached;
}
