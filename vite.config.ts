import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { defineConfig, type Plugin } from "vite";

/** Files worth keeping in the offline cache. The engine and demos are small. */
const PRECACHE_PATTERN = /\.(?:html|js|css|json|wasm|webmanifest|png|svg)$/i;

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

/**
 * Emit `sw.js` after the bundle is written, with the real hashed asset names
 * and a cache version derived from the file list and the worker source.
 * No extra dependencies needed.
 */
function serviceWorker(): Plugin {
  return {
    name: "knightwatch-pwa",
    apply: "build",
    closeBundle() {
      const root = process.cwd();
      const outDir = resolve(root, "dist");
      const files = walk(outDir)
        .map((file) => `/${relative(outDir, file).replace(/\\/g, "/")}`)
        .filter((file) => PRECACHE_PATTERN.test(file) && file !== "/sw.js")
        .sort();

      const template = readFileSync(resolve(root, "src/pwa/sw.js"), "utf8");
      // Hash the worker logic as well, so changing cache behaviour also rotates
      // the cache name and drops entries the new build no longer needs.
      const version = createHash("sha256").update(`${template}\n${files.join("|")}`).digest("hex").slice(0, 10);
      const output = template
        .replaceAll("__PRECACHE__", JSON.stringify(files))
        .replaceAll("__VERSION__", version);

      writeFileSync(join(outDir, "sw.js"), output, "utf8");
    },
  };
}

export default defineConfig({
  plugins: [serviceWorker()],
  build: {
    target: "es2022",
    sourcemap: false,
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
  },
  preview: {
    port: 4173,
    host: "127.0.0.1",
  },
});
