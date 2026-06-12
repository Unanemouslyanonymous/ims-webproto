/* ============================================================
 * Simulation engine — mimics low-level hardware behaviour:
 *   - 12 resource units (4 rows x 3 columns), row 0 = secure enclave
 *   - slot contention (speed shared between co-resident jobs)
 *   - thermal model with throttling above THROTTLE_TEMP
 *   - NVMe write wear accumulation
 *   - power draw per column
 *
 * Two engines run in lock-step on identical arrivals: one driven by
 * the RL agent, one by round-robin, so the RL advantage is provable.
 * ============================================================ */
(function () {
  const IMS = window.IMS;
  const C = () => IMS.CONFIG;

  let nextPid = 1;

  class Unit {
    constructor(colKey, row) {
      this.colKey = colKey;
      this.row = row;
      this.spec = IMS.RES_SPECS[colKey];
      this.isolated = row === 0; // secure enclave / isolated partition
      this.id = colKey + '-' + row;
      this.temp = 38;
      this.wear = 0;            // NVMe write endurance consumed (0..1)
      this.running = [];        // active jobs
      this.throttled = false;
    }
    load() { return this.running.length / this.spec.slots; }
    free() { return this.running.length < this.spec.slots; }
  }

  function makeProcess(rng) {
    // weighted type draw
    let r = rng(), key = IMS.PROC_KEYS[0];
    for (const k of IMS.PROC_KEYS) {
      const t = IMS.PROC_TYPES[k];
      if (r < t.mix) { key = k; break; }
      r -= t.mix;
    }
    const t = IMS.PROC_TYPES[key];
    const work = t.work[0] + rng() * (t.work[1] - t.work[0]);
    return { pid: nextPid++, type: key, work, secure: t.secure };
  }

  class Engine {
    constructor(seed, policyName, agent) {
      this.policyName = policyName;     // 'rl' | 'rr'
      this.agent = agent;               // QAgent (rl) or RoundRobinPolicy
      this.arrivalRng = IMS.mulberry32(seed);
      this.policyRng = IMS.mulberry32(seed ^ 0x9e3779b9);
      this.units = {};
      for (const k of IMS.RES_KEYS) {
        this.units[k] = [];
        for (let r = 0; r < IMS.ROWS; r++) this.units[k].push(new Unit(k, r));
      }
      this.queue = [];
      this.tick = 0;
      this.events = [];                 // drained by the UI each frame
      this.stats = {
        completed: 0,
        violations: 0,
        completionTicks: [],            // ring of completion times
        latencies: [],                  // last N latencies (sec)
        effs: [],                       // last N efficiency rewards
        rewardEMA: 0,
        lastReward: null,
        samples: { thr: [], lat: [], rew: [] },  // chart history
        energy: 0,                      // joules consumed
      };
      this._sampleCountdown = 15;
    }

    colLoads() {
      const loads = {};
      for (const k of IMS.RES_KEYS) {
        let used = 0, cap = 0;
        for (const u of this.units[k]) { used += u.running.length; cap += u.spec.slots; }
        loads[k] = used / cap;
      }
      return loads;
    }

    maskedActions() {
      return IMS.RES_KEYS.filter((k) => this.units[k].some((u) => u.free()));
    }

    /* deterministic intra-column placement: RL picks the column,
       the dispatcher picks the unit (enclave-aware, least-loaded). */
    pickUnit(colKey, proc) {
      const free = this.units[colKey].filter((u) => u.free());
      if (!free.length) return null;
      const sortLoad = (a, b) => a.load() - b.load() || a.row - b.row;
      if (proc.secure) {
        const enclaves = free.filter((u) => u.isolated);
        if (enclaves.length) return enclaves.sort(sortLoad)[0];
        return free.sort(sortLoad)[0]; // forced violation under pressure
      }
      const open = free.filter((u) => !u.isolated);
      return (open.length ? open : free).sort(sortLoad)[0];
    }

    enqueue(proc) {
      if (this.queue.length < C().maxQueue) {
        this.queue.push({ ...proc, arrived: this.tick });
      }
    }

    step() {
      const cfg = C();
      this.tick++;

      /* 1. arrivals (shared rng stream keeps both engines identical) */
      if (cfg.autoGenerate && this.arrivalRng() < cfg.arrivalRate) {
        this.enqueue(makeProcess(this.arrivalRng));
      } else if (cfg.autoGenerate) {
        // burn the same rng calls a spawn would, so streams stay aligned
        this.arrivalRng(); this.arrivalRng();
      }

      /* 2. meta-scheduler dispatch with backfilling: scan past the
         queue head so one stuck process can't block the whole grid.
         When the grid is under pressure the agent is also offered a
         WAIT action — learned admission control: holding a process
         can beat placing it on hostile hardware. */
      let dispatched = 0;
      const scanLimit = 8;
      for (let qi = 0; qi < this.queue.length && qi < scanLimit; qi++) {
        if (dispatched >= cfg.dispatchPerTick) break;
        const masked = this.maskedActions();
        if (!masked.length) break;
        const proc = this.queue[qi];
        const loads = this.colLoads();
        const state = IMS.encodeState(proc.type, loads);
        const actions =
          masked.length < IMS.RES_KEYS.length ? [...masked, 'WAIT'] : masked;
        const { action, mode } = this.agent.choose(state, actions, this.policyRng);
        if (action === 'WAIT') {
          if (this.policyName === 'rl') {
            this.agent.update(state, 'WAIT', -0.05, state, [...IMS.RES_KEYS, 'WAIT']);
          }
          continue; // hold this process, consider the next one
        }
        const unit = this.pickUnit(action, proc);
        if (!unit) continue;
        this.queue.splice(qi, 1);
        qi--;
        dispatched++;
        unit.running.push({
          proc,
          remaining: proc.work,
          state,
          action,
          ticksRun: 0,
          overheatTicks: 0,
          wearAdded: 0,
          violation: proc.secure && !unit.isolated,
          misuse: !proc.secure && unit.isolated,
        });
        if (unit.running.at(-1).violation) this.stats.violations++;
        this.events.push({ kind: 'dispatch', proc, unitId: unit.id, mode, state });
      }

      /* 3. execution: contention, thermals, wear, power */
      for (const k of IMS.RES_KEYS) {
        for (const u of this.units[k]) {
          const spec = u.spec;
          if (u.running.length) {
            u.throttled = u.temp > IMS.THROTTLE_TEMP;
            const share =
              (spec.baseSpeed / u.running.length) *
              (u.throttled ? IMS.THROTTLE_FACTOR : 1);
            for (const job of u.running) {
              const aff = IMS.PROC_TYPES[job.proc.type].affinity[k];
              const rate = share * aff;
              job.remaining -= rate;
              job.ticksRun++;
              if (u.throttled) job.overheatTicks++;
              if (spec.wearPerWork) {
                const dw = rate * spec.wearPerWork * 0.01;
                u.wear = Math.min(1, u.wear + dw);
                job.wearAdded += dw;
              }
            }
            u.temp += spec.heatRate * u.load();
            this.stats.energy +=
              (spec.idleW + (spec.activeW - spec.idleW) * u.load()) /
              IMS.CONFIG.TICKS_PER_SEC;
          } else {
            u.throttled = false;
            this.stats.energy += spec.idleW / IMS.CONFIG.TICKS_PER_SEC;
          }
          u.temp = Math.max(36, Math.min(100, u.temp - spec.coolRate));

          /* 4. completions -> reward -> learning */
          for (let i = u.running.length - 1; i >= 0; i--) {
            const job = u.running[i];
            if (job.remaining <= 0) {
              u.running.splice(i, 1);
              this.complete(job, u);
            }
          }
        }
      }

      /* 5. telemetry sampling for charts */
      if (--this._sampleCountdown <= 0) {
        this._sampleCountdown = 15;
        const s = this.stats.samples;
        s.thr.push(this.throughput());
        s.lat.push(this.avgLatency());
        s.rew.push(this.stats.rewardEMA);
        if (s.thr.length > 400) { s.thr.shift(); s.lat.shift(); s.rew.shift(); }
      }
    }

    complete(job, unit) {
      const cfg = C();
      const t = IMS.PROC_TYPES[job.proc.type];

      /* reward components, each roughly in [-1, 1] */
      let bestSpeed = 0;
      for (const k of IMS.RES_KEYS) {
        bestSpeed = Math.max(bestSpeed, IMS.RES_SPECS[k].baseSpeed * t.affinity[k]);
      }
      const idealTicks = job.proc.work / bestSpeed;
      const latencyTicks = this.tick - job.proc.arrived;
      const rThr = Math.min(1, (2 * idealTicks) / Math.max(1, latencyTicks));

      const powerNorm = unit.spec.activeW / IMS.MAX_ACTIVE_W;
      const rEff = t.affinity[unit.colKey] * (1 - 0.3 * powerNorm);

      const rSec = job.proc.secure
        ? (job.violation ? -1 : 1)
        : (job.misuse ? -0.15 : 0);

      const rHw = Math.max(
        -1,
        -(job.overheatTicks / Math.max(1, job.ticksRun)) - job.wearAdded * 50
      );

      const w = cfg.weights;
      const wSum = w.throughput + w.efficiency + w.security + w.hardware;
      const r =
        (w.throughput * rThr + w.efficiency * rEff + w.security * rSec + w.hardware * rHw) /
        wSum;

      if (this.policyName === 'rl') {
        const s2 = IMS.encodeState(job.proc.type, this.colLoads());
        this.agent.update(job.state, job.action, r, s2, IMS.RES_KEYS);
      }

      const st = this.stats;
      st.completed++;
      st.completionTicks.push(this.tick);
      if (st.completionTicks.length > 600) st.completionTicks.shift();
      st.latencies.push(latencyTicks / IMS.CONFIG.TICKS_PER_SEC);
      if (st.latencies.length > 60) st.latencies.shift();
      st.effs.push(rEff);
      if (st.effs.length > 60) st.effs.shift();
      st.rewardEMA = st.rewardEMA * 0.97 + r * 0.03;
      st.lastReward = {
        pid: job.proc.pid, type: job.proc.type, unitId: unit.id,
        r, rThr, rEff, rSec, rHw,
      };
      this.events.push({ kind: 'complete', proc: job.proc, unitId: unit.id, reward: st.lastReward });
    }

    /* processes per second over the last 300 ticks */
    throughput() {
      const horizon = 300;
      const from = this.tick - horizon;
      const n = this.stats.completionTicks.filter((t) => t > from).length;
      return n / (horizon / IMS.CONFIG.TICKS_PER_SEC);
    }

    avgLatency() {
      const l = this.stats.latencies;
      return l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0;
    }

    avgEff() {
      const e = this.stats.effs;
      return e.length ? e.reduce((a, b) => a + b, 0) / e.length : 0;
    }
  }

  IMS.Engine = Engine;
  IMS.makeProcess = makeProcess;
})();
