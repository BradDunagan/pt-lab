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
- `src/App.svelte` — control panel. Svelte 5 runes (`$state`/`$effect`/`$derived`); each control pushes into the lab via an `$effect`.

Assets (Damaged Helmet glTF, HDR environment) are served statically from `public/assets/` and loaded via `import.meta.env.BASE_URL`. If the model fails to load, `PathTracerLab` falls back to a procedural scene.

## Path-tracer behavior that shapes the code

- Rendering is **progressive accumulation**: `renderSample()` runs every frame and accumulates; image quality = sample count. Any camera/material/environment change must reset or update accumulation — that's why every setter in `PathTracerLab` calls `reset()`, `updateCamera()`, `updateMaterials()`, or `updateEnvironment()`.
- `setScene()` rebuilds the BVH and repacks all textures — expensive, done once at init, never per-frame. Material/environment tweaks use the cheap `update*()` calls that keep the BVH.
- The hybrid interaction pattern (rasterize while interacting, path trace when idle, crossfade) is built into `WebGLPathTracer` and configured in the `PathTracerLab` constructor (`rasterizeScene`, `renderDelay`, `dynamicLowRes`, `fadeDuration`, `tiles`). The render loop stays dumb: just `renderSample()` per frame.

## Version coupling

`three-gpu-pathtracer` reaches into three.js internals (shaders, material properties). The known-good pairing is `three@0.185` + `three-gpu-pathtracer@0.0.24`; don't bump `three` without re-testing rendering. Only `MeshPhysicalMaterial` translates well to the path tracer — custom `ShaderMaterial`s won't.
