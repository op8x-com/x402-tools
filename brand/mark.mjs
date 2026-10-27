// Generates the op8x candy-stack mark, the custom wordmark and their lockups as SVG.
// Every shape is a superellipse, so the figure and the letters share one geometry.
// Usage: node mark.mjs <out-dir>
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: node mark.mjs <out-dir>");
mkdirSync(outDir, { recursive: true });

const INK = "#14142B";
const WHITE = "#ffffff";

// Design parameters (approved 27.10.2026): head tilted away, the 8 in the word leans back towards it.
const HEAD_TILT = -6;
const EIGHT_TILT = -8;
const LOOK = { x: 3, y: -1.5 }; // eye offset towards the 8, in eye units
const N = 3.3; // superellipse exponent: between ellipse (2) and rounded square (5)
const WOBBLE = 0.01; // slight organic irregularity

const STEPS = 240;
const f = (v) => +v.toFixed(2);

// Superellipse outline as points; wob adds a gentle three-lobed irregularity.
function superellipse({ cx, cy, a, b, n = N, wob = WOBBLE, ph = 0, rot = 0, ox = cx, oy = cy }) {
  const r = (rot * Math.PI) / 180;
  const pts = [];
  for (let i = 0; i < STEPS; i++) {
    const t = (i / STEPS) * 2 * Math.PI;
    const c = Math.cos(t), s = Math.sin(t);
    const w = 1 + wob * Math.sin(3 * t + ph);
    const x = cx + a * Math.sign(c) * Math.abs(c) ** (2 / n) * w;
    const y = cy + b * Math.sign(s) * Math.abs(s) ** (2 / n) * w;
    pts.push(rotate([x, y], ox, oy, r));
  }
  return pts;
}
function rotate([x, y], ox, oy, r) {
  const dx = x - ox, dy = y - oy;
  return [ox + dx * Math.cos(r) - dy * Math.sin(r), oy + dx * Math.sin(r) + dy * Math.cos(r)];
}
const d = (pts) => "M" + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L") + "Z";

// Bounding box over points, padded by half a stroke where needed.
function bbox(list) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [pts, pad = 0] of list)
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x - pad); y0 = Math.min(y0, y - pad);
      x1 = Math.max(x1, x + pad); y1 = Math.max(y1, y + pad);
    }
  return { x0, y0, x1, y1 };
}

// Figure in a 100x100 frame: body, tilted head with a gap, eyes cut out.
function figure({ id, color, gap = 4, wob = WOBBLE, eyeScale = 1 }) {
  const body = { cx: 50, cy: 74, a: 41, b: 22, wob, ph: 1 };
  const head = { cx: 51, cy: 30, a: 29, b: 22, wob, ph: 2 };
  const pivot = [head.cx, head.cy + 8];
  const bodyPts = superellipse(body);
  const headPts = superellipse({ ...head, rot: HEAD_TILT, ox: pivot[0], oy: pivot[1] });
  const s = (head.a / 28) * eyeScale;
  const eyes = [-1, 1].map((k) => {
    const x = head.cx + k * head.a * 0.27 - 4 * s + LOOK.x * s;
    const y = head.cy + 1 - 6.5 * s + LOOK.y * s;
    return `<rect x="${f(x)}" y="${f(y)}" width="${f(8 * s)}" height="${f(13 * s)}" rx="${f(2.5 * s)}"/>`;
  }).join("");
  const svg =
    `<defs>` +
    `<mask id="${id}-b" maskUnits="userSpaceOnUse" x="-10" y="-10" width="120" height="120"><rect x="-10" y="-10" width="120" height="120" fill="#fff"/><path d="${d(headPts)}" fill="#000" stroke="#000" stroke-width="${gap}"/></mask>` +
    `<mask id="${id}-h" maskUnits="userSpaceOnUse" x="-10" y="-10" width="120" height="120"><path d="${d(headPts)}" fill="#fff" stroke="#000" stroke-width="${gap}"/><g fill="#000" transform="rotate(${HEAD_TILT} ${pivot[0]} ${pivot[1]})">${eyes}</g></mask>` +
    `</defs>` +
    `<path d="${d(bodyPts)}" fill="${color}" mask="url(#${id}-b)"/>` +
    `<path d="${d(headPts)}" fill="${color}" mask="url(#${id}-h)"/>`;
  return { svg, box: bbox([[bodyPts], [headPts]]) };
}

