// dataset.mjs - build/refresh the history that evolution trains on.
// Usage: node dataset.mjs out/dataset.json [days=35]
// Only fetches what's missing, so weekly refreshes are quick.
import fs from 'node:fs';
import { WINDOW, COINBASE, CLOB, getJSON, getMarket, winnerOf } from './lib.js';

const out = process.argv[2] || 'dataset.json';
const days = +(process.argv[3] || 35);
export const LEAD = 600; // decisions are made 10 min before a window opens
const CANDLE_PAD = 300 * 60; // features need up to 4h+ of history before a decision

const now = Math.floor(Date.now() / 1000);
const lastStart = Math.floor(now / WINDOW) * WINDOW - 2 * WINDOW;
const firstStart = lastStart - days * 96 * WINDOW + WINDOW;

let ds = null;
try { ds = JSON.parse(fs.readFileSync(out, 'utf8')); } catch {}
if (!ds || ds.version !== 1) ds = { version: 1, windows: [], candles: null };

async function pool(items, n, fn, label) {
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const it = items[i++];
      try { await fn(it); } catch (e) { /* skip; retried next refresh */ }
      if (++done % 250 === 0) console.log(`  ${label} ${done}/${items.length}`);
    }
  }));
}

// ---------- windows ----------
const have = new Map(ds.windows.filter(w => w.s >= firstStart).map(w => [w.s, w]));
const need = [];
for (let s = firstStart; s <= lastStart; s += WINDOW) if (!have.has(s)) need.push(s);
console.log(`windows: have ${have.size}, fetching ${need.length}`);
await pool(need, 8, async s => {
  const m = await getMarket(s);
  if (!m) { have.set(s, { s, skip: 'no market' }); return; }
  const w = winnerOf(m);
  if (!w) return; // not resolved yet -> try again next time
  const at = s - LEAD;
  const h = await getJSON(`${CLOB}/prices-history?market=${m.tokens[0]}&startTs=${at - 1800}&endTs=${at}&fidelity=1`);
  const pts = (h.history || []).filter(p => p.t <= at);
  if (!pts.length) { have.set(s, { s, skip: 'no price' }); return; }
  have.set(s, { s, m: pts.at(-1).p, o: w === 'Up' ? 1 : 0, fr: m.feeRate });
}, 'windows');
ds.windows = [...have.values()].sort((a, b) => a.s - b.s);

// ---------- candles (BTC + ETH, 1-minute) ----------
const cStart = firstStart - LEAD - CANDLE_PAD, cEnd = lastStart;
const minutes = Math.floor((cEnd - cStart) / 60);
const maps = { btc: new Map(), eth: new Map() };
if (ds.candles) {
  const { t0, btcC, btcV, ethC } = ds.candles;
  btcC.forEach((c, i) => c != null && maps.btc.set(t0 + i * 60, [c, btcV[i]]));
  ethC.forEach((c, i) => c != null && maps.eth.set(t0 + i * 60, [c, 0]));
}
for (const [asset, product] of [['btc', 'BTC-USD'], ['eth', 'ETH-USD']]) {
  const chunks = [];
  for (let s = cStart; s < cEnd; s += 300 * 60) {
    const e = Math.min(s + 299 * 60, cEnd);
    let missing = 0;
    for (let t = s; t <= e; t += 60) if (!maps[asset].has(t)) missing++;
    if (missing > 5) chunks.push([s, e]);
  }
  console.log(`${asset} candles: fetching ${chunks.length} chunks`);
  await pool(chunks, 3, async ([s, e]) => {
    const iso = x => new Date(x * 1000).toISOString();
    const rows = await getJSON(`${COINBASE}/products/${product}/candles?granularity=60&start=${iso(s)}&end=${iso(e)}`);
    for (const [t, , , , close, vol] of rows) maps[asset].set(t, [close, vol]);
  }, asset);
}
const btcC = [], btcV = [], ethC = [];
let lb = null, le = null;
for (let i = 0; i <= minutes; i++) {
  const t = cStart + i * 60;
  const b = maps.btc.get(t), e = maps.eth.get(t);
  if (b) lb = b; if (e) le = e;
  btcC.push(lb ? +lb[0].toFixed(2) : null);
  btcV.push(b ? +b[1].toFixed(3) : 0); // a missing minute = no trades
  ethC.push(le ? +le[0].toFixed(3) : null);
}
ds.candles = { t0: cStart, btcC, btcV, ethC };
ds.builtAt = now;
ds.days = days;
ds.range = { firstStart, lastStart };
fs.writeFileSync(out, JSON.stringify(ds));
const usable = ds.windows.filter(w => w.m != null).length;
console.log(`dataset: ${usable} usable windows, ${minutes} minutes of candles, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
