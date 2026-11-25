/* Sea-level Cities: one chapter per place, each read off a gauge staff (staff.js) in metres above the place's own
   mean sea level, beside a 3D block of the place (block3d.js, three.js) whose water rises with the reader's scroll
   to the levels the IPCC projects (AR6, median), only where the sea can actually reach.

   <div id="sea-level-cities"> options:
     data-base        where data/ and blocks/ live (default: this page's folder)
     data-header      "false" hides the page's own title (the host page has one)
     data-layout      "standalone" adds the page's own width and gutters
     data-sticky-top  height in px of a fixed header on the host page
   Every number in the text comes from data/*.json (exported from MotherDuck marts by pipeline/run.py).
   Levels are handled in model metres (above EGM2008, as in scenarios.json) and shown as metres above local mean
   sea level (places.json msl_m). Blocks are created when their chapter comes near the viewport and disposed
   when it leaves, so the page never holds more than a few WebGL contexts. */
(function () {
  'use strict';
  const root = document.getElementById('sea-level-cities');
  if (!root) return;
  const base = root.dataset.base || '';
  root.classList.add('slc');
  root.style.setProperty('--sticky-top', (parseFloat(root.dataset.stickyTop || '0') || 0) + 'px');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (v, d = 0) => (v == null || !Number.isFinite(v) ? '–' : d3.format(`,.${d}f`)(v));
  // Colours of the 3D block: a white "plaster" relief model, the sea in the site blue, and land the sea would take
  // (between today's high tide and the projected one) in red. Hex values are theme.css tokens where one fits.
  const PALETTES = {
    light: { landLow: '#F3F2EF', landHigh: '#E4E2DD', built: '#D9D6D0', builtAmount: 0.5, seaDeep: '#C3CFD8', seaShallow: '#E3E9ED',
             shadeStrength: 0.9, water: '#4A7194', waterOpacity: 0.32, waterOverLand: 0.06, lost: '#D94B30', lostAmount: 0.9,
             lostStyle: 'fill', side: '#3E4349', shadow: 0.3 },
    dark:  { landLow: '#4A5058', landHigh: '#5A6168', built: '#626A73', builtAmount: 0.5, seaDeep: '#262B31', seaShallow: '#353B42',
             shadeStrength: 0.9, water: '#85B0D0', waterOpacity: 0.3, waterOverLand: 0.06, lost: '#E45B35', lostAmount: 0.9,
             lostStyle: 'fill', side: '#1B1E22', shadow: 0.5, shore: '#B9D3E6', road: '#7D858E', border: '#C9CED4' },
  };
  const isDark = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  };
  const live = new Set();   // { b, extra }: blocks that exist now, for theme changes
  const paint = (x) => x.b.palette({ ...PALETTES[isDark() ? 'dark' : 'light'], ...x.extra });
  const stills = new Set();   // functions that redraw a chapter's still image (no WebGL) in the current theme
  const applyPalette = () => { live.forEach(paint); stills.forEach((f) => f()); };
  if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyPalette);
  new MutationObserver(applyPalette).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const WEBGL = FCC.block3d.supported();
  // Reduced motion: the camera jumps to each step's view instead of flying there; the water still follows the scroll.
  const STILL = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const fly = (ms) => (STILL ? 0 : ms);
  const SCEN = { ssp126: 'low emissions', ssp245: 'medium emissions', ssp585: 'very high emissions' };
  const SINK = 'halflife30';   // Jakarta: the sinking slows, halving every 30 years (flood.py PATHS)
  // Through the first 60% of a step the water rises from the previous step's level to this step's level.
  const easeAt = (p) => { const k = Math.min(1, p / 0.6); return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; };
  // What each place stands for in the story (docs/projects/sea-level-cities/chapters.md, agreed 18 Nov 2026).
  const THEME = { jakarta: 'Subsidence', majuro: 'An atoll capital', 'new-york': 'Storms on a higher sea', hamburg: 'The defended city',
    mekong: 'Salinisation', khulna: 'Cyclones and salt', 'nile-delta': 'Erosion', louisiana: 'Land loss' };
  // Places without a chapter, kept in the comparison row (staff only). None at present.
  const NO_CHAPTER = new Set([]);
  const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

  Promise.all(['places', 'scenarios', 'units', 'exposure', 'overview', 'overview_facts', 'meta'].map((f) => d3.json(`${base}data/${f}.json`))).then(([places, scen, units, expo, overview, ofacts, meta]) => {
    places.sort((a, b) => a.chapter_order - b.chapter_order);
    const byId = new Map(places.map((p) => [p.place_id, p]));
    const row = (P, s, y, sub = 'none', w = 'high_tide') =>
      scen.find((r) => r.p === P && r.s === s && r.sub === sub && r.w === w && (y == null || r.y === y)) || {};
    const YEAR = (scen.find((r) => r.s === 'today' && r.y) || {}).y;
    // People on land below the high-tide line, rounded so the text does not claim false precision.
    const people = (v) => (v == null ? '–' : fmt(v >= 100000 ? Math.round(v / 10000) * 10000 : v >= 10000 ? Math.round(v / 1000) * 1000 : Math.round(v / 100) * 100));
    const likely = (r) => (r && r.pl != null ? ` (likely ${people(r.pl)} to ${people(r.ph)})` : '');
    const km2 = (v) => (v != null && v < 10 ? fmt(v, 1) : fmt(v));   // small areas (Majuro) need a decimal
    const metres = (v) => fmt(Math.abs(v), 2);
    // "1.23 m above" / "0.40 m below" mean sea level
    const vsMsl = (v) => `${metres(v)} m ${v < 0 ? 'below' : 'above'}`;
    const cm = (v) => fmt(Math.round(v * 100));
    // only facts of medium or high confidence reach places.json (mart.slr_places, review E1)
    const imp = (P, f) => (byId.get(P).impacts || []).find(f);
    const cite = (i) => (i ? `${esc(i.text)} <span class="slc-src">(<a href="${esc(i.url)}">${esc(i.src)}</a>)</span>` : '');
    const date = (s) => d3.timeFormat('%-d %B %Y')(new Date(s));

    // ---------- the numbers of one place, in model metres ----------
    function model(P) {
      const p = byId.get(P), msl = p.msl_m, base0 = msl + p.mhhw_m;    // high water on the projections' 1995–2014 sea
      const t = row(P, 'today'), f50 = row(P, 'ssp245', 2050), f100 = row(P, 'ssp245', 2100), x100 = row(P, 'ssp585', 2100);
      const modelled = t.wl != null;
      // Not modelled: the rise to today is interpolated from 0 in 2005 (the baseline's centre) to the 2030 median.
      const r30 = row(P, 'ssp245', 2030).r;
      const tide = modelled ? t.wl : base0 + (r30 * (YEAR - 2005)) / 25;
      const rToday = tide - base0;
      // the modelled water level (scenarios.json wl) where it exists, so staff, text and map agree; Jakarta's excludes
      // AR6's land-motion term because its measured sinking is modelled instead (review A26)
      const lvl = (r) => (r.wl != null ? r.wl : base0 + r.r);
      const ab = (m) => m - msl;
      const crest = (p.defences || []).filter((d) => d.on_staff);
      const above = imp(P, (i) => /above high tide/.test(i.unit || ''));
      const ground = modelled ? f100.g : above ? tide + above.value : null;
      const marks = [];
      if (ground != null) marks.push({ key: 'ground', text: 'Ground', m: ground, tone: 'ground' });
      marks.push({ key: 'tide', text: 'High water', m: tide, tone: 'tide' });
      crest.forEach((d) => marks.push({ key: 'crest', text: 'Defence', m: msl + d.low_msl, tone: 'crest',
        range: d.high_msl > d.low_msl ? [msl + d.low_msl, msl + d.high_msl] : null }));
      [[2050, f50], [2100, f100]].forEach(([y, r]) => r.r != null && marks.push({ key: `y${y}`, text: String(y), m: lvl(r), tone: 'future',
        range: [base0 + r.rl, base0 + r.rh] }));
      return { p, P, msl, base0, t, f50, f100, x100, modelled, tide, rToday, lvl, ab, crest, ground, marks };
    }
    const MODELS = new Map(places.map((p) => [p.place_id, model(p.place_id)]));

    // ---------- the chapters ----------
    // Shared sentences
    // AR6's land-motion term is a slight uplift at some deltas, so its "relative" rise there contains no sinking (review B3)
    const uplift = (c) => c.P !== 'jakarta' && c.p.ar6_vlm_m != null && c.p.ar6_vlm_m <= 0;
    const upliftNote = (c) => (uplift(c) ? ` The IPCC’s figure here contains no sinking of the delta (its land-motion term is a
      slight rise of the land), so the relative rise is if anything a lower bound.` : '');
    const rising = (c, y, r, rel) => `By ${y}, with medium emissions (SSP2-4.5), the IPCC projects the ${rel ? 'relative ' : ''}sea level
      ${c.P === 'new-york' ? 'at the Battery ' : ''}to rise about <strong>${cm(c.lvl(r) - c.tide)} cm</strong> above today’s, to
      ${vsMsl(c.ab(c.lvl(r)))} mean sea level at high water.${rel && y === 2100 ? upliftNote(c) : ''}`;
    const below = (r, verb = 'would lie') => (r.a == null ? '' : ` Without defences, <strong>${km2(r.a)} km²</strong> ${verb} below the
      high-tide line, land where about <strong>${people(r.pop)}</strong> people live today${likely(r)}.`);
    const groundLine = (c) => (c.ground == null ? '' : `<p>The land the sea could reach by 2100 lies typically
      <strong>${vsMsl(c.ab(c.ground))}</strong> mean sea level (the dashed mark).</p>`);
    const tideLine = (c) => `<p>On an ordinary day, high water rises to <strong>${vsMsl(c.ab(c.tide))}</strong> mean sea level.${below(c.t, 'lie')}</p>`;
    const extremeLine = (c, rel) => (c.x100.r == null ? '' : ` With very high emissions (SSP5-8.5) the ${rel ? 'relative ' : ''}rise to 2100
      would be about ${cm(c.lvl(c.x100) - c.tide)} cm above today’s${c.x100.a != null ? `, and about ${people(c.x100.pop)} people would live below the line` : ''}.`);
    // A crest whose source does not state the datum: the published figure with the source's own wording (d.datum),
    // not converted and not drawn on the staff.
    const unconverted = (d) => `${esc(d.name)}: a crest of ${fmt(d.low, 1)}${d.high > d.low ? `–${fmt(d.high, 1)}` : ''} ${esc(d.unit)},
      ${esc(d.datum)}. Without a stated datum it cannot be compared with the staff, so it is not drawn there.
      <span class="slc-src">(<a href="${esc(d.url)}">${esc(d.src)}</a>)</span>`;
    const crestLine = (c, d) => `The crest stands <strong>${metres(d.low_msl)}${d.high_msl > d.low_msl ? `–${metres(d.high_msl)}` : ''} m</strong>
      above mean sea level (published: ${fmt(d.low, 2)}${d.high > d.low ? `–${fmt(d.high, 2)}` : ''} ${esc(d.unit)} ${esc(d.datum)}).
      <span class="slc-src">(<a href="${esc(d.url)}">${esc(d.src)}</a>)</span>`;
    const defence = (c, id) => (c.p.defences || []).find((d) => d.id === id);
    const upliftLine = () => { const n = places.filter((p) => uplift({ P: p.place_id, p })).map((p) => esc(p.name.split(/[:,]| and the /)[0]));
      return n.length ? `For ${n.join(', ').replace(/, ([^,]*)$/, ' and $1')} that trend is a slight rise of the land, so the
        IPCC’s figure contains none of the deltas’ sinking and the relative rise there is if anything a lower bound.` : ''; };
    // Opening paragraph: who lives there and what the place is known for (content/slr/profile.csv, sourced).
    const PROFILE = { jakarta: ['population', 'capital'], majuro: ['population', 'median-height'], 'new-york': ['population', 'floodplain'], hamburg: ['population', 'port'],
      mekong: ['province', 'rice'], khulna: ['population', 'sundarbans'], 'nile-delta': ['population', 'delta', 'sediment'],
      louisiana: ['population', 'football-field'] };
    const profile = (c) => { const f = (PROFILE[c.P] || []).map((id) => (c.p.profile || []).find((x) => x.id === id)).filter(Boolean);
      return f.length ? `<p class="slc-profile">${f.map((x) => esc(x.text)).join(' ')} <span class="slc-src">(Sources:
        ${f.map((x) => `<a href="${esc(x.url)}">${esc(x.src)}</a>`).join('; ')})</span></p>` : ''; };

    // az: the side the camera looks from (0 = from the south, 90 from the east, 180 from the north): from the sea.
    const CH = {
      'new-york': { az: 10, relative: false,
        lede: () => `<p>New York’s danger is not the daily tide but the storm on top of it. When Sandy came ashore, the water
          rose metres above the ordinary high tide and flooded the subway, the tunnels and whole neighbourhoods.</p>`,
        defence: () => `<p>No continuous sea wall protects the city. Its defences are piecemeal: bulkheads, dunes, raised
          parks and a few walls under construction <span class="slc-src">(<a href="https://www.nyc.gov/assets/sustainability/downloads/pdf/publications/Sandy-10-Years-Later.pdf">NYC, Sandy 10 Years Later</a>)</span>.
          On the staff, what matters is the height a storm reaches.</p>`,
        extra: (c) => {
          const s = (c.p.storms || [])[0];
          if (!s) return [];
          const now = row(c.P, 'today', null, 'none', s.id), later = row(c.P, 'ssp245', 2100, 'none', s.id);
          c.marks.push({ key: 'storm', text: s.name, m: s.peak_m, tone: 'storm' });
          return [
            { level: now.wl, show: ['storm'], when: `${s.name}’s peak on today’s sea`,
              html: `<p>${esc(s.name)}’s storm tide peaked at the Battery on the evening of ${date(s.date)}
                <span class="slc-src">(<a href="${esc(s.url)}">${esc(s.src)}</a>)</span>: <strong>${vsMsl(c.ab(s.peak_m))}</strong>
                mean sea level as this page measures it (from satellite altimetry; NOAA’s own tide-gauge mean for 1983–2001
                is a few centimetres lower). The staff marks that peak; the level shown on the map is the same storm on
                today’s higher sea.
                The same storm on today’s slightly higher sea would reach land where about <strong>${people(now.pop)}</strong>
                people live${likely(now)}, ${km2(now.a)} km² in this block, which includes the New Jersey shore.</p>
                <p>${cite(imp(c.P, (i) => i.unit === 'sq mi'))}</p>` },
            { level: later.wl, show: ['storm', 'y2100'], when: `${s.name} on the 2100 sea, medium emissions`,
              html: `<p>On the sea of 2100 with medium emissions, a storm like ${esc(s.name)} would reach land where about
                <strong>${people(later.pop)}</strong> people live today${likely(later)}.</p>
                <p>${cite(imp(c.P, (i) => i.unit === 'billion USD'))}</p>` },
          ];
        },
        mechanism: (c) => `<p>${cite(imp(c.P, (i) => i.unit === 'mm/yr'))}</p><p>${cite(imp(c.P, (i) => i.unit === 'deaths'))}</p>` },
      hamburg: { az: 240, relative: false,
        lede: () => `<p>Hamburg lies far up the Elbe, yet the tide reaches it, and the river funnels it: high water is
          higher in the city than at the river’s mouth. Hamburg is the defended city.</p>`,
        defence: (c) => { const d = defence(c, 'defence_line');
          return `<p>${esc(d.name)}. ${crestLine(c, d)}</p><p>${cite(imp(c.P, (i) => i.unit === 'm NHN' && i.value > 8))}</p>`; },
        extra: (c) => {
          const d = defence(c, 'defence_line'), off = d.low - d.low_msl;   // NHN to local mean sea level
          const s76 = imp(c.P, (i) => i.unit === 'm NHN' && i.value < 8), design = imp(c.P, (i) => i.unit === 'm NHN' && i.value > 8);
          if (s76) c.marks.push({ key: 'storm', text: '1976', m: c.msl + s76.value - off, tone: 'storm' });
          if (design) c.marks.push({ key: 'design', text: 'Design', m: c.msl + design.value - off, tone: 'storm' });
          return s76 ? [{ level: c.msl + s76.value - off, show: ['storm', 'design'], when: 'the 1976 storm flood, without dikes',
            html: `<p>${cite(s76)} That is <strong>${vsMsl(s76.value - off)}</strong> mean sea level: the block shows,
              roughly, the land such a flood could reach if there were no dikes.</p>
              <p>The city plans for more: its design water level is ${metres(design.value - off)} m above mean sea level.</p>` }] : [];
        },
        mechanism: (c) => `<p>${cite(imp(c.P, (i) => i.unit === 'deaths'))}</p><p>${cite(imp(c.P, (i) => i.unit === '% of city area'))}</p>` },
      mekong: { az: 100, relative: true,
        lede: () => `<p>In the Mekong Delta the sea does not need a storm. The land of Ben Tre and Tra Vinh is so low and
          flat that the ordinary high tide already stands above much of it, and salt water pushes up the river arms.</p>`,
        defence: (c) => `<p>Earth sea dikes and sluice gates hold the tide and the salt back, but we found no documented
          crest heights for the dikes of these two provinces.</p>${(() => { const d = defence(c, 'ba_lai_sluice');
            return d ? `<p>${unconverted(d)}</p>` : ''; })()}`,
        mechanism: (c) => `<p>${cite(imp(c.P, (i) => i.unit === 'households'))}</p>
          <p>${cite(imp(c.P, (i) => i.kind === 'subsidence'))} This sinking from groundwater pumping is not in the map’s
          terrain, so the land below the line is if anything understated.</p>` },
      khulna: { az: 10, relative: true,
        lede: () => `<p>On Bangladesh’s southwest coast, by the Sundarbans, people live on islands ringed by embankments:
          the polders, built from the 1960s to keep the tide and the salt off the rice fields.</p>`,
        defence: () => `<p>The polder embankments are the defence here. We found design rules for them, but no documented
          crest heights for these polders, so the staff does not show one. Cyclones have repeatedly broken them.</p>`,
        mechanism: (c) => `<p>${cite(imp(c.P, (i) => i.unit === 'deaths'))}</p><p>${cite(imp(c.P, (i) => i.value === 2500000))}</p>
          <p>${cite(imp(c.P, (i) => i.kind === 'salinisation'))}</p>` },
      'nile-delta': { az: 180, relative: true,
        lede: () => `<p>The Mediterranean barely has a tide. Yet the land behind Alexandria, around Lake Maryut, lies
          below sea level, and the delta’s edge sinks and wears away now that the Nile’s sediment stops at the dam.</p>`,
        defence: (c) => { const w = (c.p.profile || []).find((x) => x.id === 'rosetta-seawalls');
          return `<p>${w ? cite(w) : ''}</p><p>They hold the eroding river mouth in place; they do not protect the low land
          behind Alexandria, where most of the people below the line live.</p>`; },
        mechanism: (c) => `<p>${cite(imp(c.P, (i) => i.unit === 'm/yr'))}</p><p>${cite(imp(c.P, (i) => i.kind === 'subsidence'))}</p><p>${cite(imp(c.P, (i) => i.unit === 'buildings'))}</p>` },
      louisiana: { az: 10, relative: true,
        lede: (c) => `<p>Coastal Louisiana sinks about ${fmt(imp(c.P, (i) => i.kind === 'subsidence').value)} millimetres a year on average (see below). Here
          the sea is rising and the land is sinking and washing away at the same time, between the bayous of Terrebonne
          and Barataria.</p>`,
        defence: (c) => { const d = defence(c, 'larose_golden_meadow');
          return `<p>The towns along the bayous sit inside levee rings. ${d ? unconverted(d) : ''}</p>
            <p>Outside the rings, the marsh and the fishing camps have no levee at all.</p>`; },
        mechanism: (c) => `<p>${cite(imp(c.P, (i) => i.unit === 'km²'))}</p><p>${cite(imp(c.P, (i) => i.kind === 'subsidence'))}</p>
          <p>Isle de Jean Charles: ${cite(imp(c.P, (i) => i.unit === 'acres remaining'))} ${cite(imp(c.P, (i) => i.kind === 'relocation'))}</p>` },
      // Majuro: the atoll is 46 km across, its land a thin ring; the steps zoom in on the capital's islets in the east
      // (view targets in km from the block's centre, tx east, tz north: Delap-Uliga-Djarrit at about 16.5, -3.6).
      majuro: { az: 20, relative: false,
        cams: [{ az: 15, el: 40, dist: 2.1, tx: 0, tz: 0 }, { az: 25, el: 55, dist: 0.3, tx: 16, tz: -2.5 },
          { az: 10, el: 55, dist: 0.26, tx: 16.3, tz: -3.2 }, { az: 35, el: 55, dist: 0.32, tx: 16, tz: -2.5 },
          { az: 30, el: 55, dist: 0.45, tx: 13, tz: -4.2 }, { az: 15, el: 45, dist: 2.1, tx: 0, tz: 0 }],
        lede: () => `<p>Majuro is a ring of coral islets around a lagoon, most of them a few hundred metres wide. There is
          no high ground to retreat to: on the capital’s islets in the east, the lagoon and the open ocean lie a short walk
          apart.</p>`,
        defence: () => `<p>Sea walls guard stretches of the capital’s shore, but we found no documented crest heights for
          them, so the staff does not show one.</p>`,
        mechanism: (c) => `<p>${cite(imp(c.P, (i) => i.unit === 'km² of land'))}</p><p>${cite(imp(c.P, (i) => i.unit === 'households'))}</p>
          <p>${cite(imp(c.P, (i) => i.unit === '% of urban land'))}</p>` },
    };

    function genericSteps(c, cfg) {
      const n = c.n, rel = cfg.relative;
      const steps = [
        { level: c.msl, show: ['ground'], when: 'mean sea level',
          html: `<p class="slc-kicker">${n} · ${esc(THEME[c.P] || '')}</p><h2>${esc(c.p.name)}</h2>${profile(c)}${cfg.lede(c)}${groundLine(c)}` },
        { level: c.tide, show: ['ground', 'tide'], when: 'high water today', html: tideLine(c) },
        { level: c.tide, show: ['ground', 'tide', 'crest'], when: 'high water today', html: cfg.defence(c) },
        { level: c.lvl(c.f50), show: ['ground', 'tide', 'crest', 'y2050'], when: '2050 · medium emissions',
          html: `<p>${rising(c, 2050, c.f50, rel)}${below(c.f50)}</p>` },
        { level: c.lvl(c.f100), show: ['ground', 'tide', 'crest', 'y2050', 'y2100'], when: '2100 · medium emissions',
          html: `<p>${rising(c, 2100, c.f100, rel)}${below(c.f100)}${extremeLine(c, rel)}</p>` },
      ];
      if (cfg.cams) steps.forEach((s, i) => { s.cam = cfg.cams[Math.min(i, cfg.cams.length - 1)]; });
      const extra = cfg.extra ? cfg.extra(c) : [];
      extra.forEach((s) => { s.show = [...steps[steps.length - 1].show, ...s.show]; });
      steps.push(...extra);
      steps.push({ level: c.lvl(c.f100), show: steps[steps.length - 1].show, when: '2100 · medium emissions', html: cfg.mechanism(c) });
      return steps;
    }

    // Jakarta: the ground sinks as well; the steps move through land states (spill rasters) as well as levels.
    function jakartaSteps(c) {
      const P = c.P, t = c.t, r = (s, y, sub) => row(P, s, y, sub);
      const sub = imp(P, (i) => i.kind === 'subsidence');
      const OHENHEN = '<a href="https://doi.org/10.1126/sciadv.aec0172">Ohenhen et al. 2026</a>';
      const topDistrict = (s, y, sb) => units.filter((u) => u.l === 6).map((u) => ({ u, e: expo.find((e) => e.p === P && e.w === 'high_tide'
        && e.s === s && e.y === y && e.sub === sb && e.u === u.u) })).filter((d) => d.e).sort((a, b) => b.e.pop - a.e.pop)[0];
      const r50 = r('today', 2050, SINK), b50 = r('ssp245', 2050, SINK), b100 = r('ssp245', 2100, SINK), x100 = r('ssp585', 2100, SINK);
      const wall = defence(c, 'ncicd_phase_a');
      return [
        { cam: { az: 200, el: 32, dist: 2.15, tx: 0, tz: 0 }, level: c.msl, show: ['ground'], when: 'mean sea level', t: 'none',
          html: `<p class="slc-kicker">${c.n} · ${esc(THEME[c.P] || '')}</p><h2>${esc(c.p.name)}</h2>${profile(c)}
            <p>Jakarta sits on a flat coastal plain on the Java Sea. Its northern districts are barely above the sea, and
            some are already below it.</p>${groundLine(c)}` },
        { cam: { az: 165, el: 28, dist: 1.2, tx: -3, tz: 3 }, level: c.tide, show: ['ground', 'tide'], when: 'high water today', t: 'none',
          html: `${tideLine(c)}${(() => { const u = r('today', null, 'dem_epoch');   // review B5: the terrain's date is uncertain
              return u.pop == null ? '' : `<p>That count lowers the terrain model by the sinking measured since about 2013, when
              its heights were taken; the model was later corrected with satellite heights from 2018 on, so its true date is
              uncertain. On its heights as published, the figure would be about ${people(u.pop)}; the true figure for today most likely lies between the two.</p>`; })()}<p>Sea walls, embankments and pumps keep most of it dry. ${wall ? unconverted(wall) : ''}</p>` },
        { cam: { az: 175, el: 30, dist: 1.3, tx: -2, tz: 2 }, level: c.tide, show: ['ground', 'tide'], when: 'sea as today · ground sinking',
          t: `${SINK}_2050`,
          html: `<p>${sub ? cite(sub) : ''}</p><p>The ground is sinking, mostly because groundwater is pumped from beneath
            the city and the soft delta soils compact. Satellite radar measured how fast between 2017 and 2023
            <span class="slc-src">(${OHENHEN})</span>. Even if the sea did not rise at all: if the sinking slows, halving
            every 30 years, about <strong>${km2(r50.a)} km²</strong> would lie below today’s high tide by 2050, home to about
            <strong>${people(r50.pop)}</strong> people${likely(r50)}. At today’s pace it would be about
            ${people(r('today', 2050, 'constant').pop)}.</p>` },
        { cam: { az: 185, el: 30, dist: 1.45, tx: 0, tz: 2 }, level: c.lvl(c.f50), show: ['ground', 'tide', 'y2050'],
          when: '2050 · medium emissions · ground sinking', t: `${SINK}_2050`,
          html: `<p>${rising(c, 2050, c.f50, true)} Together with the sinking ground, about <strong>${km2(b50.a)} km²</strong>
            would lie below the high-tide line, land where about <strong>${people(b50.pop)}</strong> people live
            today${likely(b50)}. The rising sea alone, on today’s ground, would reach land with about
            ${people(c.f50.pop)} people.</p>` },
        { cam: { az: 215, el: 32, dist: 1.8, tx: 0, tz: 1 }, level: c.lvl(c.f100), show: ['ground', 'tide', 'y2050', 'y2100'],
          when: '2100 · medium emissions · ground sinking', t: `${SINK}_2100`,
          html: `<p>${rising(c, 2100, c.f100, true)} With the ground still sinking, ever more slowly, about
            <strong>${km2(b100.a)} km²</strong> would lie below the line, where about <strong>${people(b100.pop)}</strong>
            people live today${likely(b100)}${(() => { const d = topDistrict('ssp245', 2100, SINK);
              return d ? `, ${people(d.e.pop)} of them in the district of ${esc(d.u.n)}` : ''; })()}.</p>` },
        { cam: { az: 235, el: 34, dist: 2.25, tx: 0, tz: 0 }, level: c.lvl(c.x100), show: ['ground', 'tide', 'y2050', 'y2100'],
          when: '2100 · very high emissions · ground sinking', t: `${SINK}_2100`,
          html: `<p>With very high emissions (SSP5-8.5): about <strong>${cm(c.lvl(c.x100) - c.tide)} cm</strong> of relative
            sea-level rise above today’s and <strong>${km2(x100.a)} km²</strong> below the high-tide line, home to about
            <strong>${people(x100.pop)}</strong> people today${likely(x100)}. Even if the sinking halved every 10 years,
            it would be about ${people(r('ssp585', 2100, 'halflife10').pop)}.</p>` },
      ];
    }

    const CAMS = [{ el: 34, dist: 2.15, d: 0 }, { el: 30, dist: 1.5, d: -20 }, { el: 32, dist: 1.4, d: 15 },
      { el: 32, dist: 1.6, d: 0 }, { el: 34, dist: 1.9, d: 25 }, { el: 34, dist: 2.1, d: 35 }, { el: 35, dist: 2.2, d: 45 }, { el: 36, dist: 2.25, d: 50 }];
    const chapters = places.filter((p) => !NO_CHAPTER.has(p.place_id)).map((p, k) => {
      const c = MODELS.get(p.place_id);
      c.n = k + 1;                                   // chapter number on the page
      const steps = p.place_id === 'jakarta' ? jakartaSteps(c) : genericSteps(c, CH[p.place_id]);
      const az = (CH[p.place_id] || {}).az ?? 200;
      steps.forEach((s, i) => { s.cam = s.cam || { az: az + CAMS[Math.min(i, CAMS.length - 1)].d, el: CAMS[i % CAMS.length].el,
        dist: CAMS[Math.min(i, CAMS.length - 1)].dist, tx: 0, tz: 0 }; s.t = s.t || 'none'; });
      return { c, steps, hasBlock: c.modelled };
    });

    // ---------- page ----------
    const credit = `Sources, licences and method: see the end of the page. Borders and names © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL).`;
    root.innerHTML = `
      ${root.dataset.header === 'false' ? '' : `<header class="slc-head">
        <h1>Sea-level Cities</h1>
        <p class="slc-dek">Where the sea already stands against the land, and how much higher it is projected to stand.</p>
</header>`}
      <nav class="slc-nav" id="slc-nav" aria-label="On this page">
        <a href="#slc-overview">The world</a><a href="#slc-places"><span class="slc-nplaces-cap"></span> places</a><a href="#slc-compare-h">All staffs side by side</a><a href="#slc-explore-h">Look up a spot</a><a href="#slc-method-h">Sources and method</a>
      </nav>
      <section class="slc-overview" id="slc-overview" aria-labelledby="slc-overview-h">
        <h2 id="slc-overview-h">Below the high-tide line</h2>
        <div class="slc-tabs" role="group" aria-label="Emissions scenario"></div>
        <p class="slc-overview__scen" aria-live="polite"></p>
        <div class="slc-hero">
          <div class="slc-hero__item"><p class="slc-hero__label"><i class="slc-sw slc-sw--blue"></i>Worldwide today</p>
            <p class="slc-hero__figure" id="slc-hero-today"></p><p class="slc-hero__text" id="slc-hero-today-text"></p></div>
          <div class="slc-hero__item"><p class="slc-hero__label"><i class="slc-sw slc-sw--red"></i>Worldwide by 2100</p>
            <p class="slc-hero__figure" id="slc-hero-2100" aria-live="polite"></p><p class="slc-hero__text" id="slc-hero-2100-text"></p></div>
        </div>
        <p class="slc-overview__context"></p>
      </section>
      <section class="slc-places" id="slc-places" aria-labelledby="slc-places-h">
        <div class="block"><div class="block__rail">
          <h2 id="slc-places-h"><span class="slc-nplaces-cap"></span> places, <span class="slc-nplaces"></span> ways the sea gets in</h2>
          <p class="slc-places__lead" aria-live="polite"></p>
          <p class="slc-places__cta"><a href="#slc-explore-h">Look up a spot</a>: pick one of the <span class="slc-nplaces"></span> places, zoom in, tap a street or use your location, and see whether high water would reach it.</p>
        </div><div class="block__body">
          <ul class="slc-places__list"></ul>
          <p class="slc-overview__note"></p>
        </div></div>
      </section>
      <section class="slc-compare" aria-labelledby="slc-compare-h">
        <div class="block"><div class="block__rail">
        <h2 id="slc-compare-h">The same sea, <span class="slc-nshores"></span> shores</h2>
        <p class="slc-compare__dek">All the staffs side by side, each with its zero at its own mean sea level. The water
          stands where high water would be in 2100 with <span class="slc-compare__scen">medium emissions</span> (the emissions switch at the top); the dashed mark is the typical height of the land that line would reach.</p>
        </div><div class="block__body">
        <div class="slc-compare__row"></div>
        <p class="slc-note slc-compare__note"></p>
        </div></div>
      </section>
      <section class="slc-intro">
        <p>Each chapter reads the water off one ruler: a <strong>gauge staff</strong>, like the ones on harbour walls,
          with its zero at the place’s own mean sea level. On it: the typical height of the ground, where high water
          stands on an ordinary day, the top of the defences where their height is documented, and where high water would
          stand in 2050 and 2100 in the IPCC’s projections.</p>
        <p>The block beside it shows the land below the high-tide line: land the sea could reach if nothing held it
          back. As the water on the staff rises, the water on the block rises with it.</p>
      </section>
      ${chapters.map(({ c, steps, hasBlock }) => `
      <section class="story slc-chapter" id="slc-ch-${c.P}" data-place="${c.P}" aria-label="${esc(c.p.name)}">
        <a class="slc-top" href="#slc-nav" aria-label="Back to the top of the page">↑ Top</a>
        <div class="story__graphic"><figure>
          <div class="slc-graphic${hasBlock ? '' : ' slc-graphic--staff'}">
            ${hasBlock ? `<div class="slc-block" id="slc-block-${c.P}" role="img" aria-label="3D block of ${esc(c.p.name)}"></div>` : ''}
            <div class="slc-staffbox" role="img" aria-label="Gauge staff for ${esc(c.p.name)}, metres above local mean sea level"></div>
          </div>
          <div class="slc-readout" aria-live="polite"></div>
          <p class="slc-credit">${credit} <span class="slc-exag"></span></p>
        </figure></div>
        <div class="story__steps">${steps.map((s, i) => `<div class="step" data-i="${i}"><div class="step__text">${s.html}</div></div>`).join('')}</div>
      </section>`).join('')}
      <section class="slc-explore" aria-labelledby="slc-explore-h">
        <a class="slc-top" href="#slc-nav" aria-label="Back to the top of the page">↑ Top</a>
        <h2 id="slc-explore-h">Look up a spot</h2>
        <p class="slc-explore__dek">Choose a place, zoom in and tap a spot, or use your location, to see whether the sea
          would reach it at high tide in the IPCC’s projections.</p>
        <div class="slc-explore__grid">
          <figure class="slc-explore__map">
            <div class="slc-block slc-block--explore" id="slc-explore-block" role="application"
                 aria-label="Zoomable 3D map. Use the zoom buttons, then tap a spot to look it up.">
              <div class="slc-zoom">
                <button type="button" data-z="in" aria-label="Zoom in">+</button>
                <button type="button" data-z="out" aria-label="Zoom out">−</button>
                <button type="button" data-z="all" aria-label="Show the whole map">⤢</button>
              </div>
              <p class="slc-hint" aria-hidden="true"></p>
            </div>
            <p class="slc-credit">Drag to move · right-drag or Shift-drag to turn · pinch, or Ctrl/⌘ + scroll, to zoom ·
              double-click to zoom in. <span class="slc-exag"></span> Roads, borders and names: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL).
              People: GHS-POP 2025 (JRC); Jakarta scaled to BPS kelurahan counts.</p>
          </figure>
          <div class="slc-explore__panel">
            <div class="slc-tools"><label class="slc-pick" for="slc-place"><span>Place</span>
              <select id="slc-place">${chapters.filter((x) => x.hasBlock).map(({ c }) => `<option value="${c.P}">${esc(c.p.name)}</option>`).join('')}</select>
            </label></div>
            <div class="slc-field"><p class="slc-field__label" id="slc-l-year">Year</p>
              <div class="slc-seg" role="group" aria-labelledby="slc-l-year" data-k="year">
                <button type="button" data-v="today">Today</button><button type="button" data-v="2050">2050</button><button type="button" data-v="2100">2100</button>
              </div></div>
            <div class="slc-field"><p class="slc-field__label" id="slc-l-ssp">Emissions</p>
              <div class="slc-seg" role="group" aria-labelledby="slc-l-ssp" data-k="ssp">
                <button type="button" data-v="ssp126">Low</button><button type="button" data-v="ssp245">Medium</button><button type="button" data-v="ssp585">Very high</button>
              </div></div>
            <div class="slc-field slc-ground"><p class="slc-field__label" id="slc-l-ground">Ground (sinking is modelled for Jakarta only)</p>
              <div class="slc-seg" role="group" aria-labelledby="slc-l-ground" data-k="ground">
                <button type="button" data-v="sink">Keeps sinking</button><button type="button" data-v="none">Stops sinking today</button>
              </div>
              <p class="slc-note">Keeps sinking: the sinking slows, halving every 30 years.</p>
            </div>
            <form class="slc-search slc-tools" role="search">
              <label class="slc-find" for="slc-q"><svg class="slc-mag" viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.75"/><line x1="10" y1="10" x2="14.5" y2="14.5"/></svg><span>Find a neighbourhood</span>
              <input id="slc-q" type="search" list="slc-names" autocomplete="off"></label>
              <datalist id="slc-names"></datalist>
            </form>
            <button type="button" class="slc-locate">Use my location</button>
            <p class="slc-note">Your location stays in your browser and is not sent anywhere.</p>
            <div class="slc-answer" aria-live="polite"><p>Tap a spot on the map.</p></div>
            <p class="slc-note slc-caveat"></p>
          </div>
        </div>
      </section>
      <section class="slc-method" aria-labelledby="slc-method-h">
        <h2 id="slc-method-h">Sources and method</h2>
        ${meta && meta[0] && meta[0].generated_at ? `<p class="slc-updated">Data updated ${d3.utcFormat('%-d %B %Y')(new Date(meta[0].generated_at))}.</p>` : ''}
        <div class="slc-method__cols">
          <div>
            <h3>What the maps show</h3>
            <p>Land that lies at or below a water level <em>and</em> is connected to the open sea through other such land,
              on a grid of about 30 m (about 11 m for Majuro): low hollows inland with no path to the sea stay dry. The
              water level is the place’s mean sea level, plus its mean higher high water (the average of each day’s
              higher high tide; for Hamburg, the mean of all high tides), plus the rise the IPCC projects for that year
              (AR6, median; the likely range is the 17th to 83rd percentile). Today’s level adds the median rise from
              the 1995–2014 baseline to ${YEAR}. The IPCC’s rise is relative: it includes a long-term trend of land
              motion at the nearest tide gauge or grid cell. ${upliftLine()}</p>
            <p>People are those living <em>today</em> on land below the line (population held at 2025). The counts are
              not a forecast of where people will live. The maps show land below the high-tide line, not land that floods:
              sea walls, dikes, pumps and drains are not modelled, and they keep much of this land dry today.</p>
            <h3>What it leaves out</h3>
            <p>Defences; waves, rain and river floods; erosion and salinisation, which the chapters tell from documented
              impacts. Storms appear only as levels (Sandy in New York, the 1976 flood in Hamburg). Measured sinking of
              the ground is modelled only for Jakarta; elsewhere the land is today’s terrain, and where it sinks fast
              (the Mekong Delta, Louisiana) the land below the line is understated. One high-tide level is used for each
              block, although the tide weakens up rivers: in the Mekong Delta the coastal level is applied up to 80 km
              inland. Terrain models have errors of tens of centimetres, more on built-up land, and their heights date
              from about 2011–2015. The likely ranges combine
              the uncertainty of the rise, of the local mean sea level and of the terrain; they do not cover unlikely
              but severe ice-sheet outcomes.</p>
          </div>
          <div>
            <h3>Sources</h3>
            <ul>
              <li>Sea-level projections: Fox-Kemper et al. 2021, IPCC AR6 WGI chapter 9
                (<a href="https://doi.org/10.1017/9781009157896.011">doi:10.1017/9781009157896.011</a>); Kopp et al. 2023,
                the FACTS model (<a href="https://doi.org/10.5194/gmd-16-7461-2023">doi:10.5194/gmd-16-7461-2023</a>); Garner
                et al. 2021, IPCC AR6 Sea Level Projections, version 20210809
                (<a href="https://doi.org/10.5281/zenodo.5914709">doi:10.5281/zenodo.5914709</a>),
                <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. We thank the projection authors for
                developing and making the sea-level rise projections available, multiple funding agencies for supporting
                the development of the projections, and the NASA Sea Level Change Team for developing and hosting the IPCC
                AR6 Sea Level Projection Tool.</li>
              <li>Terrain: DeltaDTM v1.1.1, Pronk et al. 2024 (<a href="https://doi.org/10.4121/21997565">TU Delft</a>,
                <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>); Majuro: USGS 1 m topobathymetric
                model, Palaseanu-Lovejoy et al. 2017 (<a href="https://doi.org/10.5066/F7416VXX">doi:10.5066/F7416VXX</a>).
                Relief above it: produced using Copernicus WorldDEM-30 © DLR e.V. 2010–2014 and © Airbus Defence and
                Space GmbH 2014–2018 provided under COPERNICUS by the European Union and ESA; all rights reserved. The
                organisations in charge of the Copernicus programme by law or by delegation do not incur any liability
                for any use of the Copernicus WorldDEM-30. Seafloor: ETOPO 2022 (NOAA NCEI,
                <a href="https://doi.org/10.25921/fd45-gt74">doi:10.25921/fd45-gt74</a>).</li>
              <li>Mean sea level: DTU21 mean sea surface, © Technical University of Denmark (DTU Space), free for
                non-commercial use; the EGM2008 geoid (NGA). High water: research-quality tide gauge data of the
                University of Hawaii Sea Level Center (Caldwell et al. 2015,
                <a href="https://doi.org/10.7289/V5V40S7W">doi:10.7289/V5V40S7W</a>) and PEGELONLINE (WSV,
                DL-DE/Zero-2.0); for the Mekong Delta the EOT20 tide model (Hart-Davis et al. 2021,
                <a href="https://doi.org/10.17882/79489">doi:10.17882/79489</a>, CC BY 4.0). Sandy’s peak: NOAA CO-OPS,
                the Battery.</li>
              <li>People and buildings: GHS-POP R2023A (Schiavina et al. 2023,
                <a href="https://doi.org/10.2905/2FF68A52-5B5B-4A22-8F40-C41DA8332CFE">doi:10.2905/2FF68A52-5B5B-4A22-8F40-C41DA8332CFE</a>)
                and GHS-BUILT-H R2023A (Pesaresi &amp; Politis 2023,
                <a href="https://doi.org/10.2905/85005901-3A49-48DD-9D19-6261354F56FE">doi:10.2905/85005901-3A49-48DD-9D19-6261354F56FE</a>),
                European Commission, JRC, <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>; in Jakarta
                scaled to sub-district counts from the BPS <em>Kecamatan … Dalam Angka 2026</em> yearbooks.</li>
              <li>Jakarta’s sinking ground: Ohenhen et al. 2026 (Sentinel-1 radar 2017–2023,
                <a href="https://zenodo.org/records/15786357">Zenodo 15786357</a>, CC BY 4.0), checked against Lăpădat
                &amp; Hanssen (2014–2025, preprint; data on
                <a href="https://data.4tu.nl/datasets/39e7a39c-d305-425f-b238-1f3a4271dda9">4TU.ResearchData</a>,
                Apache-2.0).</li>
              <li>Locator maps in the list of places: <a href="https://www.naturalearthdata.com/">Natural Earth</a> 1:50m land and borders (public domain), simplified; each map is a section of the globe centred on the place, and its scale bar holds at the centre.</li>
              <li>Borders, roads and place names: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). The borders and names in this page’s data files (<code>blocks/*/admin.json</code>, <code>names.json</code>, <code>data/units.json</code>) are extracts of OpenStreetMap, available under the <a href="https://opendatacommons.org/licenses/odbl/1-0/">Open Database License 1.0</a>.</li>
              <li>Documented impacts, storms and defence heights: cited where they appear in the text. Defence heights are
                converted to local mean sea level only where the source states its datum.</li>
            </ul>
          </div>
        </div>
      </section>`;
    window.__slc = { chapters: {} };   // handles for tools/page_check

    // ---------- one chapter: staff, lazy block, scroll ----------
    function runChapter({ c, steps, hasBlock }) {
      const sec = root.querySelector(`#slc-ch-${c.P}`), el = sec.querySelector('.slc-block');
      const readout = sec.querySelector('.slc-readout');
      const staff = FCC.slcStaff(sec.querySelector('.slc-staffbox'), { msl: c.msl, marks: c.marks });
      const cur = { i: 0, p: 0 };
      let inst = null, pending = null, want = false;
      const levelAt = (i, p) => { const from = i ? steps[i - 1].level : steps[0].level; return from + (steps[i].level - from) * easeAt(p); };
      function apply() {
        const { i, p } = cur, l = levelAt(i, p);
        staff.level(l, 0);
        const at = Math.abs(c.ab(l)) < 0.005 ? 'water <b>at mean sea level</b>' : `water <b>${vsMsl(c.ab(l))}</b> mean sea level`;
        // The projection shown, if any, and its likely range (17th–83rd percentile).
        const proj = p >= 0.6 && c.marks.find((k) => k.tone === 'future' && k.range && Math.abs(k.m - steps[i].level) < 0.005);
        const range = proj ? ` · likely ${metres(c.ab(proj.range[0]))} to ${metres(c.ab(proj.range[1]))} m` : '';
        readout.innerHTML = `${at}${p >= 0.6 && steps[i].when !== 'mean sea level' ? ` · ${esc(steps[i].when)}` : ''}${range}`;
        if (inst) { inst.b.level(l, 0); inst.b.terrain(i ? steps[i - 1].t : 'none', steps[i].t, easeAt(p)); }
      }
      const terrains = [...new Set(steps.map((s) => s.t))].filter((k) => k !== 'none');
      function make() {
        return FCC.block3d.create({ container: el, base, place: c.P }).then((b) => {
          if (!want) { b.dispose(); return; }
          inst = { b, extra: { roadAmount: 0 } };
          live.add(inst); paint(inst);
          sec.querySelector('.slc-exag').textContent = `Heights exaggerated ×${b.meta.exaggeration}.`;
          b.today(c.tide);
          b.labels(c.p.labels || []);
          b.view(steps[cur.i].cam, 0);
          apply();
          Promise.all(terrains.map((k) => b.loadTerrain(k).catch(() => null))).then(() => { if (inst && inst.b === b) apply(); });
          window.__slc.chapters[c.P] = { block: b, steps, staff };
        }).catch((e) => { el.innerHTML = `<p class="slc-note" style="padding:1rem">The 3D view could not load (${esc(e.message)}).</p>`; })
          .finally(() => { pending = null; });
      }
      // Without WebGL: the step's image, rendered from the same block state by tools/static/sea-level-cities.mjs.
      let stillAt = 0;
      const still = (i) => { if (!el || WEBGL) return; const img = el.querySelector('img'); stillAt = i;
        img.src = `${base}static/${c.P}-${i}${isDark() ? '-dark' : ''}.jpg`; img.alt = `3D view of ${c.p.name}. ${plain(steps[i].html)}`; };
      if (hasBlock && !WEBGL) stills.add(() => still(stillAt));
      if (hasBlock && !WEBGL) {
        el.removeAttribute('role');
        el.classList.add('slc-block--still');
        el.innerHTML = '<img decoding="async"><p class="slc-note">Still image: this browser cannot show the 3D view (WebGL).</p>';
        still(0);
      }
      else if (hasBlock) {
        const io = new IntersectionObserver((es) => {
          want = es[es.length - 1].isIntersecting;
          if (want && !inst && !pending) pending = make();
          if (!want && inst) { live.delete(inst); inst.b.dispose(); inst = null; delete window.__slc.chapters[c.P]; }
        }, { rootMargin: '120% 0px' });
        io.observe(sec);
      }
      window.__slc.chapters[c.P] = window.__slc.chapters[c.P] || { block: null, steps, staff };
      FCC.scrolly({
        root: sec,
        onStep: (i) => {
          cur.i = i; staff.show(steps[i].show); still(i);
          if (inst) inst.b.view(steps[i].cam, fly(1800));
          if (el && WEBGL) el.setAttribute('aria-label', `3D block of ${c.p.name}. ${plain(steps[i].html)}`);
        },
        onProgress: (i, p) => { if (cur.seen && cur.i === i && cur.p === p) return; cur.i = i; cur.p = p; cur.seen = true; apply(); },
      });
    }
    chapters.forEach(runChapter);

    // ---------- close: all staffs side by side, aligned on mean sea level ----------
    function compare(ssp) {
      const rowEl = root.querySelector('.slc-compare__row');
      rowEl.innerHTML = '';
      root.querySelector('.slc-compare__scen').textContent = SCEN[ssp];
      const KEYS = ['ground', 'tide', 'crest'];
      const picks = places.map((p) => MODELS.get(p.place_id)).map((c) => {
        const r = row(c.P, ssp, 2100);   // the chosen scenario's 2100 mark replaces the chapters' medium one
        const y = r.r == null ? [] : [{ key: 'y2100', text: '2100', m: c.lvl(r), tone: 'future', range: [c.base0 + r.rl, c.base0 + r.rh] }];
        // the ground mark: the typical height of the land below that scenario's 2100 line (follows the switch)
        const g = r.g != null ? [{ key: 'ground', text: 'Ground', m: r.g, tone: 'ground' }] : c.marks.filter((k) => k.key === 'ground');
        return { c, r, marks: [...g, ...c.marks.filter((k) => KEYS.includes(k.key) && k.key !== 'ground'), ...y] };
      });
      const rel = picks.flatMap(({ c, marks }) => marks.filter((k) => k.key !== 'crest').flatMap((k) => [k.m, ...(k.range || [])].map((v) => v - c.msl)));
      const LO = Math.floor(Math.min(...rel) - 0.3), HI0 = Math.ceil(Math.max(...rel) + 0.5);
      // Crests up to twice the scale's height widen it; taller ones (Hamburg's dikes) are listed below the row instead.
      const crests = picks.flatMap(({ c, marks }) => marks.filter((k) => k.key === 'crest').map((k) => (k.range ? k.range[1] : k.m) - c.msl));
      const HI = Math.ceil(Math.max(HI0, ...crests.filter((v) => v <= 2 * HI0)) + 0.2);
      const off = [];
      picks.forEach(({ c, r, marks }) => {
        const keep = marks.filter((k) => (k.range ? k.range[1] : k.m) - c.msl <= HI);
        marks.filter((k) => !keep.includes(k)).forEach((k) => off.push(`${c.p.name.split(/[:,]| and the /)[0]}: ${k.key === 'crest' ? 'defence crest' : k.text}
          ${k.range ? `${metres(k.range[0] - c.msl)}–${metres(k.range[1] - c.msl)}` : metres(k.m - c.msl)} m`));
        const cell = document.createElement('figure');
        cell.className = 'slc-compare__cell';
        cell.innerHTML = `<figcaption>${esc(c.p.name.split(/[:,]| and the /)[0])}</figcaption>`;
        rowEl.appendChild(cell);
        const s = FCC.slcStaff(cell, { msl: c.msl, marks: keep, min: c.msl + LO, max: c.msl + HI });
        s.show(keep.map((k) => k.key));
        s.level(r.r == null ? c.tide : c.lvl(r), 0);
      });
      root.querySelector('.slc-compare__note').textContent = off.length ? `Above the top of the scale: ${off.join('; ')}.` : '';
    }

    // ---------- overview: the world first (Kulp & Strauss), then the mapped places as examples ----------
    (function overviewSection() {
      const sec = root.querySelector('.slc-overview'), seg = sec.querySelector('.slc-tabs'), pl = root.querySelector('.slc-places');
      const SSPS = ['ssp126', 'ssp245', 'ssp585'], LABEL = { ssp126: 'Low emissions', ssp245: 'Medium emissions', ssp585: 'Very high emissions' };
      const CODE = { ssp126: 'SSP1-2.6', ssp245: 'SSP2-4.5', ssp585: 'SSP5-8.5' }, RCP = { ssp126: 'RCP2.6', ssp245: 'RCP4.5', ssp585: 'RCP8.5' };
      const o = (s, y) => overview.find((r) => r.scenario === s && r.year === y);
      const fact = (s, m) => ofacts.find((f) => f.scenario === s && f.measure === m);
      const src = (f, extra = '') => `<span class="slc-src">(<a href="${esc(f.url)}">${esc(f.src)}${extra}</a>)</span>`;
      const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
      const word = (n) => WORDS[n] || fmt(n);
      const mio = (v) => fmt(Math.round(v / 1e5) / 10, 1);
      const glob = ofacts.find((f) => f.measure === 'people_below_high_tide'), commit = ofacts.find((f) => f.measure === 'commitment');
      const base = o('ssp245', 2100);
      if (!glob || !base) { sec.hidden = true; pl.hidden = true; compare('ssp245'); return; }
      sec.querySelector('#slc-hero-today').innerHTML = `${fmt(glob.value / 1e6)}<small> million</small>`;
      sec.querySelector('#slc-hero-today-text').innerHTML = `people live on land that the study places below today’s high-tide line. Many are protected by levees and
        sea walls; the authors note that part of the figure may reflect errors in the elevation data. ${src(glob)}`;
      sec.querySelector('.slc-overview__context').innerHTML = `Both figures count people where they lived in 2010, treat the sea level of 2000 as the present,
        and do not consider defences; the study used the earlier RCP scenarios, which reach about the same end-of-century forcing. ${commit ? `${esc(commit.text)} ${src(commit, ', B.5.4')}` : ''}`;
      // The mapped places: why each is a good example, with a link to its 3D view. Their number, in words, in the headings.
      const nMapped = chapters.filter(({ hasBlock }) => hasBlock).length, nShores = places.length;
      root.querySelectorAll('.slc-nplaces').forEach((e) => { e.textContent = word(nMapped); });
      root.querySelectorAll('.slc-nplaces-cap').forEach((e) => { e.textContent = word(nMapped).replace(/^./, (x) => x.toUpperCase()); });
      root.querySelectorAll('.slc-nshores').forEach((e) => { e.textContent = word(nShores); });
      const WHY = {
        majuro: 'The capital of an atoll nation, on a thin ring of coral islets with no high ground: king tides and ocean swells already flood parts of the capital.',
        jakarta: 'A capital that sinks faster than the sea rises: groundwater pumping, together with the weight of buildings and the natural settling of young soils, has lowered the north so far that parts already lie below the high-tide line. It shows how local causes add to climate change.',
        'new-york': 'A rich city with little land below the daily tide. Its danger is the storm on top of a higher sea, as Hurricane Sandy showed in 2012.',
        hamburg: 'The defended city: far up the Elbe, yet reached by the tide. Since the deadly flood of 1962 it has relied on dikes and walls, which are now being raised again.',
        mekong: 'Viet Nam’s rice bowl, so low and flat that the ordinary high tide already stands above much of the land, while salt water pushes up the river arms.',
        khulna: 'Islands ringed by embankments beside the Sundarbans mangroves, where cyclones break the walls and salt water spoils the fields.',
        'nile-delta': 'Egypt’s farmland and its second city on a delta that sinks and wears away, since the Aswan dam stopped the sediment that built it.',
        louisiana: 'A coast that has lost about a quarter of its land since 1932 as it sinks and erodes; most families of one island community have resettled about 40 miles inland.',
      };
      pl.querySelector('.slc-places__list').innerHTML = chapters.filter(({ hasBlock }) => hasBlock).map(({ c }) => `<li>
        <svg class="slc-places__map" data-lon="${c.p.lon}" data-lat="${c.p.lat}" data-span="${c.P === 'majuro' ? 62 : 28}" role="img"
          data-label="${esc(`Locator map: ${c.p.name.split(/[:,]| and the /)[0]}, ${Math.abs(c.p.lat).toFixed(1)}° ${c.p.lat >= 0 ? 'N' : 'S'}, ${Math.abs(c.p.lon).toFixed(1)}° ${c.p.lon >= 0 ? 'E' : 'W'}`)}"></svg>
        <a class="slc-places__name" href="#slc-ch-${c.P}">${esc(c.p.name.split(/[:,]| and the /)[0])}</a>
        <span class="slc-places__kind">${esc(THEME[c.P] || '')}</span> ${esc(WHY[c.P] || '')}
        <a class="slc-places__go" href="#slc-ch-${c.P}">3D view ↓</a></li>`).join('');
      // Locator maps: a section of the globe (orthographic, centred on the place, about 3,000 km to either side) so the
      // reader can find the place on Earth; wider for Majuro, whose nearest large land is thousands of km away. Natural Earth 1:50m, simplified (pipeline/slr/locator.py); no tile service.
      (FCC.locator ? Promise.resolve() : new Promise((ok, no) => {   // embeds that list scripts by hand may not include locator.js: load it
        const s = document.createElement('script'); s.src = `${root.dataset.base || ''}locator.js`; s.onload = ok; s.onerror = no; document.head.append(s);
      })).then(() => FCC.locatorWorld(root.dataset.base || '')).then((world) => {
        const maps = [...pl.querySelectorAll('.slc-places__map')];
        const draw = () => maps.forEach((el) => FCC.locator(el, world, { lon: +el.dataset.lon, lat: +el.dataset.lat, span: +el.dataset.span, cls: 'slc-loc' }));
        draw();
        let wPrev = 0;
        new ResizeObserver(() => { const w = maps[0] && maps[0].clientWidth; if (w && w !== wPrev) { wPrev = w; draw(); } }).observe(pl.querySelector('.slc-places__list'));
      }).catch(() => pl.querySelectorAll('.slc-places__map').forEach((el) => el.remove()));
      pl.querySelector('.slc-overview__note').textContent = `How the figures for the ${word(nMapped)} places are made: central estimates
        from the same model as the chapters. People are counted where they live today (GHS-POP 2025). The ground sinks no
        further after today; where it keeps sinking, as in Jakarta, more land would fall below the line. The terrain model
        errs both ways: its heights date from about 2011–2015, so land that has sunk since lies lower than it says (the
        figures too low); on built-up land it reads about a quarter of a metre too low on average, and it can remove
        embankments (the figures too high). Its errors, tens of centimetres, are larger than the steps between today, 2050
        and 2100, so the changes from one year to the next are less certain than the totals. Defences are not modelled.`;
      let cur = 'ssp245';
      const draw = () => {
        const g = fact(cur, 'people_below_high_tide_2100'), r = o(cur, 2100);
        sec.querySelector('#slc-hero-2100').innerHTML = `${fmt(g.value / 1e6)}<small> million</small>`;
        sec.querySelector('#slc-hero-2100-text').innerHTML = `people live today on land that would lie below the high-tide line
          by 2100 with ${SCEN[cur]} (90% range ${fmt(g.lo / 1e6)}–${fmt(g.hi / 1e6)} million from the uncertainty of the sea-level
          projection alone; ${RCP[cur]} and the study’s K14 sea-level model, the lower of its two). ${src(g)}`;
        const em = fact(cur, 'emissions'), wm = fact(cur, 'warming'), sl = fact(cur, 'gmsl_2100');
        sec.querySelector('.slc-overview__scen').innerHTML = em && wm && sl ? `<strong>${esc(LABEL[cur])} (${CODE[cur]}):</strong>
          ${esc(em.text)} Warming by 2081–2100 of about ${fmt(wm.value, 1)} °C above 1850–1900 (very likely ${fmt(wm.lo, 1)}–${fmt(wm.hi, 1)} °C).
          Global sea level in 2100 likely ${fmt(sl.lo, 2)}–${fmt(sl.hi, 2)} m above 1995–2014. ${src(wm)}` : '';
        pl.querySelector('.slc-places__lead').innerHTML = `This story looks at ${word(r.places)} places where the sea
          already stands against the land, each for a different reason. Together, <strong>${mio(r.pop_today)} million</strong> people
          there live on land below today’s high-tide line; by 2100 with ${SCEN[cur]}, land where another
          <strong>${mio(r.pop_added)} million</strong> live today would fall below it.`;
        compare(cur);
      };
      SSPS.forEach((s) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = LABEL[s]; b.setAttribute('aria-pressed', String(s === cur));
        b.addEventListener('click', () => { if (s === cur) return; cur = s;
          seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); draw(); });
        seg.appendChild(b);
      });
      draw();
    })();

    // ---------- explorer: pick a place, zoom in, look up a spot ----------
    const exEl = root.querySelector('#slc-explore-block'), panel = root.querySelector('.slc-explore__panel');
    const ans = panel.querySelector('.slc-answer'), select = panel.querySelector('#slc-place');
    const YEARS = [2050, 2100], SSPS = ['ssp126', 'ssp245', 'ssp585'];
    const NAME = { ssp126: 'low', ssp245: 'medium', ssp585: 'very high' };
    const state = { year: '2100', ssp: 'ssp245', ground: 'sink' };
    let X = null, opening = null;   // the open place: { P, c, b, sink, meta, last }
    const exposure = (P, s, y, id, sub = 'none') => expo.find((e) => e.p === P && e.w === 'high_tide' && e.s === s && e.y === y && e.sub === sub && e.u === id);
    const exagEl = root.querySelector('.slc-explore .slc-exag');
    const ALL = { az: 0, el: 55, dist: 1.45, tx: 0, tz: 0 };   // from the south: north is up, as on a map
    const sinking = () => X && X.sink && state.ground === 'sink' && state.year !== 'today';
    const key = (y) => (X.sink && state.ground === 'sink' ? `${SINK}_${y}` : 'none');
    const subFor = () => (sinking() ? SINK : 'none');
    // Years of today's rate that add up by a year on the path (subsidence.displacement_factor).
    const factor = (y) => { const hl = X.meta?.subsidence?.half_life?.[SINK]; const n = y - X.c.t.y;
      return n <= 0 ? 0 : hl ? (hl / Math.LN2) * (1 - Math.pow(2, -n / hl)) : n; };
    const rowX = (s, y, sub = 'none') => row(X.P, s, y, sub);

    // Places open one after another, so a quick change of the menu never leaves two explorer blocks.
    function open(P) {
      opening = (opening || Promise.resolve()).catch(() => null).then(() => openNow(P));
      return opening;
    }
    function openNow(P) {
      if (X && X.P === P) return X;
      if (X) { live.delete(X.inst); X.b.dispose(); X = null; }
      const c = MODELS.get(P);
      select.value = P;
      ans.innerHTML = WEBGL ? '<p>Tap a spot on the map.</p>' : '<p>Search a neighbourhood or use your location.</p>';
      // without WebGL: the same data and lookup, answered as text (review F3)
      const load = WEBGL ? FCC.block3d.create({ container: exEl, base, place: P, detail: true }) : FCC.block3d.data({ base, place: P });
      return load.then((b) => {
        const inst = { b, extra: isDark() ? { roadAmount: 0.45 } : { roadAmount: 0.6 } };
        live.add(inst); paint(inst);
        X = { P, c, b, inst, meta: b.meta, sink: !!b.meta.subsidence, last: null };
        b.today(c.tide);
        panel.querySelector('.slc-ground').hidden = !X.sink;
        const loaded = X.sink ? Promise.all(YEARS.map((y) => b.loadTerrain(`${SINK}_${y}`).catch(() => null))) : Promise.resolve();
        b.labels([...(c.p.labels || []), ...b.names.map((n) => ({ text: n.text, lon: n.lon, lat: n.lat, tone: 'place',
          maxDist: n.kind === 'village' ? 0.45 : 0.2 }))]);
        const form = panel.querySelector('.slc-search'), input = form.querySelector('input');
        form.hidden = !b.names.length;
        input.value = '';
        input.placeholder = b.names.length ? `e.g. ${b.names[0].text}` : '';
        panel.querySelector('#slc-names').innerHTML = b.names.map((n) => `<option value="${esc(n.text)}"></option>`).join('');
        const cell_m = (b.meta.width_km * 1000) / (b.spillWidth || b.meta.spill_cols);   // the published raster, which can be thinned
        panel.querySelector('.slc-caveat').textContent = `The flood model uses a grid of about ${fmt(cell_m)} m, so it shows
          a neighbourhood, not a single house. Sea walls, dikes, pumps and drains are not modelled${X.sink ? ', and neither is the ground sinking further unless you choose “keeps sinking”. The sinking rates come from satellite radar 2017–2023 and are a scenario, not a forecast' : ''}.`;
        b.view(ALL, 0);
        b.interact('explore', (pt) => choose(pt, 'Selected spot'), exEl.querySelector('.slc-hint'),
          (x) => { exagEl.textContent = `Heights exaggerated ×${fmt(x)} (less when you zoom in).`; });
        window.__slc.explore = b;
        return loaded.then(() => { setState(); return X; });
      });
    }
    const go = () => {
      const input = panel.querySelector('.slc-search input');
      const n = X && X.b.names.find((x) => x.text.toLowerCase() === input.value.trim().toLowerCase());
      if (!n) return;
      X.b.flyTo(n.lon, n.lat, 0.16);
      choose({ lon: n.lon, lat: n.lat }, n.text, true);
    };
    panel.querySelector('.slc-search input').addEventListener('change', go);
    panel.querySelector('.slc-search').addEventListener('submit', (e) => { e.preventDefault(); go(); });
    select.addEventListener('change', () => open(select.value));
    exEl.querySelectorAll('.slc-zoom button').forEach((btn) => btn.addEventListener('click', () => {
      if (!X) return;
      const z = btn.dataset.z;
      if (z === 'all') X.b.view(ALL, fly(900)); else X.b.zoomBy(z === 'in' ? 0.5 : 2);
    }));
    function setState() {
      panel.querySelectorAll('.slc-seg').forEach((g) => g.querySelectorAll('button').forEach((btn) =>
        btn.setAttribute('aria-pressed', String(state[g.dataset.k] === btn.dataset.v))));
      const isToday = state.year === 'today';
      for (const k of ['ssp', 'ground']) {
        const g = panel.querySelector(`[data-k="${k}"]`);
        g.classList.toggle('is-off', isToday);
        g.querySelectorAll('button').forEach((btn) => { btn.disabled = isToday; });
      }
      if (!X) return;
      X.b.level(isToday ? X.c.tide : rowX(state.ssp, +state.year).wl, fly(900));
      if (X.sink) X.b.sinkTo(isToday ? 'none' : key(+state.year), fly(900));
      if (X.last) choose(...X.last);   // the answer follows the year and emissions chosen
    }
    panel.querySelectorAll('.slc-seg button').forEach((btn) => btn.addEventListener('click', () => {
      state[btn.closest('.slc-seg').dataset.k] = btn.dataset.v; setState();
    }));
    // Centimetres, rounded to 5: the elevation data are not more precise than that (errors are tens of cm).
    const cm5 = (m) => `${fmt(Math.max(5, Math.round(Math.abs(m) * 20) * 5))} cm`;
    // Where the spot sits relative to a high-tide level, on the ground of year y (sinking if chosen).
    function versus(q, wl, y) {
      const sk = y != null && X.sink && state.ground === 'sink';
      const sp = sk && q.states[key(y)] != null ? q.states[key(y)] : q.spill;
      const g = q.ground == null ? null : q.ground + (sk && q.vlm ? (q.vlm / 1000) * factor(y) : 0);
      if (sp <= wl) return { below: true, text: g != null ? `${cm5(wl - g)} below` : 'below' };
      return { below: false, text: sp >= 999 ? 'not reached' : `${cm5(sp - wl)} above` };
    }
    function choose(pt, text, isName) {
      X.last = [pt, text, isName];
      const q = X.b.lookup(pt.lon, pt.lat), today = X.c.t;
      const where = `${isName ? `${esc(text)} (centre of the neighbourhood) · ` : ''}${fmt(Math.abs(pt.lat), 4)}° ${pt.lat < 0 ? 'S' : 'N'}, ${fmt(Math.abs(pt.lon), 4)}° ${pt.lon < 0 ? 'W' : 'E'}`;
      if (!q.inside) { ans.innerHTML = '<p>This spot is outside the map.</p>'; return; }
      X.b.marker({ text, lon: pt.lon, lat: pt.lat });
      if (q.sea) { ans.innerHTML = `<p class="slc-where">${where}</p><p>This spot is in the sea.</p>`; return; }
      const now = versus(q, X.c.tide);
      const hit = (p, y) => rowX(p, y).wl != null && versus(q, rowX(p, y).wl, y).below;
      const highest = Math.max(...SSPS.flatMap((p) => YEARS.map((y) => rowX(p, y).wl)).filter((v) => v != null));
      let head;
      if (now.below) head = `This spot lies <strong>${now.text} today’s high tide</strong>. If it is dry, sea walls,
        embankments, dikes or pumps keep it so.`;
      else {
        const first = YEARS.find((y) => SSPS.some((p) => hit(p, y)));
        if (first) {
          const who = SSPS.filter((p) => hit(p, first)).map((p) => NAME[p]);
          head = `Without defences${X.sink && state.ground === 'sink' ? ' and with the ground still sinking' : ''}, this spot would lie <strong>below the high-tide line by ${first}</strong> with
            ${who.length === 3 ? 'low, medium or very high' : who.join(' or ')} emissions. Today it is ${now.text} high tide.`;
        } else if (q.spill >= 999) head = 'The sea does not reach this spot in any of these projections.';
        else head = `This spot stays <strong>above the high-tide line</strong> in all these projections to 2100:
            ${cm5(q.spill - highest)} above it even with very high emissions.`;
      }
      const grid = `<table class="slc-grid"><caption>Compared with the projected high tide</caption>
        <thead><tr><th scope="col">Emissions</th>${YEARS.map((y) => `<th scope="col">${y}</th>`).join('')}</tr></thead>
        <tbody>${SSPS.map((p) => `<tr><th scope="row">${NAME[p]}</th>${YEARS.map((y) => {
          const v = rowX(p, y).wl == null ? null : versus(q, rowX(p, y).wl, y);
          return v ? `<td${v.below ? ' class="is-below"' : ''}>${v.text}</td>` : '<td>–</td>';
        }).join('')}</tr>`).join('')}</tbody></table>
        <p class="slc-note">Below: how deep the high tide would be here without defences. Above: how much higher the
          sea would have to rise to reach this spot. Rounded to 5 cm; the elevation data have errors of tens of centimetres.</p>`;
      // The administrative area around the spot, and how many of its people live below the line in the state shown.
      const jk = X.P === 'jakarta';
      const adminLine = [q.subdistrict && `${jk ? 'Kelurahan ' : ''}${esc(q.subdistrict.name)}`, q.district && `${jk ? 'Kecamatan ' : ''}${esc(q.district.name)}`,
        q.district && esc(q.district.city)].filter(Boolean).join(' · ');
      const isToday = state.year === 'today';
      const [es, ey] = isToday ? ['today', today.y] : [state.ssp, +state.year];
      const when = isToday ? 'today' : `in ${state.year} with ${NAME[state.ssp]} emissions`;
      const area = q.subdistrict || q.district;
      const e = area && exposure(X.P, es, ey, area.id, subFor());
      const UNIT = { jakarta: ['kecamatan', 'kelurahan'], majuro: ['municipality'], 'new-york': ['county', 'community district'],
        hamburg: ['borough', 'quarter'], mekong: ['ward or commune'], khulna: ['upazila (in India: block)'], 'nile-delta': ['governorate'],
        louisiana: ['parish', 'municipality'] }[X.P] || ['district', 'sub-district'];
      const kind = q.subdistrict ? UNIT[1] : UNIT[0];
      const areaLine = !e ? '' : e.pop < 50
        ? `<p class="slc-area">In the ${kind} of ${esc(area.name)}, almost nobody lives on land below the high-tide line ${when}.</p>`
        : `<p class="slc-area">In the ${kind} of ${esc(area.name)}, <strong>${fmt((e.pop / e.tot) * 100)}%</strong> of the
            roughly ${people(e.tot)} residents inside this map, about ${people(e.pop)} people, live on land below the high-tide line ${when}.</p>`;
      // Jakarta: the spot's own split, how much the sea rises and how much the ground sinks by the year shown.
      let split = '';
      if (!isToday && q.vlm != null && X.sink) {
        const sea = rowX(state.ssp, ey).wl - X.c.tide, f = factor(ey);
        const sinkCm = (mm) => Math.max(0, -mm / 1000) * f;
        const sd = Math.hypot(X.meta.subsidence.rate_sd_mm, q.vlmSpread || 0), z = 0.9542;
        const lo = sinkCm(q.vlm + z * sd), hi = sinkCm(q.vlm - z * sd);
        const other = q.vlmCheck != null ? ` A second radar study (Lăpădat &amp; Hanssen, 2014–2025, cells of 450 m)
          measured ${Math.abs(q.vlmCheck) < 0.5 ? 'no sinking' : `${fmt(Math.abs(q.vlmCheck), 1)} mm a year`} here.` : '';
        const rate = Math.abs(q.vlm) < 0.5 ? 'The radar data show no sinking here, or a slight rise, which the map treats as stable ground.'
          : `The ground here sank about <strong>${fmt(Math.abs(q.vlm), 1)} mm a year</strong> in 2017–2023 (Ohenhen et al.).`;
        const land = sinkCm(q.vlm);
        const why = q.vlmCheck != null && Math.abs(q.vlmCheck - q.vlm) > 2 * sd
          ? ' The two studies disagree here by more than the usual margin: they cover different years, use different reference frames and average over areas of different size, and the hot spots change quickly from one block to the next.'
          : '';
        split = `<div class="slc-split"><p>${rate}${other}</p>${sinking() ? `<p>By ${ey}: sea <strong>+${cm5(sea)}</strong>,
          ground <strong>${land >= 0.025 ? `−${cm5(land)}` : 'about the same'}</strong>${hi >= 0.025
            ? ` (likely ${lo >= 0.025 ? `−${cm5(lo)}` : 'about 0'} to −${cm5(hi)})` : ''}${q.vlmCheck != null && Math.abs(sinkCm(q.vlmCheck) - land) >= 0.05
            ? `; at the second study’s rate, −${cm5(sinkCm(q.vlmCheck))}` : ''}, if the sinking halves every 30 years.${why}</p>`
          : `<p>By ${ey}: sea <strong>+${cm5(sea)}</strong>; the ground is held at today’s level in this view.</p>`}
          <p class="slc-note">For a single spot the sinking is less certain than for the city as a whole, where local
          differences average out.</p></div>`;
      }
      ans.innerHTML = `<p class="slc-where">${adminLine ? adminLine + '<br>' : ''}${where}</p><p>${head}</p>${split}${areaLine}${grid}`;
    }
    window.__slc.choose = (...a) => choose(...a);
    window.__slc.open = open;
    panel.querySelector('.slc-locate').addEventListener('click', () => {
      if (!navigator.geolocation) { ans.innerHTML = '<p>Your browser cannot share a location.</p>'; return; }
      ans.innerHTML = '<p>Finding your location…</p>';
      navigator.geolocation.getCurrentPosition((pos) => {
        const pt = { lon: pos.coords.longitude, lat: pos.coords.latitude };
        // Open the place whose map holds the location, if any.
        const hit = chapters.filter((x) => x.hasBlock).find(({ c }) => { const [w, s, e, n] = c.p.bbox; return pt.lon >= w && pt.lon <= e && pt.lat >= s && pt.lat <= n; });
        if (!hit) { ans.innerHTML = '<p>Your location is outside the maps of these places.</p>'; return; }
        open(hit.c.P).then(() => {
          if (!X.b.lookup(pt.lon, pt.lat).inside) { ans.innerHTML = '<p>Your location is outside this map.</p>'; return; }
          X.b.flyTo(pt.lon, pt.lat, 0.12);
          choose(pt, 'You are here');
        });
      }, () => { ans.innerHTML = '<p>The location was not shared.</p>'; }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
    });
    if (!WEBGL) {   // no map: the lookup still answers searches and locations, as text
      exEl.innerHTML = '<p class="slc-note" style="padding:1rem">This browser cannot show the 3D map (WebGL). The lookup still works: search a neighbourhood by name or use your location.</p>';
      exEl.classList.add('is-textonly');
      exEl.removeAttribute('role'); exEl.removeAttribute('aria-label');
      const credit = root.querySelector('.slc-explore__map .slc-credit');   // no map instructions without a map
      credit.innerHTML = credit.innerHTML.replace(/^[\s\S]*?<span class="slc-exag"><\/span>\s*/, '');
    }
    // The explorer loads its block when the reader gets near it.
    const start = () => open(select.value).catch((e) => { exEl.innerHTML = `<p class="slc-note" style="padding:1rem">The map could not load (${esc(e.message)}).</p>`; });
    const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { io.disconnect(); start(); } }, { rootMargin: '600px 0px' });
    io.observe(root.querySelector('.slc-explore'));
  });
})();
