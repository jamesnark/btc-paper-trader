// dsio.js - read/write the compressed training dataset (dataset.json.gz).
// Prices are stored as small integer differences ("delta encoding") so a year
// of 1-minute candles gzips down to a few MB.
import fs from 'node:fs';
import zlib from 'node:zlib';

export const DS_VERSION = 2;
export const H_FROM = 2160; // window price history starts 36 min before the window opens...
export const H_TO = 180;    // ...and ends 3 min before. One sample per minute.
export const H_LEN = (H_FROM - H_TO) / 60 + 1; // 34 samples

const enc = (arr, scale) => {
  const out = new Array(arr.length); let prev = 0;
  for (let i = 0; i < arr.length; i++) { const v = Math.round(arr[i] * scale); out[i] = v - prev; prev = v; }
  return out;
};
const dec = (arr, scale) => {
  const out = new Float64Array(arr.length); let v = 0;
  for (let i = 0; i < arr.length; i++) { v += arr[i]; out[i] = v / scale; }
  return out;
};
const SCALES = { btcC: 100, btcV: 1000, ethC: 100, perpC: 10 };

export function saveDataset(path, ds) {
  const c = ds.candles;
  const packed = {
    ...ds,
    candles: { t0: c.t0, n: c.btcC.length, ...Object.fromEntries(Object.keys(SCALES).map(k => [k, c[k] ? enc(c[k], SCALES[k]) : null])) },
  };
  fs.writeFileSync(path, zlib.gzipSync(JSON.stringify(packed), { level: 9 }));
}

export function loadDataset(path) {
  if (!fs.existsSync(path)) return null;
  const ds = JSON.parse(zlib.gunzipSync(fs.readFileSync(path)).toString());
  if (ds.version !== DS_VERSION) return null;
  const c = ds.candles;
  if (c) ds.candles = { t0: c.t0, ...Object.fromEntries(Object.keys(SCALES).map(k => [k, c[k] ? dec(c[k], SCALES[k]) : null])) };
  return ds;
}

// Window price at time t (seconds), from the per-minute history h (ints x1000, -1 = missing).
export function priceAt(w, t) {
  const i = Math.floor((t - (w.s - H_FROM)) / 60);
  if (i < 0 || i >= w.h.length) return null;
  for (let k = i; k >= 0; k--) if (w.h[k] >= 0) return w.h[k] / 1000;
  return null;
}
