/* Block diagram in 3D (rayshader-style), drawn live with three.js so the water can rise as the reader scrolls.
   Assets per place, baked by pipeline/slr/block.py into <base>blocks/<place>/:
     height.png (Terrarium), spill.png (Terrarium: lowest water level at which the sea reaches each cell),
     shade.png (R light, G built-up, B sea; no colour), block.json (grid size, km, height range, exaggeration)
   Colour comes from a palette at run time (b.palette), so themes and palettes need no re-bake.
   three.js is loaded on demand as an ES module (exact version), so pages stay plain scripts with no build step.
   Canonical copy: site/_shared/block3d.js (tools/sync_shared.py copies it into each page).

   FCC.block3d.supported()                 false without WebGL -> show the static images instead
   const b = await FCC.block3d.create({ container, base, place, detail })
                                           detail: also load ground.png, roads.png, names.json, admin.png/json (explorer)
   b.view({ az, el, dist, tx, tz }, ms)    camera: azimuth (deg, 0 = from the south, 90 = from the east), elevation
                                           (deg), distance (in block widths), target offset (km east, km north)
   b.level(m, ms)                          water level in metres above the datum, eased over ms
   b.today(m)                              today's high-tide level: land between it and the current level is "lost"
   await b.loadTerrain(name)               load a land state's spill raster (blocks/<place>/spill_<name>.png, e.g.
                                           'halflife30_2100'; 'none' = spill.png, today's ground)
   b.terrain(from, to, k)                  draw the flood from a blend of two loaded land states (k = 0..1), so the
                                           ground is seen to sink; "lost" land is always judged against today's ground
   b.sinkTo(name, ms)                      ease from the state shown to another one
   b.palette(p)                            colours and highlight style, see PALETTE_DEFAULT below
   b.labels([{ text, lon, lat, tone }])    names on stalks, tone 'ink' | 'muted' | 'red'
   b.marker({ text, lon, lat } | null)     a pin that is always shown (the reader's chosen spot)
   b.flyTo(lon, lat, dist, ms)             centre the camera on a point at a distance (block widths)
   b.zoomBy(f)                             multiply the camera distance (f < 1 zooms in)
   b.lookup(lon, lat)                      { inside, sea, spill, states, ground, vlm, district, subdistrict } at that
                                           point (m above datum; states = spill per loaded land state; ground, vlm
                                           (mm/yr, negative = sinking), vlmSpread (local sd of radar points, mm/yr),
                                           vlmCheck (second dataset, mm/yr, null if none) and admin units only with detail)
   b.names                                 place names [{ text, lon, lat, kind }] (with detail and an OSM layer)
   Labels with maxDist are shown only when the camera distance is at most that (names when zoomed in).
   b.interact(mode, onPick, hintEl, onExag) 'story': mouse drag turns the block. 'explore': drag pans, right- or
                                           shift-drag turns and tilts, Ctrl/⌘ + wheel or pinch zooms, two fingers move
                                           on touch, click or tap calls onPick({ lon, lat }); hintEl gets short messages;
                                           the exaggeration drops as you zoom in and onExag(x) reports it
   b.meta                                  block.json
   b.dispose()                             free the GPU memory and the WebGL context, remove the canvas and listeners
                                           (pages with many blocks create them near the viewport and dispose them after)
   Water is drawn only where the sea can reach (spill <= level), so low hollows behind higher ground stay dry. */
