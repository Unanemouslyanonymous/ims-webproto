/* ============================================================
 * Wiring: engines, agent, controls, animation loop.
 * ============================================================ */
(function () {
  const IMS = window.IMS;
  const cfg = IMS.CONFIG;
  const $ = (id) => document.getElementById(id);

  let agent, engineRL, engineRR, seed;

  function boot(newSeed) {
    seed = newSeed ?? ((Math.random() * 2 ** 31) | 0);
    agent = agent || new IMS.QAgent(cfg);
    engineRL = new IMS.Engine(seed, 'rl', agent);
    engineRR = new IMS.Engine(seed, 'rr', new IMS.RoundRobinPolicy());
  }

  boot();

  /* ---------- build static DOM ---------- */
  IMS.UI.buildResourceGrid();
  IMS.UI.buildBrain();
  IMS.UI.buildLegend();
  IMS.UI.buildInjectButtons((type) => {
    // identical burst into both engines keeps the comparison fair
    const t = IMS.PROC_TYPES[type];
    for (let i = 0; i < 6; i++) {
      const work = t.work[0] + Math.random() * (t.work[1] - t.work[0]);
      const proto = { type, work, secure: t.secure };
      engineRL.enqueue({ ...proto, pid: nextInjectPid() });
      engineRR.enqueue({ ...proto, pid: 0 });
    }
  });
  let injectPid = 90000;
  function nextInjectPid() { return injectPid++; }

  const latChart = new IMS.LineChart($('chart-lat'), [
    { name: 'RL meta-scheduler', color: '#3ddc84' },
    { name: 'round-robin baseline', color: '#8892aa' },
  ], { digits: 1 });
  const rewChart = new IMS.LineChart($('chart-rew'), [
    { name: 'avg reward (EMA)', color: '#c084fc' },
  ], { digits: 2 });

  /* ---------- controls ---------- */
  function bindSlider(id, get, set, fmt) {
    const el = $(id), out = $(id + '-val');
    el.value = get();
    out.textContent = fmt(get());
    el.addEventListener('input', () => {
      set(parseFloat(el.value));
      out.textContent = fmt(get());
    });
  }

  bindSlider('ctl-speed', () => cfg.speed, (v) => (cfg.speed = v), (v) => v + 'x');
  bindSlider('ctl-arrival', () => cfg.arrivalRate, (v) => (cfg.arrivalRate = v), (v) => (v * 100).toFixed(0) + '%');
  bindSlider('ctl-alpha', () => cfg.alpha, (v) => (cfg.alpha = v), (v) => v.toFixed(2));
  bindSlider('ctl-gamma', () => cfg.gamma, (v) => (cfg.gamma = v), (v) => v.toFixed(2));
  bindSlider('ctl-wthr', () => cfg.weights.throughput, (v) => (cfg.weights.throughput = v), (v) => v.toFixed(1));
  bindSlider('ctl-weff', () => cfg.weights.efficiency, (v) => (cfg.weights.efficiency = v), (v) => v.toFixed(1));
  bindSlider('ctl-wsec', () => cfg.weights.security, (v) => (cfg.weights.security = v), (v) => v.toFixed(1));
  bindSlider('ctl-whw', () => cfg.weights.hardware, (v) => (cfg.weights.hardware = v), (v) => v.toFixed(1));

  $('ctl-auto').checked = cfg.autoGenerate;
  $('ctl-auto').addEventListener('change', (e) => (cfg.autoGenerate = e.target.checked));

  $('btn-pause').addEventListener('click', () => {
    cfg.running = !cfg.running;
    $('btn-pause').textContent = cfg.running ? '⏸ Pause' : '▶ Resume';
  });
  $('btn-reset-learning').addEventListener('click', () => {
    agent.reset();
    IMS.UI.pushLog('<span class="log-sys">⟲ Q-table wiped — agent relearning from scratch (ε reset to 1.0)</span>');
  });
  $('btn-reset-all').addEventListener('click', () => {
    agent.reset();
    boot();
    $('decision-log').innerHTML = '';
    IMS.UI.pushLog('<span class="log-sys">⟲ Full reset — fresh hardware, fresh agent</span>');
  });

  /* ---------- main loop ---------- */
  let lastDecision = null;
  let frame = 0;

  function loop() {
    if (cfg.running) {
      for (let i = 0; i < cfg.speed; i++) {
        engineRL.step();
        engineRR.step();
      }

      // drain RL engine events for the brain panel, log and animations
      const events = engineRL.events.splice(0);
      engineRR.events.length = 0;
      for (const ev of events) {
        if (ev.kind === 'dispatch') {
          lastDecision = ev;
          if (cfg.speed <= 4) IMS.UI.flyChip(ev.proc, ev.unitId);
        } else if (ev.kind === 'complete') {
          const rw = ev.reward;
          const t = IMS.PROC_TYPES[ev.proc.type];
          const sign = rw.r >= 0 ? 'log-pos' : 'log-neg';
          IMS.UI.pushLog(
            `<b style="color:${t.color}">${t.label}</b> #${ev.proc.pid} on <b>${ev.unitId}</b> ` +
            `<span class="${sign}">r=${rw.r >= 0 ? '+' : ''}${rw.r.toFixed(2)}</span> ` +
            `<small>thr ${rw.rThr.toFixed(1)} · eff ${rw.rEff.toFixed(1)} · sec ${rw.rSec.toFixed(1)} · hw ${rw.rHw.toFixed(1)}</small>`
          );
        }
      }
    }

    IMS.UI.updateQueue(engineRL);
    IMS.UI.updateGrid(engineRL);
    IMS.UI.updateBrain(engineRL, agent, lastDecision);
    IMS.UI.updateKpis(engineRL, engineRR, agent);

    if (frame++ % 12 === 0) {
      latChart.draw([engineRL.stats.samples.lat, engineRR.stats.samples.lat]);
      rewChart.draw([engineRL.stats.samples.rew]);
      IMS.renderHeatmap($('heatmap'), agent.policyMatrix(IMS.PROC_KEYS, IMS.RES_KEYS));
    }

    requestAnimationFrame(loop);
  }

  IMS.UI.pushLog('<span class="log-sys">⚡ IMS online — agent exploring (ε=1.0). Watch the policy heatmap converge.</span>');
  requestAnimationFrame(loop);
})();
