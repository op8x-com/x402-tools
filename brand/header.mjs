// Generates the X/Twitter header (1500x500): a world map drawn from ASCII-like glyphs.
// Land mask from Natural Earth via world-atlas (land-110m.json).
// Usage: node header.mjs <land-110m.json> <out.svg>
import { readFileSync, writeFileSync } from "node:fs";

const [landFile, outFile] = process.argv.slice(2);
if (!landFile || !outFile) throw new Error("usage: node header.mjs <land-110m.json> <out.svg>");

const BLUE = "#003399";
const WHITE = "#ffffff";
const W = 1500, H = 500, CELL = 12;
const COLS = W / CELL, ROWS = Math.floor(H / CELL);
const LON0 = -170, LAT0 = 76; // top-left corner; map is centered slightly east of Greenwich
const DEG = 360 / COLS;

// Decode TopoJSON arcs (quantized + delta-encoded) into lon/lat rings.
const topo = JSON.parse(readFileSync(landFile, "utf8"));
const { scale: [sx, sy], translate: [tx, ty] } = topo.transform;
const arcs = topo.arcs.map((arc) => {
  let x = 0, y = 0;
  return arc.map(([dx, dy]) => [(x += dx) * sx + tx, (y += dy) * sy + ty]);
});
const ring = (ids) => ids.flatMap((i, n) => {
  const pts = i < 0 ? [...arcs[~i]].reverse() : arcs[i];
  return n ? pts.slice(1) : pts;
});
// Unwrap rings that cross the antimeridian (e.g. Eurasia) so consecutive points never jump by 360°.
const unwrap = (r) => {
  let shift = 0;
  return r.map(([x, y], i) => {
    if (i) {
      const d = x + shift - (r[i - 1][0] + prevShift);
      if (d > 180) shift -= 360;
      else if (d < -180) shift += 360;
    }
    prevShift = shift;
    return [x + shift, y];
  });
};
let prevShift = 0;
const rings = topo.objects.land.geometries
  .flatMap((g) => (g.type === "Polygon" ? g.arcs.map(ring) : g.arcs.flatMap((p) => p.map(ring))))
  .map(unwrap);

const inRing = (r, lon, lat) => {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
// Even-odd across all rings (handles holes); unwrapped rings may sit up to 360° off.
const isLand = (lon, lat) =>
  rings.reduce((inside, r) => ([0, 360, -360].some((o) => inRing(r, lon + o, lat)) ? !inside : inside), false);

// Deterministic per-cell noise so the texture is stable between runs.
const noise = (c, r) => (((c * 73856093) ^ (r * 19349663)) >>> 0) % 100;

const rects = [];
const rect = (x, y, w, h) => rects.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`);
// Glyphs drawn from squares, centered in the cell: "+" (size s, stroke t) and "·" (square d).
const plus = (cx, cy, s, t) => { rect(cx - (s >> 1), cy - (t >> 1), s, t); rect(cx - (t >> 1), cy - (s >> 1), t, s); };
const dot = (cx, cy, d) => rect(cx - (d >> 1), cy - (d >> 1), d, d);

for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    let lon = LON0 + (c + 0.5) * DEG;
    if (lon > 180) lon -= 360;
    const lat = LAT0 - (r + 0.5) * DEG;
    if (!isLand(lon, lat)) continue;
    const cx = c * CELL + CELL / 2, cy = Math.round(r * CELL + CELL / 2 + (H - ROWS * CELL) / 2);
    const n = noise(c, r);
    if (n < 55) plus(cx, cy, 7, 1);
    else dot(cx, cy, n < 85 ? 2 : 3);
  }
}

writeFileSync(
  outFile,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${WHITE}"/><g fill="${BLUE}">${rects.join("")}</g></svg>`
);
console.log(`${outFile}: ${rects.length} rects`);
