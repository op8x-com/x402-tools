// Generates the tightly cropped op8x pixel wordmark (transparent background).
// Usage: node wordmark.mjs <out.svg> [color]   color "currentColor" for inline use on the site.
import { writeFileSync } from "node:fs";

const [outFile, color = "#003399"] = process.argv.slice(2);
if (!outFile) throw new Error("usage: node wordmark.mjs <out.svg> [color]");

// 5x9 glyphs: rows 0-6 above baseline, 7-8 descender. Same grid as the avatar.
const G = {
  o: ["     ", "     ", " ### ", "#   #", "#   #", "#   #", " ### ", "     ", "     "],
  p: ["     ", "     ", "#### ", "#   #", "#   #", "#   #", "#### ", "#    ", "#    "],
  8: [" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### ", "     ", "     "],
  x: ["     ", "     ", "#   #", " # # ", "  #  ", " # # ", "#   #", "     ", "     "],
};

const CELL = 10, BLOCK = 9; // 10% gap between blocks, as on the avatar
const rects = [];
let x0 = 0;
for (const ch of "op8x") {
  G[ch].forEach((row, y) =>
    [...row].forEach((c, i) => c === "#" && rects.push(`<rect x="${(x0 + i) * CELL}" y="${y * CELL}" width="${BLOCK}" height="${BLOCK}"/>`))
  );
  x0 += 6;
}
const w = (x0 - 1) * CELL - (CELL - BLOCK), h = 9 * CELL - (CELL - BLOCK);

writeFileSync(
  outFile,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" fill="${color}" role="img" aria-label="op8x">${rects.join("")}</svg>\n`
);
console.log(`${outFile}: ${w}x${h}`);
