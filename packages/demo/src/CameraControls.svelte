<script lang="ts">
	import type { PathTracerLab } from 'pt-lab';

	let {
		lab,
		position,
		target,
		fov,
	}: {
		lab: PathTracerLab | null;
		// Live values (updated every frame), so orbiting the viewport moves these.
		position: [number, number, number];
		target: [number, number, number];
		fov: number;
	} = $props();

	const AXES = ['X', 'Y', 'Z'] as const;
</script>

{#snippet vec(
	label: string,
	v: [number, number, number],
	apply: (x: number, y: number, z: number) => void,
)}
	<div class="block">
		<div class="block-label">{label}</div>
		<div class="row">
			{#each AXES as ax, i (ax)}
				<label class="axis">
					<span>{ax}</span>
					<input
						type="number"
						step="0.1"
						value={v[i].toFixed(2)}
						onchange={(e) => {
							const a: [number, number, number] = [...v];
							a[i] = +e.currentTarget.value;
							apply(a[0], a[1], a[2]);
						}}
					/>
				</label>
			{/each}
		</div>
	</div>
{/snippet}

<div class="camera">
	{@render vec('Position (m)', position, (x, y, z) => lab?.setCameraPosition(x, y, z))}
	{@render vec('Target (m)', target, (x, y, z) => lab?.setCameraTarget(x, y, z))}

	<label class="slider">
		<div class="block-label">FOV <span>{fov.toFixed(0)}°</span></div>
		<input
			type="range"
			min="20"
			max="100"
			step="1"
			value={fov}
			oninput={(e) => lab?.setCameraFov(+e.currentTarget.value)}
		/>
	</label>
</div>

<style>
	.camera {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		padding: 0.6rem 0.75rem;
	}

	.block-label {
		display: flex;
		justify-content: space-between;
		font-size: 0.75rem;
		color: #999;
		margin-bottom: 0.3rem;
	}

	.block-label span {
		color: #eee;
		font-variant-numeric: tabular-nums;
	}

	.row {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.3rem;
	}

	.axis {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.75rem;
		color: #888;
	}

	.axis span {
		width: 0.7rem;
	}

	.axis input {
		width: 100%;
		min-width: 0;
		padding: 0.25rem 0.3rem;
		border: 1px solid #3a3a45;
		border-radius: 4px;
		background: #1a1a22;
		color: #eee;
		font-size: 0.78rem;
		font-variant-numeric: tabular-nums;
	}

	.axis input:focus {
		outline: none;
		border-color: #7c6cf4;
	}

	.slider input[type='range'] {
		width: 100%;
		accent-color: #7c6cf4;
	}
</style>
