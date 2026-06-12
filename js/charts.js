/* ============================================================
 * Dependency-free canvas line charts + learned-policy heatmap.
 * ============================================================ */
(function () {
  const IMS = window.IMS;

  class LineChart {
    constructor(canvas, series, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.series = series; // [{name, color}]
      this.opts = opts;
    }

    draw(dataArrays) {
      const c = this.canvas, ctx = this.ctx;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const padL = 30, padR = 8, padT = 8, padB = 16;
      let min = this.opts.min ?? Infinity, max = this.opts.max ?? -Infinity;
      if (this.opts.min === undefined || this.opts.max === undefined) {
        for (const d of dataArrays) for (const v of d) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
        if (!isFinite(min)) { min = 0; max = 1; }
        if (max - min < 1e-6) max = min + 1;
        const pad = (max - min) * 0.1;
        min -= pad; max += pad;
      }

      ctx.strokeStyle = 'rgba(140,160,200,0.15)';
      ctx.fillStyle = 'rgba(160,180,220,0.55)';
      ctx.font = '9px monospace';
      ctx.lineWidth = 1;
      for (let g = 0; g <= 3; g++) {
        const y = padT + ((h - padT - padB) * g) / 3;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
        const val = max - ((max - min) * g) / 3;
        ctx.fillText(val.toFixed(this.opts.digits ?? 1), 2, y + 3);
      }

      dataArrays.forEach((data, si) => {
        if (data.length < 2) return;
        ctx.strokeStyle = this.series[si].color;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        const n = data.length;
        for (let i = 0; i < n; i++) {
          const x = padL + ((w - padL - padR) * i) / (n - 1);
          const y = padT + (h - padT - padB) * (1 - (data[i] - min) / (max - min));
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      });

      // legend
      let lx = padL + 4;
      for (const s of this.series) {
        ctx.fillStyle = s.color;
        ctx.fillRect(lx, h - 11, 8, 8);
        ctx.fillStyle = 'rgba(200,215,240,0.8)';
        ctx.fillText(s.name, lx + 11, h - 4);
        lx += 11 + s.name.length * 5.6 + 14;
      }
    }
  }

  /* 4x3 heatmap: rows = process types, cols = resource columns.
     Mirrors the resource grid so the learned policy reads instantly. */
  function renderHeatmap(container, matrix) {
    if (!container._built) {
      container._built = true;
      let html = '<div class="hm-row hm-head"><div class="hm-label"></div>';
      for (const k of IMS.RES_KEYS) html += `<div class="hm-cell-head">${IMS.RES_SPECS[k].label}</div>`;
      html += '</div>';
      for (const t of IMS.PROC_KEYS) {
        html += `<div class="hm-row"><div class="hm-label" style="color:${IMS.PROC_TYPES[t].color}">${IMS.PROC_TYPES[t].label}</div>`;
        for (const k of IMS.RES_KEYS) {
          html += `<div class="hm-cell" id="hm-${t}-${k}"><span></span></div>`;
        }
        html += '</div>';
      }
      container.innerHTML = html;
    }
    let lo = 0, hi = 0;
    for (const t of IMS.PROC_KEYS) for (const k of IMS.RES_KEYS) {
      lo = Math.min(lo, matrix[t][k]); hi = Math.max(hi, matrix[t][k]);
    }
    const span = Math.max(0.001, hi - lo);
    for (const t of IMS.PROC_KEYS) {
      const best = IMS.RES_KEYS.reduce((a, b) => (matrix[t][a] >= matrix[t][b] ? a : b));
      for (const k of IMS.RES_KEYS) {
        const v = matrix[t][k];
        const el = document.getElementById(`hm-${t}-${k}`);
        const norm = (v - lo) / span;
        const hue = 8 + norm * 130; // red -> green
        el.style.background = `hsla(${hue}, 65%, ${22 + norm * 14}%, 0.9)`;
        el.firstChild.textContent = v.toFixed(2);
        el.classList.toggle('hm-best', k === best && Math.abs(v) > 0.001);
      }
    }
  }

  IMS.LineChart = LineChart;
  IMS.renderHeatmap = renderHeatmap;
})();
