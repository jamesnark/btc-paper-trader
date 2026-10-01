// arena.js - evolved champions compete LIVE, on data that didn't exist when they were born.
// Each member: own $1,000 pretend bankroll, half-Kelly sizing (max 20% per bet).
// Every new evolution run (weekly): the worst member with 50+ graded bets (or anyone broke)
// is retired and replaced by the best new champion. Members only survive by being good on the future.
import { START_BANK, MIN_SHARES } from './lib.js';
import { genomeDecision, betFraction } from './genome.js';

export const ARENA_SIZE = 5;
export const MIN_BETS_TO_JUDGE = 50;
export const MIN_LEAD = 300; // training decided 10 min early; only bet live with >= 5 min to spare

const pendingOf = (state, id) => state.rounds.filter(r => !r.outcome && r.arena?.[id]?.cost).reduce((a, r) => a + r.arena[id].cost, 0);
export const equityOf = (state, m) => m.cash + pendingOf(state, m.id);

export function syncArena(state, evo, now) {
  if (!evo || !evo.tribes?.length) return [];
  state.arena ??= { members: [], retired: [], evoId: null, equity: [], log: [] };
  const A = state.arena;
  if (A.evoId === evo.id) return [];
  const born = new Date(evo.createdAt * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  const mk = t => ({
    id: `${evo.id}-t${t.tribe}`, name: `Tribe ${t.tribe} (${born})`, genome: t.genome, desc: t.desc,
    born: now, evoId: evo.id, testVerdict: t.verdict, testAtBirth: { winRate: t.test.winRate, roi: t.test.roi, bets: t.test.bets },
    cash: START_BANK, bets: 0, wins: 0,
  });
  const ranked = [...evo.tribes].filter(t => t.test.bets >= 20).sort((x, y) => y.test.roi - x.test.roi);
  const events = [];
  if (A.members.length < ARENA_SIZE) {
    for (const t of ranked) {
      if (A.members.length >= ARENA_SIZE) break;
      A.members.push(mk(t)); events.push(`joined: ${A.members.at(-1).name}`);
    }
  } else {
    const judged = A.members.filter(m => m.bets >= MIN_BETS_TO_JUDGE || equityOf(state, m) < 3);
    if (judged.length && ranked.length) {
      const worst = judged.reduce((w, m) => (equityOf(state, m) < equityOf(state, w) ? m : w));
      worst.retiredAt = now; worst.finalEquity = +equityOf(state, worst).toFixed(2);
      A.members = A.members.filter(m => m !== worst);
      A.retired.push(worst);
      const fresh = mk(ranked[0]);
      A.members.push(fresh);
      events.push(`eliminated: ${worst.name} at $${worst.finalEquity}`, `joined: ${fresh.name}`);
    } else events.push('no one has 50+ bets yet; nobody eliminated');
  }
  A.evoId = evo.id;
  A.log.unshift(...events.map(m => ({ t: now, m })));
  A.log = A.log.slice(0, 50);
  return events;
}

// Place arena bets for a new round. fill(side, dollars) -> {shares, cost}
export function arenaBets(state, round, f, fill) {
  const A = state.arena;
  if (!A?.members?.length || !f) return;
  round.arena = {};
  for (const m of A.members) {
    const d = genomeDecision(m.genome, f, round.upMid, round.upAsk, round.downAsk, round.feeRate);
    const entry = { p: +d.pUp.toFixed(4) };
    if (d.bet && round.leadSec >= MIN_LEAD) {
      let dollars = m.cash * betFraction(d.bet.kelly);
      const minCost = MIN_SHARES * d.bet.cost;
      if (dollars < minCost) dollars = m.cash >= minCost ? minCost : 0;
      if (dollars > 0) {
        const got = fill(d.bet.side, dollars);
        if (got.shares) {
          m.cash -= got.cost;
          Object.assign(entry, { side: d.bet.side, ask: d.bet.ask, edge: +d.bet.edge.toFixed(4), cost: +got.cost.toFixed(4), shares: +got.shares.toFixed(4) });
        }
      }
    } else if (d.bet) entry.skipped = 'too close to start';
    round.arena[m.id] = entry;
  }
}

export function arenaSettle(state, round, outcome, t) {
  if (!round.arena || !state.arena) return;
  const all = [...state.arena.members, ...state.arena.retired];
  for (const [id, a] of Object.entries(round.arena)) {
    if (!a.cost) continue;
    const m = all.find(x => x.id === id);
    if (!m) continue;
    const payout = outcome === 'void' ? a.cost : (a.side === outcome ? a.shares : 0);
    a.pnl = +(payout - a.cost).toFixed(4);
    m.cash += payout;
    if (outcome !== 'void') { m.bets++; if (a.side === outcome) m.wins++; }
  }
  const pt = { t };
  for (const m of state.arena.members) pt[m.id] = +equityOf(state, m).toFixed(2);
  state.arena.equity.push(pt);
}
