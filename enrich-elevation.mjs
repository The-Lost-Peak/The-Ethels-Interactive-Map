#!/usr/bin/env node
/*
 * enrich-elevation.mjs
 * Reads GPX files, fetches elevation for each track point from Mapbox Terrain-RGB,
 * and writes <ele> values into each <trkpt>. Handles BOTH trkpt formats:
 *   self-closing:      <trkpt lat=".." lon=".."/>
 *   with children:     <trkpt lat=".." lon=".."> ...<time>..</time>... </trkpt>
 * Idempotent via an <!-- ele-hash:.. --> stamp; re-runs only when coords change.
 *
 * Usage:  MAPBOX_TOKEN=xxx node enrich-elevation.mjs [file1.gpx ...]
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const TOKEN = process.env.MAPBOX_TOKEN;
const GPX_DIR = process.env.GPX_DIR || 'GPX';
const ZOOM = 14;
const CONCURRENCY = 8;

if (!TOKEN) { console.error('ERROR: MAPBOX_TOKEN env var is required.'); process.exit(1); }

const tileCache = new Map();
function lonLatToTile(lon, lat, z) {
  const latRad = (lat * Math.PI) / 180, n = 2 ** z;
  return { xf: ((lon + 180) / 360) * n,
           yf: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n };
}
async function getTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const url = `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}@2x.pngraw?access_token=${TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Tile ${key} HTTP ${res.status}`);
  const { PNG } = await import('pngjs');
  const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
  tileCache.set(key, png);
  return png;
}
async function elevationAt(lon, lat) {
  const { xf, yf } = lonLatToTile(lon, lat, ZOOM);
  const xt = Math.floor(xf), yt = Math.floor(yf);
  const png = await getTile(ZOOM, xt, yt);
  const size = png.width;
  let px = Math.min(size - 1, Math.max(0, Math.floor((xf - xt) * size)));
  let py = Math.min(size - 1, Math.max(0, Math.floor((yf - yt) * size)));
  const idx = (py * size + px) * 4;
  const R = png.data[idx], G = png.data[idx + 1], B = png.data[idx + 2];
  return -10000 + (R * 256 * 256 + G * 256 + B) * 0.1;
}

// Match a whole <trkpt> element, whether self-closing or with children.
// Group 1 = lat, Group 2 = lon, Group 3 = inner content (undefined if self-closing).
const TRKPT_RE = /<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"\s*(?:\/>|>([\s\S]*?)<\/trkpt>)/g;

function parsePoints(xml) {
  const pts = []; let m;
  TRKPT_RE.lastIndex = 0;
  while ((m = TRKPT_RE.exec(xml))) pts.push({ lat: parseFloat(m[1]), lon: parseFloat(m[2]) });
  return pts;
}
function coordHash(points) {
  return createHash('sha1').update(points.map(p => p.lat + ',' + p.lon).join(';')).digest('hex').slice(0, 16);
}


// Repair files damaged by an earlier buggy enrichment: the old script wrongly
// self-closed trkpts that had children (e.g. <time>), leaving a dangling tail.
// Pattern:  <trkpt lat lon>[<ele>..</ele>]</trkpt> <children> </trkpt>
// Collapse back to a single clean <trkpt lat lon> <children> </trkpt>.
function repairCorruption(xml) {
  const REPAIR = /<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)">(?:<ele>[-\d.]*<\/ele>)?<\/trkpt>(\s*(?:(?!<trkpt)[\s\S])*?)<\/trkpt>/g;
  let n = 0;
  const out = xml.replace(REPAIR, (full, lat, lon, tail) => { n++; return `<trkpt lat="${lat}" lon="${lon}">${tail.trim()}</trkpt>`; });
  return { out, repaired: n };
}

async function enrichFile(file) {
  let xml = await readFile(file, 'utf8');
  const rep = repairCorruption(xml);
  if (rep.repaired > 0) {
    xml = rep.out.replace(/<!-- ele-hash:[a-f0-9]+ -->\n?/g, '');
    console.log(`repaired ${rep.repaired} corrupted trkpt(s) in ${path.basename(file)}`);
  }
  const points = parsePoints(xml);
  if (points.length === 0) { console.log(`skip (no trkpt): ${path.basename(file)}`); return false; }

  const hash = coordHash(points);
  const stamp = `<!-- ele-hash:${hash} -->`;
  if (xml.includes(stamp)) { console.log(`up-to-date: ${path.basename(file)}`); return false; }

  const eles = new Array(points.length);
  let next = 0;
  async function worker() {
    while (next < points.length) {
      const i = next++;
      try { eles[i] = await elevationAt(points[i].lon, points[i].lat); }
      catch { eles[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Rewrite each trkpt. Preserve any existing children (e.g. <time>), strip any old <ele>,
  // then inject the fresh <ele> right after the opening tag.
  let i = -1;
  TRKPT_RE.lastIndex = 0;
  let out = xml.replace(TRKPT_RE, (full, lat, lon, inner) => {
    i++;
    const e = eles[i];
    const eleTag = (e == null || !isFinite(e)) ? '' : `<ele>${e.toFixed(1)}</ele>`;
    if (inner === undefined) {
      // was self-closing
      return `<trkpt lat="${lat}" lon="${lon}">${eleTag}</trkpt>`;
    }
    // had children: remove any pre-existing <ele>, keep the rest, prepend new <ele>
    const cleaned = inner.replace(/<ele>[-\d.]*<\/ele>/g, '');
    return `<trkpt lat="${lat}" lon="${lon}">${eleTag}${cleaned}</trkpt>`;
  });

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
