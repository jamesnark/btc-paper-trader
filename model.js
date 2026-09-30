// model.js - THIS IS THE PART YOU IMPROVE.
//
// Job: given recent Bitcoin prices, return the probability (0 to 1) that
// BTC finishes the NEXT 15-minute Polymarket window "Up".
//
// Input: `candles` = 1-minute Coinbase candles, oldest first, all fully
// closed before the decision time. Each one looks like:
//   { t: 1790794800, open: 83850.4, high: 83909.4, low: 83831.2, close: 83874.1, volume: 6.7 }
// You get the last ~120 minutes.
//
// Output: a number like 0.54 (= "54% chance of Up").
//
// Rules the simulator enforces, so you can't cheat by accident:
//   - It only ever sees candles from BEFORE it decides.
//   - It only "bets" when your probability beats the market price + fee.
//     Saying 0.51 when the market charges 0.51 + fee = no bet.
//   - Being overconfident gets punished: Kelly sizing bets bigger when you
//     claim a bigger edge, so a model that says 0.70 and is wrong loses big.

export const MODEL_NAME = 'Momentum v1 (placeholder)';

export function predictUp(candles) {
  const closes = candles.map(c => c.close);
  const n = closes.length;
  if (n < 61) return 0.5; // not enough data -> no opinion

  // How much does BTC normally move per minute lately? (volatility)
  const rets = [];
  for (let i = n - 60; i < n; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const sd = Math.sqrt(rets.reduce((a, r) => a + r * r, 0) / rets.length) || 1e-6;

  // Recent move, measured in "normal-sized moves" (a z-score).
  const move = k => Math.log(closes[n - 1] / closes[n - 1 - k]);
  const z15 = move(15) / (sd * Math.sqrt(15)); // last 15 minutes
  const z60 = move(60) / (sd * Math.sqrt(60)); // last hour

  // Momentum bet: if it's been going up, lean Up (and vice versa).
  // tanh squashes huge moves so one spike can't make it crazy-confident.
  const score = 0.6 * Math.tanh(z15 / 2) + 0.4 * Math.tanh(z60 / 2); // -1..1

  // Max confidence 58%. Honest starting point: 15-min BTC moves are close
  // to a coin flip, so a model claiming 80% is almost certainly lying.
  return 0.5 + 0.08 * score;
}
