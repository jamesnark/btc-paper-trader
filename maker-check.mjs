// maker-check.mjs - would fee-free orders have worked on the ensemble's recent out-of-sample bets?
// Usage: node maker-check.mjs out/evolution.json out/maker.json
//
// For each bet the walk-forward ensemble made in the last ~3 weeks (bets it made blind),
// pretend we posted a buy order at the bid instead of paying the ask + fee, then check
// Polymarket's real trade record to see if it would have filled before we'd cancel it
// (3 minutes into the window). Fills only count if a trade went strictly through our price.
import fs from 'node:fs';
import { getMarket, getTrades, makerFillVolume, MAKER_CANCEL_AFTER } from './lib.js';

const evo = JSON.parse(fs.readFileSync(process.argv[2] || 'evolution.json', 'utf8'));
const out = process.argv[3] || 'maker.json';
const bets = (evo.recentBets || []).slice(-400);
const STAKE = 10;
const res = [];
let i = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (i < bets.length) {
    const b = bets[i++];
    try {
      const m = await getMarket(b.s);
      if (!m?.conditionId) continue;
      const trades = await getTrades(m.conditionId);
      const sideMid = b.side === 'Up' ? b.mid : 1 - b.mid;
      const limit = Math.floor((sideMid - 0.005) * 100 + 1e-6) / 100; // join the best bid (1¢ spread assumed)
      const [upTok, downTok] = m.tokens;
      const tok = b.side === 'Up' ? upTok : downTok, other = b.side === 'Up' ? downTok : upTok;
      const shares = STAKE / limit;
      const vol = makerFillVolume(trades, tok, other, limit, b.s - b.lead, b.s + MAKER_CANCEL_AFTER);
      const filled = Math.min(shares, vol);
      res.push({ s: b.s, side: b.side, won: b.won, takerCost: b.cost, limit, fillRate: filled / shares, filled,
        takerPnl: b.won ? STAKE * (1 - b.cost) / b.cost : -STAKE, makerPnl: b.won ? filled * (1 - limit) : -filled * limit });
    } catch { /* skip */ }
  }
}));
res.sort((a, b) => a.s - b.s);
const sum = (a, k) => a.reduce((t, x) => t + x[k], 0);
const any = res.filter(r => r.filled > 0), full = res.filter(r => r.fillRate > 0.999), none = res.filter(r => r.filled === 0);
const wr = a => a.length ? +(a.filter(r => r.won).length / a.length).toFixed(4) : null;
const makerStaked = res.reduce((t, r) => t + r.filled * r.limit, 0);
const summary = {
  createdAt: Math.floor(Date.now() / 1000), evoId: evo.id, bets: res.length,
  from: res[0]?.s ?? null, to: res.at(-1)?.s ?? null,
  avgFillRate: res.length ? +(sum(res, 'fillRate') / res.length).toFixed(4) : null,
  anyFill: any.length, fullFill: full.length, noFill: none.length,
  winRate: { all: wr(res), filled: wr(any), unfilled: wr(none) },
  taker: { pnl: +sum(res, 'takerPnl').toFixed(2), staked: STAKE * res.length, roi: res.length ? +(sum(res, 'takerPnl') / (STAKE * res.length) * 100).toFixed(2) : null },
  maker: { pnl: +sum(res, 'makerPnl').toFixed(2), staked: +makerStaked.toFixed(2), roi: makerStaked ? +(sum(res, 'makerPnl') / makerStaked * 100).toFixed(2) : null },
};
fs.writeFileSync(out, JSON.stringify(summary));
console.log(JSON.stringify(summary));