// Wordmark "op8x" built from stroked superellipses; baseline at y=80, x-height 30..80.
function wordmark(color) {
  const sw = 11, h = sw / 2, gapX = 9;
  const parts = [];
  const shapes = [];
  const ring = (o) => {
    const pts = superellipse({ wob: 0.012, ...o });
    shapes.push([pts, h]);
    parts.push(`<path d="${d(pts)}"/>`);
  };
  const line = (p) => {
    shapes.push([p.pts, h]);
    parts.push(`<path d="${p.d}"/>`);
  };
  let x = 0;
  const oa = 20, ob = (80 - 30 - sw) / 2, ocy = 30 + h + ob;
  ring({ cx: x + h + oa, cy: ocy, a: oa, b: ob, ph: 1 }); // o
  x += 2 * oa + sw + gapX;
  ring({ cx: x + h + oa, cy: ocy, a: oa, b: ob, ph: 2 }); // p bowl
  line({ d: `M${f(x + h)} ${f(ocy)}V${f(100 - h)}`, pts: [[x + h, ocy], [x + h, 100 - h]] }); // p stem
  x += 2 * oa + sw + gapX;
  const tb = 12.5, ta = 15, bb = 17, ba = 18;
  const tcy = 8 + h + tb, bcy = tcy + tb + bb, tx = x + h + ba + 1;
  ring({ cx: x + h + ba, cy: bcy, a: ba, b: bb, ph: 3 }); // 8 bottom
  ring({ cx: tx, cy: tcy, a: ta, b: tb, ph: 4, rot: EIGHT_TILT, ox: tx, oy: tcy + tb }); // 8 top, leaning towards the head
  x += 2 * ba + sw + gapX;
  const x0 = x + h, x1 = x + h + 38, ym = 55;
  line({
    d: `M${f(x0)} ${f(30 + h)}Q${f(x0 + 19)} ${ym} ${f(x1)} ${f(80 - h)}M${f(x1)} ${f(30 + h)}Q${f(x0 + 19)} ${ym} ${f(x0)} ${f(80 - h)}`,
    pts: [[x0, 30 + h], [x1, 80 - h], [x1, 30 + h], [x0, 80 - h]],
  }); // x
  const svg = `<g fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round">${parts.join("")}</g>`;
  return { svg, box: bbox(shapes) };
}

const PAD = 2;
function doc(box, body, label, extra = "") {
  const x = f(box.x0 - PAD), y = f(box.y0 - PAD), w = f(box.x1 - box.x0 + 2 * PAD), hh = f(box.y1 - box.y0 + 2 * PAD);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${hh}" role="img" aria-label="${label}">${extra}${body}</svg>\n`;
}
// Figure spans from the top of the 8 down to the baseline (with the usual 1-unit overshoot of round shapes).
function lockup(color, id) {
  const fig = figure({ id, color });
  const word = wordmark(color);
  const bottom = 81;
  const k = (bottom - word.box.y0) / (fig.box.y1 - fig.box.y0);
  const tx = -fig.box.x0 * k, ty = bottom - fig.box.y1 * k;
  const shift = (fig.box.x1 - fig.box.x0) * k + 16;
  const body = `<g transform="translate(${f(tx)} ${f(ty)}) scale(${f(k)})">${fig.svg}</g><g transform="translate(${f(shift)} 0)">${word.svg}</g>`;
  return doc({ x0: 0, y0: word.box.y0, x1: shift + word.box.x1, y1: word.box.y1 }, body, "op8x");
}
function square(size, bg, color, id, scale = 0.62) {
  const fig = figure({ id, color });
  const w = fig.box.x1 - fig.box.x0, hh = fig.box.y1 - fig.box.y0;
  const k = (size * scale) / Math.max(w, hh);
  const tx = (size - w * k) / 2 - fig.box.x0 * k, ty = (size - hh * k) / 2 - fig.box.y0 * k;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="op8x"><rect width="${size}" height="${size}" fill="${bg}"/><g transform="translate(${f(tx)} ${f(ty)}) scale(${f(k)})">${fig.svg}</g></svg>\n`;
}

const out = (name, svg) => {
  writeFileSync(join(outDir, name), svg);
  console.log(join(outDir, name));
};

const m = figure({ id: "op8x-m", color: INK });
out("d-stack-mark.svg", doc(m.box, m.svg, "op8x"));
const mw = figure({ id: "op8x-mw", color: WHITE });
out("d-stack-mark-inv.svg", doc(mw.box, mw.svg, "op8x"));
out("d-stack-lockup.svg", lockup(INK, "op8x-l"));
out("d-stack-lockup-inv.svg", lockup(WHITE, "op8x-lw"));
const w = wordmark(INK);
out("d-stack-wordmark.svg", doc(w.box, w.svg, "op8x"));
out("d-stack-avatar.svg", square(400, WHITE, INK, "op8x-a"));
out("d-stack-avatar-inv.svg", square(400, INK, WHITE, "op8x-ai"));

// Favicon: wider gap and no wobble so the head stays separate at 16 px; follows the browser theme.
const fav = figure({ id: "op8x-f", color: "currentColor", gap: 7, wob: 0, eyeScale: 1.15 });
const side = Math.max(fav.box.x1 - fav.box.x0, fav.box.y1 - fav.box.y0);
const mx = (fav.box.x0 + fav.box.x1) / 2, my = (fav.box.y0 + fav.box.y1) / 2;
out(
  "d-stack-favicon.svg",
  doc({ x0: mx - side / 2, y0: my - side / 2, x1: mx + side / 2, y1: my + side / 2 },`<g style="color:${INK}" class="m">${fav.svg}</g>`, "op8x",
    `<style>@media (prefers-color-scheme: dark){.m{color:${WHITE}!important}}</style>`)
);
