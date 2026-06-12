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

IMS.applyPreset('nominal');
const agent = new IMS.QAgent(IMS.CONFIG);
const rl = new IMS.Engine(SEED, 'rl', agent);
const rr = new IMS.Engine(SEED, 'rr', new IMS.RoundRobinPolicy());

/* run a phase, counting where PARALLEL work physically lands */
function runPhase(ticks) {
  const parallelDispatch = { CPU: 0, GPU: 0, NVME: 0 };
  for (let t = 0; t < ticks; t++) {
    rl.step();
    rr.step();
    for (const ev of rl.events) {
      if (ev.kind === 'dispatch' && ev.proc.type === 'PARALLEL') {
        parallelDispatch[ev.unitId.split('-')[0]]++;
      }
    }
    rl.events.length = 0;
    rr.events.length = 0;
  }
  return parallelDispatch;
}

const phase1Parallel = runPhase(TICKS);

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

/* ============================================================
 * Phase 2 — environment shift: GPUs fail mid-run (XID preset).
 * The agent must notice through reward alone and reroute the
 * PARALLEL work it previously sent to the GPU column.
 * ============================================================ */
console.log('\n--- phase 2: applying 🧨 GPU Failure preset (live, mid-run) ---');
IMS.applyPreset('gpufail');
agent.eps = Math.max(agent.eps, 0.35); // re-exploration on fleet event
const completedBefore = { rl: rl.stats.completed, rr: rr.stats.completed };

const phase2Parallel = runPhase(TICKS);

const p1Total = Object.values(phase1Parallel).reduce((a, b) => a + b, 0);
const p2Total = Object.values(phase2Parallel).reduce((a, b) => a + b, 0);
const gpuShare1 = phase1Parallel.GPU / p1Total;
const gpuShare2 = phase2Parallel.GPU / p2Total;
const rlGain = rl.stats.completed - completedBefore.rl;
const rrGain = rr.stats.completed - completedBefore.rr;

console.log('PARALLEL placement, healthy GPUs :', phase1Parallel,
  `(${(gpuShare1 * 100).toFixed(0)}% on GPU)`);
console.log('PARALLEL placement, failed GPUs  :', phase2Parallel,
  `(${(gpuShare2 * 100).toFixed(0)}% on GPU)`);
console.log('phase-2 completions: RL=%d RR=%d', rlGain, rrGain);

if (gpuShare1 < 0.5)
  fails.push(`with healthy GPUs, PARALLEL should mostly go to GPU (got ${(gpuShare1 * 100).toFixed(0)}%)`);
if (gpuShare2 > 0.45)
  fails.push(`after GPU failure, agent should reroute PARALLEL away from GPU (still ${(gpuShare2 * 100).toFixed(0)}%)`);
if (rlGain <= rrGain)
  fails.push(`RL phase-2 completions (${rlGain}) should exceed RR (${rrGain})`);

if (fails.length) {
  console.error('\nFAIL:\n  ' + fails.join('\n  '));
  process.exit(1);
}
console.log('\nPASS — RL learns correct affinities, outperforms round-robin,');
console.log('       and adapts live when the hardware degrades under it.');
