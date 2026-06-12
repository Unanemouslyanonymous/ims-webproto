/* Headless verification: run the engine in Node (no DOM) and assert
 * that the RL meta-scheduler learns to beat round-robin on identical
 * arrivals.  Usage: node tests/smoke.js
 */
const fs = require('fs');
const path = require('path');

global.window = {};
for (const f of ['config.js', 'agent.js', 'engine.js']) {
  eval(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'));
}
const IMS = global.window.IMS;

const SEED = 1337;
const TICKS = 30000;

const agent = new IMS.QAgent(IMS.CONFIG);
const rl = new IMS.Engine(SEED, 'rl', agent);
const rr = new IMS.Engine(SEED, 'rr', new IMS.RoundRobinPolicy());

for (let t = 0; t < TICKS; t++) {
  rl.step();
  rr.step();
  rl.events.length = 0;
  rr.events.length = 0;
}

const fmt = (e) => ({
  completed: e.stats.completed,
  throughput: +e.throughput().toFixed(2),
  avgLatency: +e.avgLatency().toFixed(2),
  avgEff: +e.avgEff().toFixed(2),
  violations: e.stats.violations,
  rewardEMA: +e.stats.rewardEMA.toFixed(3),
});

console.log('RL :', fmt(rl));
console.log('RR :', fmt(rr));
console.log('agent: eps=%s decisions=%d qEntries=%d', agent.eps.toFixed(3), agent.decisions, agent.q.size);

console.log('\nLearned policy (avg Q per type x column):');
const m = agent.policyMatrix(IMS.PROC_KEYS, IMS.RES_KEYS);
for (const t of IMS.PROC_KEYS) {
  const row = IMS.RES_KEYS.map((k) => `${k}=${m[t][k].toFixed(2)}`).join('  ');
  const best = IMS.RES_KEYS.reduce((a, b) => (m[t][a] >= m[t][b] ? a : b));
  console.log(`  ${t.padEnd(9)} ${row}   -> prefers ${best}`);
}

/* assertions */
const fails = [];
if (rl.stats.completed <= rr.stats.completed)
  fails.push(`RL completed (${rl.stats.completed}) should exceed RR (${rr.stats.completed})`);
if (rl.avgEff() <= rr.avgEff())
  fails.push('RL efficiency should exceed RR');
if (rl.stats.violations > rr.stats.violations)
  fails.push(`RL violations (${rl.stats.violations}) should be <= RR (${rr.stats.violations})`);
const expectBest = { COMPUTE: 'CPU', PARALLEL: 'GPU', IO: 'NVME' };
for (const [t, want] of Object.entries(expectBest)) {
  const best = IMS.RES_KEYS.reduce((a, b) => (m[t][a] >= m[t][b] ? a : b));
  if (best !== want) fails.push(`policy for ${t} should prefer ${want}, got ${best}`);
}

if (fails.length) {
  console.error('\nFAIL:\n  ' + fails.join('\n  '));
  process.exit(1);
}
console.log('\nPASS — RL learns correct affinities and outperforms round-robin.');
