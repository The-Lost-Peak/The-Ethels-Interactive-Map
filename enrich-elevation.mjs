#!/usr/bin/env node
/*
 * enrich-elevation.mjs
 * Reads GPX files, fetches elevation for each track point from Mapbox Terrain-RGB,
 * and writes <ele> values back into the GPX. Only processes files that are missing
 * elevation OR whose coordinates have changed since last enrichment (tracked via a
 * hash comment embedded in the file).
 *
 * Usage:  MAPBOX_TOKEN=xxx node enrich-elevation.mjs [file1.gpx file2.gpx ...]
 * If no files are passed, it processes every .gpx under GPX_DIR.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const TOKEN = process.env.MAPBOX_TOKEN;
const GPX_DIR = process.env.GPX_DIR || 'GPX';
const ZOOM = 14; // Terrain-RGB zoom; 14 is plenty accurate for hills
const CONCURRENCY = 8;

if (!TOKEN) {
  console.error('ERROR: MAPBOX_TOKEN env var is required.');
  process.exit(1);
}

// ---- Mapbox Terrain-RGB: fetch a tile, decode elevation at a pixel ----
const tileCache = new Map();

function lonLatToTile(lon, lat, z) {
  const latRad = (lat * Math.PI) / 180;
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { xf: x, yf: y };
}

async function getTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const url = `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}@2x.pngraw?access_token=${TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Tile ${key} HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { PNG } = await import('pngjs');
  const png = PNG.sync.read(buf);
  tileCache.set(key, png);
  return png;
}

async function elevationAt(lon, lat) {
  const { xf, yf } = lonLatToTile(lon, lat, ZOOM);
  const xt = Math.floor(xf), yt = Math.floor(yf);
  const png = await getTile(ZOOM, xt, yt);
  const size = png.width; // 512 for @2x
  let px = Math.floor((xf - xt) * size);
  let py = Math.floor((yf - yt) * size);
  px = Math.min(size - 1, Math.max(0, px));
  py = Math.min(size - 1, Math.max(0, py));
  const idx = (py * size + px) * 4;
  const R = png.data[idx], G = png.data[idx + 1], B = png.data[idx + 2];
  // Mapbox Terrain-RGB decode formula
  return -10000 + (R * 256 * 256 + G * 256 + B) * 0.1;
}

// ---- GPX helpers ----
function coordHash(points) {
  const h = createHash('sha1');
  h.update(points.map(p => p.lat + ',' + p.lon).join(';'));
  return h.digest('hex').slice(0, 16);
}

function parsePoints(xml) {
  const pts = [];
  const re = /<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"\s*(\/?)>/g;
  let m;
  while ((m = re.exec(xml))) {
    pts.push({ lat: parseFloat(m[1]), lon: parseFloat(m[2]), selfClose: m[3] === '/' });
  }
  return pts;
}

async function enrichFile(file) {
  const xml = await readFile(file, 'utf8');
  const points = parsePoints(xml);
  if (points.length === 0) { console.log(`skip (no trkpt): ${file}`); return false; }

  const hash = coordHash(points);
  const stamp = `<!-- ele-hash:${hash} -->`;
  if (xml.includes(stamp)) { console.log(`up-to-date: ${path.basename(file)}`); return false; }

  // fetch elevations with limited concurrency
  const eles = new Array(points.length);
  let next = 0;
  async function worker() {
    while (next < points.length) {
      const i = next++;
      try { eles[i] = await elevationAt(points[i].lon, points[i].lat); }
      catch (e) { eles[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // rewrite each trkpt to include <ele>
  let i = -1;
  let out = xml.replace(/<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"\s*\/?>(\s*<ele>[-\d.]*<\/ele>)?/g,
    (full, lat, lon) => {
      i++;
      const e = eles[i];
      const eleTag = (e == null || !isFinite(e)) ? '' : `<ele>${e.toFixed(1)}</ele>`;
      return `<trkpt lat="${lat}" lon="${lon}">${eleTag}</trkpt>`;
    });

  // embed/replace the hash stamp so we can detect changes next time
  out = out.replace(/<!-- ele-hash:[a-f0-9]+ -->\n?/g, '');
  out = out.replace('</gpx>', `${stamp}\n</gpx>`);

  await writeFile(file, out, 'utf8');
  console.log(`enriched: ${path.basename(file)} (${points.length} pts)`);
  return true;
}

async function main() {
  let files = process.argv.slice(2);
  if (files.length === 0) {
    const all = await readdir(GPX_DIR);
    files = all.filter(f => f.toLowerCase().endsWith('.gpx')).map(f => path.join(GPX_DIR, f));
  }
  let changed = 0;
  for (const f of files) {
    try { if (await enrichFile(f)) changed++; }
    catch (e) { console.error(`FAILED ${f}: ${e.message}`); }
  }
  console.log(`\nDone. ${changed} file(s) updated.`);
}

main();
