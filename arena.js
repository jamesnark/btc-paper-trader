// arena.js (v2) - models compete LIVE on windows that didn't exist when they were built.
// Each member: own $1,000 pretend bankroll, half-Kelly sizing (max 20% per bet).
//   kind 'genome'   = a single evolved champion (v1 members)
//   kind 'ensemble' = calibrated vote of the latest champions (v2)
//   exec 'taker'    = buys at the ask and pays the fee
//   exec 'maker'    = posts a fee-free order at the bid; only fills if the market trades through it
// Every evolution run adds a new ensemble pair (taker + maker). If that pushes the arena over
// 8 members, the worst member with 50+ bets (or anyone broke) is eliminated; if nobody has
// 50 bets yet, the oldest retires to make room.
import { START_BANK, MIN_SHARES } from './lib.js';
import { genomeDecision, ensembleDecision, betFraction, describe } from './genome.js';

export const ARENA_CAP = 8;
export const MIN_BETS_TO_JUDGE = 50;
export const MIN_LEAD = 150; // v2 models are trained on decisions 4-10 min early

const pendingOf = (state, id) => state.rounds.filter(r => !r.outcome && r.arena?.[id]?.cost).reduce((a, r) => a + r.arena[id].cost, 0);
export const equityOf = (state, m) => m.cash + pendingOf(state, m.id);

