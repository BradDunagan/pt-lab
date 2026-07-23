# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A lab for evaluating photo-realistic (not-necessarily-realtime) rendering in the browser with three.js + three-gpu-pathtracer, before building the capability into a larger web app. `docs/what-this-is.md` is the real project documentation — architecture rationale, production caveats, and integration notes live there (the root README.md is just Vite template boilerplate). Keep that doc in sync with meaningful changes.

## Commands

```sh
npm run dev      # Vite dev server
npm run build    # production build to dist/
npm run check    # type-check: svelte-check + tsc (build does NOT type-check)
npm run preview  # serve the built dist/
```

There are no tests or linters.

## Architecture

Three layers, with a deliberate framework boundary:

- `src/lib/pathtracer.ts` — **the reusable core**, and the piece intended to port into the larger app. `PathTracerLab` is a framework-agnostic class owning the `WebGLRenderer`, scene, `OrbitControls`, and `WebGLPathTracer`. The host UI talks to it only through public methods and the `onStatus` callback — never through three.js internals. Preserve this boundary: don't leak three.js types or objects into the Svelte layer (the boundary exists so the backend can be swapped for WebGPU later).
- `src/lib/PathTracerViewer.svelte` — thin glue: mounts the class on a canvas, wires `ResizeObserver`, disposes on unmount, exposes `lab` and `status` via `$bindable` props.
- `src/App.svelte` — control panel + Scene Editor UI. Svelte 5 runes (`$state`/`$effect`/`$derived`); each control pushes into the lab via an `$effect`. Inspector panels (`TransformPanel.svelte`, `MaterialPanel.svelte`) hold a local copy seeded once from the selection and are keyed by object id (`{#key selectedId}`) so switching selection remounts and re-seeds them.

Assets (Damaged Helmet glTF, HDR environment, denoiser `.tza` weights) are served statically from `public/assets/` and loaded via `import.meta.env.BASE_URL`. If the model fails to load, `PathTracerLab` falls back to a procedural scene.

### Scene Editor

`PathTracerLab` also hosts a data-driven Scene Editor (`docs/what-this-is.md` has the user-facing details). Load-bearing points:

- **Two render modes**: path-traced (`renderSample()`) vs. a fast raster edit mode (`renderer.render()` when `editing`). Object/room/material edits happen in edit mode against the raster view and mark the scene dirty; returning to render rebuilds/updates the tracer.
- **A scene is data** (`SceneData`: room + per-object state + camera). `buildEditorScene()` rebuilds the whole scene from scratch (floor + object library + room + state), which is why loading a saved scene works from any starting point. The room demos now route through this same path.
- **Two-tier persistence**: the object library (built-in factories + imported `.glb` templates) is global (`library-store.ts`); named scenes reference objects by key (`scenes.ts`). Both are localStorage (~5 MB origin quota) — imported `.glb` bytes (base64 in `library-store`) are the heavy tier and can exhaust it; a save that would overflow aborts the import with a "Storage full" message. Material props are exposed as artist terms (shininess = `1 − roughness`, reflectivity = `metalness`).
- Keep the framework boundary: the editor API is plain-data methods/callbacks (`listObjects`, `setObjectMaterial`, `serializeScene`, `applyScene`, `importGLB`, `onObjectsChanged`) — no three.js types cross into Svelte.

## Path-tracer behavior that shapes the code

- Rendering is **progressive accumulation**: `renderSample()` runs every frame and accumulates; image quality = sample count. Any camera/material/environment change must reset or update accumulation — that's why every setter in `PathTracerLab` calls `reset()`, `updateCamera()`, `updateMaterials()`, or `updateEnvironment()`.
- `setScene()` rebuilds the BVH and repacks all textures — expensive, done once at init, never per-frame. Material/environment tweaks use the cheap `update*()` calls that keep the BVH.
- The hybrid interaction pattern (rasterize while interacting, path trace when idle, crossfade) is built into `WebGLPathTracer` and configured in the `PathTracerLab` constructor (`rasterizeScene`, `renderDelay`, `dynamicLowRes`, `fadeDuration`, `tiles`). The render loop stays dumb: just `renderSample()` per frame.

## Version coupling

`three-gpu-pathtracer` reaches into three.js internals (shaders, material properties). The known-good pairing is `three@0.185` + `three-gpu-pathtracer@0.0.24`; don't bump `three` without re-testing rendering. Only `MeshPhysicalMaterial` translates well to the path tracer — custom `ShaderMaterial`s won't.
