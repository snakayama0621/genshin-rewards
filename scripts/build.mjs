import { build } from "esbuild";
import { cpSync, rmSync } from "node:fs";

const ENTRY_POINTS = ["src/background/index.ts", "src/popup/popup.ts", "src/options/options.ts"];
const STATIC_FILES = ["manifest.json", "icons", "popup/popup.html", "options/options.html", "ui/theme.css"];

rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints: ENTRY_POINTS,
  outdir: "dist",
  outbase: "src",
  bundle: true,
  format: "esm",
  target: "chrome120",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
});

for (const file of STATIC_FILES) {
  cpSync(`src/${file}`, `dist/${file}`, { recursive: true });
}

console.log("built: dist/");