export function syncArena(state, evo, now) {
  if (!evo) return [];
  state.arena ??= { members: [], retired: [], evoId: null, equity: [], log: [] };
  const A = state.arena;
  if (A.evoId === evo.id) return [];
  const born = new Date(evo.createdAt * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  const newcomers = [];
  if (evo.version === 2 && evo.production?.ensemble) {
    const E = evo.production.ensemble;
    const desc = `Vote of ${E.members.length} champions, calibrated (keeps ${(E.k * 100).toFixed(0)}% of their disagreement with the market). Needs ${(E.minEdge * 100).toFixed(1)}¢ edge.`;
    const birth = { winRate: evo.oos.winRate, roi: evo.oos.roi / 100, bets: evo.oos.bets, label: `${evo.oos.weeks}-week walk-forward` };
    const rawBirth = { winRate: evo.oos.raw.winRate, roi: evo.oos.raw.roi / 100, bets: evo.oos.raw.bets, label: `${evo.oos.weeks}-week walk-forward` };
    const variants = [
      { key: 'taker', exec: 'taker', E, name: '', desc, birth },
      { key: 'maker', exec: 'maker', E, name: ' fee-free', desc: desc + ' Posts fee-free orders at the bid.', birth },
      // Same vote at full confidence. In blind testing it beat the calibrated one; live decides if that was luck.
      { key: 'raw', exec: 'taker', E: { ...E, k: 1 }, name: ' uncalibrated', desc: `Same vote of ${E.members.length} champions at full confidence (no calibration). Needs ${(E.minEdge * 100).toFixed(1)}¢ edge.`, birth: rawBirth },
    ];
    for (const v of variants) newcomers.push({
      id: `${evo.id}-ens-${v.key}`, name: `Ensemble (${born})${v.name}`, kind: 'ensemble', exec: v.exec,
      ensemble: v.E, desc: v.desc, born: now, evoId: evo.id, testVerdict: evo.verdict, testAtBirth: v.birth,
      cash: START_BANK, bets: 0, wins: 0, orders: 0, fillSum: 0,
    });
  } else if (evo.tribes?.length) { // v1 evolution file
    const ranked = [...evo.tribes].filter(t => t.test.bets >= 20).sort((x, y) => y.test.roi - x.test.roi);
    for (const t of ranked.slice(0, 5)) newcomers.push({
      id: `${evo.id}-t${t.tribe}`, name: `Tribe ${t.tribe} (${born})`, kind: 'genome', exec: 'taker', genome: t.genome, desc: t.desc,
      born: now, evoId: evo.id, testVerdict: t.verdict, testAtBirth: { winRate: t.test.winRate, roi: t.test.roi, bets: t.test.bets }, cash: START_BANK, bets: 0, wins: 0,
    });
  }
  const events = [];
  for (const m of newcomers) { A.members.push(m); events.push(`joined: ${m.name}`); }
  while (A.members.length > ARENA_CAP) {
    const old = A.members.filter(m => !newcomers.includes(m));
    const judged = old.filter(m => m.bets >= MIN_BETS_TO_JUDGE || equityOf(state, m) < 3);
    let out, why;
    if (judged.length) { out = judged.reduce((w, m) => (equityOf(state, m) < equityOf(state, w) ? m : w)); why = 'eliminated (worst bankroll)'; }
    else { out = old.reduce((o, m) => (m.born < o.born ? m : o)); why = 'retired to make room (oldest)'; }
    out.retiredAt = now; out.finalEquity = +equityOf(state, out).toFixed(2); out.retireReason = why;
    A.members = A.members.filter(m => m !== out); A.retired.push(out);
    events.push(`${why}: ${out.name} at $${out.finalEquity}`);
  }
  A.evoId = evo.id;
  A.log.unshift(...events.map(m => ({ t: now, m })));
  A.log = A.log.slice(0, 50);
  return events;
}

// Place arena bets for a new round.
// books = {Up: {bestBid,bestAsk}, Down: {...}}; fill(side, dollars) -> {shares, cost} for taker orders.
export function arenaBets(state, round, f, books, fill) {
  const A = state.arena;
  if (!A?.members?.length || !f) return;
  round.arena = {};
  for (const m of A.members) {
    const d = m.kind === 'ensemble'
      ? ensembleDecision(m.ensemble, f, round.upMid, round.upAsk, round.downAsk, round.feeRate)
      : genomeDecision(m.genome, f, round.upMid, round.upAsk, round.downAsk, round.feeRate);
    const entry = { p: +d.pUp.toFixed(4) };
    round.arena[m.id] = entry;
    if (!d.bet) continue;
    if (round.leadSec < MIN_LEAD) { entry.skipped = 'too close to start'; continue; }
    let dollars = m.cash * betFraction(d.bet.kelly);
    if (m.exec === 'maker') {
      const b = books[d.bet.side];
      if (b?.bestBid == null || b?.bestAsk == null) { entry.skipped = 'no book'; continue; }
      const limit = +(b.bestAsk - b.bestBid > 0.011 ? b.bestBid + 0.01 : b.bestBid).toFixed(3);
      if (dollars < MIN_SHARES * limit) dollars = m.cash >= MIN_SHARES * limit ? MIN_SHARES * limit : 0;
      if (!dollars) continue;
      m.cash -= dollars;
      Object.assign(entry, { exec: 'maker', side: d.bet.side, ask: d.bet.ask, limit, edge: +d.bet.edge.toFixed(4), reserved: +dollars.toFixed(4), cost: +dollars.toFixed(4), shares: +(dollars / limit).toFixed(4) });
    } else {
      const minCost = MIN_SHARES * d.bet.cost;
      if (dollars < minCost) dollars = m.cash >= minCost ? minCost : 0;
      if (!dollars) continue;
      const got = fill(d.bet.side, dollars);
      if (!got.shares) { entry.skipped = 'no liquidity'; continue; }
      m.cash -= got.cost;
      Object.assign(entry, { side: d.bet.side, ask: d.bet.ask, edge: +d.bet.edge.toFixed(4), cost: +got.cost.toFixed(4), shares: +got.shares.toFixed(4) });
    }
  }
}

export const hasMakerOrders = round => Object.values(round.arena || {}).some(a => a.exec === 'maker' && a.reserved);

// fillVol(entry) -> shares that traded through that maker order (only called for maker entries)
export function arenaSettle(state, round, outcome, t, fillVol) {
  if (!round.arena || !state.arena) return;
  const all = [...state.arena.members, ...state.arena.retired];
  for (const [id, a] of Object.entries(round.arena)) {
    if (!a.cost && !a.reserved) continue;
    const m = all.find(x => x.id === id);
    if (!m) continue;
    if (a.exec === 'maker') {
      const filled = outcome === 'void' ? 0 : Math.min(a.shares, fillVol ? fillVol(a) : 0);
      const cost = filled * a.limit;
      const payout = (a.reserved - cost) + (outcome !== 'void' && a.side === outcome ? filled : 0);
      Object.assign(a, { filled: +filled.toFixed(4), fillRate: +(filled / a.shares).toFixed(3), cost: +cost.toFixed(4), pnl: +(payout - a.reserved).toFixed(4) });
      m.cash += payout;
      if (outcome !== 'void') { m.orders = (m.orders || 0) + 1; m.fillSum = (m.fillSum || 0) + a.fillRate; }
      if (filled > 0 && outcome !== 'void') { m.bets++; if (a.side === outcome) m.wins++; }
    } else {
      const payout = outcome === 'void' ? a.cost : (a.side === outcome ? a.shares : 0);
      a.pnl = +(payout - a.cost).toFixed(4);
      m.cash += payout;
      if (outcome !== 'void') { m.bets++; if (a.side === outcome) m.wins++; }
    }
  }
  const pt = { t };
  for (const m of state.arena.members) pt[m.id] = +equityOf(state, m).toFixed(2);
  state.arena.equity.push(pt);
}

export { describe };
