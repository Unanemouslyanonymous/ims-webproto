/* ============================================================
 * Q-learning agent + all baseline scheduling policies.
 *
 * State  : (processType, cpuLoadBucket, gpuLoadBucket, nvmeLoadBucket)
 * Action : which resource column to dispatch to (CPU | GPU | NVME)
 * Reward : weighted blend of throughput, efficiency, security, hw health
 *
 * All policies share the same choose(state, actions, rng, ctx) signature.
 * ctx = { loads, proc, queue } — baseline policies may use it; RL ignores it.
 * Policies that reorder the queue implement sortQueue(queue).
 * ============================================================ */
(function () {
  const IMS = window.IMS;

  function bucket(load) {
    return load < 0.34 ? 0 : load < 0.67 ? 1 : 2;
  }

  IMS.encodeState = function (procType, loads, proc) {
    const loadStr = '' + bucket(loads.CPU) + bucket(loads.GPU) + bucket(loads.NVME);
    if (!proc || !proc.reqVec) return procType + ':' + loadStr;
    /* dominant resource fingerprint enriches state without state-space explosion */
    const r = proc.reqVec;
    const dom = r.io > 0.5 ? 'I' : r.parallelism > 0.5 ? 'P' : r.cpu > 0.5 ? 'C' : 'M';
    return procType + ':' + dom + ':' + loadStr;
  };

  /* ============================================================
   * RL AGENT — tabular Q-learning with epsilon-greedy exploration
   * ============================================================ */
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

    choose(state, actions, rng, _ctx) {
      this.decisions++;
      this.eps = Math.max(this.cfg.epsilonMin, this.eps * this.cfg.epsilonDecay);
      if (rng() < this.eps) {
        return { action: actions[(rng() * actions.length) | 0], mode: 'EXPLORE' };
      }
      return { action: this.bestAction(state, actions).action, mode: 'EXPLOIT' };
    }

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

    /* visit-weighted avg Q per (processType, action) */
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

    /* human-readable one-sentence summary of what the policy has learned */
    explain() {
      if (this.eps > 0.7) return `Still exploring — collecting experience about each workload (ε = ${this.eps.toFixed(2)}).`;
      const m = this.policyMatrix(IMS.PROC_KEYS, IMS.RES_KEYS);
      const sentences = IMS.PROC_KEYS.map((t) => {
        const best = IMS.RES_KEYS.reduce((a, b) => m[t][a] >= m[t][b] ? a : b);
        const second = IMS.RES_KEYS.filter((k) => k !== best).reduce((a, b) => m[t][a] >= m[t][b] ? a : b);
        const adv = m[t][best] - m[t][second];
        if (adv < 0.3) return `${t}: still settling`;
        return `${IMS.PROC_TYPES[t].icon} ${t} → ${best} (+${adv.toFixed(1)})`;
      });
      const exploit = ((1 - this.eps) * 100).toFixed(0);
      return `Policy: ${sentences.join(' · ')} · exploiting ${exploit}% of the time.`;
    }
  }

  /* ============================================================
   * BASELINE POLICIES — identical signature, never learn
   * ============================================================ */

  /* 1. Round-Robin: strict column rotation, ignores everything */
  class RoundRobinPolicy {
    constructor() { this.i = 0; }
    choose(state, actions, rng, _ctx) {
      const cols = actions.filter((a) => a !== 'WAIT');
      this.i = (this.i + 1) % IMS.RES_KEYS.length;
      const pref = IMS.RES_KEYS[this.i];
      return { action: cols.includes(pref) ? pref : cols[this.i % cols.length], mode: 'RR' };
    }
  }

  /* 2. Random: random column every time */
  class RandomPolicy {
    choose(state, actions, rng, _ctx) {
      const cols = actions.filter((a) => a !== 'WAIT');
      return { action: cols[(rng() * cols.length) | 0], mode: 'RANDOM' };
    }
  }

  /* 3. Least Loaded: always pick the column with the most free capacity */
  class LeastLoadedPolicy {
    choose(state, actions, rng, ctx) {
      const cols = actions.filter((a) => a !== 'WAIT');
      if (!ctx || !ctx.loads) return { action: cols[0], mode: 'LL' };
      let best = cols[0], bestLoad = Infinity;
      for (const k of cols) {
        if ((ctx.loads[k] ?? 1) < bestLoad) { bestLoad = ctx.loads[k]; best = k; }
      }
      return { action: best, mode: 'LEAST-LOAD' };
    }
  }

  /* 4. Priority: SECURE > COMPUTE > PARALLEL > I/O urgency ordering;
        within priority, dispatch to least-loaded column */
  class PriorityPolicy {
    constructor() { this.pri = { SECURE: 3, COMPUTE: 2, PARALLEL: 1, IO: 0 }; }
    sortQueue(queue) {
      queue.sort((a, b) => (this.pri[b.type] || 0) - (this.pri[a.type] || 0));
    }
    choose(state, actions, rng, ctx) {
      const cols = actions.filter((a) => a !== 'WAIT');
      if (!ctx || !ctx.loads) return { action: cols[0], mode: 'PRI' };
      let best = cols[0], bestLoad = Infinity;
      for (const k of cols) {
        if ((ctx.loads[k] ?? 1) < bestLoad) { bestLoad = ctx.loads[k]; best = k; }
      }
      return { action: best, mode: 'PRIORITY' };
    }
  }

  /* 5. Shortest Job First: sort queue by ascending work remaining;
        dispatch to least-loaded column — no affinity awareness */
  class ShortestJobFirstPolicy {
    sortQueue(queue) {
      queue.sort((a, b) => a.work - b.work);
    }
    choose(state, actions, rng, ctx) {
      const cols = actions.filter((a) => a !== 'WAIT');
      if (!ctx || !ctx.loads) return { action: cols[0], mode: 'SJF' };
      let best = cols[0], bestLoad = Infinity;
      for (const k of cols) {
        if ((ctx.loads[k] ?? 1) < bestLoad) { bestLoad = ctx.loads[k]; best = k; }
      }
      return { action: best, mode: 'SJF' };
    }
  }

  /* 6. Affinity Oracle: cheats — knows the exact physics model.
        Upper bound. Uses computeAffinity() directly with the job's reqVec
        to pick the best perf-per-watt column. Adapts live to spec changes. */
  class AffinityOraclePolicy {
    choose(state, actions, rng, ctx) {
      const cols = actions.filter((a) => a !== 'WAIT');
      if (!ctx || !ctx.proc) return { action: cols[0], mode: 'ORACLE' };
      let best = cols[0], bestScore = -Infinity;
      for (const k of cols) {
        const s = IMS.RES_SPECS[k];
        const score = IMS.computeAffinity(ctx.proc, k) * s.baseSpeed / s.activeW;
        if (score > bestScore) { bestScore = score; best = k; }
      }
      return { action: best, mode: 'ORACLE' };
    }
  }

  /* ============================================================
   * Algorithm registry — drives the benchmark table
   * ============================================================ */
  IMS.ALGO_DEFS = [
    {
      key: 'rl',     label: 'RL IMS',          color: '#4da3ff',
      desc: 'Q-learning · learns from reward alone', isRL: true,
      makePolicy: null, // supplied by main.js (the live QAgent)
    },
    {
      key: 'oracle', label: 'Affinity Oracle',  color: '#ffd700',
      desc: 'cheats — knows affinity table (upper bound ★)',
      makePolicy: () => new AffinityOraclePolicy(),
    },
    {
      key: 'll',     label: 'Least Loaded',     color: '#3ddc84',
      desc: 'always fills the emptiest column',
      makePolicy: () => new LeastLoadedPolicy(),
    },
    {
      key: 'pri',    label: 'Priority',         color: '#ffb648',
      desc: 'SECURE › COMPUTE › PARALLEL › I/O + least loaded',
      makePolicy: () => new PriorityPolicy(),
    },
    {
      key: 'sjf',    label: 'SJF',              color: '#c084fc',
      desc: 'shortest job first · least-loaded column',
      makePolicy: () => new ShortestJobFirstPolicy(),
    },
    {
      key: 'rr',     label: 'Round-Robin',      color: '#8892aa',
      desc: 'strict column rotation — the classic baseline',
      makePolicy: () => new RoundRobinPolicy(),
    },
    {
      key: 'rand',   label: 'Random',           color: '#ff5566',
      desc: 'random column — chaos lower bound',
      makePolicy: () => new RandomPolicy(),
    },
  ];

  IMS.QAgent           = QAgent;
  IMS.RoundRobinPolicy = RoundRobinPolicy;
  IMS.RandomPolicy     = RandomPolicy;
  IMS.LeastLoadedPolicy      = LeastLoadedPolicy;
  IMS.PriorityPolicy         = PriorityPolicy;
  IMS.ShortestJobFirstPolicy = ShortestJobFirstPolicy;
  IMS.AffinityOraclePolicy   = AffinityOraclePolicy;
})();
