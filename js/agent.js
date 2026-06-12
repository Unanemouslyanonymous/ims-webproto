/* ============================================================
 * Q-learning agent — the heart of the Intelligent Meta Scheduler.
 *
 * State  : (processType, cpuLoadBucket, gpuLoadBucket, nvmeLoadBucket)
 * Action : which resource column to dispatch to (CPU | GPU | NVME)
 * Reward : weighted blend of throughput, efficiency, security, hw health
 *
 * Tabular Q with epsilon-greedy exploration and decay. The table is
 * small (4 types x 27 load combos x 3 actions) so convergence is
 * visible live during a demo.
 * ============================================================ */
(function () {
  const IMS = window.IMS;

  function bucket(load) {
    return load < 0.34 ? 0 : load < 0.67 ? 1 : 2;
  }

  IMS.encodeState = function (procType, loads) {
    return (
      procType + ':' +
      bucket(loads.CPU) + bucket(loads.GPU) + bucket(loads.NVME)
    );
  };

  class QAgent {
    constructor(cfg) {
      this.cfg = cfg;
      this.reset();
    }

    reset() {
      this.q = new Map();
      this.visits = new Map();
      this.eps = this.cfg.epsilon;
      this.decisions = 0;
      this.updates = 0;
    }

    getQ(s, a) {
      const v = this.q.get(s + '|' + a);
      return v === undefined ? 0 : v;
    }

    bestAction(s, actions) {
      let best = actions[0];
      let bestQ = -Infinity;
      for (const a of actions) {
        const q = this.getQ(s, a);
        if (q > bestQ) { bestQ = q; best = a; }
      }
      return { action: best, q: bestQ };
    }

    /* epsilon-greedy over the masked (non-full) actions */
    choose(state, actions, rng) {
      this.decisions++;
      this.eps = Math.max(this.cfg.epsilonMin, this.eps * this.cfg.epsilonDecay);
      if (rng() < this.eps) {
        return { action: actions[(rng() * actions.length) | 0], mode: 'EXPLORE' };
      }
      return { action: this.bestAction(state, actions).action, mode: 'EXPLOIT' };
    }

    /* one-step Q update fired when a process completes */
    update(s, a, r, s2, allActions) {
      const max2 = this.bestAction(s2, allActions).q;
      const old = this.getQ(s, a);
      const next = max2 === -Infinity ? 0 : max2;
      const td = r + this.cfg.gamma * next - old;
      const key = s + '|' + a;
      this.q.set(key, old + this.cfg.alpha * td);
      this.visits.set(key, (this.visits.get(key) || 0) + 1);
      this.updates++;
    }

    /* visit-weighted avg Q per (processType, action) — feeds the
       learned-policy heatmap; weighting by experience keeps rarely
       visited noisy states from distorting the picture */
    policyMatrix(types, actions) {
      const sums = {}, counts = {};
      for (const [key, v] of this.q) {
        const [s, a] = key.split('|');
        const type = s.split(':')[0];
        const k = type + '|' + a;
        const w = this.visits.get(key) || 1;
        sums[k] = (sums[k] || 0) + v * w;
        counts[k] = (counts[k] || 0) + w;
      }
      const m = {};
      for (const t of types) {
        m[t] = {};
        for (const a of actions) {
          const k = t + '|' + a;
          m[t][a] = counts[k] ? sums[k] / counts[k] : 0;
        }
      }
      return m;
    }
  }

  /* baseline policy for the shadow comparison — never waits, never learns */
  class RoundRobinPolicy {
    constructor() { this.i = 0; }
    choose(state, actions) {
      const cols = actions.filter((a) => a !== 'WAIT');
      this.i = (this.i + 1) % IMS.RES_KEYS.length;
      const pref = IMS.RES_KEYS[this.i];
      return {
        action: cols.includes(pref) ? pref : cols[this.i % cols.length],
        mode: 'RR',
      };
    }
  }

  IMS.QAgent = QAgent;
  IMS.RoundRobinPolicy = RoundRobinPolicy;
})();