(function (g) {
  'use strict';
  const FCC = g.FCC || (g.FCC = {});
  const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.min.js';
  let threePromise = null;
  // Every colour of the block. lostStyle: 'fill' | 'hatch'. coastLine: draw today's coastline in `coast`.
  const PALETTE_DEFAULT = {
    landLow: '#F1F0EC', landHigh: '#E2E0DA', built: '#D6D3CC', builtAmount: 0.6,
    seaDeep: '#C9D3DA', seaShallow: '#E6EBEE', shadeStrength: 0.85,
    water: '#4A7194', waterOpacity: 0.3, waterOverLand: 0.18,
    lost: '#D94B30', lostAmount: 0.9, lostStyle: 'fill',
    shore: '#35587A', shoreAmount: 0.85,      // fine line where the water meets the land, so the water reads as a surface
    road: '#9EA4AA', roadAmount: 0.5,         // OSM main roads (only where roads.png is loaded)
    border: '#3E4349', borderMain: 0.85, borderDistrict: 0.6, borderSub: 0.5,   // province/city, district, sub-district
                                              // lines (borders.png); districts fade in below distance 1.3, sub-districts below 0.5
    below: null, belowAmount: 0.85,           // land already below today's high tide (null = not shown)
    coastLine: false, coast: '#3E4349',
    side: '#3E4349', shadow: 0.3,
  };
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function supported() {
    try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); }
    catch (e) { return false; }
  }

  function loadImage(url) {
    return new Promise((ok, fail) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = fail; im.src = url; });
  }
  function pixels(im) {
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
    const ctx = c.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    ctx.drawImage(im, 0, 0);
    return ctx.getImageData(0, 0, im.width, im.height).data;
  }
  function decodeTerrarium(im) {
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
    const ctx = c.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    ctx.drawImage(im, 0, 0);
    const d = ctx.getImageData(0, 0, im.width, im.height).data, out = new Float32Array(im.width * im.height);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
    return out;
  }

  async function create({ container, base = '', place, detail = false }) {
    const THREE = await (threePromise || (threePromise = import(THREE_URL)));
    const dir = `${base}blocks/${place}/`;
    const [meta, heightIm, spillIm] = await Promise.all([
      fetch(dir + 'block.json').then((r) => r.json()), loadImage(dir + 'height.png'), loadImage(dir + 'spill.png')]);
    const loader = new THREE.TextureLoader();
    const shadeTex = await loader.loadAsync(dir + 'shade.png');
    shadeTex.colorSpace = THREE.NoColorSpace;
    shadeTex.anisotropy = 4;
    const spillTex = await loader.loadAsync(dir + 'spill.png');
    spillTex.colorSpace = THREE.NoColorSpace;
    spillTex.magFilter = spillTex.minFilter = THREE.NearestFilter;
    spillTex.generateMipmaps = false;
    const layers = new Set(meta.layers || []);
    let G = null, V = null, VS = null, VC = null, roadsTex = null, names = [], adminPx = null, adminW = 0, adminH = 0, adminUnits = null;
    const bordersTex = layers.has('borders') ? await loader.loadAsync(dir + 'borders.png') : null;
    if (bordersTex) { bordersTex.colorSpace = THREE.NoColorSpace; bordersTex.anisotropy = 4; }
    if (detail) {
      const [gIm, rTex, nm, aIm, aJs] = await Promise.all([
        loadImage(dir + 'ground.png'),
        layers.has('roads') ? loader.loadAsync(dir + 'roads.png') : null,
        layers.has('names') ? fetch(dir + 'names.json').then((r) => r.json()) : [],
        layers.has('admin') ? loadImage(dir + 'admin.png') : null,
        layers.has('admin') ? fetch(dir + 'admin.json').then((r) => r.json()) : null,
        layers.has('vlm') ? loadImage(dir + 'vlm.png') : null,
        layers.has('vlm_spread') ? loadImage(dir + 'vlm_spread.png') : null,
        layers.has('vlm_check') ? loadImage(dir + 'vlm_check.png') : null,
      ]).then((a) => { if (a[5]) V = decodeTerrarium(a[5]); if (a[6]) VS = decodeTerrarium(a[6]);
                       if (a[7]) VC = decodeTerrarium(a[7]); return a; });
      G = decodeTerrarium(gIm); roadsTex = rTex; names = nm;
      if (aIm) { adminPx = pixels(aIm); adminW = aIm.width; adminH = aIm.height; adminUnits = aJs; }
      if (roadsTex) { roadsTex.colorSpace = THREE.NoColorSpace; roadsTex.anisotropy = 4; }
    }
    const blank = () => { const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); t.needsUpdate = true; return t; };
    if (!roadsTex) roadsTex = blank();
    const H = decodeTerrarium(heightIm), S = decodeTerrarium(spillIm);
    const { cols, rows, width_km: W, height_km: D, exaggeration: X } = meta;
    const SC = spillIm.width, SR = spillIm.height;                // the flood model's grid (may be finer than the mesh)
    // Land states: spill rasters of the ground at different stages of sinking. The flood is drawn from a blend of two.
    const terrains = { none: { tex: spillTex, S } };
    let tFrom = terrains.none, tTo = terrains.none, tK = 0, tName = 'none';
    const spillCR = (c, r) => {
      const i = Math.round((r / (rows - 1)) * (SR - 1)) * SC + Math.round((c / (cols - 1)) * (SC - 1));
      const a = tFrom.S[i];
      return tK ? a + (tTo.S[i] - a) * tK : a;
    };
    const yOf = (m) => (m * X) / 1000;                     // metres -> scene units (km), exaggerated
    const baseY = yOf(meta.min_m) - 0.06 * W;               // bottom of the block
    const xOf = (c) => (c / (cols - 1) - 0.5) * W, zOf = (r) => (r / (rows - 1) - 0.5) * D;

    // ---------- scene ----------
    let disposed = false;
    const winListeners = [];                                // window-level listeners, removed by dispose()
    const onWin = (type, fn, opts) => { g.addEventListener(type, fn, opts); winListeners.push([type, fn, opts]); };
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(g.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 2000);
    // Everything that has height lives in `world`; its y-scale lowers the exaggeration when the explorer zooms in.
    const world = new THREE.Group();
    scene.add(world);
    let vScale = 1;

    // Terrain surface
    const pos = new Float32Array(cols * rows * 3), uv = new Float32Array(cols * rows * 2), elev = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      pos.set([xOf(c), yOf(H[i]), zOf(r)], i * 3);
      uv.set([c / (cols - 1), 1 - r / (rows - 1)], i * 2);
      elev[i] = H[i];
    }
    const idx = [];
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('elev', new THREE.BufferAttribute(elev, 1));
    geo.setIndex(idx);
    const C = () => new THREE.Color();
    const U = {
      shade: { value: shadeTex }, spill: { value: spillTex }, level: { value: 0 }, todayLevel: { value: 0 },
      spillFrom: { value: spillTex }, spillTo: { value: spillTex }, sinkK: { value: 0 },
      landLow: { value: C() }, landHigh: { value: C() }, built: { value: C() }, builtAmount: { value: 0 },
      seaDeep: { value: C() }, seaShallow: { value: C() }, shadeStrength: { value: 0.8 },
      lost: { value: C() }, lostAmount: { value: 0.9 }, hatch: { value: 0 }, hatchScale: { value: 1 },
      below: { value: C() }, belowAmount: { value: 0 }, coastLine: { value: 0 }, coast: { value: C() },
      shore: { value: C() }, shoreAmount: { value: 0.85 }, roads: { value: roadsTex }, road: { value: C() }, roadAmount: { value: 0 },
      borders: { value: bordersTex || blank() }, border: { value: C() }, borderAmount: { value: new THREE.Vector3() },
      lowM: { value: 0 }, highM: { value: Math.max(10, meta.max_m) }, deepM: { value: Math.min(-5, meta.min_m) },
    };
    const terrainMat = new THREE.ShaderMaterial({
      uniforms: U,
      vertexShader: `attribute float elev; varying vec2 vUv; varying float vElev; varying vec2 vXZ;
        void main(){ vUv = uv; vElev = elev; vXZ = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform sampler2D shade, spill, spillFrom, spillTo, roads, borders; uniform vec3 borderAmount; uniform float sinkK, level, todayLevel, builtAmount, shadeStrength, lostAmount, hatch,
          hatchScale, belowAmount, coastLine, lowM, highM, deepM, shoreAmount, roadAmount;
        uniform vec3 landLow, landHigh, built, seaDeep, seaShallow, lost, below, coast, shore, road, border;
        varying vec2 vUv; varying float vElev; varying vec2 vXZ;
        float dec(vec4 t){ vec3 c = t.rgb * 255.0; return c.r * 256.0 + c.g + c.b / 256.0 - 32768.0; }
        void main(){
          vec3 t = texture2D(shade, vUv).rgb;
          float light = t.r, isSea = step(0.5, t.b);
          vec3 land = mix(landLow, landHigh, smoothstep(lowM, highM, vElev));
          land = mix(land, built, t.g * builtAmount);
          vec3 base = mix(land, mix(seaDeep, seaShallow, smoothstep(deepM, 0.0, vElev)), isSea);
          // light: 0.5 ~ flat open ground; scale around it so flat land keeps its palette colour
          vec3 col = base * (1.0 + shadeStrength * (light * 2.0 - 1.0) * 0.6);
          col = mix(col, road, texture2D(roads, vUv).r * roadAmount * (1.0 - isSea));
          float s0 = dec(texture2D(spill, vUv));                                         // today's ground
          float s = mix(dec(texture2D(spillFrom, vUv)), dec(texture2D(spillTo, vUv)), sinkK);   // ground shown
          float isBelow = (1.0 - isSea) * step(s0, todayLevel);
          float isLost = (1.0 - isSea) * step(todayLevel + 0.001, s0) * step(s, level);
          col = mix(col, below * (0.75 + 0.25 * light * 2.0), isBelow * belowAmount);
          // Hatching, anti-aliased: sharp stripes up close; where they get finer than a pixel or two (far side of
          // an oblique view) they fade to an even half-tone instead of flickering into moiré.
          float u = (vXZ.x - vXZ.y) * hatchScale, fw = fwidth(u);
          float tri = abs(fract(u) - 0.5) * 2.0;
          float stripe = smoothstep(0.5 - fw, 0.5 + fw, tri);
          stripe = mix(stripe, 0.55, smoothstep(0.2, 0.5, fw));
          stripe = hatch > 0.5 ? stripe : 1.0;
          col = mix(col, lost * (0.8 + 0.2 * light * 2.0), isLost * lostAmount * stripe);
          // administrative borders, over land only (the province's boundary also runs out to sea, to its islands)
          vec3 bd = texture2D(borders, vUv).rgb;
          float bline = max(bd.r * borderAmount.x, max(bd.g * borderAmount.y, bd.b * borderAmount.z));
          col = mix(col, border, bline * (1.0 - isSea));
          // waterline: one or two pixels where wet meets dry at the current level
          float wet = step(s, level);
          col = mix(col, shore, clamp(fwidth(wet), 0.0, 1.0) * shoreAmount);
          if (coastLine > 0.5) {
            float m = step(s0, todayLevel) * (1.0 - isSea) + isSea;
            float edge = clamp(fwidth(m) * 1.0, 0.0, 1.0);
            col = mix(col, coast, edge);
          }
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const terrain = new THREE.Mesh(geo, terrainMat);
    world.add(terrain);

    // The block's sides: from the terrain edge down to the base, dark like a printed relief model.
    const edges = [];   // [col, row] along the outline, clockwise from the north-west corner
    for (let c = 0; c < cols; c++) edges.push([c, 0]);
    for (let r = 1; r < rows; r++) edges.push([cols - 1, r]);
    for (let c = cols - 2; c >= 0; c--) edges.push([c, rows - 1]);
    for (let r = rows - 2; r > 0; r--) edges.push([0, r]);
    edges.push([0, 0]);
    function strip(topY, botY) {     // vertical strip along the outline between two height functions
      const p = new Float32Array(edges.length * 6), ix = [];
      edges.forEach(([c, r], k) => {
        p.set([xOf(c), topY(c, r), zOf(r), xOf(c), botY(c, r), zOf(r)], k * 6);
        if (k) { const a = 2 * (k - 1); ix.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      });
      const gm = new THREE.BufferGeometry();
      gm.setAttribute('position', new THREE.BufferAttribute(p, 3));
      gm.setIndex(ix);
      return gm;
    }
    const sideMat = new THREE.MeshBasicMaterial({ color: 0x3e4349, side: THREE.DoubleSide });
    world.add(new THREE.Mesh(strip((c, r) => yOf(H[r * cols + c]), () => baseY), sideMat));
    const bottom = new THREE.Mesh(new THREE.PlaneGeometry(W, D), sideMat);
    bottom.rotation.x = Math.PI / 2; bottom.position.y = baseY; world.add(bottom);

    // Soft shadow under the block
    const sc = document.createElement('canvas'); sc.width = sc.height = 128;
    const sx = sc.getContext('2d'), gr = sx.createRadialGradient(64, 64, 10, 64, 64, 64);
    gr.addColorStop(0, 'rgba(0,0,0,0.35)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    sx.fillStyle = gr; sx.fillRect(0, 0, 128, 128);
    const shadowMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false });
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.5, D * 1.6), shadowMat);
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = baseY - 0.02; world.add(shadow);

    // ---------- water ----------
    const waterColor = new THREE.Color();
    const waterMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { spill: { value: spillTex }, spillFrom: U.spillFrom, spillTo: U.spillTo, sinkK: U.sinkK,
                  level: { value: 0 }, todayLevel: U.todayLevel, color: { value: waterColor },
                  opacity: { value: 0.3 }, overLand: { value: 0.18 }, belowShown: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform sampler2D spill, spillFrom, spillTo; uniform float sinkK, level, todayLevel, opacity, overLand, belowShown; uniform vec3 color; varying vec2 vUv;
        float dec(vec4 t){ vec3 c = t.rgb * 255.0; return c.r * 256.0 + c.g + c.b / 256.0 - 32768.0; }
        void main(){ float s0 = dec(texture2D(spill, vUv));
          float s = mix(dec(texture2D(spillFrom, vUv)), dec(texture2D(spillTo, vUv)), sinkK);
          if (s > level) discard;
          // over land that is lost (not today's sea), the water is thinner so the highlight underneath reads
          // and over land already below today's high tide too, when the palette colours it (so its colour stays true)
          bool thin = s0 > todayLevel || (belowShown > 0.5 && s0 > -49.0);
          gl_FragColor = vec4(color, thin ? overLand : opacity);
          #include <colorspace_fragment>
        }`,
    });
    const water = new THREE.Mesh(new THREE.PlaneGeometry(W, D, 1, 1), waterMat);
    water.rotation.x = -Math.PI / 2; water.renderOrder = 2; world.add(water);
    const wallMat = new THREE.MeshBasicMaterial({ color: waterColor, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide });
    let wall = null, current = 0;
    function setWater(m) {
      current = m;
      const y = yOf(m);
      water.position.y = y;
      waterMat.uniforms.level.value = m;
      U.level.value = m;
      if (wall) { world.remove(wall); wall.geometry.dispose(); }
      // Water's side: from the terrain at the edge up to the level, where the sea reaches the edge.
      wall = new THREE.Mesh(strip((c, r) => { const i = r * cols + c; return spillCR(c, r) <= m ? Math.max(y, yOf(H[i])) : yOf(H[i]); },
                                  (c, r) => yOf(H[r * cols + c])), wallMat);
      wall.renderOrder = 1; world.add(wall);
    }

    // ---------- labels ----------
    const overlay = document.createElement('div');
    overlay.className = 'b3d-labels';
    overlay.innerHTML = '<svg class="b3d-stalks"></svg>';
    container.style.position = 'relative';
    container.appendChild(overlay);
    // Scale bar and north arrow (bottom left), redrawn with every frame so they follow zoom and rotation.
    const hud = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    hud.setAttribute('class', 'b3d-hud');
    hud.setAttribute('role', 'img');
    overlay.appendChild(hud);
    const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
    function screenOf(v, w, h) { v.project(camera); return [(v.x + 1) / 2 * w, (1 - v.y) / 2 * h]; }
    function placeHud(w, h) {
      // Ground distance per screen pixel at the centre of the view, measured along the screen's horizontal.
      const right = tmpB.setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
      const y0 = groundY(target.x, target.z, true);
      const c = screenOf(tmpA.set(target.x, y0, target.z), w, h);
      const r = screenOf(tmpA.set(target.x + right.x, y0, target.z + right.z), w, h);
      const pxPerKm = Math.hypot(r[0] - c[0], r[1] - c[1]);
      // North: the screen direction of a step towards smaller z (the top edge of the bbox).
      const nn = screenOf(tmpA.set(target.x, y0, target.z - 1), w, h);
      const ang = Math.atan2(nn[0] - c[0], -(nn[1] - c[1])) * 180 / Math.PI;
      if (!isFinite(pxPerKm) || pxPerKm <= 0) { hud.innerHTML = ''; return; }
      const maxPx = Math.min(130, w * 0.28);
      const nice = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100].filter((k) => k * pxPerKm <= maxPx).pop() || 0.1;
      const len = nice * pxPerKm, R = 13, x0 = 8, cx = x0 + R, cy = 22, bx = cx + R + 14, by = cy + 4;
      const lab = nice < 1 ? `${Math.round(nice * 1000)} m` : `${nice} km`;
      const hw = Math.ceil(bx + Math.max(len, 40) + 8), hh = 44;
      hud.setAttribute('width', hw);
      hud.setAttribute('height', hh);
      hud.setAttribute('aria-label', `North arrow and scale bar: ${lab} at the centre of the view`);
      hud.innerHTML = `<rect class="b3d-hud-bg" width="${hw}" height="${hh}" rx="3"/>` +
        `<g transform="translate(${cx},${cy}) rotate(${ang.toFixed(1)})"><circle class="b3d-hud-ring" r="${R}"/>` +
        `<path class="b3d-hud-n" d="M0,${-R + 2}L5,4L0,1L-5,4Z"/><text class="b3d-hud-t" y="${-R - 3}" text-anchor="middle" transform="rotate(${(-ang).toFixed(1)},0,${-R - 7})">N</text></g>` +
        `<path class="b3d-hud-bar" d="M${bx},${by - 5}V${by}H${(bx + len).toFixed(1)}V${by - 5}"/>` +
        `<text class="b3d-hud-t" x="${bx}" y="${by - 9}">${lab}</text>`;
    }
    let labels = [];
    function lonlatToXZ(lon, lat) {
      const [w, s, e, n] = meta.bbox;
      return [((lon - w) / (e - w) - 0.5) * W, ((n - lat) / (n - s) - 0.5) * D];
    }
    function xzToLonlat(x, z) {
      const [w, s, e, n] = meta.bbox;
      return [w + (x / W + 0.5) * (e - w), n - (z / D + 0.5) * (n - s)];
    }
    function groundY(x, z, terrainOnly) {
      const c = Math.round((x / W + 0.5) * (cols - 1)), r = Math.round((z / D + 0.5) * (rows - 1));
      const i = Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c));
      return (terrainOnly ? yOf(H[i]) : Math.max(yOf(H[i]), water.position.y)) * vScale;
    }
    let pin = null;
    function marker(m) {
      if (pin) pin.el.remove();
      pin = m ? { ...m, tone: 'pin', el: Object.assign(document.createElement('span'), { className: 'b3d-label b3d-pin', textContent: m.text || '' }) } : null;
      if (pin) overlay.appendChild(pin.el);
      render();
    }
    function setLabels(list) {
      labels = list.map((l) => ({ ...l, el: Object.assign(document.createElement('span'), { className: `b3d-label b3d-${l.tone || 'ink'}`, textContent: l.text }) }));
      overlay.querySelectorAll('.b3d-label').forEach((e) => e.remove());
      labels.forEach((l) => overlay.appendChild(l.el));
      render();
    }
    function placeLabels(w, h) {
      const svg = overlay.firstChild;
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.innerHTML = '';
      const v = new THREE.Vector3(), placed = [];
      const order = { pin: -1, red: 0, ink: 1, muted: 2, place: 3 };
      const stalk = 0.06 * camera.position.distanceTo(target);
      [...labels.filter((l) => !(pin && l.tone === 'place' && l.text === pin.text)), ...(pin ? [pin] : [])].sort((a, b) => (order[a.tone] ?? 1) - (order[b.tone] ?? 1)).forEach((l) => {
        const [x, z] = lonlatToXZ(l.lon, l.lat), y0 = groundY(x, z), y1 = y0 + stalk;
        const p0 = v.set(x, y0, z).project(camera).clone(), p1 = new THREE.Vector3(x, y1, z).project(camera);
        const s0 = [(p0.x + 1) / 2 * w, (1 - p0.y) / 2 * h], s1 = [(p1.x + 1) / 2 * w, (1 - p1.y) / 2 * h];
        let visible = p0.z < 1 && s1[0] > 0 && s1[0] < w && s1[1] > 0 && s1[1] < h && !(l.maxDist && cam.dist > l.maxDist);
        // Skip a label whose text would overlap one already placed (the story's focus, in red, goes first).
        const flat = l.tone === 'place';     // place names: small text on the ground, no stalk
        const at = flat ? s0 : s1;
        if (!l.w && l.el.offsetWidth) { l.w = l.el.offsetWidth; l.h = l.el.offsetHeight; }   // measure once: no layout thrash
        const lw = l.w || 80, lh = l.h || 20;
        const box = flat ? [at[0] - lw / 2, at[1] - lh / 2, at[0] + lw / 2, at[1] + lh / 2] : [at[0] - lw / 2, at[1] - lh * 1.1, at[0] + lw / 2, at[1]];
        if (visible && placed.some((b) => box[0] < b[2] + 4 && box[2] > b[0] - 4 && box[1] < b[3] + 2 && box[3] > b[1] - 2)) visible = false;
        l.el.style.display = visible ? '' : 'none';
        if (!visible) return;
        placed.push(box);
        l.el.style.transform = `translate(${at[0]}px, ${at[1]}px) translate(-50%, ${flat ? '-50%' : '-110%'})`;
        if (!flat) svg.insertAdjacentHTML('beforeend', `<line class="b3d-${l.tone || 'ink'}" x1="${s0[0]}" y1="${s0[1]}" x2="${s1[0]}" y2="${s1[1]}"/>`);
      });
    }

    // ---------- camera, animation, rendering on demand ----------
    let cam = { az: 20, el: 30, dist: 1.6, tx: 0, tz: 0 }, drag = 0;
    const target = new THREE.Vector3();
    function applyCamera() {
      // Steps are framed for a wide view (aspect ~1.4); on taller screens move back so the block still fits.
      const fit = Math.min(1.8, Math.pow(Math.max(1, 1.4 / camera.aspect), 0.6));
      const az = ((cam.az + drag) * Math.PI) / 180, el = (cam.el * Math.PI) / 180, r = cam.dist * W * fit;
      const tx = cam.tx, tz = -cam.tz;
      camera.position.set(tx + r * Math.cos(el) * Math.sin(az), r * Math.sin(el), tz + r * Math.cos(el) * Math.cos(az));
      if (autoExag) {             // explorer: 45x for the overview, down to 5x close up (snapped to round values)
        const want = X * Math.min(1, cam.dist / 0.9);
        const eff = [X, 30, 20, 10, 5].filter((v) => v <= X).find((v) => v <= want * 1.0001) || 5;
        if (eff / X !== vScale) { vScale = eff / X; world.scale.y = vScale; if (onExag) onExag(eff); }
      }
      target.set(tx, 0, tz);
      camera.lookAt(target);
      camera.updateMatrixWorld();
      // Hatching: stripes about 9 screen pixels apart at the centre of the view, in ground units snapped to powers
      // of two, so they stay fixed to the ground while the camera moves and only change step when the zoom does.
      const px = (2 * r * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, container.clientHeight);
      U.hatchScale.value = 1 / Math.pow(2, Math.round(Math.log2(px * 9)));
      const fade = (d0, d1) => Math.min(1, Math.max(0, (d0 - cam.dist) / (d0 - d1)));   // 0 beyond d0, 1 within d1
      U.borderAmount.value.set(pal.borderMain ?? 0, (pal.borderDistrict ?? 0) * fade(1.3, 0.8), (pal.borderSub ?? 0) * fade(0.5, 0.25));
    }
    let raf = 0;
    function render() {
      if (raf || disposed) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const w = container.clientWidth, h = container.clientHeight;
        if (!w || !h) return;
        if (renderer.domElement.width !== Math.round(w * renderer.getPixelRatio())) { renderer.setSize(w, h, false); renderer.domElement.style.width = w + 'px'; renderer.domElement.style.height = h + 'px'; }
        camera.aspect = w / h; camera.updateProjectionMatrix();
        applyCamera();
        renderer.render(scene, camera);
        placeLabels(w, h);
        placeHud(w, h);
      });
    }
    const tweens = {};
    function tween(key, from, to, ms, apply) {
      cancelAnimationFrame(tweens[key]);
      if (!ms) { apply(to); render(); return; }
      const t0 = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - t0) / ms);
        apply(from + (to - from) * ease(k)); render();
        if (k < 1) tweens[key] = requestAnimationFrame(step);
      };
      tweens[key] = requestAnimationFrame(step);
    }
    function view(v, ms = 1600) {
      const from = { ...cam }, to = { ...cam, ...v };
      tween('cam', 0, 1, ms, (k) => { for (const key in to) cam[key] = from[key] + (to[key] - from[key]) * k; });
    }
    function level(m, ms = 1200) { tween('level', current, m, ms, setWater); }
    function loadTerrain(name) {
      if (terrains[name]) return Promise.resolve(terrains[name]);
      return (terrains[name] = loadImage(`${dir}spill_${name}.png`).then((im) => {
        const tex = new THREE.Texture(im);
        tex.colorSpace = THREE.NoColorSpace; tex.magFilter = tex.minFilter = THREE.NearestFilter;
        tex.generateMipmaps = false; tex.needsUpdate = true;
        return (terrains[name] = { tex, S: decodeTerrarium(im) });
      }));
    }
    const ready = (n) => (terrains[n] && terrains[n].S ? terrains[n] : terrains.none);
    function setTerrain(from = 'none', to = from, k = 1) {
      tFrom = ready(from); tTo = ready(to); tK = from === to ? 0 : Math.max(0, Math.min(1, k));
      tName = tK >= 0.5 ? to : from;
      U.spillFrom.value = tFrom.tex; U.spillTo.value = tTo.tex; U.sinkK.value = tK;
      setWater(current); render();
    }
    function sinkTo(name, ms = 900) {
      const from = tName;
      if (from === name) { setTerrain(name); return; }
      tween('sink', 0, 1, ms, (k) => setTerrain(from, name, k));
    }

    // ---------- interaction ----------
    const el = renderer.domElement;
    const ndc = (e) => { const b = el.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1); };
    const ray = new THREE.Raycaster();
    function groundAt(e) {             // where the pointer meets the plane at sea level (for panning and zooming)
      ray.setFromCamera(ndc(e), camera);
      const o = ray.ray.origin, d = ray.ray.direction;
      if (Math.abs(d.y) < 1e-6) return null;
      const t = (0 - o.y) / d.y;
      return t > 0 ? o.clone().addScaledVector(d, t) : null;
    }
    function pickAt(e) {               // where the pointer meets the terrain: march along the ray, then bisect
      ray.setFromCamera(ndc(e), camera);
      const o = ray.ray.origin, d = ray.ray.direction, p = new THREE.Vector3();
      const above = (t) => { p.copy(o).addScaledVector(d, t); return p.y > groundY(p.x, p.z, true); };
      const stepT = (W / cols) * 0.5, far = camera.position.length() + 2 * W;
      let t0 = 0;
      for (let t = stepT; t < far; t += stepT) {
        if (!above(t)) {
          let a = t0, b = t;
          for (let k = 0; k < 20; k++) { const m = (a + b) / 2; if (above(m)) a = m; else b = m; }
          p.copy(o).addScaledVector(d, b);
          if (Math.abs(p.x) > W / 2 || Math.abs(p.z) > D / 2) return null;
          return xzToLonlat(p.x, p.z);
        }
        t0 = t;
      }
      return null;
    }
    const clampCam = () => {
      cam.tx = Math.max(-W / 2, Math.min(W / 2, cam.tx)); cam.tz = Math.max(-D / 2, Math.min(D / 2, cam.tz));
      cam.dist = Math.max(0.035, Math.min(2.6, cam.dist)); cam.el = Math.max(12, Math.min(88, cam.el));
    };
    function panTo(anchor, e) {        // move the target so `anchor` (a ground point) sits under the pointer again
      const g2 = groundAt(e);
      if (!anchor || !g2) return;
      cam.tx += anchor.x - g2.x; cam.tz -= anchor.z - g2.z;
      clampCam(); applyCamera(); render();
    }
    function zoomAround(f, e) {        // zoom keeping the ground point under the pointer in place
      for (const k in tweens) if (k === 'cam') cancelAnimationFrame(tweens[k]);
      const a = e && groundAt(e);
      cam.dist *= f; clampCam(); applyCamera();
      if (a) panTo(a, e); else render();
    }
    let mode = 'story', onPick = null, hintEl = null, hintTimer = 0, autoExag = false, onExag = null;
    const hint = (msg) => {
      if (!hintEl) return;
      hintEl.textContent = msg; hintEl.classList.add('is-on');
      clearTimeout(hintTimer); hintTimer = setTimeout(() => hintEl.classList.remove('is-on'), 1600);
    };
    const pointers = new Map();
    let gesture = null;
    el.addEventListener('contextmenu', (e) => { if (mode === 'explore') e.preventDefault(); });
    el.addEventListener('pointerdown', (e) => {
      if (mode === 'story') { if (e.pointerType !== 'touch') gesture = { kind: 'turn', x: e.clientX, az: drag }; return; }
      pointers.set(e.pointerId, e);
      if (e.pointerType !== 'touch' || pointers.size > 1) el.setPointerCapture(e.pointerId);
      for (const k in tweens) if (k === 'cam') cancelAnimationFrame(tweens[k]);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const mid = { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 };
        gesture = { kind: 'pinch', d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), ang: Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX),
                    dist: cam.dist, az: cam.az, anchor: groundAt(mid) };
      } else if (e.pointerType !== 'touch' && (e.button === 2 || e.shiftKey)) {
        gesture = { kind: 'orbit', x: e.clientX, y: e.clientY, az: cam.az, el: cam.el };
      } else {
        gesture = { kind: e.pointerType === 'touch' ? 'tap' : 'pan', x: e.clientX, y: e.clientY, anchor: groundAt(e), moved: false };
      }
    });
    onWin('pointermove', (e) => {
      if (!gesture) return;
      if (mode === 'story') { if (gesture.kind === 'turn') { drag = gesture.az + (e.clientX - gesture.x) / 4; render(); } return; }
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, e);
      if (gesture.kind === 'pinch' && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), ang = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX);
        cam.dist = gesture.dist * (gesture.d / Math.max(d, 1));
        cam.az = gesture.az - ((ang - gesture.ang) * 180) / Math.PI;
        clampCam(); applyCamera();
        panTo(gesture.anchor, { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 });
      } else if (gesture.kind === 'orbit') {
        cam.az = gesture.az - (e.clientX - gesture.x) / 3; cam.el = gesture.el + (e.clientY - gesture.y) / 4;
        clampCam(); render();
      } else if (gesture.kind === 'pan' || gesture.kind === 'tap') {
        if (Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 5) gesture.moved = true;
        if (gesture.kind === 'pan' && gesture.moved) panTo(gesture.anchor, e);
      }
    });
    const end = (e) => {
      if (mode === 'story') { gesture = null; return; }
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (gesture && (gesture.kind === 'pan' || gesture.kind === 'tap') && !gesture.moved && e.type === 'pointerup' && onPick) {
        const ll = pickAt(e);
        if (ll) onPick({ lon: ll[0], lat: ll[1] });
      }
      if (gesture && gesture.kind === 'tap' && gesture.moved) hint('Use two fingers to move and zoom the map');
      gesture = null;
      if (pointers.size === 1) {         // a finger left a pinch: carry on panning with the other one
        const p = [...pointers.values()][0];
        if (p.pointerType === 'touch') gesture = { kind: 'tap', x: p.clientX, y: p.clientY, moved: true };
      }
    };
    onWin('pointerup', end);
    onWin('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      if (mode !== 'explore') return;
      if (!(e.ctrlKey || e.metaKey)) { hint(/Mac/.test(navigator.platform) ? 'Hold ⌘ and scroll to zoom the map' : 'Hold Ctrl and scroll to zoom the map'); return; }
      e.preventDefault();
      zoomAround(Math.exp(e.deltaY * (e.deltaMode ? 0.05 : 0.0025)), e);
    }, { passive: false });
    el.addEventListener('dblclick', (e) => { if (mode === 'explore') zoomAround(0.5, e); });
    function interact(m, pick, hintElement, exagCallback) {
      mode = m; onPick = pick || null; hintEl = hintElement || null;
      autoExag = m === 'explore'; onExag = exagCallback || null;
      if (!autoExag) { vScale = 1; world.scale.y = 1; }
      if (onExag) onExag(X * vScale);
      render();
      el.style.touchAction = m === 'explore' ? 'pan-y' : '';
      el.style.cursor = m === 'explore' ? 'crosshair' : 'grab';
    }
    function flyTo(lon, lat, dist = cam.dist, ms = 1400) {
      const [x, z] = lonlatToXZ(lon, lat);
      view({ tx: x, tz: -z, dist }, ms);
    }
    function zoomBy(f) { const to = { dist: Math.max(0.035, Math.min(2.6, cam.dist * f)) }; view(to, 350); }
    function lookup(lon, lat) {
      const [w, s0, e, n] = meta.bbox;
      const inside = lon >= w && lon <= e && lat >= s0 && lat <= n;
      if (!inside) return { inside };
      const c = Math.min(SC - 1, Math.floor(((lon - w) / (e - w)) * SC)), r = Math.min(SR - 1, Math.floor(((n - lat) / (n - s0)) * SR));
      const v = S[r * SC + c];
      let district = null, subdistrict = null;
      if (adminPx) {
        // the admin raster has its own grid (it can be finer than the flood raster): index it with its own size
        const ac = Math.min(adminW - 1, Math.floor(((lon - w) / (e - w)) * adminW)), ar = Math.min(adminH - 1, Math.floor(((n - lat) / (n - s0)) * adminH));
        const k = (ar * adminW + ac) * 4, si = adminPx[k] * 256 + adminPx[k + 1], di = adminPx[k + 2];
        district = di ? adminUnits.districts[di - 1] : null;
        subdistrict = si ? adminUnits.subdistricts[si - 1] : null;
      }
      const states = {};
      for (const n in terrains) if (terrains[n].S) states[n] = terrains[n].S[r * SC + c];
      const at = (A) => (A && A[r * SC + c] < 900 ? A[r * SC + c] : null);
      return { inside, sea: v <= -49, spill: v, states, ground: G ? G[r * SC + c] : null, vlm: at(V),
               vlmSpread: at(VS), vlmCheck: at(VC),
               district, subdistrict };
    }
    const resizeObs = 'ResizeObserver' in g ? new ResizeObserver(render) : null;
    if (resizeObs) resizeObs.observe(container);
    container.__fcc = { renderer, scene, camera };   // handle for tools/page_check

    let pal = {};
    function palette(p) {
      pal = { ...PALETTE_DEFAULT, ...p };
      for (const k of ['landLow', 'landHigh', 'built', 'seaDeep', 'seaShallow', 'lost', 'coast', 'shore', 'road', 'border']) U[k].value.set(pal[k]);
      U.shoreAmount.value = pal.shoreAmount; U.roadAmount.value = pal.roadAmount;
      U.below.value.set(pal.below || '#000000');
      U.belowAmount.value = pal.below ? pal.belowAmount : 0;
      waterMat.uniforms.belowShown.value = pal.below ? 1 : 0;
      U.builtAmount.value = pal.builtAmount; U.shadeStrength.value = pal.shadeStrength; U.lostAmount.value = pal.lostAmount;
      U.hatch.value = pal.lostStyle === 'hatch' ? 1 : 0; U.coastLine.value = pal.coastLine ? 1 : 0;
      waterColor.set(pal.water); waterMat.uniforms.opacity.value = pal.waterOpacity; waterMat.uniforms.overLand.value = pal.waterOverLand;
      wallMat.color.set(pal.water); wallMat.opacity = Math.min(0.9, pal.waterOpacity + 0.15);
      sideMat.color.set(pal.side); shadowMat.opacity = pal.shadow / 0.35;
      render();
    }
    function today(m) { U.todayLevel.value = m; render(); }

    palette({});
    setWater(0);
    render();
    function dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      for (const k in tweens) cancelAnimationFrame(tweens[k]);
      winListeners.forEach(([type, fn, opts]) => g.removeEventListener(type, fn, opts));
      if (resizeObs) resizeObs.disconnect();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        [].concat(o.material || []).forEach((m) => {
          Object.values(m.uniforms || {}).forEach((u) => u && u.value && u.value.isTexture && u.value.dispose());
          ['map', 'alphaMap'].forEach((k) => m[k] && m[k].dispose());
          m.dispose();
        });
      });
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      overlay.remove();
      delete container.__fcc;
    }
    return { view, level, today, loadTerrain, terrain: setTerrain, sinkTo, palette, labels: setLabels, names, marker, flyTo, zoomBy, lookup, spillWidth: SC,
             interact, meta, render, dispose };
  }

  FCC.block3d = { supported, create };
})(window);
