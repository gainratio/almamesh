# Third-Party Notices

AlmaMesh itself is released under the **MIT License** (see [`LICENSE`](./LICENSE),
© 2026 Harish Seshadri). It ships, vendors, or syncs the third-party works listed
below, each under its own license. This file consolidates those attributions so a
downstream user has, in one place, the credit and license terms required for
redistribution.

Nothing here changes AlmaMesh's own MIT terms; it documents the obligations that
travel with the bundled dependencies.

---

## 1. Ephemeris data — JPL DE421 (`backend/de421.bsp`)

- **What:** The JPL Development Ephemeris **DE421** planetary/lunar ephemeris,
  shipped as a SPICE SPK kernel and synced into the browser inside the signed
  edge-proc bundle. It is the astronomical source of truth for every chart.
- **Origin:** Jet Propulsion Laboratory (JPL), California Institute of Technology,
  for NASA — distributed via the NAIF (Navigation and Ancillary Information
  Facility) PDS node.
- **License / status:** Produced by a U.S. Government agency; JPL DE-series
  ephemerides are **in the public domain** and free to use. No copyright is
  asserted over the data.
- **Credit:** Please credit *JPL / NASA NAIF* (and cite Folkner, W. M., et al.,
  "The Planetary and Lunar Ephemeris DE 421," JPL IOM 343R-08-003, 2009) when
  reusing the ephemeris.

> Note: the `finals2000A.all` Earth-orientation file referenced by the bundle
> publisher is fetched at build time from IERS/USNO and is likewise not subject to
> copyright; it is not committed to this repository.

## 2. Astronomy Python wheels (`backend/offline_wheels/`)

Pure-Python (`py3-none-any`) wheels vendored so the in-browser Pyodide engine can
boot the Skyfield stack offline. All three are **MIT-licensed, © Brandon Rhodes**.

| Package | Version | License | Copyright |
|---------|---------|---------|-----------|
| `skyfield` | 1.53 | MIT | © 2013–2018 Brandon Rhodes |
| `jplephem` | 2.23 | MIT | © Brandon Rhodes |
| `sgp4` | 2.25 | MIT | © 2012–2016 Brandon Rhodes |

MIT License (the text below applies to each of the three packages above):

