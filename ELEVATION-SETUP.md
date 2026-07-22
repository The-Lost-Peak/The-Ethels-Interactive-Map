# Elevation Profiles — Setup

This adds an **elevation profile** to each Ethel popup. Tap the mountain-line button
(next to the flyover button) to flip the popup between the normal view and a chart of
the route's ascent; tap again to flip back.

Elevation is **baked into the GPX files** by an automated GitHub Actions workflow, so
there are **no live API calls in visitors' browsers** — the profile draws instantly from
local data, and updates automatically whenever you change a route.

---

## Files

| File | Where it goes |
|------|----------------|
| `index.html` | repo root (replaces current map) |
| `enrich-elevation.mjs` | repo root |
| `package.json` | repo root (or merge the `pngjs` dependency into your existing one) |
| `enrich-elevation.yml` | `.github/workflows/` |

---

## One-time setup

1. Commit the four files to the locations above.
2. Add your Mapbox token as a repository secret so it stays out of public code:
   **repo → Settings → Secrets and variables → Actions → New repository secret**
   - Name: `MAPBOX_TOKEN` (exactly)
   - Value: your Mapbox access token
3. Trigger the first run — either push any change to a file under `GPX/`, or go to the
   **Actions** tab → **Enrich GPX Elevation** → **Run workflow**.

The first run processes all ~95 GPX files (a few minutes; well within Mapbox's free tier).
After that, reload the map and the elevation profiles will draw.

---

## How it stays current

- The workflow runs automatically whenever you push a changed `.gpx` under `GPX/`.
- Each GPX gets a hidden `<!-- ele-hash:... -->` stamp based on its coordinates.
  - Unchanged file → hash matches → **skipped** (fast, no API calls).
  - Changed route → hash differs → **re-fetched** and re-baked automatically.
- So when you re-walk and improve a route, just commit the new GPX as normal — the
  elevation updates itself on push. Nothing manual to remember.

You can also run it by hand any time from the **Actions** tab (**Run workflow**).

---

## Running it locally (optional)

If you ever want to enrich on your own machine instead of via Actions:

```bash
npm install pngjs
MAPBOX_TOKEN=your_token_here node enrich-elevation.mjs
# or a single file:
MAPBOX_TOKEN=your_token_here node enrich-elevation.mjs "GPX/Aleck Low.gpx"
```

---

## Notes / tuning

- **Source:** Mapbox Terrain-RGB at zoom 14 — high-quality ground elevation, plenty
  accurate for Peak District hills.
- **Accuracy:** the profile reflects ground elevation at each track point, which is what
  you want for a walk. If a route was drawn loosely (cutting corners across a slope), the
  profile reflects the drawn line, not a corrected path.
- **"No elevation data"** in a popup means that GPX hasn't been enriched yet (run the
  workflow) or genuinely has no track points.
- **Tuning knobs** in `enrich-elevation.mjs`: `ZOOM` (detail vs tile count) and
  `CONCURRENCY` (speed vs rate-limit headroom).
