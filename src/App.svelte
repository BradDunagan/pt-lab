<script lang="ts">
	import PathTracerViewer from './lib/PathTracerViewer.svelte';
	import { PathTracerLab, type LabStatus } from './lib/pathtracer';

	let lab = $state<PathTracerLab | null>(null);
	let status = $state<LabStatus>({
		mode: 'loading',
		samples: 0,
		elapsedMs: 0,
		denoise: 'off',
		denoisedAt: 0,
		denoiseAux: true,
	});

	const SCENES = [
		{ value: 'helmet', label: 'Helmet — HDR photo env' },
		{ value: 'procedural', label: 'Primitives — HDR photo env' },
		{ value: 'room', label: 'Room — baked HDR env' },
		{ value: 'room-emissive', label: 'Room — emissive mesh' },
		{ value: 'room-arealight', label: 'Room — rect area light' },
	];
	const currentScene = new URLSearchParams(location.search).get('scene') ?? 'helmet';
	const currentSceneLabel = SCENES.find((s) => s.value === currentScene)?.label ?? currentScene;

	let editMode = $state(false);

	// Scene selection lives in the URL (?scene=...) so views are shareable;
	// switching reloads the page, which rebuilds the whole scene and BVH anyway.
	function changeScene(value: string) {
		const url = new URL(location.href);
		if (value === 'helmet') url.searchParams.delete('scene');
		else url.searchParams.set('scene', value);
		location.href = url.toString();
	}

	let pathTracingEnabled = $state(true);
	let denoiseEnabled = $state(false);
	let denoiseAuxEnabled = $state(true);
	let bounces = $state(5);
	let renderScale = $state(1);
	let envIntensity = $state(1);

	// Power-of-two stops: fine resolution at the low end (where denoising
	// experiments live), coarse at the high end. 0 = unlimited.
	const MAX_SAMPLES_STOPS = [0, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
	let maxSamplesIndex = $state(0);
	const maxSamples = $derived(MAX_SAMPLES_STOPS[maxSamplesIndex]);

	$effect(() => {
		lab?.setEditMode(editMode);
	});
	$effect(() => {
		lab?.setPathTracingEnabled(pathTracingEnabled);
	});
	$effect(() => {
		lab?.setDenoiseEnabled(denoiseEnabled);
	});
	$effect(() => {
		lab?.setDenoiseAuxEnabled(denoiseAuxEnabled);
	});
	$effect(() => {
		lab?.setBounces(bounces);
	});
	$effect(() => {
		lab?.setRenderScale(renderScale);
	});
	$effect(() => {
		lab?.setMaxSamples(maxSamples);
	});
	$effect(() => {
		lab?.setEnvironmentIntensity(envIntensity);
	});

	const elapsed = $derived((status.elapsedMs / 1000).toFixed(1));
	const converged = $derived(maxSamples > 0 && status.samples >= maxSamples);
	const rendering = $derived(status.mode === 'pathtracing' || status.mode === 'raster');
	const denoiseText = $derived(
		{
			off: '',
			unsupported: 'needs WebGPU',
			loading: 'loading model…',
			ready: 'waiting',
			denoising: 'running…',
			denoised: `@ ${status.denoisedAt} samples${status.denoiseAux ? ' · aux' : ''}`,
			error: 'failed (see console)',
		}[status.denoise],
	);
</script>

<main>
	<PathTracerViewer bind:lab bind:status />

	<aside>
		<h1>pt-lab</h1>
		<p class="subtitle">three.js + three-gpu-pathtracer</p>

		<button class="mode-toggle" onclick={() => (editMode = !editMode)}>
			{editMode ? '← Return to Render' : 'Edit Scene →'}
		</button>

		{#if editMode}
			<div class="editor">
				<div class="scene-name">{currentSceneLabel}</div>
				<p class="hint">
					Scene Editor — fast raster preview (no path tracing). Orbit to inspect.
					Object, material, and transform tools arrive in the next steps.
				</p>
			</div>
		{:else}
		<label>
			Scene
			<select value={currentScene} onchange={(e) => changeScene(e.currentTarget.value)}>
				{#each SCENES as s (s.value)}
					<option value={s.value}>{s.label}</option>
				{/each}
			</select>
		</label>

		<label class="toggle">
			<input type="checkbox" bind:checked={pathTracingEnabled} />
			Path tracing
		</label>

		<label class="toggle">
			<input type="checkbox" bind:checked={denoiseEnabled} />
			AI denoise
		</label>

		<label class="toggle sub">
			<input type="checkbox" bind:checked={denoiseAuxEnabled} disabled={!denoiseEnabled} />
			Albedo/normal aux
		</label>

		<label>
			Bounces <span>{bounces}</span>
			<input type="range" min="1" max="10" step="1" bind:value={bounces} />
		</label>

		<label>
			Render scale <span>{renderScale.toFixed(2)}</span>
			<input type="range" min="0.25" max="1" step="0.05" bind:value={renderScale} />
		</label>

		<label>
			Max samples <span>{maxSamples === 0 ? '∞' : maxSamples}</span>
			<input
				type="range"
				min="0"
				max={MAX_SAMPLES_STOPS.length - 1}
				step="1"
				bind:value={maxSamplesIndex}
			/>
		</label>

		<label>
			Environment <span>{envIntensity.toFixed(2)}</span>
			<input type="range" min="0" max="3" step="0.05" bind:value={envIntensity} />
		</label>

		<button onclick={() => lab?.savePNG()} disabled={!rendering}>Save PNG</button>

		<div class="status">
			<div><span class="key">Mode</span><span>{status.mode}{converged ? ' · converged' : ''}</span></div>
			<div><span class="key">Samples</span><span>{status.samples}</span></div>
			<div><span class="key">Elapsed</span><span>{elapsed}s</span></div>
			{#if status.denoise !== 'off'}
				<div><span class="key">Denoise</span><span>{denoiseText}</span></div>
			{/if}
		</div>

		<p class="hint">
			Orbit to move the camera — accumulation restarts from sample 0 and the
			image progressively converges once the camera is still.
		</p>
		{/if}
	</aside>
</main>

<style>
	main {
		display: flex;
		width: 100vw;
		height: 100vh;
	}

	aside {
		width: 250px;
		flex-shrink: 0;
		padding: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		background: #16161c;
		border-left: 1px solid #2a2a33;
		overflow-y: auto;
	}

	h1 {
		margin: 0;
		font-size: 1.2rem;
		color: #f0f0f4;
	}

	.subtitle {
		margin: -0.85rem 0 0;
		font-size: 0.8rem;
		color: #888;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.85rem;
		color: #bbb;
	}

	label:not(.toggle) {
		position: relative;
	}

	label:not(.toggle) span {
		position: absolute;
		right: 0;
		color: #eee;
		font-variant-numeric: tabular-nums;
	}

	.toggle {
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
		color: #eee;
		font-weight: 500;
	}

	.toggle.sub {
		margin: -0.6rem 0 0 1.4rem;
		font-weight: 400;
		font-size: 0.8rem;
		color: #bbb;
	}

	.toggle.sub:has(input:disabled) {
		opacity: 0.4;
	}

	input[type='range'] {
		width: 100%;
		accent-color: #7c6cf4;
	}

	select {
		padding: 0.4rem;
		border: 1px solid #3a3a45;
		border-radius: 6px;
		background: #22222b;
		color: #eee;
		font-size: 0.85rem;
	}

	input[type='checkbox'] {
		accent-color: #7c6cf4;
	}

	button {
		padding: 0.5rem;
		border: 1px solid #3a3a45;
		border-radius: 6px;
		background: #22222b;
		color: #eee;
		cursor: pointer;
		font-size: 0.85rem;
	}

	button:hover:not(:disabled) {
		background: #2c2c37;
	}

	.mode-toggle {
		background: #2a2440;
		border-color: #4a3f7a;
		font-weight: 600;
		color: #d9d2ff;
	}

	.mode-toggle:hover:not(:disabled) {
		background: #332b52;
	}

	.editor {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.scene-name {
		padding: 0.5rem 0.75rem;
		border-radius: 6px;
		background: #101016;
		color: #f0f0f4;
		font-weight: 600;
		font-size: 0.9rem;
	}

	button:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.status {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.75rem;
		border-radius: 6px;
		background: #101016;
		font-size: 0.85rem;
		color: #eee;
		font-variant-numeric: tabular-nums;
	}

	.status div {
		display: flex;
		justify-content: space-between;
	}

	.status .key {
		color: #888;
	}

	.hint {
		margin: 0;
		font-size: 0.75rem;
		color: #777;
		line-height: 1.45;
	}
</style>
