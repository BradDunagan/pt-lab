# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A lab for evaluating photo-realistic (not-necessarily-realtime) rendering in the browser with three.js + three-gpu-pathtracer. `docs/what-this-is.md` is the real project documentation — architecture rationale, production caveats, and integration notes live there. Keep that doc in sync with meaningful changes.

## Repository layout (npm workspaces monorepo)

```
packages/pt-lab/   # the library — the consumable module (path tracer + scene editor)
packages/demo/     # a demo app that consumes pt-lab and provides the demo assets
```

`packages/pt-lab` is published/consumed the way `../paneless-workspace/packages/paneless` is: its `package.json` points `svelte`/`main`/`types`/`exports` at `./src/index.ts` (a barrel), so consumers use the **source** (compiled by their own Vite/Svelte). An external app depends on it via a path dependency (`"pt-lab": "../pt-lab-workspace/packages/pt-lab"`) and `import { PathTracerLab, PathTracerViewer, … } from 'pt-lab'`. `packages/demo` is exactly such a consumer, in-repo.

## Commands

Run `npm install` once at the root (sets up the workspaces). Then:

```sh
npm run dev        # demo dev server (delegates to packages/demo)
npm run build      # build the demo app
npm run check      # svelte-check both packages (library + demo)
npm run pkg:build  # svelte-package the library to packages/pt-lab/dist (publish artifact)
npm run pkg:dev    # svelte-package --watch
```

Per-package: `npm run --workspace packages/pt-lab check`, `… --workspace packages/demo check`. There are no tests or linters. `pkg:build` warns about `import.meta.env` — harmless, since consumers use the source (where Vite provides it), not the dist.

## Architecture

The library (`packages/pt-lab/src/`) is the reusable core; the demo (`packages/demo/src/`) is one consumer. A deliberate framework boundary runs between them:

- `packages/pt-lab/src/lib/pathtracer.ts` — **the reusable core**. `PathTracerLab` is a framework-agnostic class owning the `WebGLRenderer`, scene, `OrbitControls`, and `WebGLPathTracer`. Hosts talk to it only through public methods and callbacks (`onStatus`, `onObjectsChanged`) — never through three.js internals. Preserve this boundary: don't leak three.js types into the Svelte layer (so the backend can be swapped for WebGPU later).
- `packages/pt-lab/src/lib/PathTracerViewer.svelte` — thin glue: mounts the class on a canvas, wires `ResizeObserver`, disposes on unmount, exposes `lab` and `status` via `$bindable` props.
- `packages/pt-lab/src/index.ts` — the barrel: exports `PathTracerLab` + types, the components (`PathTracerViewer`, `TransformPanel`, `MaterialPanel`, `LightPanel`, `BundleTree`), and the persistence/bundled modules.
- `packages/demo/src/App.svelte` — control panel + Scene Editor UI, importing everything from `'pt-lab'`. Svelte 5 runes (`$state`/`$effect`/`$derived`); each control pushes into the lab via an `$effect`. Inspector panels hold a local copy seeded once from the selection and are keyed by object id (`{#key selectedId}`) so switching selection remounts and re-seeds them.

Asset URLs (Damaged Helmet glTF, HDR environment, denoiser `.tza` weights) are **configurable via `LabOptions`** (`modelUrl`, `envUrl`, `denoiserWeights`), defaulting to `${import.meta.env.BASE_URL}assets/…`. The demo serves those files from `packages/demo/public/assets/`; other consumers pass their own URLs or provide the files. If the model fails to load, `PathTracerLab` falls back to a procedural scene. Bundled importable objects (`packages/pt-lab/src/assets/imports/`) are enumerated at build time by `bundled.ts` via `import.meta.glob` and travel *with the library*.

### Scene Editor

`PathTracerLab` also hosts a data-driven Scene Editor (`docs/what-this-is.md` has the user-facing details). Load-bearing points:

