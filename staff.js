/* Sea-level Cities: the gauge staff. A vertical ruler beside each place's 3D block, in metres above the place's
   own mean sea level, with marks for the ground, high water, the defence crest, storm peaks and projected water.
   The water column rises with the block (staff.level follows block.level), so the reader reads the same level twice.

   const s = FCC.slcStaff(container, { msl, marks, min, max, label })
     msl     local mean sea level above the model datum (EGM2008), m: places.json msl_m. Every value below is in
             model metres (as in scenarios.json wl and g) and shown as metres above that sea level.
     marks   [{ key, text, m, tone: 'ground' | 'tide' | 'crest' | 'storm' | 'future', range: [lo, hi] }]
     min/max range of the ruler in model metres (optional; fitted to the marks)
   s.level(m, ms)       water column to m (model metres), eased over ms (0: at once, for scroll-driven updates)
   s.show(keys)         only these marks are drawn (others fade), so a step can introduce one mark at a time
   A projection's likely range is a bracket right of the bar, drawn only while it is the level shown, never a band in
   the bar (the bar holds only water); a key under the staff says what the bracket means. The bracket means only
   that: a defence crest's range (lowest to highest section) is written in its label instead.
   A solid triangle (ink) left of the bar points at the water's surface: the level the reader is looking at. The mark
   it reaches is set in bold. Ink, not the Bauhaus yellow: yellow on paper is below the 3:1 contrast a graphic needs.
   Page-specific (not in _shared): styles are scoped under .slc in slc.css, colours are theme.css tokens. */
(function (g) {
  'use strict';
  const FCC = g.FCC || (g.FCC = {});
  FCC.slcStaff = function (container, { msl, marks, min, max, label = 'm above mean sea level' }) {
    const W = 196, H = 420, M = { t: 14, r: 6, b: 38, l: 36 }, X0 = M.l, BAR = 14, TRI = 9;
    const vals = marks.flatMap((k) => [k.m, ...(k.range || [])]).filter(Number.isFinite);
    const lo = min ?? Math.min(msl - 0.5, ...vals) - 0.3, hi = max ?? Math.max(msl + 0.5, ...vals) + 0.3;
    const y = d3.scaleLinear().domain([lo - msl, hi - msl]).range([H - M.b, M.t]);
    const svg = d3.select(container).append('svg').attr('class', 'slc-staff').attr('viewBox', `0 0 ${W} ${H}`)
      .attr('role', 'img').attr('aria-label', `Gauge staff in metres above mean sea level`);
    const step = (hi - lo) > 6 ? 1 : 0.5;
    const ticks = d3.range(Math.ceil((lo - msl) / step) * step, hi - msl + 1e-9, step);
    svg.append('rect').attr('class', 'slc-staff-bar').attr('x', X0).attr('y', M.t).attr('width', BAR).attr('height', H - M.t - M.b);
    const water = svg.append('rect').attr('class', 'slc-staff-water').attr('x', X0).attr('width', BAR).attr('y', y(lo - msl)).attr('height', 0);
    const ax = svg.append('g').attr('class', 'slc-staff-axis');
    ticks.forEach((v) => {
      const major = Math.abs(v - Math.round(v)) < 1e-9;
      ax.append('line').attr('x1', X0 - (major ? 6 : 3)).attr('x2', X0).attr('y1', y(v)).attr('y2', y(v));
      if (major) ax.append('text').attr('x', X0 - TRI - 6).attr('y', y(v)).attr('dy', '0.32em').attr('text-anchor', 'end')
        .text(v === 0 ? '0' : d3.format('+')(v));
    });
    ax.append('text').attr('class', 'slc-staff-unit').attr('x', 0).attr('y', H - 20).text(label);
    // Key for the bracket
    const BX = X0 + BAR + 5;
    const bracket = (g, y0, y1) => g.append('path').attr('class', 'slc-staff-bracket')
      .attr('d', `M${BX - 2.5},${y0}H${BX}V${y1}H${BX - 2.5}`);
    if (marks.some((k) => k.range && k.tone !== 'crest')) {
      const key = ax.append('g').attr('class', 'slc-staff-key').attr('transform', `translate(${-BX + 3},${H - 13})`);
      bracket(key, 0, 9);
      key.append('text').attr('x', BX + 5).attr('y', 4.5).attr('dy', '0.32em').text('likely range (17–83%)');
    }
    // Marks: a tick across the bar and a label to its right; labels that would overlap are pushed apart.
    const mk = svg.append('g').attr('class', 'slc-staff-marks');
    const placed = marks.filter((k) => Number.isFinite(k.m)).map((k) => ({ ...k, y: y(k.m - msl) })).sort((a, b) => b.y - a.y);
    for (let i = 1; i < placed.length; i++) placed[i].ly = Math.min(placed[i].y, (placed[i - 1].ly ?? placed[i - 1].y) - 13);
    placed.forEach((k) => {
      k.ly = k.ly ?? k.y;
      const gk = mk.append('g').attr('class', `slc-staff-mark is-${k.tone}`).attr('data-k', k.key);
      if (k.range && k.tone !== 'crest') bracket(gk, y(k.range[1] - msl), y(k.range[0] - msl));
      gk.append('line').attr('x1', X0 - 3).attr('x2', X0 + BAR + 3).attr('y1', k.y).attr('y2', k.y);
      gk.append('path').attr('class', 'slc-staff-leader').attr('d', `M${X0 + BAR + 3},${k.y}L${X0 + BAR + 9},${k.ly}`);
      gk.append('text').attr('x', X0 + BAR + 11).attr('y', k.ly).attr('dy', '0.32em')
        .text(`${k.text} ${d3.format('+.2f')(k.m - msl)}${k.tone === 'crest' && k.range ? `–${d3.format('.2f')(k.range[1] - msl)}` : ''}`);
    });
    // The pointer: a triangle whose tip touches the bar at the water's surface.
    const now = svg.append('path').attr('class', 'slc-staff-now').attr('aria-hidden', 'true')
      .attr('d', `M${X0 - 1},0L${X0 - 1 - TRI},${-TRI * 0.58}L${X0 - 1 - TRI},${TRI * 0.58}Z`)
      .attr('transform', `translate(0,${y(lo - msl)})`);
    const markAt = (m) => mk.selectAll('.slc-staff-mark').classed('is-current', function () {
      const k = placed.find((x) => x.key === this.dataset.k); return !!k && Math.abs(k.m - m) < 0.01; });
    let current = lo;
    function level(m, ms = 900) {
      const from = current, to = Math.max(lo, Math.min(hi, m));
      current = to;
      markAt(to);
      if (!ms) { water.interrupt().attr('y', y(to - msl)).attr('height', Math.max(0, y(lo - msl) - y(to - msl)));
        now.interrupt().attr('transform', `translate(0,${y(to - msl)})`); return; }
      now.interrupt().transition().duration(ms).ease(d3.easeCubicInOut)
        .attrTween('transform', () => (t) => `translate(0,${y(from + (to - from) * t - msl)})`);
      water.interrupt().transition().duration(ms).ease(d3.easeCubicInOut)
        .attrTween('y', () => (t) => y(from + (to - from) * t - msl))
        .attrTween('height', () => (t) => Math.max(0, y(lo - msl) - y(from + (to - from) * t - msl)));
    }
    function show(keys) {
      const on = new Set(keys);
      mk.selectAll('.slc-staff-mark').classed('is-off', function () { return !on.has(this.dataset.k); });
    }
    return { level, show, node: svg.node() };
  };
})(window);
