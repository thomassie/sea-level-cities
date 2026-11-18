# Sea-level Cities: published files

Published to `thomassie/sea-level-cities` (GitHub Pages) by `.github/scripts/publish-pages.sh`. Embed: see
`HANDOVER-sea-level-cities.md` in the repository root.

| File | What it is |
|---|---|
| `index.html` | Standalone page |
| `embed-example.html` | The page inside a stand-in host page with hostile styles and a fixed header (test only, noindex) |
| `slc.js`, `slc.css` | The page: chapters, comparison row, explorer, sources and method |
| `staff.js` | The gauge staff (page-specific) |
| `block3d.js`, `scrolly.js`, `theme.css` | Shared code, copied from `site/_shared/` by `tools/sync_shared.py` |
| `data/places.json` | One row per place: name, bbox, `msl_m` (local mean sea level above EGM2008), `mhhw_m`, storms, defences (crest heights as published and above local MSL), documented impacts with sources, labels |
| `data/scenarios.json` | One row per place, scenario (`s`), year (`y`), land state (`sub`) and water (`w`: `high_tide` or a storm): rise `r` (with likely range `rl`, `rh`), water level `wl` (m above EGM2008), land below it `a` km² (`al`, `ah`), median ground height `g`, people `pop` (`pl`, `ph`), cropland and built-up km² |
| `data/units.json`, `data/exposure.json` | Administrative units (OpenStreetMap) and people below the line per unit, for the explorer |
| `data/meta.json` | Export time and source database |
| `blocks/<place>/` | 3D block assets baked by `pipeline/slr/block.py`: height, spill (lowest water level that reaches each cell), shade, borders, roads, names, admin; `block.json` holds size and exaggeration |
| `static/<place>-<step>.jpg`, `static/<place>-<step>-dark.jpg` | Still images of each step for browsers without WebGL, light and dark (`tools/static/sea-level-cities.mjs`) |
| `og.png`, `figure-light.png`, `figure-dark.png` | Link preview and series figures (`tools/og/sea-level-cities.mjs`) |

All levels in the data are metres above EGM2008; the page shows them above local mean sea level (`wl - msl_m`).
Every number in the page's text is computed from these files.
