// dataset.mjs - build/refresh the training history (incremental: only fetches what's missing).
// Usage: node dataset.mjs out/dataset.json.gz [days=400] [budgetSeconds=0 (no limit)]
//
// Per 15-minute window: official result + the market's Up price every minute from
// 36 to 3 minutes before it opened. Plus 1-minute candles for:
//   BTC-USD and ETH-USD (Coinbase spot) and BTC-PERPETUAL (Deribit futures).
import { WINDOW, COINBASE, CLOB, GAMMA, getJSON } from './lib.js';
import { DS_VERSION, H_FROM, H_TO, H_LEN, loadDataset, saveDataset } from './dsio.js';

const out = process.argv[2] || 'dataset.json.gz';
const days = +(process.argv[3] || 400);
const budget = +(process.argv[4] || 0);
const T_START = Date.now();
const timeLeft = () => !budget || (Date.now() - T_START) / 1000 < budget;
const SERIES_ID = 10192; // "BTC Up or Down 15m"
const CANDLE_PAD = 320 * 60;

const now = Math.floor(Date.now() / 1000);
const lastStart = Math.floor(now / WINDOW) * WINDOW - 2 * WINDOW;
const firstWanted = lastStart - days * 96 * WINDOW;

const ds = loadDataset(out) || { version: DS_VERSION, windows: [], candles: null };
const byS = new Map(ds.windows.map(w => [w.s, w]));
const log = (...a) => console.log(`[${((Date.now() - T_START) / 1000).toFixed(0)}s]`, ...a);

async function pool(items, n, fn, label) {
  let i = 0, done = 0, fails = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length && timeLeft()) {
      const it = items[i++];
      try { await fn(it); } catch { fails++; }
      if (++done % 2000 === 0) log(`  ${label} ${done}/${items.length}${fails ? ` (${fails} failed, retried next run)` : ''}`);
    }
  }));
}

// ---------- 1. list markets in the series (100 per request, paged by start time) ----------
// First build lists everything; later runs re-list only the last 2 days (+ anything never finished).
const complete = ds.listComplete && ds.listedThrough;
const listFrom = complete ? Math.max(firstWanted, ds.listedThrough - 2 * 86400) : firstWanted;
const known = new Map();
{
  const ranges = [];
  const span = Math.max(WINDOW, Math.ceil((lastStart - listFrom) / 8 / WINDOW) * WINDOW);
  for (let a = listFrom; a <= lastStart; a += span) ranges.push([a, Math.min(a + span - WINDOW, lastStart)]);
  let allOk = true;
  await Promise.all(ranges.map(async ([a, b]) => {
    let cursor = a;
    try {
      while (cursor <= b) {
        if (!timeLeft()) { allOk = false; break; }
        const iso = new Date(cursor * 1000).toISOString().replace('.000Z', 'Z');
        const evs = await getJSON(`${GAMMA}/events?series_id=${SERIES_ID}&limit=100&order=startTime&ascending=true&start_time_min=${iso}`);
        if (!evs.length) break;
        let maxS = cursor;
        for (const e of evs) {
          const s = Math.floor(Date.parse(e.startTime) / 1000);
          if (!Number.isFinite(s) || s % WINDOW) continue;
          maxS = Math.max(maxS, s);
          const m = e.markets?.[0];
          if (!m || s > b) continue;
          const prices = JSON.parse(m.outcomePrices || '[]').map(Number);
          const outs = JSON.parse(m.outcomes || '["Up","Down"]');
          let o = null;
          if (m.closed && prices.length === 2) {
            if (prices[0] >= 0.99) o = outs[0] === 'Up' ? 1 : 0;
            else if (prices[1] >= 0.99) o = outs[1] === 'Up' ? 1 : 0;
          }
          known.set(s, { token: JSON.parse(m.clobTokenIds || '[]')[0], o });
        }
        if (maxS <= cursor) break;
        cursor = maxS + WINDOW;
      }
    } catch (e) { allOk = false; log(`listing ${new Date(a * 1000).toISOString()} failed: ${e.message}`); }
  }));
  if (allOk) { ds.listComplete = true; ds.listedThrough = lastStart; }
  log(`listed ${known.size} markets`);
}

// ---------- 2. per-window price history ----------
const need = [];
for (const [s, k] of known) {
  if (s < firstWanted || k.o == null || !k.token) continue;
  if (byS.get(s)?.h) continue;
  need.push([s, k]);
}
log(`price histories: have ${[...byS.values()].filter(w => w.h).length}, fetching ${need.length}`);
await pool(need, 16, async ([s, k]) => {
  const a = s - H_FROM - 600, b = s - H_TO;
  const h = await getJSON(`${CLOB}/prices-history?market=${k.token}&startTs=${a}&endTs=${b}&fidelity=1`, 3);
  const pts = (h.history || []).sort((x, y) => x.t - y.t);
  const arr = new Array(H_LEN).fill(-1);
  let j = 0, last = -1;
  for (let i = 0; i < H_LEN; i++) {
    const t = s - H_FROM + i * 60;
    while (j < pts.length && pts[j].t <= t) { last = Math.round(pts[j].p * 1000); j++; }
    arr[i] = last;
  }
  if (arr.every(x => x < 0)) return;
  byS.set(s, { s, o: k.o, h: arr });
}, 'histories');
ds.windows = [...byS.values()].filter(w => w.s >= firstWanted && w.h).sort((a, b) => a.s - b.s);

