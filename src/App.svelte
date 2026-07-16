<script lang="ts">
	import PathTracerViewer from './lib/PathTracerViewer.svelte';
	import { PathTracerLab, type LabStatus } from './lib/pathtracer';

	let lab = $state<PathTracerLab | null>(null);
	let status = $state<LabStatus>({ mode: 'loading', samples: 0, elapsedMs: 0 });

	let pathTracingEnabled = $state(true);
	let bounces = $state(5);
	let renderScale = $state(1);
	let maxSamples = $state(0);
	let envIntensity = $state(1);

	$effect(() => {
		lab?.setPathTracingEnabled(pathTracingEnabled);
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
</script>

<main>
	<PathTracerViewer bind:lab bind:status />

	<aside>
		<h1>pt-lab</h1>
		<p class="subtitle">three.js + three-gpu-pathtracer</p>

		<label class="toggle">
			<input type="checkbox" bind:checked={pathTracingEnabled} />
			Path tracing
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
			<input type="range" min="0" max="2048" step="64" bind:value={maxSamples} />
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
		</div>

		<p class="hint">
			Orbit to move the camera — accumulation restarts from sample 0 and the
			image progressively converges once the camera is still.
		</p>
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

	input[type='range'] {
		width: 100%;
		accent-color: #7c6cf4;
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
