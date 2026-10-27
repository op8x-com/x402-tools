// Rasterizes any SVG to PNG with headless Chrome (for shapes export-png.mjs cannot draw).
// Usage: node render-png.mjs <in.svg> <out.png> <width>   (height follows the viewBox ratio, transparent background)
// Chrome is taken from $CHROME, else the default Windows install paths.
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const [inFile, outFile, widthArg] = process.argv.slice(2);
if (!inFile || !outFile || !widthArg) throw new Error("usage: node render-png.mjs <in.svg> <out.png> <width>");

const chrome = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => p && existsSync(p));
if (!chrome) throw new Error("no Chrome or Edge found; set CHROME to the browser executable");

const vb = readFileSync(inFile, "utf8").match(/viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/);
if (!vb) throw new Error("viewBox not found");
const width = Number(widthArg);
const height = Math.round((width * Number(vb[4])) / Number(vb[3]));

const dir = mkdtempSync(join(tmpdir(), "op8x-png-"));
try {
  const page = join(dir, "page.html");
  writeFileSync(
    page,
    `<!doctype html><html><body style="margin:0;background:transparent"><img src="${pathToFileURL(resolve(inFile))}" width="${width}" height="${height}" style="display:block"></body></html>`
  );
  execFileSync(chrome, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    "--default-background-color=00000000", `--user-data-dir=${join(dir, "profile")}`,
    `--window-size=${width},${height}`, `--screenshot=${resolve(outFile)}`, pathToFileURL(page).href,
  ], { stdio: "ignore", timeout: 60000 });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (!existsSync(outFile)) throw new Error(`Chrome did not write ${outFile}`);
console.log(`${outFile} ${width}x${height}`);
