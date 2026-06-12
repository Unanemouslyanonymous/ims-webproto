/* ============================================================
 * UI layer: DOM construction + per-frame updates.
 * ============================================================ */
(function () {
  const IMS = window.IMS;
  const $ = (id) => document.getElementById(id);

  /* ---------- one-time construction ---------- */

  function buildResourceGrid() {
    const head = $('grid-heads');
    head.innerHTML = IMS.RES_KEYS.map((k) => {
      const s = IMS.RES_SPECS[k];
      const tweaks = IMS.SPEC_PARAMS.filter((p) => !p.only || p.only === k)
        .map((p) => `
          <div class="tweak-row">
            <label>${p.label}</label>
            <input type="range" data-col="${k}" data-param="${p.key}"
                   min="${p.min}" max="${p.max}" step="${p.step}" id="spec-${k}-${p.key}" />
            <output id="specv-${k}-${p.key}"></output>
          </div>`).join('');
      return `<div class="col-head">
        <div class="col-title">
          <span class="col-icon">${s.icon}</span>
          <div><div class="col-name">${s.label}</div><div class="col-sub">${s.sub}</div></div>
          <div class="col-spec" id="colspec-${k}"></div>
        </div>
        <div class="col-tweaks">${tweaks}</div>
      </div>`;
    }).join('');

    head.addEventListener('input', (e) => {
      const el = e.target;
      if (!el.dataset || !el.dataset.param) return;
      IMS.RES_SPECS[el.dataset.col][el.dataset.param] = parseFloat(el.value);
      syncSpecControls();
      if (onSpecTouched) onSpecTouched();
    });
    syncSpecControls();

    const grid = $('resource-grid');
    let html = '';
    for (let r = 0; r < IMS.ROWS; r++) {
      for (const k of IMS.RES_KEYS) {
        const isolated = r === 0;
        const wearBar = k === 'NVME'
          ? `<div class="meter"><label>wear</label><div class="bar"><i id="wear-${k}-${r}" class="bar-wear"></i></div></div>`
          : '';
        html += `<div class="cell ${isolated ? 'cell-isolated' : ''}" id="cell-${k}-${r}">
          <div class="cell-head">
            <span class="cell-name">${IMS.RES_SPECS[k].label}-${r}</span>
            ${isolated ? '<span class="shield" title="Secure enclave / isolated partition">⛨</span>' : ''}
            <span class="badge-throttle" id="thr-${k}-${r}">THROTTLE</span>
          </div>
          <div class="slots" id="slots-${k}-${r}"></div>
          <div class="meter"><label>load</label><div class="bar"><i id="load-${k}-${r}" class="bar-load"></i></div></div>
          <div class="meter"><label>temp</label><div class="bar"><i id="temp-${k}-${r}" class="bar-temp"></i></div><span class="temp-val" id="tempv-${k}-${r}"></span></div>
          ${wearBar}
        </div>`;
      }
    }
    grid.innerHTML = html;
  }

  function buildBrain() {
    $('q-bars').innerHTML = IMS.RES_KEYS.map((k) => `
      <div class="qbar-row" id="qrow-${k}">
        <span class="qbar-name">${IMS.RES_SPECS[k].icon} ${IMS.RES_SPECS[k].label}</span>
        <div class="qbar-track"><i id="qbar-${k}"></i></div>
        <span class="qbar-val" id="qval-${k}">0.00</span>
      </div>`).join('');

    $('reward-bars').innerHTML = [
      ['rThr', 'throughput'], ['rEff', 'efficiency'],
      ['rSec', 'security'], ['rHw', 'hw health'],
    ].map(([id, name]) => `
      <div class="rwd-row">
        <span class="rwd-name">${name}</span>
        <div class="rwd-track"><i class="rwd-neg" id="rwd-${id}-n"></i><i class="rwd-pos" id="rwd-${id}-p"></i></div>
        <span class="rwd-val" id="rwdv-${id}">–</span>
      </div>`).join('');
  }

  function buildLegend() {
    $('legend-types').innerHTML = IMS.PROC_KEYS.map((k) => {
      const t = IMS.PROC_TYPES[k];
      return `<span class="lg-item"><i class="lg-dot" style="background:${t.color}"></i>${t.label} <em>${t.desc}</em></span>`;
    }).join('');
  }

  function buildInjectButtons(onInject) {
    $('inject-btns').innerHTML = IMS.PROC_KEYS.map((k) => {
      const t = IMS.PROC_TYPES[k];
      return `<button class="btn-inject" data-type="${k}" style="--c:${t.color}">${t.icon} +6 ${t.label}</button>`;
    }).join('');
    $('inject-btns').addEventListener('click', (e) => {
      const b = e.target.closest('.btn-inject');
      if (b) onInject(b.dataset.type);
    });
  }

  let onSpecTouched = null;
  function syncSpecControls() {
    for (const k of IMS.RES_KEYS) {
      const s = IMS.RES_SPECS[k];
      for (const p of IMS.SPEC_PARAMS) {
        if (p.only && p.only !== k) continue;
        const el = $(`spec-${k}-${p.key}`);
        if (!el) continue;
        el.value = s[p.key];
        $(`specv-${k}-${p.key}`).textContent = p.fmt(s[p.key]);
      }
      $(`colspec-${k}`).textContent =
        `${s.baseSpeed} u/t · ${s.slots} slots · ${s.activeW}W`;
    }
  }

  function buildPresetBar(onApply) {
    $('preset-bar').innerHTML = IMS.PRESETS.map((p) => `
      <button class="btn-preset" data-preset="${p.key}" title="${p.desc}">
        ${p.name}
      </button>`).join('');
    $('preset-bar').addEventListener('click', (e) => {
      const b = e.target.closest('.btn-preset');
      if (b) onApply(b.dataset.preset);
    });
    onSpecTouched = () => setActivePreset(null);
  }

  function setActivePreset(key) {
    for (const b of document.querySelectorAll('.btn-preset')) {
      b.classList.toggle('preset-active', b.dataset.preset === key);
    }
    $('preset-desc').textContent = key
      ? IMS.PRESETS.find((p) => p.key === key).desc
      : 'custom hardware condition — set by the column tweakers above';
  }

  /* ---------- narrator panel ---------- */

  function buildNarratorPanel() {
    // built in HTML; just ensure it exists
  }

  const MAX_NAR = 14;
  function pushNarrator(html, cls = '') {
    const log = $('narrator');
    if (!log) return;
    const div = document.createElement('div');
    div.className = 'nar-line' + (cls ? ' ' + cls : '');
    div.innerHTML = html;
    log.prepend(div);
    while (log.children.length > MAX_NAR) log.lastChild.remove();
  }

  /* ---------- benchmark table ---------- */

  function buildBenchmarkTable() {
    const wrap = $('bench-table-wrap');
    if (!wrap) return;
    const metrics = [
      { key: 'completed', label: 'Completed', best: 'max', fmt: (v) => v.toLocaleString() },
      { key: 'latency',   label: 'Avg Latency', best: 'min', fmt: (v) => v.toFixed(1) + 's', unit: 'lower ↓' },
      { key: 'eff',       label: 'Efficiency', best: 'max', fmt: (v) => (v * 100).toFixed(0) + '%', unit: 'perf/W' },
      { key: 'violations',label: 'Sec. Violations', best: 'min', fmt: (v) => v },
      { key: 'reward',    label: 'Reward EMA', best: 'max', fmt: (v) => v.toFixed(2) },
    ];
    let html = `<table class="bench-table">
      <thead><tr>
        <th>Algorithm</th>
        ${metrics.map((m) => `<th>${m.label}<br><small>${m.unit || 'higher ↑'}</small></th>`).join('')}
      </tr></thead><tbody>`;
    for (const a of IMS.ALGO_DEFS) {
      const isRL = a.isRL;
      html += `<tr class="bench-row${isRL ? ' bench-rl' : ''}" id="bench-${a.key}">
        <td class="bench-algo-name">
          <i class="bench-dot" style="background:${a.color}"></i>
          <span>${a.label}${a.oracle ? ' <em class="oracle-tag">★ upper bound</em>' : ''}</span>
          <div class="bench-desc">${a.desc}</div>
        </td>
        ${metrics.map((m) => `<td class="bench-val" id="bench-${a.key}-${m.key}">—</td>`).join('')}
      </tr>`;
    }
    html += '</tbody></table>';
    wrap.innerHTML = html;
  }

  function updateBenchmarkTable(algoEngines) {
    const metrics = ['completed', 'latency', 'eff', 'violations', 'reward'];
    const bestFn  = ['max', 'min', 'max', 'min', 'max'];

    const vals = {};
    for (const { key, engine } of algoEngines) {
      vals[key] = {
        completed:  engine.stats.completed,
        latency:    engine.avgLatency(),
        eff:        engine.avgEff(),
        violations: engine.stats.violations,
        reward:     engine.stats.rewardEMA,
      };
    }

    for (let mi = 0; mi < metrics.length; mi++) {
      const m = metrics[mi];
      const fn = bestFn[mi];
      const allV = algoEngines.map(({ key }) => vals[key][m]);
      const best = fn === 'max' ? Math.max(...allV) : Math.min(...allV);
      const worst = fn === 'max' ? Math.min(...allV) : Math.max(...allV);

      for (const { key } of algoEngines) {
        const cell = $(`bench-${key}-${m}`);
        if (!cell) continue;
        const v = vals[key][m];
        const fmts = [
          (v) => v.toLocaleString(),
          (v) => v.toFixed(1) + 's',
          (v) => (v * 100).toFixed(0) + '%',
          (v) => v,
          (v) => v.toFixed(2),
        ];
        cell.textContent = fmts[mi](v);
        cell.classList.remove('bench-best', 'bench-worst');
        if (Math.abs(v - best) < 1e-9)  cell.classList.add('bench-best');
        if (Math.abs(v - worst) < 1e-9 && best !== worst) cell.classList.add('bench-worst');
      }
    }
  }

  /* ---------- per-frame updates ---------- */

  function chip(proc, extra = '') {
    const t = IMS.PROC_TYPES[proc.type];
    return `<span class="chip ${extra}" style="--c:${t.color}" title="${t.label} #${proc.pid} · ${proc.work.toFixed(0)} work units">${t.icon}${proc.pid}</span>`;
  }

  function updateQueue(engine) {
    const q = engine.queue;
    const shown = q.slice(0, 24);
    $('queue').innerHTML =
      shown.map((p) => chip(p)).join('') +
      (q.length > 24 ? `<span class="chip chip-more">+${q.length - 24}</span>` : '') ||
      '<span class="queue-empty">queue empty — all work placed</span>';
    $('queue-count').textContent = q.length;
  }

  function updateGrid(engine) {
    for (const k of IMS.RES_KEYS) {
      for (const u of engine.units[k]) {
        const r = u.row;
        $(`slots-${k}-${r}`).innerHTML =
          u.running.map((j) => chip(j.proc, 'chip-sm')).join('') +
          Array(Math.max(0, u.spec.slots - u.running.length))
            .fill('<span class="slot-empty"></span>').join('');
        const load = Math.min(1, u.load());
        $(`load-${k}-${r}`).style.width = (load * 100).toFixed(0) + '%';
        const tFrac = (u.temp - 36) / 64;
        const tEl = $(`temp-${k}-${r}`);
        tEl.style.width = (tFrac * 100).toFixed(0) + '%';
        tEl.style.background = u.temp > IMS.THROTTLE_TEMP ? '#ff5566' : u.temp > 70 ? '#ffb648' : '#3ddc84';
        $(`tempv-${k}-${r}`).textContent = u.temp.toFixed(0) + '°';
        $(`thr-${k}-${r}`).style.display = u.throttled ? 'inline-block' : 'none';
        if (k === 'NVME') $(`wear-${k}-${r}`).style.width = (u.wear * 100).toFixed(1) + '%';
        $(`cell-${k}-${r}`).classList.toggle('cell-hot', u.throttled);
      }
    }
  }

  function updateBrain(engine, agent, lastDecision) {
    $('eps-bar').style.width = (agent.eps * 100).toFixed(1) + '%';
    $('eps-val').textContent = agent.eps.toFixed(3);
    $('agent-decisions').textContent = agent.decisions.toLocaleString();
    $('agent-states').textContent = agent.q.size.toLocaleString();

    // plain-English policy summary
    const explain = $('brain-explain');
    if (explain && agent.decisions % 10 === 0) {
      explain.textContent = agent.explain();
    }

    if (lastDecision) {
      const t = IMS.PROC_TYPES[lastDecision.proc.type];
      $('brain-mode').textContent = lastDecision.mode;
      $('brain-mode').className = 'mode-badge mode-' + lastDecision.mode.toLowerCase();
      $('brain-state').innerHTML =
        `<b style="color:${t.color}">${t.label}</b> #${lastDecision.proc.pid} · state <code>${lastDecision.state.split(':')[1]}</code> → <b>${lastDecision.unitId}</b>`;
      const qs = IMS.RES_KEYS.map((k) => agent.getQ(lastDecision.state, k));
      const lo = Math.min(0, ...qs), hi = Math.max(0.01, ...qs);
      IMS.RES_KEYS.forEach((k, i) => {
        const frac = (qs[i] - lo) / (hi - lo || 1);
        $(`qbar-${k}`).style.width = (frac * 100).toFixed(0) + '%';
        $(`qval-${k}`).textContent = qs[i].toFixed(2);
        $(`qrow-${k}`).classList.toggle('q-chosen', lastDecision.unitId.startsWith(k));
      });
    }

    const lr = engine.stats.lastReward;
    if (lr) {
      $('rwd-total').textContent = (lr.r >= 0 ? '+' : '') + lr.r.toFixed(2);
      $('rwd-total').style.color = lr.r >= 0 ? '#3ddc84' : '#ff5566';
      for (const [id, v] of [['rThr', lr.rThr], ['rEff', lr.rEff], ['rSec', lr.rSec], ['rHw', lr.rHw]]) {
        const pos = Math.max(0, Math.min(1, v)), neg = Math.max(0, Math.min(1, -v));
        $(`rwd-${id}-p`).style.width = (pos * 50) + '%';
        $(`rwd-${id}-n`).style.width = (neg * 50) + '%';
        $(`rwdv-${id}`).textContent = (v >= 0 ? '+' : '') + v.toFixed(2);
      }
    }
  }

  function updateKpis(engineRL, algoEngines, agent) {
    const eRR = algoEngines.find((a) => a.key === 'rr')?.engine;
    $('kpi-thr').textContent = engineRL.throughput().toFixed(2);
    $('kpi-lat').textContent = engineRL.avgLatency().toFixed(1) + 's';
    $('kpi-eff').textContent = (engineRL.avgEff() * 100).toFixed(0) + '%';
    $('kpi-sec').textContent = engineRL.stats.violations;
    $('kpi-rew').textContent = engineRL.stats.rewardEMA.toFixed(2);
    $('kpi-eps').textContent = agent.eps.toFixed(2);
    if (eRR && eRR.stats.completed > 20) {
      const adv = ((engineRL.stats.completed - eRR.stats.completed) / eRR.stats.completed) * 100;
      const advEl = $('kpi-adv');
      advEl.textContent = (adv >= 0 ? '+' : '') + adv.toFixed(0) + '%';
      advEl.style.color = adv >= 5 ? '#3ddc84' : adv <= -5 ? '#ff5566' : '#e8eefc';
    }
  }

  const MAX_LOG = 9;
  function pushLog(html) {
    const log = $('decision-log');
    const div = document.createElement('div');
    div.className = 'log-line';
    div.innerHTML = html;
    log.prepend(div);
    while (log.children.length > MAX_LOG) log.lastChild.remove();
  }

  let activeFlies = 0;
  function flyChip(proc, unitId) {
    if (activeFlies > 6) return;
    const from = $('brain-card'), to = $('cell-' + unitId);
    if (!from || !to) return;
    const f = from.getBoundingClientRect(), t = to.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'fly-chip';
    el.style.background = IMS.PROC_TYPES[proc.type].color;
    el.style.left = f.right - 14 + 'px';
    el.style.top = f.top + f.height / 2 + 'px';
    document.body.appendChild(el);
    activeFlies++;
    requestAnimationFrame(() => {
      el.style.left = t.left + t.width / 2 + 'px';
      el.style.top = t.top + t.height / 2 + 'px';
      el.style.opacity = '0.15';
    });
    setTimeout(() => { el.remove(); activeFlies--; }, 480);
    to.classList.add('cell-flash');
    setTimeout(() => to.classList.remove('cell-flash'), 450);
  }

  IMS.UI = {
    buildResourceGrid, buildBrain, buildLegend, buildInjectButtons,
    buildPresetBar, setActivePreset, syncSpecControls,
    buildNarratorPanel, pushNarrator,
    buildBenchmarkTable, updateBenchmarkTable,
    updateQueue, updateGrid, updateBrain, updateKpis,
    pushLog, flyChip, chip,
  };
})();