// ---------- 3. candles ----------
const cStart = Math.floor((firstWanted - H_FROM - CANDLE_PAD) / 60) * 60, cEnd = lastStart;
const N = Math.floor((cEnd - cStart) / 60) + 1;
const series = { btcC: new Float64Array(N).fill(NaN), btcV: new Float64Array(N), ethC: new Float64Array(N).fill(NaN), perpC: new Float64Array(N).fill(NaN) };
if (ds.candles) { // carry over what we already have (up to the last real candle)
  const o = ds.candles, off = Math.round((o.t0 - cStart) / 60);
  // older files didn't record lastReal; fall back to the last window start they covered (minus an hour, to be safe)
  const lastRealT = o.lastReal ?? ((ds.range?.lastStart ?? o.t0) - 3600);
  const realEnd = Math.round((lastRealT - o.t0) / 60);
  for (const k of Object.keys(series)) if (o[k]) for (let i = 0; i <= Math.min(realEnd, o[k].length - 1); i++) { const j = i + off; if (j >= 0 && j < N) series[k][j] = o[k][i]; }
}
const idx = t => Math.round((t - cStart) / 60);
for (const [key, vkey, product] of [['btcC', 'btcV', 'BTC-USD'], ['ethC', null, 'ETH-USD']]) {
  const chunks = [];
  for (let s = cStart; s <= cEnd; s += 300 * 60) {
    const e = Math.min(s + 299 * 60, cEnd);
    let miss = 0; for (let t = s; t <= e; t += 60) if (Number.isNaN(series[key][idx(t)])) miss++;
    if (miss > 3) chunks.push([s, e]);
  }
  log(`${product}: fetching ${chunks.length} chunks`);
  await pool(chunks, 6, async ([s, e]) => {
    const iso = x => new Date(x * 1000).toISOString();
    const rows = await getJSON(`${COINBASE}/products/${product}/candles?granularity=60&start=${iso(s)}&end=${iso(e)}`);
    for (const [t, , , , close, vol] of rows) { const j = idx(t); if (j >= 0 && j < N) { series[key][j] = close; if (vkey) series[vkey][j] = vol; } }
  }, product);
}
{
  const chunks = [];
  for (let s = cStart; s <= cEnd; s += 4900 * 60) {
    const e = Math.min(s + 4899 * 60, cEnd);
    let miss = 0; for (let t = s; t <= e; t += 60) if (Number.isNaN(series.perpC[idx(t)])) miss++;
    if (miss > 10) chunks.push([s, e]);
  }
  log(`Deribit BTC-PERPETUAL: fetching ${chunks.length} chunks`);
  await pool(chunks, 4, async ([s, e]) => {
    const r = await getJSON(`https://www.deribit.com/api/v2/public/get_tradingview_chart_data?instrument_name=BTC-PERPETUAL&resolution=1&start_timestamp=${s * 1000}&end_timestamp=${e * 1000}`);
    const res = r.result; if (!res?.ticks) return;
    res.ticks.forEach((ms, i) => { const j = idx(ms / 1000); if (j >= 0 && j < N) series.perpC[j] = res.close[i]; });
  }, 'perp');
}
// forward-fill gaps (a missing minute = price unchanged, no volume)
let lastReal = cStart;
for (let i = 0; i < N; i++) if (!Number.isNaN(series.btcC[i])) lastReal = cStart + i * 60;
const gaps = {};
for (const k of ['btcC', 'ethC', 'perpC']) {
  const a = series[k]; let first = a.findIndex(x => !Number.isNaN(x)); if (first < 0) first = 0;
  gaps[k] = a.reduce((n, x) => n + (Number.isNaN(x) ? 1 : 0), 0);
  for (let i = 0; i < first; i++) a[i] = a[first] || 0;
  for (let i = 1; i < N; i++) if (Number.isNaN(a[i])) a[i] = a[i - 1];
}
ds.candles = { t0: cStart, ...series, lastReal };
ds.builtAt = now;
ds.range = { firstWanted, lastStart };
saveDataset(out, ds);
const usable = ds.windows.filter(w => w.h && w.o != null).length;
log(`dataset: ${usable} windows (${(usable / 96).toFixed(0)} days), ${N} minutes of candles, gaps ${JSON.stringify(gaps)}${timeLeft() ? '' : ' [time budget hit, will continue next run]'}`);
