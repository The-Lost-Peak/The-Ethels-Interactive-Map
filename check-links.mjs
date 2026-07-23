#!/usr/bin/env node
/*
 * check-links.mjs
 * Reads all ETHELS link fields from index.html and checks each URL is reachable.
 * Separates results into: OK, DEAD (clear 404/410/gone), and UNVERIFIED
 * (blocked/timeout/anti-bot — may still work in a browser).
 *
 * Usage: node check-links.mjs [path-to-index.html]   (default: index.html)
 * Exit code 1 if any DEAD links found (so the Action can flag red).
 */
import { readFile } from 'node:fs/promises';

const FILE = process.argv[2] || 'index.html';
const FIELDS = [
  ['Directions', 'googleMaps'],
  ['OS Maps',    'osMapsUrl'],
  ['AllTrails',  'allTrailsUrl'],
  ['Komoot',     'komootUrl'],
  ['OS buy',     'osAffiliateUrl'],
  ['Image',      'image'],
  ['GPX',        'gpx'],
];
const CONCURRENCY = 6;
const TIMEOUT_MS = 20000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

function parseEthels(html) {
  const i = html.indexOf('ETHELS=[');
  const j = html.indexOf('];', i) + 1;
  const arr = html.slice(i + 7, j);
  // split objects on top-level "},{" — good enough for this flat data
  const objs = arr.split(/\},\s*\{/).map((o, k, a) => (k === 0 ? o : '{' + o) + (k === a.length - 1 ? '' : '}'));
  const rows = [];
  for (const o of objs) {
    const get = (f) => { const m = o.match(new RegExp(f + ':"((?:[^"\\\\]|\\\\.)*)"')); return m ? m[1].replace(/\\\//g, '/') : ''; };
    const name = get('name') || get('displayName');
    if (!name || !(get('googleMaps') || get('osMapsUrl'))) continue;
    const rec = { name };
    for (const [, field] of FIELDS) rec[field] = get(field);
    rows.push(rec);
  }
  return rows;
}

async function check(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // Try HEAD first, fall back to GET (some servers reject HEAD)
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA } });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA } });
    }
    clearTimeout(t);
    if (res.status === 404 || res.status === 410) return { state: 'DEAD', code: res.status };
    if (res.status >= 200 && res.status < 400) return { state: 'OK', code: res.status };
    // 403/429/etc — likely anti-bot, not necessarily dead
    return { state: 'UNVERIFIED', code: res.status };
  } catch (e) {
    clearTimeout(t);
    return { state: 'UNVERIFIED', code: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message.slice(0, 30)) };
  }
}

async function main() {
  const html = await readFile(FILE, 'utf8');
  const rows = parseEthels(html);
  console.log(`Checking links for ${rows.length} Ethels...\n`);

  // build task list
  const tasks = [];
  for (const r of rows) for (const [label, field] of FIELDS) {
    const url = r[field];
    if (!url) { tasks.push({ name: r.name, label, url: '', pre: 'EMPTY' }); continue; }
    if (!/^https?:\/\//.test(url) || /\s/.test(url)) { tasks.push({ name: r.name, label, url, pre: 'MALFORMED' }); continue; }
    tasks.push({ name: r.name, label, url });
  }

  const dead = [], unverified = [], malformed = [], empty = [];
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const task = tasks[next++];
      if (task.pre === 'EMPTY') { empty.push(task); continue; }
      if (task.pre === 'MALFORMED') { malformed.push(task); continue; }
      const r = await check(task.url);
      if (r.state === 'DEAD') dead.push({ ...task, code: r.code });
      else if (r.state === 'UNVERIFIED') unverified.push({ ...task, code: r.code });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const show = (arr) => arr.forEach(t => console.log(`  • ${t.name} [${t.label}] ${t.code ? '(' + t.code + ') ' : ''}${t.url || ''}`));

  console.log(`\n===== MALFORMED (${malformed.length}) — fix these =====`); show(malformed);
  console.log(`\n===== DEAD (${dead.length}) — clear 404/410, definitely broken =====`); show(dead);
  console.log(`\n===== EMPTY (${empty.length}) — no link set =====`); show(empty);
  console.log(`\n===== UNVERIFIED (${unverified.length}) — blocked/timeout, CHECK MANUALLY in a browser =====`); show(unverified);

  console.log(`\nSummary: ${dead.length} dead, ${malformed.length} malformed, ${empty.length} empty, ${unverified.length} unverified.`);
  if (dead.length || malformed.length) process.exit(1);
}
main();
