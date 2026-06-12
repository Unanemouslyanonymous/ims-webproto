/* ============================================================
 * IMS — Intelligent Meta Scheduler
 * Global namespace + all tunable functional parameters.
 * Everything the RL allocation depends on lives here.
 * ============================================================ */
(function () {
  const IMS = (window.IMS = window.IMS || {});

  IMS.CONFIG = {
    /* --- simulation clock --- */
    TICKS_PER_SEC: 30,        // sim ticks that equal one "second" for display
    speed: 0.4,               // fractional ticks/frame — slow enough to read each job
    running: true,

    /* --- workload generation --- */
    autoGenerate: true,
    arrivalRate: 0.15,        // P(new process) per tick — gentle rain
    maxQueue: 60,
    dispatchPerTick: 3,       // scheduler decisions per tick

    /* --- Q-learning hyper-parameters --- */
    alpha: 0.15,              // learning rate
    gamma: 0.90,              // discount factor (values future grid health)
    epsilon: 1.0,             // initial exploration probability
    epsilonMin: 0.05,
    epsilonDecay: 0.9985,     // slower decay — convergence arc is clearly visible

    /* --- reward shaping weights (the allocation objectives) --- */
    weights: {
      throughput: 1.0,        // finish work fast (low slowdown)
      efficiency: 0.8,        // affinity match + power draw
      security: 1.2,          // secure procs must land on enclave units
      hardware: 0.6,          // thermal throttling + NVMe wear penalties
    },
  };

  /* --- process taxonomy: behaviour of each workload class --- */
  /* reqVec = per-job resource demand profile sampled at arrival time.
     computeAffinity() derives the column fit score from these vectors —
     no hard-coded mapping, the physics emerge from the hardware model. */
  IMS.PROC_TYPES = {
    COMPUTE: {
      label: 'COMPUTE', color: '#4da3ff', icon: '⚙',
      desc: 'branchy serial integer work — CPU-bound, low parallelism',
      reqVec: { cpu: [0.60, 0.95], gpu: [0.02, 0.15], io: [0.02, 0.15], parallelism: [0.02, 0.20], mem: [0.5, 6] },
      secure: false, work: [30, 90], mix: 0.22,
    },
    PARALLEL: {
      label: 'PARALLEL', color: '#3ddc84', icon: '⧉',
      desc: 'vectorizable SIMD / tensor kernels — massively parallel, HBM-intensive',
      reqVec: { cpu: [0.05, 0.20], gpu: [0.70, 0.95], io: [0.02, 0.10], parallelism: [0.70, 0.95], mem: [2, 14] },
      secure: false, work: [40, 120], mix: 0.20,
    },
    IO: {
      label: 'I/O', color: '#ffb648', icon: '⇆',
      desc: 'storage-bound streams — sequential / random NVMe access',
      reqVec: { cpu: [0.05, 0.15], gpu: [0.02, 0.10], io: [0.75, 0.98], parallelism: [0.02, 0.10], mem: [0.25, 2] },
      secure: false, work: [25, 80], mix: 0.18,
    },
    SECURE: {
      label: 'SECURE', color: '#c084fc', icon: '⛨',
      desc: 'attested crypto ops — sequential, TEE-resident, CPU enclave',
      reqVec: { cpu: [0.60, 0.90], gpu: [0.05, 0.15], io: [0.05, 0.15], parallelism: [0.02, 0.10], mem: [0.25, 2] },
      secure: true, work: [20, 60], mix: 0.10,
    },
    /* ---- reality-gap workloads: expose where the 3-column abstraction is incomplete ---- */
    INFER: {
      label: 'INFER', color: '#fb923c', icon: '∑',
      desc: 'ML inference — GPU HBM-bound; large model weights cause memory pressure under concurrent load',
      reqVec: { cpu: [0.10, 0.25], gpu: [0.55, 0.80], io: [0.05, 0.15], parallelism: [0.45, 0.70], mem: [32, 44] },
      secure: false, work: [60, 180], mix: 0.12,
    },
    STREAM: {
      label: 'STREAM', color: '#22d3ee', icon: '⇉',
      desc: 'event stream processing — CPU-bound in-sim; reality gap: no "network" column; real bottleneck is network-I/O',
      reqVec: { cpu: [0.55, 0.80], gpu: [0.02, 0.08], io: [0.15, 0.35], parallelism: [0.05, 0.15], mem: [0.5, 2] },
      secure: false, work: [15, 45], mix: 0.10,
    },
    GRAPH: {
      label: 'GRAPH', color: '#818cf8', icon: '⬡',
      desc: 'graph analytics — large working set (6–20 GB) exceeds NVMe 8 GB buffer → GPU wins; reality gap: thread divergence penalty not modeled',
      reqVec: { cpu: [0.35, 0.55], gpu: [0.05, 0.12], io: [0.30, 0.55], parallelism: [0.15, 0.35], mem: [6, 20] },
      secure: false, work: [40, 140], mix: 0.08,
    },
  };
  IMS.PROC_KEYS = Object.keys(IMS.PROC_TYPES);

  /* --- resource columns: hardware behaviour models --- */
  IMS.RES_SPECS = {
    CPU: {
      label: 'CPU', icon: '🧠', sub: '4-core class · OoO',
      baseSpeed: 5,  slots: 3,  idleW: 10, activeW: 65,
      heatRate: 0.50, coolRate: 0.35, memCapacityGB: 256,
    },
    GPU: {
      label: 'GPU', icon: '🎮', sub: 'SM array · HBM',
      baseSpeed: 12, slots: 2,  idleW: 15, activeW: 250,
      heatRate: 0.90, coolRate: 0.35, memCapacityGB: 80,
    },
    NVME: {
      label: 'NVMe', icon: '💽', sub: 'flash · PCIe 5.0',
      baseSpeed: 9,  slots: 4,  idleW: 5,  activeW: 25,
      heatRate: 0.25, coolRate: 0.35, wearPerWork: 0.004, memCapacityGB: 8,
    },
  };
  IMS.RES_KEYS = Object.keys(IMS.RES_SPECS);
  IMS.ROWS = 4;                 // 4 rows x 3 columns = 12 units
  IMS.THROTTLE_TEMP = 85;       // degC above which a unit throttles
  IMS.THROTTLE_FACTOR = 0.55;

  /* NUMA topology: rows 0-1 = node 0, rows 2-3 = node 1.
     Cross-NUMA memory accesses incur a latency penalty on CPU-bound work. */
  IMS.NUMA = { rowsPerNode: 2, crossPenalty: 1.20 };

  /* Rack PDU budget: proportional throttle when draw exceeds limit */
  IMS.POWER = { rackBudgetW: 1500 };

  /* CPU P-states: graduated speed reduction before hard throttle engages */
  IMS.CPU_PSTATE = { thresholds: [65, 72, 79], factors: [1.0, 0.87, 0.73, 0.60] };

  /* Context-switch startup cost: new jobs run at 30% efficiency for 3 ticks */
  IMS.CONTEXT_SWITCH_TICKS = 3;
  IMS.CONTEXT_SWITCH_FACTOR = 0.30;

  /* Physics-based affinity: derived from each job's resource demand vector.
     No assumed mapping — the column fit score emerges from hardware physics. */
  IMS.computeAffinity = function (proc, colKey) {
    let r = proc.reqVec;
    if (!r) {
      // graceful fallback: use type mid-range when reqVec is absent
      const rv = (IMS.PROC_TYPES[proc.type] || {}).reqVec;
      if (!rv) return 0.10;
      r = {
        cpu: (rv.cpu[0] + rv.cpu[1]) / 2,
        gpu: (rv.gpu[0] + rv.gpu[1]) / 2,
        io:  (rv.io[0]  + rv.io[1])  / 2,
        parallelism: (rv.parallelism[0] + rv.parallelism[1]) / 2,
      };
    }
    const cpu = r.cpu, gpu = r.gpu, io = r.io, par = r.parallelism;
    switch (colKey) {
      case 'CPU':
        // excels at high-cpu, sequential (low-par), non-IO workloads
        return Math.max(0.05, cpu * 0.55 + (1 - par) * 0.30 + (1 - io) * 0.15);
      case 'GPU':
        // excels at high-parallelism, high-gpu, non-IO workloads
        return Math.max(0.05, par * 0.55 + gpu * 0.30 + (1 - io) * 0.15);
      case 'NVME':
        // almost entirely IO-driven; non-IO work barely benefits from flash
        return Math.max(0.02, io * 0.85 +
          (io > 0.5 ? (1 - cpu) * 0.10 : 0) +
          (io > 0.5 ? (1 - par) * 0.05 : 0));
      default: return 0.10;
    }
  };

  /* --- live-tweakable hardware parameters (per column) ---
     These mutate IMS.RES_SPECS in place; units hold references, so the
     engine reads the new values on the very next tick. Nothing static. */
  IMS.SPEC_PARAMS = [
    { key: 'baseSpeed',   label: 'clock', min: 0.5,  max: 16,   step: 0.5,   fmt: (v) => v + ' u/t' },
    { key: 'slots',       label: 'slots', min: 1,    max: 6,    step: 1,     fmt: (v) => v },
    { key: 'heatRate',    label: 'heat',  min: 0.05, max: 2.5,  step: 0.05,  fmt: (v) => v.toFixed(2) },
    { key: 'coolRate',    label: 'cool',  min: 0.05, max: 1,    step: 0.05,  fmt: (v) => v.toFixed(2) },
    { key: 'activeW',     label: 'power', min: 5,    max: 400,  step: 5,     fmt: (v) => v + ' W' },
    { key: 'wearPerWork', label: 'wear',  min: 0,    max: 0.05, step: 0.001, fmt: (v) => v.toFixed(3), only: 'NVME' },
  ];

  /* pristine copy of the silicon, used as the base for every preset */
  IMS.NOMINAL_SPECS = JSON.parse(JSON.stringify(IMS.RES_SPECS));

  /* --- preset hardware conditions: real failure/operating modes an
     HPC fleet actually sees. Partial overrides on top of nominal. --- */
  IMS.PRESETS = [
    {
      key: 'nominal', name: '⚖ Nominal',
      desc: 'baseline silicon · stock clocks · healthy cooling',
      specs: {},
    },
    {
      key: 'gpufail', name: '🧨 GPU Failure',
      desc: 'XID errors: SMs fused off, ECC storms — GPUs crawl at 1 u/t',
      specs: { GPU: { baseSpeed: 1, heatRate: 1.6 } },
    },
    {
      key: 'cooling', name: '🔥 Cooling Failure',
      desc: 'CRAC unit down: heat soak everywhere, throttle storms',
      specs: {
        CPU: { heatRate: 1.3, coolRate: 0.10 },
        GPU: { heatRate: 2.2, coolRate: 0.10 },
        NVME: { heatRate: 0.7, coolRate: 0.10 },
      },
    },
    {
      key: 'nvmewear', name: '🧯 NVMe Wear-Out',
      desc: 'SMART pre-fail: link degraded, brutal write amplification',
      specs: { NVME: { baseSpeed: 1, wearPerWork: 0.03 } },
    },
    {
      key: 'overclock', name: '⚡ CPU Overclock',
      desc: 'all-core OC: 2× clock — fast, hot and power-hungry',
      specs: { CPU: { baseSpeed: 10, heatRate: 1.3, activeW: 140 } },
    },
  ];

  IMS.applyPreset = function (key) {
    const preset = IMS.PRESETS.find((p) => p.key === key);
    if (!preset) return;
    for (const col of IMS.RES_KEYS) {
      Object.assign(
        IMS.RES_SPECS[col],
        IMS.NOMINAL_SPECS[col],
        preset.specs[col] || {}
      );
    }
  };

  /* deterministic RNG so RL and the round-robin shadow see identical arrivals */
  IMS.mulberry32 = function (seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
})();