```
Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in the
Software without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## 3. Fonts (`frontend/apps/web/public/fonts/`)

The self-hosted "Observatory" UI fonts are licensed under the **SIL Open Font
License, Version 1.1 (OFL-1.1)**. The full license text for each family ships
alongside the font files; the relevant files are:

- [`frontend/apps/web/public/fonts/OFL.txt`](./frontend/apps/web/public/fonts/OFL.txt) — Hanken Grotesk
- [`frontend/apps/web/public/fonts/OFL-Fraunces.txt`](./frontend/apps/web/public/fonts/OFL-Fraunces.txt) — Fraunces
- [`frontend/apps/web/public/fonts/OFL-SplineSansMono.txt`](./frontend/apps/web/public/fonts/OFL-SplineSansMono.txt) — Spline Sans Mono

| Font | License | Copyright |
|------|---------|-----------|
| Fraunces | OFL-1.1 | © 2020 The Fraunces Project Authors (github.com/undercasetype/Fraunces) |
| Hanken Grotesk | OFL-1.1 | © 2021 The Hanken Grotesk Project Authors (github.com/marcologous/hanken-grotesk) |
| Spline Sans Mono | OFL-1.1 | © 2022 The Spline Sans Mono Project Authors (github.com/SorkinType/SplineSansMono) |

Under the OFL, these fonts may be used, studied, modified, and redistributed
freely so long as they are not sold by themselves and the license/copyright
notices (the `OFL*.txt` files above) travel with them.

## 4. Sentence-embedding model — `Xenova/all-MiniLM-L6-v2`

- **What:** A quantized ONNX export of `sentence-transformers/all-MiniLM-L6-v2`,
  used by `@almamesh/memory` for fully on-device (zero-egress) semantic chat
  recall via Transformers.js.
- **Where:** Weights live under
  `frontend/apps/web/public/models/Xenova/all-MiniLM-L6-v2/`. **This directory is
  a gitignored local/dev asset and is not committed to the repository** — it is
  downloaded during dev setup — so this notice (rather than an in-tree `LICENSE`
  file) records its terms.
- **License:** **Apache License 2.0.**
- **Credit:** `sentence-transformers/all-MiniLM-L6-v2` by the Sentence-Transformers
  / UKP authors (Nils Reimers et al.), derived from
  `nreimers/MiniLM-L6-H384-uncased`; ONNX conversion by the Xenova / Hugging Face
  Transformers.js project. See https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2.

## 5. Vendored first-/related-party packages

| Path | Package | License | Copyright |
|------|---------|---------|-----------|
| `frontend/packages/edgeproc-browser/` | @gainratio/browser (edge-reco) | MIT | © 2026 Harish Seshadri |

`edge-proc` (MIT, © 2026 Harish Seshadri) and its `edgeproc-core` dependency (MIT,
© 2025 Vector Management Team) were vendored under `backend/vendor/` until
2026-08-03; both now resolve from PyPI and are covered by section 1 alongside the
other Python dependencies.

Each vendored package keeps its own `LICENSE` in place; consult those files for
the authoritative terms. In particular:

- **`edgeproc-core`** (formerly `shared-libs-python`) is MIT-licensed and
  **© 2025 Vector Management Team**, reproduced verbatim:

  ```
  MIT License

  Copyright (c) 2025 Vector Management Team

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
  ```

- **`@gainratio/browser`** is the owner's own code (from the edge-reco project),
  relicensed to **MIT** for this release — see
  [`frontend/packages/edgeproc-browser/LICENSE`](./frontend/packages/edgeproc-browser/LICENSE).

## 6. Offline city / location data (`frontend/apps/web/src/data/cities.min.json`)

- **What:** The bundled, offline city database that powers birth-location search.
  `frontend/scripts/generate-cities.mjs` pre-bakes a pruned, browser-ready
  `cities.min.json` (city names, coordinates, country, population) that is
  **committed to the repository as a static data asset**, so location entry
  resolves to latitude/longitude with zero network calls (no geocoding API).
- **Data origin & required attribution:** The city data is derived from
  **GeoNames** via the `all-the-cities` package (which in turn derives from the
  `cities-with-1000` GeoNames export). The GeoNames geographical database is
  licensed under **Creative Commons Attribution 4.0 International (CC BY 4.0)**
  and **requires attribution**. Please credit *GeoNames
  (https://www.geonames.org/), CC BY 4.0* when redistributing this data.

| Source | Role | License | Link |
|--------|------|---------|------|
| GeoNames | Geographical data (city names, coordinates, population) baked into `cities.min.json` | **CC BY 4.0 — attribution required** | https://www.geonames.org/ · https://creativecommons.org/licenses/by/4.0/ |
| `all-the-cities` 3.1.0 | Build-time npm package supplying the GeoNames-derived dataset | MIT | https://github.com/zeke/all-the-cities |
| `countries-list` 3.3.0 | Build-time npm package resolving ISO-3166 alpha-2 codes to country display names baked into the data | MIT | https://github.com/annexare/Countries |
| `tz-lookup` 6.1.25 | Runtime library mapping latitude/longitude → IANA timezone offline | CC0-1.0 (public domain; no attribution required) | https://github.com/darkskyapp/tz-lookup |

## 7. Planet textures (`frontend/apps/web/public/planets/planet-*.jpg`)

- **What:** Equirectangular planet surface textures for the dashboard's 3D
  "force-field" hero, loaded at runtime by `PlanetMesh.tsx`. Committed under
  `frontend/apps/web/public/planets/` as
  `planet-{sun,moon,mercury,venus,mars,jupiter,saturn}.jpg`.
- **Origin & required attribution:** **Solar System Scope** planet textures
  (https://www.solarsystemscope.com/textures/), licensed under **Creative Commons
  Attribution 4.0 International (CC BY 4.0)**
  (https://creativecommons.org/licenses/by/4.0/) — free for any purpose,
  including commercial use, **with attribution**. Please credit *"Planet textures
  from Solar System Scope (CC BY 4.0)."*
- **Note:** The Rahu/Ketu lunar-node icons (`planet-rahu.png`, `planet-ketu.png`)
  are simple placeholder symbols generated locally by the repo's own
  `frontend/apps/web/public/planets/create-placeholders.sh` (ImageMagick); they
  are not third-party assets and carry no external attribution requirement.

---

The npm/PyPI dependencies pulled at install time (React, Vite, Tailwind, Zustand,
Pydantic, Pyodide, Transformers.js, etc.) carry their own licenses in their
respective package metadata; this file covers the works that are committed,
vendored, or synced as data/assets rather than resolved by a package manager.
