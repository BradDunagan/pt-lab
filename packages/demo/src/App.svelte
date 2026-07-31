<script lang="ts">
	import {
		PathTracerViewer,
		TransformPanel,
		MaterialPanel,
		BundleTree,
		PathTracerLab,
		bundledTree,
		bundledIsEmpty,
		listSceneNames,
		loadSceneData,
		saveSceneData,
		deleteSceneData,
		newSceneData,
		type BundleFile,
		type LabStatus,
		type LabObject,
		type RoomKind,
	} from 'pt-lab';

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

	// Dropdown value: a demo id, 'saved:<name>', or 'unsaved' (a New scene not
	// yet saved). The scene name shown in both modes derives from it.
	let sceneValue = $state<string>(currentScene);
	let savedScenes = $state<string[]>(listSceneNames());
	const currentSceneName = $derived.by(() => {
		if (sceneValue === 'unsaved') return 'Untitled (unsaved)';
		if (sceneValue.startsWith('saved:')) return sceneValue.slice(6);
		return SCENES.find((s) => s.value === sceneValue)?.label ?? sceneValue;
	});

	function loadSavedScene(name: string) {
		const data = loadSceneData(name);
		if (!data || !lab) return;
		lab.applyScene(data);
		roomKind = data.room;
		selectedId = null;
		sceneValue = `saved:${name}`;
	}

	function onSceneChange(value: string) {
		if (value.startsWith('saved:')) loadSavedScene(value.slice(6));
		else changeScene(value); // a demo → page reload (as before)
	}

	function newScene() {
		if (!lab) return;
		const data = newSceneData();
		lab.applyScene(data);
		roomKind = data.room;
		selectedId = null;
		sceneValue = 'unsaved';
	}

	function saveScene() {
		if (!lab) return;
		const suggested = sceneValue.startsWith('saved:') ? sceneValue.slice(6) : '';
		const name = prompt('Save scene as:', suggested)?.trim();
		if (!name) return;
		saveSceneData(name, lab.serializeScene());
		savedScenes = listSceneNames();
		sceneValue = `saved:${name}`;
	}

	function deleteScene() {
		if (!sceneValue.startsWith('saved:')) return;
		const name = sceneValue.slice(6);
		if (!confirm(`Delete scene "${name}"?`)) return;
		deleteSceneData(name);
		savedScenes = listSceneNames();
		newScene();
	}

	let editMode = $state(false);
	let objects = $state<LabObject[]>([]);
	let selectedId = $state<string | null>(null);
	let importError = $state('');
	let fileInput = $state<HTMLInputElement>();

	async function onImportFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file || !lab) return;
		importError = '';
		try {
			await lab.importGLB(await file.arrayBuffer(), file.name);
		} catch (err) {
			importError =
				err instanceof DOMException && err.name === 'QuotaExceededError'
					? 'Storage full — delete some scenes or objects.'
					: 'Import failed — is it a valid .glb?';
		}
		input.value = '';
	}

	function removeObject(id: string) {
		if (selectedId === id) selectedId = null;
		lab?.removeLibraryObject(id);
	}

	// Names already in the current library, so the browser can mark them.
	const importedNames = $derived(new Set(objects.map((o) => o.name)));

	async function importBundled(file: BundleFile) {
		if (!lab || importedNames.has(file.name)) return;
		importError = '';
		try {
			const res = await fetch(file.url);
			if (!res.ok) throw new Error(`fetch ${res.status}`);
			await lab.importGLB(await res.arrayBuffer(), file.name);
		} catch (err) {
			importError =
				err instanceof DOMException && err.name === 'QuotaExceededError'
					? 'Storage full — delete some scenes or objects.'
					: `Couldn't import ${file.name}.`;
		}
	}

	const ROOM_OPTIONS: { value: RoomKind; label: string }[] = [
		{ value: 'room', label: 'Baked HDR env' },
		{ value: 'room-emissive', label: 'Emissive mesh' },
		{ value: 'room-arealight', label: 'Rect area light' },
	];
	const ROOM_VALUES = ROOM_OPTIONS.map((r) => r.value) as string[];
	let roomKind = $state<RoomKind>(
		ROOM_VALUES.includes(currentScene) ? (currentScene as RoomKind) : 'room-arealight',
	);

	$effect(() => {
		// No-ops until the lab is ready and only when the room actually changes.
		lab?.setRoom(roomKind);
	});

	$effect(() => {
		if (!lab) return;
		lab.setOnObjectsChanged((list) => (objects = list));
		objects = lab.listObjects();
	});

	const selectedName = $derived(objects.find((o) => o.id === selectedId)?.name ?? '');
	// Recomputes only when the selection (or lab) changes — exactly when the
	// TransformPanel should re-seed. Edits after that flow one-way to the lab.
	const selectedTransform = $derived(
		selectedId && lab ? lab.getObjectTransform(selectedId) : null,
	);
	const selectedMaterial = $derived(
		selectedId && lab ? lab.getObjectMaterial(selectedId) : null,
	);

	// Resizable sidebar. Width is driven inline; the viewer's ResizeObserver
	// keeps the canvas in sync as the sidebar grows/shrinks.
	const SIDEBAR_MIN = 200;
	const SIDEBAR_MAX = 720;
	let sidebarWidth = $state(250);

	function startResize(e: PointerEvent) {
		e.preventDefault();
		const handle = e.currentTarget as HTMLElement;
		handle.setPointerCapture(e.pointerId);
		document.body.style.userSelect = 'none';
		document.body.style.cursor = 'ew-resize';
		const onMove = (ev: PointerEvent) => {
			// Sidebar is anchored to the right edge, so width grows as the
			// pointer moves left.
			const w = window.innerWidth - ev.clientX;
			sidebarWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w));
		};
		const onUp = () => {
			handle.releasePointerCapture(e.pointerId);
			handle.removeEventListener('pointermove', onMove);
			handle.removeEventListener('pointerup', onUp);
			document.body.style.userSelect = '';
			document.body.style.cursor = '';
		};
		handle.addEventListener('pointermove', onMove);
		handle.addEventListener('pointerup', onUp);
	}

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

	const EXPORT_SIZES = [64, 128, 256, 512, 1024];
	let exportSize = $state(512);
	let exporting = $state(false);
	let exportProgress = $state(0);

	async function savePNG() {
		if (!lab) return;
		exporting = true;
		exportProgress = 0;
		try {
			await lab.exportPNG(exportSize, 'pt-lab.png', (f) => (exportProgress = f));
		} finally {
			exporting = false;
		}
	}

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

	<div
		class="resize-handle"
		role="separator"
		aria-orientation="vertical"
		onpointerdown={startResize}
	></div>

	<aside style="width: {sidebarWidth}px">
		<h1>pt-lab</h1>
		<p class="subtitle">three.js + three-gpu-pathtracer</p>

		<button class="mode-toggle" onclick={() => (editMode = !editMode)}>
			{editMode ? '← Return to Render' : 'Edit Scene →'}
		</button>

		{#if editMode}
			<div class="editor">
				<button class="editor-btn wide" onclick={newScene}>New Scene</button>
				<div class="scene-name">{currentSceneName}</div>

				<label>
					Room
					<select value={roomKind} onchange={(e) => (roomKind = e.currentTarget.value as RoomKind)}>
						{#each ROOM_OPTIONS as r (r.value)}
							<option value={r.value}>{r.label}</option>
						{/each}
					</select>
				</label>

				<details class="group" open>
					<summary>Objects</summary>
					{#if objects.length}
						<ul class="object-list">
							{#each objects as obj (obj.id)}
								<li class="obj-row" class:selected={obj.id === selectedId}>
									<input
										type="checkbox"
										checked={obj.included}
										onchange={(e) => lab?.setObjectIncluded(obj.id, e.currentTarget.checked)}
									/>
									<button class="obj-name" onclick={() => (selectedId = obj.id)}>
										{obj.name}
									</button>
									{#if obj.removable}
										<button
											class="obj-remove"
											title="Remove from library"
											onclick={() => removeObject(obj.id)}
										>
											×
										</button>
									{/if}
								</li>
							{/each}
						</ul>
					{:else}
						<p class="hint pad">No objects yet — import one below.</p>
					{/if}
					<div class="obj-import">
						<button class="editor-btn" onclick={() => fileInput?.click()}>Import .glb…</button>
						{#if importError}<p class="hint error">{importError}</p>{/if}
					</div>
				</details>
				<input
					type="file"
					accept=".glb,.gltf"
					bind:this={fileInput}
					onchange={onImportFile}
					hidden
				/>

				{#if !bundledIsEmpty}
					<details class="group">
						<summary>Bundled objects</summary>
						<div class="bundle-tree">
							<BundleTree node={bundledTree} {importedNames} onimport={importBundled} />
						</div>
					</details>
				{/if}

				{#if selectedId && selectedMaterial}
					<details class="group" open>
						<summary>Material — {selectedName}</summary>
						{#key selectedId}
							<MaterialPanel
								material={selectedMaterial}
								onchange={(m) => selectedId && lab?.setObjectMaterial(selectedId, m)}
							/>
						{/key}
					</details>
				{/if}

				{#if selectedId && selectedTransform}
					<details class="group" open>
						<summary>Transform — {selectedName}</summary>
						{#key selectedId}
							<TransformPanel
								transform={selectedTransform}
								onchange={(t) => selectedId && lab?.setObjectTransform(selectedId, t)}
							/>
						{/key}
					</details>
				{/if}

				<div class="editor-actions">
					<button class="editor-btn" onclick={saveScene}>Save…</button>
					<button
						class="editor-btn"
						onclick={deleteScene}
						disabled={!sceneValue.startsWith('saved:')}
					>
						Delete
					</button>
				</div>

				<p class="hint">
					Fast raster preview (no path tracing). Click a name to select, then edit
					its material and transform. New starts an empty room; Save names the scene.
				</p>
			</div>
		{:else}
		<label>
			Scene
			<select value={sceneValue} onchange={(e) => onSceneChange(e.currentTarget.value)}>
				{#if sceneValue === 'unsaved'}
					<option value="unsaved">{currentSceneName}</option>
				{/if}
				<optgroup label="Demos">
					{#each SCENES as s (s.value)}
						<option value={s.value}>{s.label}</option>
					{/each}
				</optgroup>
				{#if savedScenes.length}
					<optgroup label="Saved scenes">
						{#each savedScenes as name (name)}
							<option value={`saved:${name}`}>{name}</option>
						{/each}
					</optgroup>
				{/if}
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

		<label>
			Export size
			<select bind:value={exportSize} disabled={exporting}>
				{#each EXPORT_SIZES as s (s)}
					<option value={s}>{s} × {s}</option>
				{/each}
			</select>
		</label>

		<button onclick={savePNG} disabled={!rendering || exporting}>
			{exporting ? `Rendering… ${Math.round(exportProgress * 100)}%` : 'Save PNG'}
		</button>

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
		flex-shrink: 0;
		padding: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		background: #16161c;
		border-left: 1px solid #2a2a33;
		overflow-y: auto;
	}

	.resize-handle {
		flex: 0 0 5px;
		cursor: ew-resize;
		background: #101016;
		transition: background 0.15s;
	}

	.resize-handle:hover {
		background: #7c6cf4;
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

	.editor-btn {
		padding: 0.5rem;
		border: 1px solid #3a3a45;
		border-radius: 6px;
		background: #22222b;
		color: #eee;
		cursor: pointer;
		font-size: 0.85rem;
	}

	.editor-btn:hover:not(:disabled) {
		background: #2c2c37;
	}

	.editor-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.editor-actions {
		display: flex;
		gap: 0.5rem;
	}

	.editor-actions .editor-btn {
		flex: 1;
	}

	.scene-name {
		padding: 0.5rem 0.75rem;
		border-radius: 6px;
		background: #101016;
		color: #f0f0f4;
		font-weight: 600;
		font-size: 0.9rem;
	}

	.group {
		border: 1px solid #2a2a33;
		border-radius: 6px;
		background: #101016;
	}

	.group > summary {
		padding: 0.5rem 0.75rem;
		cursor: pointer;
		font-size: 0.72rem;
		font-weight: 600;
		color: #aaa;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		user-select: none;
	}

	.group[open] > summary {
		border-bottom: 1px solid #2a2a33;
	}

	.object-list {
		list-style: none;
		margin: 0;
		padding: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.obj-row {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0.35rem;
		border-radius: 4px;
	}

	.obj-row.selected {
		background: #2a2440;
	}

	.obj-name {
		flex: 1;
		text-align: left;
		padding: 0.1rem 0.2rem;
		border: none;
		background: none;
		color: #ddd;
		font-size: 0.85rem;
		cursor: pointer;
	}

	.obj-row.selected .obj-name {
		color: #f0f0f4;
		font-weight: 600;
	}

	.obj-name:hover {
		color: #fff;
		background: none;
	}

	.obj-row .obj-remove {
		padding: 0 0.3rem;
		border: none;
		background: none;
		color: #888;
		font-size: 1.1rem;
		line-height: 1;
		cursor: pointer;
	}

	.obj-row .obj-remove:hover {
		color: #e77;
		background: none;
	}

	.obj-import {
		padding: 0.5rem 0.75rem;
		border-top: 1px solid #2a2a33;
	}

	.bundle-tree {
		padding: 0.4rem 0.6rem 0.6rem;
		max-height: 40vh;
		overflow-y: auto;
	}

	.obj-import .editor-btn {
		width: 100%;
	}

	.hint.pad {
		padding: 0.6rem 0.75rem;
	}

	.hint.error {
		color: #e88;
		padding-top: 0.5rem;
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
