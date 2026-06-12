/* ============================================================
 * Wiring: 7 engines (RL + 6 baselines), controls, animation loop.
 * All engines run on byte-identical seeded arrivals — controlled experiment.
 * ============================================================ */
(function () {
  const IMS = window.IMS;
  const cfg = IMS.CONFIG;
  const $ = (id) => document.getElementById(id);

  let agent, algoEngines, seed;
  let tickAccum = 0; // fractional tick accumulator (supports speed < 1)

  function boot(newSeed) {
    seed = newSeed ?? ((Math.random() * 2 ** 31) | 0);
    if (!agent) agent = new IMS.QAgent(cfg);
    algoEngines = IMS.ALGO_DEFS.map((def) => ({
      key:    def.key,
      label:  def.label,
      color:  def.color,
      policy: def.isRL ? agent : def.makePolicy(),
      engine: null,
    }));
    for (const a of algoEngines) {
      a.engine = new IMS.Engine(seed, a.key, a.policy);
    }
    tickAccum = 0;
  }

  boot();

  const engineRL = () => algoEngines.find((a) => a.key === 'rl').engine;

  /* ---------- build static DOM ---------- */
  IMS.UI.buildResourceGrid();
  IMS.UI.buildBrain();
  IMS.UI.buildLegend();
  IMS.UI.buildNarratorPanel();
  IMS.UI.buildBenchmarkTable();
  IMS.UI.buildPresetBar((key) => {
    const p = IMS.PRESETS.find((x) => x.key === key);
    IMS.applyPreset(key);
    IMS.UI.syncSpecControls();
    IMS.UI.setActivePreset(key);
    agent.eps = Math.max(agent.eps, 0.35);
    IMS.UI.pushNarrator(
      `<span class="nar-sys">⚠ HARDWARE EVENT: <b>${p.name}</b> — ${p.desc}. ` +
      `ε boosted → ${agent.eps.toFixed(2)} · re-exploration active</span>`, 'nar-alert'
    );
    IMS.UI.pushLog(
      `<span class="log-sys">⚠ <b>${p.name}</b> — ${p.desc}. ε → ${agent.eps.toFixed(2)}</span>`
    );
  });
  IMS.UI.setActivePreset('nominal');

  let injectPid = 90000;
  IMS.UI.buildInjectButtons((type) => {
    const t = IMS.PROC_TYPES[type];
    for (let i = 0; i < 6; i++) {
      const work = t.work[0] + Math.random() * (t.work[1] - t.work[0]);
      const proto = { type, work, secure: t.secure };
      for (const a of algoEngines) {
        a.engine.enqueue({ ...proto, pid: a.key === 'rl' ? injectPid : 0 }, true);
      }
      injectPid++;
    }
  });

  /* ---------- charts: latency (5 series) + reward ---------- */
  const CHART_ALGOS = ['rl', 'oracle', 'll', 'rr', 'rand'];
  const latChart = new IMS.LineChart($('chart-lat'),
    CHART_ALGOS.map((k) => {
      const d = IMS.ALGO_DEFS.find((a) => a.key === k);
      return { name: d.label, color: d.color };
    }), { digits: 1 });
  const rewChart = new IMS.LineChart($('chart-rew'), [
    { name: 'RL reward (EMA)', color: '#4da3ff' },
  ], { digits: 2 });

  /* ---------- controls ---------- */
  function bindSlider(id, get, set, fmt) {
    const el = $(id), out = $(id + '-val');
    if (!el) return;
    el.value = get();
    out.textContent = fmt(get());
    el.addEventListener('input', () => {
      set(parseFloat(el.value));
      out.textContent = fmt(get());
    });
  }

  bindSlider('ctl-speed',  () => cfg.speed,              (v) => (cfg.speed = v),              (v) => v + 'x');
  bindSlider('ctl-arrival',() => cfg.arrivalRate,         (v) => (cfg.arrivalRate = v),         (v) => (v * 100).toFixed(0) + '%');
  bindSlider('ctl-alpha',  () => cfg.alpha,               (v) => (cfg.alpha = v),               (v) => v.toFixed(2));
  bindSlider('ctl-gamma',  () => cfg.gamma,               (v) => (cfg.gamma = v),               (v) => v.toFixed(2));
  bindSlider('ctl-wthr',   () => cfg.weights.throughput,  (v) => (cfg.weights.throughput = v),  (v) => v.toFixed(1));
  bindSlider('ctl-weff',   () => cfg.weights.efficiency,  (v) => (cfg.weights.efficiency = v),  (v) => v.toFixed(1));
  bindSlider('ctl-wsec',   () => cfg.weights.security,    (v) => (cfg.weights.security = v),    (v) => v.toFixed(1));
  bindSlider('ctl-whw',    () => cfg.weights.hardware,    (v) => (cfg.weights.hardware = v),    (v) => v.toFixed(1));

  $('ctl-auto').checked = cfg.autoGenerate;
  $('ctl-auto').addEventListener('change', (e) => (cfg.autoGenerate = e.target.checked));

  $('btn-pause').addEventListener('click', () => {
    cfg.running = !cfg.running;
    $('btn-pause').textContent = cfg.running ? '⏸ Pause' : '▶ Resume';
  });
  $('btn-reset-learning').addEventListener('click', () => {
    agent.reset();
    IMS.UI.pushNarrator('<span class="nar-sys">⟲ Q-table wiped — agent relearning from ε=1.0. Watch the heatmap rebuild.</span>', 'nar-alert');
    IMS.UI.pushLog('<span class="log-sys">⟲ Q-table wiped — relearning from scratch (ε=1.0)</span>');
  });
  $('btn-reset-all').addEventListener('click', () => {
    agent.reset();
    boot();
    $('decision-log').innerHTML = '';
    $('narrator').innerHTML = '';
    IMS.UI.pushNarrator('<span class="nar-sys">⟲ Full reset — fresh hardware, fresh agent, all baselines restarted</span>');
    IMS.UI.pushLog('<span class="log-sys">⟲ Full reset</span>');
  });

  /* ---------- narrator: translate RL events into plain English ---------- */
  let lastNarrThrottle = {};
  function narrateEvents(events, agent) {
    for (const ev of events) {
      /* arrivals */
      if (ev.kind === 'arrive' && ev.narr) {
        IMS.UI.pushNarrator(ev.narr, 'nar-arrive');
        continue;
      }
      /* dispatch — the RL "thinking" moment */
      if (ev.kind === 'dispatch') {
        const t = IMS.PROC_TYPES[ev.proc.type];
        const col = ev.unitId.split('-')[0];
        const qs = IMS.RES_KEYS.map((k) => `${k} <b>${agent.getQ(ev.state, k).toFixed(2)}</b>`).join(' · ');
        const loadStr = IMS.RES_KEYS.map((k) =>
          `${k} ${((ev.loads[k] || 0) * 100).toFixed(0)}%`).join(' · ');
        const modeHtml = ev.mode === 'EXPLORE'
          ? '<span class="nar-mode nar-explore">🔍 EXPLORING</span>'
          : '<span class="nar-mode nar-exploit">🎯 EXPLOITING</span>';
        const reason = ev.mode === 'EXPLORE'
          ? 'trying to learn more about this placement'
          : `Q-table says ${col} wins (${agent.getQ(ev.state, col).toFixed(2)})`;
        IMS.UI.pushNarrator(
          `${modeHtml} <b style="color:${t.color}">${t.label}</b> #${ev.proc.pid} → <b>${ev.unitId}</b> — ${reason}<br>` +
          `<small>Q: ${qs} · grid: ${loadStr}</small>`,
          'nar-dispatch'
        );
        continue;
      }
      /* completions */
      if (ev.kind === 'complete') {
        const rw = ev.reward;
        const t = IMS.PROC_TYPES[ev.proc.type];
        const sign = rw.r >= 0;
        IMS.UI.pushNarrator(
          `${sign ? '✅' : '⚠'} <b style="color:${t.color}">${t.label}</b> #${ev.proc.pid} done on <b>${ev.unitId}</b> · ` +
          `reward <b style="color:${sign ? '#3ddc84' : '#ff5566'}">${rw.r >= 0 ? '+' : ''}${rw.r.toFixed(2)}</b>` +
          `<small> = thr ${rw.rThr.toFixed(2)} · eff ${rw.rEff.toFixed(2)} · sec ${rw.rSec.toFixed(2)} · hw ${rw.rHw.toFixed(2)}</small>`,
          sign ? 'nar-complete' : 'nar-warn'
        );
        continue;
      }
      /* thermal throttle events */
      if (ev.kind === 'throttle' && ev.narr) {
        const now = engineRL().tick;
        if (!lastNarrThrottle[ev.unitId] || now - lastNarrThrottle[ev.unitId] > 60) {
          lastNarrThrottle[ev.unitId] = now;
          IMS.UI.pushNarrator(ev.narr, 'nar-warn');
        }
      }
    }
  }

  /* ---------- main loop ---------- */
  let lastDecision = null;
  let frame = 0;

  function loop() {
    if (cfg.running) {
      tickAccum += cfg.speed;
      const ticks = Math.floor(tickAccum);
      tickAccum -= ticks;

      for (let i = 0; i < ticks; i++) {
        for (const a of algoEngines) a.engine.step();
      }

      // drain RL events for narrator, brain panel, fly-chips, decision log
      const rl = engineRL();
      const events = rl.events.splice(0);
      for (const a of algoEngines) {
        if (a.key !== 'rl') a.engine.events.length = 0;
      }

      // narrator + decision log feed
      if (cfg.speed <= 3) narrateEvents(events, agent);

      for (const ev of events) {
        if (ev.kind === 'dispatch') {
          lastDecision = ev;
          if (cfg.speed <= 3) IMS.UI.flyChip(ev.proc, ev.unitId);
        } else if (ev.kind === 'complete') {
          const rw = ev.reward;
          const t = IMS.PROC_TYPES[ev.proc.type];
          const sign = rw.r >= 0 ? 'log-pos' : 'log-neg';
          IMS.UI.pushLog(
            `<b style="color:${t.color}">${t.label}</b> #${ev.proc.pid} → <b>${ev.unitId}</b> ` +
            `<span class="${sign}">r=${rw.r >= 0 ? '+' : ''}${rw.r.toFixed(2)}</span> ` +
            `<small>thr ${rw.rThr.toFixed(1)} eff ${rw.rEff.toFixed(1)} sec ${rw.rSec.toFixed(1)} hw ${rw.rHw.toFixed(1)}</small>`
          );
        }
      }

      // periodic narrator summary every ~10s sim time
      if (rl.tick > 0 && rl.tick % (IMS.CONFIG.TICKS_PER_SEC * 10) === 0) {
        const best = IMS.ALGO_DEFS.reduce((b, a) => {
          const ae = algoEngines.find((x) => x.key === a.key).engine;
          const be = algoEngines.find((x) => x.key === b.key).engine;
          return ae.stats.completed > be.stats.completed ? a : b;
        }, IMS.ALGO_DEFS[0]);
        IMS.UI.pushNarrator(
          `<span class="nar-sys">📊 t=${(rl.tick / IMS.CONFIG.TICKS_PER_SEC).toFixed(0)}s · ` +
          `RL: ${rl.stats.completed} done · ε=${agent.eps.toFixed(2)} · ` +
          `leading algo: <b style="color:${best.color}">${best.label}</b></span>`,
          'nar-summary'
        );
      }
    }

    IMS.UI.updateQueue(engineRL());
    IMS.UI.updateGrid(engineRL());
    IMS.UI.updateBrain(engineRL(), agent, lastDecision);
    IMS.UI.updateKpis(engineRL(), algoEngines, agent);

    if (frame++ % 15 === 0) {
      const chartEngines = CHART_ALGOS.map((k) => algoEngines.find((a) => a.key === k).engine);
      latChart.draw(chartEngines.map((e) => e.stats.samples.lat));
      rewChart.draw([engineRL().stats.samples.rew]);
      IMS.renderHeatmap($('heatmap'), agent.policyMatrix(IMS.PROC_KEYS, IMS.RES_KEYS));
      IMS.UI.updateBenchmarkTable(algoEngines);
    }

    requestAnimationFrame(loop);
  }

  IMS.UI.pushNarrator(
    '<span class="nar-sys">⚡ IMS online — 7 schedulers competing on identical arrivals. ' +
    'Watch the RL agent explore then exploit its learned policy.</span>'
  );
  IMS.UI.pushLog('<span class="log-sys">⚡ IMS online — agent exploring (ε=1.0)</span>');
  requestAnimationFrame(loop);
})();