- **Two render modes**: path-traced (`renderSample()`) vs. a fast raster edit mode (`renderer.render()` when `editing`). Object/room/material edits happen in edit mode against the raster view and mark the scene dirty; returning to render rebuilds/updates the tracer.
- **Edit-mode shadows** are shadow maps (`shadowMap.autoUpdate` off + a `shadowsDirty` flag). Lamps that can't cast one — `RectAreaLight`, the emissive mesh — get a hidden `SpotLight` proxy that takes `PROXY_SHARE` of their output while editing, plus an `AmbientLight` standing in for bounce light. Both are hidden in render mode, so the tracer (which collects only *visible* rect/spot/point/directional lights) never sees them: `syncRasterLights()` owns that swap and must run before any tracer sync.
- **A scene is data** (`SceneData`: room + per-object state + lights + camera). `buildEditorScene()` rebuilds the whole scene from scratch (floor + object library + room + state), which is why loading a saved scene works from any starting point. The room demos now route through this same path.
- **Two-tier persistence**: the object library (built-in factories + imported `.glb` templates) is global (`library-store.ts`, **IndexedDB** db `pt-lab` / store `imports`, raw `ArrayBuffer` bytes — async API, with a one-time migration from the old localStorage+base64 `pt-lab.library`); named scenes are localStorage (`scenes.ts`, `pt-lab.scenes`) and reference objects by library key. A save that overflows quota aborts the import with a "Storage full" message. Material props are exposed as artist terms (shininess = `1 − roughness`, reflectivity = `metalness`).
- **Editor lights** (`addLight`/`setLight`/`removeLight`/`listLights`, `LabLight`) are point/spot/area three.js lights in a `Lights` group. Changes sync via `updateLights()` (no BVH rebuild) — immediately in render mode, via `lightsDirty` on return from edit mode. Their marker spheres live in a separate `markerScene` drawn only by the edit-mode raster pass, so they never reach the tracer or the ground-truth exports.
- **Exported scenes carry their models.** An import's key only resolves in the browser that imported it, so `serializeScene()` adds `glb` (`modelFileName`: name + first 12 hex of SHA-256) and `sha256` to imported objects, and `exportSceneData` downloads each included import's `.glb` beside the JSON. Another host (cv-lab's generator) loads them with `registerImport(key, name, bytes)` — in memory only, never IndexedDB, under the scene's own key — before `applyScene`, which silently skips any key missing from the library.
- Keep the framework boundary: the editor API is plain-data methods/callbacks (`listObjects`, `setObjectMaterial`, `setLight`, `serializeScene`, `applyScene`, `importGLB`, `registerImport`, `onObjectsChanged`, `onLightsChanged`) — no three.js types cross into Svelte.

## Path-tracer behavior that shapes the code

- Rendering is **progressive accumulation**: `renderSample()` runs every frame and accumulates; image quality = sample count. Any camera/material/environment change must reset or update accumulation — that's why every setter in `PathTracerLab` calls `reset()`, `updateCamera()`, `updateMaterials()`, or `updateEnvironment()`.
- `setScene()` rebuilds the BVH and repacks all textures — expensive, done once at init, never per-frame. Material/environment tweaks use the cheap `update*()` calls that keep the BVH.
- The hybrid interaction pattern (rasterize while interacting, path trace when idle, crossfade) is built into `WebGLPathTracer` and configured in the `PathTracerLab` constructor (`rasterizeScene`, `renderDelay`, `dynamicLowRes`, `fadeDuration`, `tiles`). The render loop stays dumb: just `renderSample()` per frame.

## Version coupling

`three-gpu-pathtracer` reaches into three.js internals (shaders, material properties). The known-good pairing is `three@0.185` + `three-gpu-pathtracer@0.0.24`; don't bump `three` without re-testing rendering. Only `MeshPhysicalMaterial` translates well to the path tracer — custom `ShaderMaterial`s won't.
