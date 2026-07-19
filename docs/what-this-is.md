# pt-lab

A small lab for evaluating **photo-realistic, not-necessarily-realtime rendering in the browser** using [three.js](https://threejs.org) and [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer). The goal is to understand quality, convergence speed, and the integration surface before building this capability into a larger web app.

The demo loads a glTF model (Khronos Damaged Helmet) under an HDR environment (Poly Haven "Royal Esplanade") and renders it with a progressive GPU path tracer. A Svelte 5 control panel exposes bounces, render scale, sample cap, and environment intensity, plus a PNG export of the converged frame.

## How it works

`three-gpu-pathtracer` is a WebGL2 path tracer built on `three-mesh-bvh`:

1. When `setScene()` is called, it collects the scene's geometry, materials, textures, and lights, builds a **BVH acceleration structure**, and packs everything into GPU textures.
2. Each call to `renderSample()` runs one path-tracing pass in a full-screen fragment shader and **accumulates** it with previous passes. Image quality is a function of accumulated sample count — noise fades as samples grow.
3. Any camera/material/environment change resets accumulation to sample 0 (via `updateCamera()`, `updateMaterials()`, `updateEnvironment()`, or `reset()`).

This maps well onto "photo-realistic stills": let the tracer run for seconds-to-a-minute and export the converged frame.

## Project structure

| Path | Role |
|---|---|
| `src/lib/pathtracer.ts` | **The reusable core.** Framework-agnostic class wrapping renderer, scene, controls, and `WebGLPathTracer`. Talks to the host UI only through public methods and an `onStatus` callback. |
| `src/lib/PathTracerViewer.svelte` | Thin Svelte binding: mounts the class on a canvas, wires `ResizeObserver`, disposes on unmount. |
| `src/App.svelte` | Control panel + status readout (Svelte 5 runes). |
| `public/assets/` | Demo model + HDR, served statically. |

## Scenes

A Scene selector in the sidebar (backed by the `?scene=` query param; switching reloads the page) chooses the experiment:

| `?scene=` | Contents | Lighting |
|---|---|---|
| *(none)* | Damaged Helmet | HDR photo environment (Royal Esplanade) |
| `procedural` | clearcoat knot, chrome + glass spheres | HDR photo environment |
| `room` | 6×6×3 m room, table + red cube + gray ball | Room baked into a **generated** HDR env map; the light is a bright ceiling patch painted into it. Importance-sampled → converges fast, but direction-only: no parallax, and the light appears in the same direction from every point |
| `room-emissive` | same | Room as real geometry; the light is an **emissive mesh**. Physically correct falloff/parallax/occlusion, but very noisy — the path tracer does not importance-sample emissive meshes, so rays find the light only by chance |
| `room-arealight` | same | Room as real geometry; the light is a **`RectAreaLight`**, which the path tracer importance-samples → spatially correct *and* fast. Lights are invisible to rays in this pathtracer version, so the lamp's output is split 90/10 between the sampled light and a co-located emissive quad that makes the fixture visible |

The room trio is a deliberate ladder — baked environment vs. emissive geometry vs. sampled light — demonstrating why production scenes model nearby lights as sampled light objects and reserve the environment map for distant surroundings. In the room scenes the Environment slider scales the lamp instead of an env map. `window.__lab` exposes the `PathTracerLab` instance for console/automation driving.

## Integration notes for the larger web app

### Keep the renderer behind an abstraction

`src/lib/pathtracer.ts` is deliberately framework-agnostic — the Svelte layer is ~40 lines of glue. Two reasons to keep this boundary in the real app:

- **WebGPU is coming.** three.js's `WebGPURenderer`/TSL is the ecosystem's forward path, and WebGPU path tracers are emerging but not yet mature. Keeping the path tracer behind your own interface means you can swap the backend later without touching app code.
- **Version coupling.** `three-gpu-pathtracer` reaches into three.js internals (shaders, material properties). Pin your `three` version and re-test when upgrading. Current known-good pairing: `three@0.185` + `three-gpu-pathtracer@0.0.24` (which requires `three >= 0.180`).

### The hybrid rendering pattern

Production UX is **rasterize while interacting, path trace when idle**. `WebGLPathTracer` has this built in — the lab configures it like so:

```ts
pathTracer.rasterizeScene = true;   // draw a normal raster frame during the reset delay
pathTracer.renderDelay = 150;       // ms after a reset before path tracing resumes
pathTracer.dynamicLowRes = true;    // trace at low res first, then full res
pathTracer.fadeDuration = 300;      // fade the traced image in over the raster one
pathTracer.tiles.set(2, 2);         // render in tiles to keep the main thread responsive
```

The render loop then just calls `renderSample()` every frame and `updateCamera()` on camera change; the library handles the raster/trace crossfade. Tiling matters at full resolution — a single untiled sample on a large canvas can blow a frame budget and make the tab feel frozen.

### Scene updates are expensive

`setScene()` rebuilds the BVH and repacks all textures. That's fine for "configure scene → render", but not per-frame. In an app where users edit the scene:

- Material/uniform-level changes are cheap: `updateMaterials()` / `updateEnvironment()` keep the BVH.
- Geometry/topology changes require a rebuild. For large scenes, do it off the main thread: `pathTracer.setBVHWorker(new ParallelMeshBVHWorker())` (from `three-mesh-bvh/worker`) + `setSceneAsync()`. The lab uses the synchronous path because the helmet builds in well under a second.

### Convergence and denoising

Progressive accumulation means clean output takes hundreds of samples. Practical levers:

- **Sample cap + UI feedback**: expose `pathTracer.samples` (the lab shows samples + elapsed time). Users tolerate waiting when they can see progress.
- **`filterGlossyFactor`** (~0.5): blurs caustic-ish glossy paths slightly to kill fireflies at a small quality cost.
- **`renderScale`**: converge at 0.5× for previews, 1× for finals.
- **AI denoising (future)**: [oidn-web](https://github.com/pissang/oidn-web) runs Intel Open Image Denoise on WebGPU and can turn ~64 noisy samples into a clean image. It operates on the accumulated buffer as a post-pass — a natural fit behind the same abstraction.

### Other production caveats

- **Material coverage**: `MeshPhysicalMaterial` is the well-supported path (transmission, clearcoat, sheen, iridescence). Custom `ShaderMaterial`s won't translate — the path tracer has its own material model.
- **Bundle size**: three + pathtracer is ~875 kB minified (~233 kB gzip). In the larger app, lazy-load the whole rendering module (`import('./pathtracer')`) so it doesn't sit in the critical path.
- **Mobile / weak GPUs**: fragment-shader path tracing is heavy and some mobile GPUs hit precision/timeout issues. Feature-detect WebGL2 float-texture support and consider gating the feature or defaulting to raster on mobile.
- **Context loss**: long GPU-heavy sessions can lose the WebGL context (especially when tabbed away). Listen for `webglcontextlost`/`webglcontextrestored` on the canvas and rebuild.
- **Maintenance status**: `three-gpu-pathtracer` is stable and widely used, but development has slowed (0.0.24, Feb 2026). Treat it as a mature-but-quiet dependency: pin versions, keep the abstraction boundary, and watch the WebGPU ecosystem as the eventual successor.

## Running

```sh
npm install
npm run dev      # dev server
npm run build    # type-check happens via `npm run check`; build emits dist/
```

Orbit with the mouse; release and the image starts converging. "Save PNG" downloads the current frame.
