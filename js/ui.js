/* ============================================================
 * UI layer: builds and updates the dashboard DOM.
 * Engine A (RL) is what the user sees; engine B (round-robin)
 * only feeds the comparison chart.
 * ============================================================ */
(function () {
  const IMS = window.IMS;
  const $ = (id) => document.getElementById(id);

  /* ---------- one-time construction ---------- */

  function buildResourceGrid() {
    const head = $('grid-heads');
    head.innerHTML = IMS.RES_KEYS.map((k) => {
      const s = IMS.RES_SPECS[k];
      return `<div class="col-head">
        <span class="col-icon">${s.icon}</span>
        <div><div class="col-name">${s.label}</div><div class="col-sub">${s.sub}</div></div>
        <div class="col-spec">${s.baseSpeed} u/t · ${s.slots} slots · ${s.activeW}W</div>
      </div>`;
    }).join('');

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
          Array(u.spec.slots - u.running.length).fill('<span class="slot-empty"></span>').join('');
        const load = u.load();
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

    if (lastDecision) {
      const t = IMS.PROC_TYPES[lastDecision.proc.type];
      $('brain-mode').textContent = lastDecision.mode;
      $('brain-mode').className = 'mode-badge mode-' + lastDecision.mode.toLowerCase();
      $('brain-state').innerHTML =
        `<b style="color:${t.color}">${t.label}</b> #${lastDecision.proc.pid} · grid state <code>${lastDecision.state.split(':')[1]}</code> → <b>${lastDecision.unitId}</b>`;
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

  function updateKpis(eA, eB, agent) {
    $('kpi-thr').textContent = eA.throughput().toFixed(2);
    $('kpi-lat').textContent = eA.avgLatency().toFixed(1) + 's';
    $('kpi-eff').textContent = (eA.avgEff() * 100).toFixed(0) + '%';
    $('kpi-sec').textContent = eA.stats.violations;
    $('kpi-rew').textContent = eA.stats.rewardEMA.toFixed(2);
    $('kpi-eps').textContent = agent.eps.toFixed(2);
    const adv = eB.stats.completed > 20
      ? ((eA.stats.completed - eB.stats.completed) / eB.stats.completed) * 100
      : 0;
    const advEl = $('kpi-adv');
    advEl.textContent = (adv >= 0 ? '+' : '') + adv.toFixed(0) + '%';
    advEl.style.color = adv >= 5 ? '#3ddc84' : adv <= -5 ? '#ff5566' : '#e8eefc';
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

  /* animated chip flying from the brain card to the target cell */
  let activeFlies = 0;
  function flyChip(proc, unitId) {
    if (activeFlies > 8) return;
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
    updateQueue, updateGrid, updateBrain, updateKpis, pushLog, flyChip, chip,
  };
})();
