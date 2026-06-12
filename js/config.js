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
    speed: 2,                 // sim ticks executed per animation frame
    running: true,

    /* --- workload generation --- */
    autoGenerate: true,
    arrivalRate: 0.28,        // P(new process) per tick
    maxQueue: 60,
    dispatchPerTick: 3,       // scheduler decisions per tick

    /* --- Q-learning hyper-parameters --- */
    alpha: 0.15,              // learning rate
    gamma: 0.90,              // discount factor (values future grid health)
    epsilon: 1.0,             // initial exploration probability
    epsilonMin: 0.05,
    epsilonDecay: 0.9990,     // multiplicative decay per decision

    /* --- reward shaping weights (the allocation objectives) --- */
    weights: {
      throughput: 1.0,        // finish work fast (low slowdown)
      efficiency: 0.8,        // affinity match + power draw
      security: 1.2,          // secure procs must land on enclave units
      hardware: 0.6,          // thermal throttling + NVMe wear penalties
    },
  };

  /* --- process taxonomy: behaviour of each workload class --- */
  /* affinity = fraction of a column's base speed this class achieves */
  IMS.PROC_TYPES = {
    COMPUTE: {
      label: 'COMPUTE', color: '#4da3ff', icon: '⚙',
      desc: 'branchy / serial integer work',
      affinity: { CPU: 1.0, GPU: 0.25, NVME: 0.12 },
      secure: false, work: [30, 90], mix: 0.30,
    },
    PARALLEL: {
      label: 'PARALLEL', color: '#3ddc84', icon: '⧉',
      desc: 'vectorizable / SIMD kernels',
      affinity: { CPU: 0.30, GPU: 1.0, NVME: 0.10 },
      secure: false, work: [40, 120], mix: 0.30,
    },
    IO: {
      label: 'I/O', color: '#ffb648', icon: '⇆',
      desc: 'storage-bound read/write streams',
      affinity: { CPU: 0.25, GPU: 0.10, NVME: 1.0 },
      secure: false, work: [25, 80], mix: 0.25,
    },
    SECURE: {
      label: 'SECURE', color: '#c084fc', icon: '⛨',
      desc: 'crypto / attested — needs enclave',
      affinity: { CPU: 0.90, GPU: 0.30, NVME: 0.35 },
      secure: true, work: [20, 60], mix: 0.15,
    },
  };
  IMS.PROC_KEYS = Object.keys(IMS.PROC_TYPES);

  /* --- resource columns: hardware behaviour models --- */
  IMS.RES_SPECS = {
    CPU: {
      label: 'CPU', icon: '🧠', sub: '4-core class · OoO',
      baseSpeed: 5,  slots: 3,  idleW: 10, activeW: 65,
      heatRate: 0.50, coolRate: 0.35,
    },
    GPU: {
      label: 'GPU', icon: '🎮', sub: 'SM array · HBM',
      baseSpeed: 12, slots: 2,  idleW: 15, activeW: 250,
      heatRate: 0.90, coolRate: 0.35,
    },
    NVME: {
      label: 'NVMe', icon: '💽', sub: 'flash · PCIe 5.0',
      baseSpeed: 9,  slots: 4,  idleW: 5,  activeW: 25,
      heatRate: 0.25, coolRate: 0.35, wearPerWork: 0.004,
    },
  };
  IMS.RES_KEYS = Object.keys(IMS.RES_SPECS);
  IMS.ROWS = 4;                 // 4 rows x 3 columns = 12 units
  IMS.THROTTLE_TEMP = 85;       // degC above which a unit throttles
  IMS.THROTTLE_FACTOR = 0.55;
  IMS.MAX_ACTIVE_W = 250;       // for power normalisation in reward

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
