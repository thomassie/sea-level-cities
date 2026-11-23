/* Locator map: a section of the globe centred on a place, with a red dot and a scale bar. Orthographic projection,
   so the section looks like the globe seen from above the place; the scale bar is true at the centre.
   Geometry: world-50m.json (Natural Earth 1:50m land and land borders, public domain, simplified by
   pipeline/slr/locator.py); no tile service. Canonical copy: site/_shared/locator.js (tools/sync_shared.py).

   FCC.locatorWorld(base)  -> Promise of the geometry (loaded once per page; base = the page's path prefix)
   FCC.locator(el, world, { lon, lat, span = 28, cls })
     el    an <svg> whose width sets the size (height = half the width)
     span  degrees of arc from the centre to the left and right edges (28 = about 3,000 km)
     cls   class prefix for styling, e.g. 'slc-loc' gives slc-loc__grat, __land, __border, __ring, __dot, __scale
   Sets el's aria-label to "<label>; scale bar N km" if el has data-label. Needs d3 (7.9.0). */
(function (g) {
  'use strict';
  const FCC = g.FCC || (g.FCC = {});
  let world = null;
  FCC.locatorWorld = (base = '') => world || (world = d3.json(`${base}world-50m.json`));
  FCC.locator = function (el, geo, { lon, lat, span = 28, cls }) {
    const W = el.clientWidth || 280, H = Math.round(W * 0.5);
    const proj = d3.geoOrthographic().rotate([-lon, -lat]).clipAngle(90)
      .scale((W / 2) / Math.sin(span * Math.PI / 180)).translate([W / 2, H / 2]);
    const path = d3.geoPath(proj);
    const svg = d3.select(el).attr('viewBox', `0 0 ${W} ${H}`).attr('height', H);
    svg.selectAll('*').remove();
    svg.append('path').attr('class', `${cls}__grat`).attr('d', path(d3.geoGraticule10()));
    svg.append('path').attr('class', `${cls}__land`).attr('d', path({ type: 'GeometryCollection', geometries: geo.land }));
    svg.append('path').attr('class', `${cls}__border`).attr('d', path({ type: 'GeometryCollection', geometries: geo.borders }));
    const [px, py] = proj([lon, lat]);
    svg.append('circle').attr('class', `${cls}__ring`).attr('cx', px).attr('cy', py).attr('r', 9);
    svg.append('circle').attr('class', `${cls}__dot`).attr('cx', px).attr('cy', py).attr('r', 3.5);
    // scale bar, bottom right: km per pixel at the centre = earth radius (6,371 km) / projection scale
    const kmPx = 6371 / proj.scale(), want = (W * 0.25) * kmPx;
    const km = [100, 200, 500, 1000, 2000, 5000].reduce((best, k) => (Math.abs(k - want) < Math.abs(best - want) ? k : best));
    const x1 = W - 8, x0 = x1 - km / kmPx, yb = H - 8;
    const sc = svg.append('g').attr('class', `${cls}__scale`);
    sc.append('path').attr('d', `M${x0},${yb - 4}V${yb}H${x1}V${yb - 4}`);
    sc.append('text').attr('x', x1).attr('y', yb - 7).attr('text-anchor', 'end').text(`${d3.format(',')(km)} km`);
    if (el.dataset.label) el.setAttribute('aria-label', `${el.dataset.label}; scale bar ${d3.format(',')(km)} km`);
  };
}(window));
