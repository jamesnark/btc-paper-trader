// features.js - the "senses" every evolved model can use.
// Same code runs in the backtest/evolution AND live, so a model sees the world
// exactly the same way in both places.
//
// Input arrays are 1-minute data, oldest first, ending at the last minute that
// fully closed BEFORE the decision. Needs at least 241 minutes.

export const FEATURES = [
  { key: 'mom5',      label: 'BTC move, last 5 min' },
  { key: 'mom15',     label: 'BTC move, last 15 min' },
  { key: 'mom60',     label: 'BTC move, last hour' },
  { key: 'mom240',    label: 'BTC move, last 4 hours' },
  { key: 'volRegime', label: 'volatility vs. normal' },
  { key: 'rangePos',  label: 'where BTC sits in its last-hour range' },
  { key: 'volSurge',  label: 'trading volume surge' },
  { key: 'ethLead',   label: 'ETH moving ahead of BTC' },
  { key: 'eth15',     label: 'ETH move, last 15 min' },
  { key: 'hourSin',   label: 'time of day (cycle A)' },
  { key: 'hourCos',   label: 'time of day (cycle B)' },
  { key: 'usHours',   label: 'US stock market open' },
  { key: 'weekend',   label: 'weekend' },
];
export const NF = FEATURES.length;
export const FI = Object.fromEntries(FEATURES.map((f, i) => [f.key, i]));
export const MIN_MINUTES = 241;

const clip = (x, lo = -3, hi = 3) => (Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : 0);

function sdLogRet(c, k) {
  const n = c.length;
  let s = 0;
  for (let i = n - k; i < n; i++) { const r = Math.log(c[i] / c[i - 1]); s += r * r; }
  return Math.sqrt(s / k) || 1e-6;
}

const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23',
});
export function etParts(ts) {
  const p = Object.fromEntries(etFmt.formatToParts(new Date(ts * 1000)).map(x => [x.type, x.value]));
  return { hour: +p.hour, minute: +p.minute, weekday: p.weekday };
}

// btcC/btcV/ethC: arrays of closes/volumes. windowStart: unix seconds the window opens.
export function computeFeatures(btcC, btcV, ethC, windowStart) {
  const n = btcC.length;
  if (n < MIN_MINUTES || ethC.length < 16) return null;
  const sd60 = sdLogRet(btcC, 60), sd240 = sdLogRet(btcC, 240);
  const mom = (c, k, sd) => Math.log(c[c.length - 1] / c[c.length - 1 - k]) / (sd * Math.sqrt(k));

  const last60 = btcC.slice(-60);
  const hi = Math.max(...last60), lo = Math.min(...last60);
  const rangePos = hi > lo ? ((btcC[n - 1] - lo) / (hi - lo) - 0.5) * 2 : 0;

  let v15 = 0, v240 = 0;
  for (let i = n - 240; i < n; i++) { v240 += btcV[i] || 0; if (i >= n - 15) v15 += btcV[i] || 0; }
  const volSurge = Math.log((v15 + 1e-6) / (v240 / 16 + 1e-6));

  const ethSd = sdLogRet(ethC, Math.min(60, ethC.length - 1));
  const btc5 = mom(btcC, 5, sd60), eth5 = mom(ethC, 5, ethSd);

  const { hour, minute, weekday } = etParts(windowStart);
  const h = hour + minute / 60;
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  const us = !isWeekend && h >= 9.5 && h < 16;

  return [
    clip(btc5),
    clip(mom(btcC, 15, sd60)),
    clip(mom(btcC, 60, sd60)),
    clip(mom(btcC, 240, sd240)),
    clip(Math.log(sd60 / sd240) * 3),
    clip(rangePos, -1, 1),
    clip(volSurge),
    clip(eth5 - btc5),
    clip(mom(ethC, 15, ethSd)),
    Math.sin((2 * Math.PI * h) / 24),
    Math.cos((2 * Math.PI * h) / 24),
    us ? 1 : 0,
    isWeekend ? 1 : 0,
  ];
}
