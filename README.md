# pt-lab-workspace

Browser GPU path tracing + a data-driven scene editor, built on [three.js](https://threejs.org) and [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer), packaged as a consumable module.

> **Project documentation:** [docs/what-this-is.md](docs/what-this-is.md) — what this is, how the path tracer and scene editor work, and integration notes.

## Layout

This is an npm-workspaces monorepo:

| Path | Role |
|---|---|
| `packages/pt-lab/` | **The library** — the consumable module (`PathTracerLab` + Svelte components + scene/library persistence). |
| `packages/demo/` | A demo app that consumes `pt-lab` and provides the demo assets (model, HDR, denoiser weights). |

## Node version

The toolchain needs a recent Node: `vite@8` requires `^20.19.0 || >=22.12.0`, and `@sveltejs/vite-plugin-svelte@7` requires `^20.19 || ^22.12 || >=24`. Node 18 won't work. The repo pins **24.11.0** in `.nvmrc`, the same version `../paneless-workspace` pins.

With [nvm](https://github.com/nvm-sh/nvm), from the repo root:

```sh
nvm install   # installs the version in .nvmrc if you don't have it
nvm use       # switches to it
npm install   # reinstall so any native dependencies rebuild for the new Node
```

To change the pinned version, edit `.nvmrc`. It's a one-line text file holding the version number.

To make `nvm use` happen automatically when you `cd` into the repo, add nvm's `load-nvmrc` hook to your `~/.zshrc`. It's in the nvm README under [Deeper Shell Integration → zsh](https://github.com/nvm-sh/nvm#zsh).

## Develop

```sh
npm install        # once, at the root — sets up the workspaces
npm run dev        # demo dev server
npm run build      # build the demo app
npm run check      # type-check both packages
npm run pkg:build  # build the library publish artifact (packages/pt-lab/dist)
```

## Use as a module

`packages/pt-lab` is consumed the way [`rr`](../rr) consumes `paneless` — a local path dependency whose `package.json` exposes `./src/index.ts`, so the consumer's own Vite/Svelte compiles the source.

In the consuming app's `package.json`:

```json
{
  "dependencies": {
    "pt-lab": "../pt-lab-workspace/packages/pt-lab"
  }
}
```

Then:

```ts
import { PathTracerLab, PathTracerViewer } from 'pt-lab';

const lab = new PathTracerLab(canvas, {
  onStatus: (s) => { /* … */ },
  // Asset URLs default to `${BASE_URL}assets/…`; point them at your own:
  modelUrl: '/assets/my-model.glb',
  envUrl: '/assets/my-env.hdr',
  denoiserWeights: { ldr: '/assets/rt_ldr.tza', ldrAux: '/assets/rt_ldr_alb_nrm.tza' },
});
await lab.init();
```

The consumer must provide the model, HDR, and denoiser-weight files it points at (the demo keeps a working set in `packages/demo/public/assets/`). The bundled importable objects under `packages/pt-lab/src/assets/imports/` travel with the library automatically.
