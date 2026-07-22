import {
	ACESFilmicToneMapping,
	Box3,
	BoxGeometry,
	CircleGeometry,
	Color,
	DataTexture,
	EquirectangularReflectionMapping,
	FloatType,
	Group,
	LinearFilter,
	LinearSRGBColorSpace,
	Mesh,
	MeshBasicMaterial,
	MeshNormalMaterial,
	MeshPhysicalMaterial,
	MeshStandardMaterial,
	NoToneMapping,
	PerspectiveCamera,
	PlaneGeometry,
	RGBAFormat,
	Scene,
	SphereGeometry,
	SRGBColorSpace,
	TorusKnotGeometry,
	Vector2,
	Vector3,
	WebGLRenderer,
	WebGLRenderTarget,
	type Material,
	type Object3D,
	type Texture,
} from 'three';
import { RectAreaLight } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import type { UNet } from 'oidn-web';
import {
	listImports,
	saveImport,
	deleteImport,
	arrayBufferToBase64,
	base64ToArrayBuffer,
} from './library-store';

export type RenderMode = 'loading' | 'building-bvh' | 'raster' | 'pathtracing' | 'editing';

export type DenoiseState =
	| 'off'
	| 'unsupported'
	| 'loading'
	| 'ready'
	| 'denoising'
	| 'denoised'
	| 'error';

export interface LabStatus {
	mode: RenderMode;
	samples: number;
	elapsedMs: number;
	denoise: DenoiseState;
	/** Sample count the visible denoised image was computed from (0 = none). */
	denoisedAt: number;
	/** Whether denoising currently uses albedo/normal auxiliary buffers. */
	denoiseAux: boolean;
}

export interface LabOptions {
	onStatus?: (status: LabStatus) => void;
	/** Overlay canvas the denoised image is drawn onto (shown via opacity). */
	denoiseCanvas?: HTMLCanvasElement;
}

/** An editor-addressable object in the scene (plain data — no three.js types). */
export interface LabObject {
	id: string;
	name: string;
	/** Whether the object is part of the scene (unchecked = hidden). */
	included: boolean;
	/** Imported objects can be removed from the library; built-ins cannot. */
	removable: boolean;
}

/** An entry in the object library (a built-in primitive or an imported model). */
interface LibraryItem {
	key: string;
	name: string;
	kind: 'builtin' | 'imported';
}

const BUILTIN_LIBRARY: LibraryItem[] = [
	{ key: 'Table', name: 'Table', kind: 'builtin' },
	{ key: 'Cube', name: 'Cube', kind: 'builtin' },
	{ key: 'Ball', name: 'Ball', kind: 'builtin' },
];

/** An object's transform, in editor-friendly units (meters, degrees, factor). */
export interface LabTransform {
	position: [number, number, number];
	rotation: [number, number, number];
	scale: [number, number, number];
}

/**
 * An object's appearance in editor-friendly terms. These map onto PBR
 * material properties: shininess = 1 - roughness, reflectivity = metalness.
 */
export interface LabMaterial {
	color: string; // '#rrggbb' (sRGB)
	shininess: number; // 0 (matte) .. 1 (mirror-sharp)
	reflectivity: number; // 0 (dielectric) .. 1 (metal)
}

/** One object's persisted state within a scene. */
export interface SceneObjectState {
	key: string; // stable library key (the object's name for built-ins)
	included: boolean;
	// Absent means "use the object's factory default" (how demos include
	// built-ins without duplicating their default look/placement).
	material?: LabMaterial;
	transform?: LabTransform;
}

/** A saved editor scene: room + per-object state + camera. */
export interface SceneData {
	version: 1;
	room: RoomKind;
	objects: SceneObjectState[];
	camera: { position: [number, number, number]; target: [number, number, number] } | null;
}

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

const MODEL_URL = `${import.meta.env.BASE_URL}assets/damaged-helmet.glb`;
const ENV_URL = `${import.meta.env.BASE_URL}assets/royal_esplanade_1k.hdr`;

// Samples a fixed-size PNG export converges to before it's written. Small
// export sizes reach this quickly; 1024² takes a few seconds (progress shown).
const EXPORT_SAMPLES = 300;

/** ?scene=procedural | room | room-emissive | room-arealight forces an alternate scene instead of the helmet. */
function sceneParam(): string | null {
	return new URLSearchParams(location.search).get('scene');
}

/** Dispose every geometry and material under an object before discarding it. */
function disposeObject(obj: Object3D) {
	obj.traverse((child) => {
		const mesh = child as Mesh;
		if (!mesh.isMesh) return;
		mesh.geometry?.dispose();
		const mat = mesh.material;
		if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
		else mat?.dispose();
	});
}

export type RoomKind = 'room' | 'room-emissive' | 'room-arealight';
const ROOM_KINDS = ['room', 'room-emissive', 'room-arealight'];

/** A built-in room demo expressed as editor-scene data (room + the 3 built-ins). */
function demoRoomData(room: RoomKind): SceneData {
	return {
		version: 1,
		room,
		objects: [
			{ key: 'Table', included: true },
			{ key: 'Cube', included: true },
			{ key: 'Ball', included: true },
		],
		camera: { position: [2.2, 1.3, 2.6], target: [0, 0.7, 0] },
	};
}

// Room scene: a 6 x 6 m room with a 3 m ceiling, lit by a bright ceiling
// patch. Three variants: 'room' bakes the room into a generated HDR
// environment map (walls/floor/ceiling are flat "painted" radiances);
// 'room-emissive' models the room as real geometry with an emissive mesh as
// the light (physically correct, but the path tracer only finds emissive
// meshes by chance — noisy); 'room-arealight' uses a RectAreaLight instead,
// which the path tracer importance-samples — correct and fast.
const ROOM_HALF = 3;
const ROOM_CEIL = 3;
const ROOM_EYE = new Vector3(0, 1.5, 0);
const PATCH_HALF_X = 0.25; // 0.5 m wide
const PATCH_HALF_Z = 0.5; // 1 m long
const PATCH_RADIANCE = 40;
// In the arealight room, the lamp's output is split: this fraction is emitted
// by a visible emissive quad (the "fixture"), the rest by a RectAreaLight.
// The pathtracer never intersects lights with rays (LIGHT_HIT is defined but
// unused in its shader), so without the quad the lamp would be invisible; a
// small fraction keeps the fixture bright to the eye while nearly all the
// light transport stays on the importance-sampled path.
const FIXTURE_FRACTION = 0.1;

/**
 * Framework-agnostic wrapper around WebGLPathTracer. This class is the piece
 * intended to port into a larger app: the host UI only talks to its public
 * methods and the onStatus callback, never to three.js internals.
 */
export class PathTracerLab {
	private renderer: WebGLRenderer;
	private scene = new Scene();
	private camera: PerspectiveCamera;
	private controls: OrbitControls;
	private pathTracer: WebGLPathTracer;
	private onStatus?: (status: LabStatus) => void;

	private rafId = 0;
	private maxSamples = 0; // 0 = unlimited
	private lastResetAt = performance.now();
	private lastSamples = 0;
	private ready = false;
	private disposed = false;
	private editing = false;
	private exporting = false;
	private patchMat: MeshPhysicalMaterial | null = null;
	private rectLight: RectAreaLight | null = null;
	// Current room and its swappable pieces (shell geometry or baked env map).
	private roomKind: RoomKind | null = null;
	private roomShell: Object3D | null = null;
	private roomEnvTex: DataTexture | null = null;
	private envIntensity = 1;

	// Editor object registry. Keyed by a stable per-session id (decoupled from
	// the display name so imported duplicates never collide).
	private objects = new Map<
		string,
		{ object3d: Object3D; name: string; key: string; included: boolean }
	>();
	private objectCounter = 0;
	private objectsChanged?: (objects: LabObject[]) => void;

	// The object library: built-in primitives plus imported models. Imports are
	// parsed once into a template Object3D that scenes clone.
	private library: LibraryItem[] = [...BUILTIN_LIBRARY];
	private importTemplates = new Map<string, Object3D>();
	private importCounter = 0;
	// Set when the included-set or a transform changed while editing, so
	// returning to render rebuilds the BVH (drops hidden meshes via
	// traverseVisible; refits for moved geometry).
	private objectsDirty = false;
	// Set when only materials changed — a cheaper updateMaterials() on return.
	private materialsDirty = false;
	// True while buildEditorScene rebuilds; suppresses tracer syncs against the
	// half-built scene (setScene refreshes everything once the build finishes).
	private buildingScene = false;

	private denoiseCanvas?: HTMLCanvasElement;
	private captureCanvas = document.createElement('canvas');
	private denoiseEnabled = false;
	private denoiseState: DenoiseState = 'off';
	private denoiseBusy = false;
	private denoisedAtSamples = 0;
	private abortDenoise: (() => void) | null = null;

	// Two UNets: one trained on color only, one on color + albedo/normal aux
	// buffers. They are mutually incompatible (an aux net requires the aux
	// inputs, a plain net rejects them), so both are kept and loaded lazily.
	private unetPlain: UNet | null = null;
	private unetAux: UNet | null = null;
	private unetPromises: { plain: Promise<UNet> | null; aux: Promise<UNet> | null } = {
		plain: null,
		aux: null,
	};
	private auxEnabled = true;
	private auxAvailable = true;
	private auxCache: { albedo: ImageData; normal: ImageData } | null = null;
	private normalMaterial = new MeshNormalMaterial();
	private basicMirrors = new WeakMap<Material, MeshBasicMaterial>();

	constructor(canvas: HTMLCanvasElement, options: LabOptions = {}) {
		this.onStatus = options.onStatus;
		this.denoiseCanvas = options.denoiseCanvas;

		this.renderer = new WebGLRenderer({ canvas, antialias: true });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.renderer.toneMapping = ACESFilmicToneMapping;

		this.camera = new PerspectiveCamera(50, 1, 0.05, 100);
		this.camera.position.set(2.2, 1.3, 2.6);

		this.controls = new OrbitControls(this.camera, canvas);
		this.controls.addEventListener('change', () => {
			if (this.ready) this.pathTracer.updateCamera();
		});

		this.pathTracer = new WebGLPathTracer(this.renderer);
		this.pathTracer.bounces = 5;
		this.pathTracer.filterGlossyFactor = 0.5;
		// Hybrid interaction pattern: rasterize during the delay after any
		// reset, path trace at low res while converging, then fade in.
		this.pathTracer.rasterizeScene = true;
		this.pathTracer.renderDelay = 150;
		this.pathTracer.fadeDuration = 300;
		this.pathTracer.minSamples = 1;
		this.pathTracer.dynamicLowRes = true;
		this.pathTracer.lowResScale = 0.35;
		this.pathTracer.tiles.set(2, 2);
	}

	async init(): Promise<void> {
		this.emit('loading');

		const kind = sceneParam();
		const isRoom = ROOM_KINDS.includes(kind ?? '');

		// Parse persisted imports into templates before building anything.
		await this.loadImports();
		if (this.disposed) return;

		if (isRoom) {
			// A room demo is just a pre-populated editor scene.
			this.buildEditorScene(demoRoomData(kind as RoomKind));
		} else {
			const [hdrEnv, model] = await Promise.all([
				new HDRLoader().loadAsync(ENV_URL),
				this.loadModel(),
			]);
			if (this.disposed) return;
			hdrEnv.mapping = EquirectangularReflectionMapping;
			this.scene.environment = hdrEnv;
			this.scene.background = hdrEnv;
			this.scene.add(model);

			const bounds = new Box3().setFromObject(model);
			const size = bounds.getSize(new Vector3());
			this.controls.target.set(0, size.y / 2, 0);
			this.controls.update();

			const floor = new Mesh(
				new CircleGeometry(Math.max(size.x, size.z) * 3, 64).rotateX(-Math.PI / 2),
				new MeshPhysicalMaterial({ color: 0xdedede, roughness: 0.85 }),
			);
			this.scene.add(floor);
		}

		this.emit('building-bvh');
		// Yield a frame so the status paints before the synchronous BVH build.
		await new Promise(requestAnimationFrame);
		if (this.disposed) return;

		this.pathTracer.setScene(this.scene, this.camera);
		this.ready = true;
		this.lastResetAt = performance.now();
		this.emitObjects();
		this.loop();
	}

	private async loadModel(): Promise<Object3D> {
		if (sceneParam() === 'procedural') return this.makeProceduralScene();
		try {
			const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
			const model = gltf.scene;
			// Center on origin, resting on the floor plane.
			const bounds = new Box3().setFromObject(model);
			const center = bounds.getCenter(new Vector3());
			model.position.set(-center.x, -bounds.min.y, -center.z);
			return model;
		} catch (err) {
			console.warn('Model load failed, using procedural scene:', err);
			return this.makeProceduralScene();
		}
	}

	private makeProceduralScene(): Object3D {
		const group = new Group();

		const knot = new Mesh(
			new TorusKnotGeometry(0.35, 0.12, 220, 40),
			new MeshPhysicalMaterial({ color: 0xb01030, roughness: 0.25, clearcoat: 1 }),
		);
		knot.position.set(0, 0.55, 0);

		const metal = new Mesh(
			new SphereGeometry(0.35, 64, 32),
			new MeshPhysicalMaterial({ color: 0xe8e8e8, metalness: 1, roughness: 0.05 }),
		);
		metal.position.set(-1, 0.35, 0.3);

		const glass = new Mesh(
			new SphereGeometry(0.35, 64, 32),
			new MeshPhysicalMaterial({
				transmission: 1,
				roughness: 0,
				ior: 1.5,
				thickness: 0.7,
			}),
		);
		glass.position.set(1, 0.35, 0.3);

		group.add(knot, metal, glass);
		return group;
	}

	/** 2 x 1 m table: top + four legs grouped so they move as one. */
	private makeTable(): Object3D {
		const mat = new MeshPhysicalMaterial({ color: 0x8a6a48, roughness: 0.6 });
		const table = new Group();
		const top = new Mesh(new BoxGeometry(2, 0.05, 1), mat);
		top.position.y = 0.725;
		table.add(top);
		for (const [x, z] of [[-0.9, -0.4], [0.9, -0.4], [-0.9, 0.4], [0.9, 0.4]]) {
			const leg = new Mesh(new BoxGeometry(0.06, 0.7, 0.06), mat);
			leg.position.set(x, 0.35, z);
			table.add(leg);
		}
		return table;
	}

	private makeCube(): Object3D {
		const cube = new Mesh(
			new BoxGeometry(0.1, 0.1, 0.1),
			new MeshPhysicalMaterial({ color: 0xb01818, roughness: 0.4 }),
		);
		cube.position.set(-0.3, 0.8, 0);
		return cube;
	}

	private makeBall(): Object3D {
		const ball = new Mesh(
			new SphereGeometry(0.05, 48, 24),
			new MeshPhysicalMaterial({ color: 0xc8c8c8, roughness: 0.3 }),
		);
		ball.position.set(0.25, 0.8, 0.12);
		return ball;
	}

	private builtinFactory(key: string): (() => Object3D) | null {
		switch (key) {
			case 'Table':
				return () => this.makeTable();
			case 'Cube':
				return () => this.makeCube();
			case 'Ball':
				return () => this.makeBall();
			default:
				return null;
		}
	}

	/** Instantiate every library object into the scene, hidden by default. */
	private instantiateLibrary() {
		for (const item of this.library) {
			let obj: Object3D | null = null;
			if (item.kind === 'builtin') {
				obj = this.builtinFactory(item.key)?.() ?? null;
			} else {
				const tmpl = this.importTemplates.get(item.key);
				if (tmpl) obj = this.cloneWithMaterials(tmpl);
			}
			if (!obj) continue;
			obj.visible = false;
			this.registerObject(obj, item.name, item.key);
			this.scene.add(obj);
		}
	}

	/** Clone an object with its own material copies (per-scene edits stay local). */
	private cloneWithMaterials(source: Object3D): Object3D {
		const obj = source.clone();
		obj.traverse((child) => {
			const mesh = child as Mesh;
			if (!mesh.isMesh || !mesh.material) return;
			mesh.material = Array.isArray(mesh.material)
				? mesh.material.map((m) => m.clone())
				: mesh.material.clone();
		});
		return obj;
	}

	/**
	 * The room as real geometry: four walls + ceiling facing inward, and a
	 * ceiling patch just below the ceiling as the only light source — either
	 * an emissive mesh (found only by chance rays → noisy) or a RectAreaLight
	 * (importance-sampled by the path tracer → converges fast, but invisible
	 * to rays, so a dim emissive quad marks the fixture; see FIXTURE_FRACTION).
	 * The floor is added separately in init() (shared with the 'room' variant).
	 * Wall/ceiling colors are the sRGB equivalents of the radiances painted
	 * into the generated environment map, for a like-for-like comparison.
	 */
	private makeRoomShell(useAreaLight: boolean): Object3D {
		const group = new Group();
		const wallMat = new MeshPhysicalMaterial({ color: 0xa0a0a0, roughness: 0.9 });

		const wall = (x: number, z: number, rotY: number) => {
			const mesh = new Mesh(new PlaneGeometry(ROOM_HALF * 2, ROOM_CEIL), wallMat);
			mesh.position.set(x, ROOM_CEIL / 2, z);
			mesh.rotation.y = rotY;
			return mesh;
		};
		group.add(
			wall(0, -ROOM_HALF, 0),
			wall(0, ROOM_HALF, Math.PI),
			wall(ROOM_HALF, 0, -Math.PI / 2),
			wall(-ROOM_HALF, 0, Math.PI / 2),
		);

		const ceiling = new Mesh(
			new PlaneGeometry(ROOM_HALF * 2, ROOM_HALF * 2).rotateX(Math.PI / 2),
			new MeshPhysicalMaterial({ color: 0xb3b3b3, roughness: 0.9 }),
		);
		ceiling.position.y = ROOM_CEIL;
		group.add(ceiling);

		if (useAreaLight) {
			// LTC lookup tables for the rasterized preview frames.
			RectAreaLightUniformsLib.init();
			this.rectLight = new RectAreaLight(
				0xfffdf8,
				PATCH_RADIANCE * (1 - FIXTURE_FRACTION),
				PATCH_HALF_X * 2,
				PATCH_HALF_Z * 2,
			);
			// Below the fixture quad so shadow rays aimed at the light are not
			// occluded by it.
			this.rectLight.position.set(0, ROOM_CEIL - 0.01, 0);
			this.rectLight.lookAt(0, 0, 0);
			group.add(this.rectLight);
		}

		// The visible fixture: carries the full lamp output in emissive mode,
		// or a small cosmetic share of it alongside the invisible RectAreaLight.
		this.patchMat = new MeshPhysicalMaterial({
			color: 0x000000,
			emissive: 0xfffdf8, // nearly white, slightly warm
			emissiveIntensity: PATCH_RADIANCE * (useAreaLight ? FIXTURE_FRACTION : 1),
		});
		const patch = new Mesh(
			new PlaneGeometry(PATCH_HALF_X * 2, PATCH_HALF_Z * 2).rotateX(Math.PI / 2),
			this.patchMat,
		);
		patch.position.y = ROOM_CEIL - 0.005;
		group.add(patch);

		return group;
	}

	/**
	 * Build an equirectangular HDR of the room interior by casting a ray per
	 * texel from ROOM_EYE and painting whichever box face it exits through.
	 * The ceiling patch gets a high radiance — it is the scene's light source.
	 */
	private makeRoomEnvironment(): DataTexture {
		const width = 1024;
		const height = 512;
		const data = new Float32Array(width * height * 4);

		const paint = (px: number, r: number, g: number, b: number) => {
			data[px] = r;
			data[px + 1] = g;
			data[px + 2] = b;
			data[px + 3] = 1;
		};

		for (let j = 0; j < height; j++) {
			// three.js equirect convention: v = asin(dir.y)/PI + 0.5.
			const elevation = ((j + 0.5) / height - 0.5) * Math.PI;
			const y = Math.sin(elevation);
			const horiz = Math.cos(elevation);
			for (let i = 0; i < width; i++) {
				const azimuth = ((i + 0.5) / width - 0.5) * 2 * Math.PI;
				const dx = horiz * Math.cos(azimuth);
				const dz = horiz * Math.sin(azimuth);

				// Exit distance of the ray from ROOM_EYE through the room box.
				const tx = dx === 0 ? Infinity : (Math.sign(dx) * ROOM_HALF - ROOM_EYE.x) / dx;
				const tz = dz === 0 ? Infinity : (Math.sign(dz) * ROOM_HALF - ROOM_EYE.z) / dz;
				const ty = y === 0 ? Infinity : ((y > 0 ? ROOM_CEIL : 0) - ROOM_EYE.y) / y;
				const t = Math.min(tx, ty, tz);

				const px = (j * width + i) * 4;
				if (t === ty && y > 0) {
					const hx = ROOM_EYE.x + t * dx;
					const hz = ROOM_EYE.z + t * dz;
					if (Math.abs(hx) <= PATCH_HALF_X && Math.abs(hz) <= PATCH_HALF_Z) {
						paint(px, 40, 39.5, 38.5); // the light: nearly white, slightly warm
					} else {
						paint(px, 0.45, 0.45, 0.45); // ceiling
					}
				} else if (t === ty) {
					paint(px, 0.25, 0.25, 0.25); // floor
				} else {
					paint(px, 0.35, 0.35, 0.35); // walls
				}
			}
		}

		const tex = new DataTexture(data, width, height, RGBAFormat, FloatType);
		tex.colorSpace = LinearSRGBColorSpace;
		tex.magFilter = LinearFilter;
		tex.minFilter = LinearFilter;
		tex.needsUpdate = true;
		return tex;
	}

	private loop = () => {
		if (this.disposed) return;
		this.rafId = requestAnimationFrame(this.loop);

		// During a fixed-size export, exportPNG() drives rendering itself.
		if (this.exporting) return;

		if (this.editing) {
			// Scene Editor: a plain, fast raster pass — no path tracing. This is
			// the same rasterization the tracer already shows while interacting,
			// so switching backends is a no-op for the renderer.
			this.controls.update();
			this.renderer.setRenderTarget(null);
			this.renderer.render(this.scene, this.camera);
			this.emit('editing');
			return;
		}

		this.pathTracer.pausePathTracing =
			this.maxSamples > 0 && this.pathTracer.samples >= this.maxSamples;
		this.pathTracer.renderSample();

		if (this.pathTracer.samples < this.lastSamples) {
			this.lastResetAt = performance.now();
			this.hideDenoise();
		}
		this.lastSamples = this.pathTracer.samples;

		this.maybeDenoise();
		this.emit(this.pathTracer.enablePathTracing ? 'pathtracing' : 'raster');
	};

	/**
	 * Denoise on a doubling schedule (4, 8, 16, ... samples) so passes get
	 * rarer as the image converges, plus a final pass when accumulation
	 * pauses at the sample cap. Must be called right after renderSample()
	 * so the drawing buffer is still valid to capture.
	 */
	private maybeDenoise() {
		const unet = this.denoiseEnabled ? this.activeUNet() : null;
		if (!unet || this.denoiseBusy) return;
		if (!this.pathTracer.enablePathTracing) return;
		const samples = Math.floor(this.pathTracer.samples);
		const paused = this.maxSamples > 0 && samples >= this.maxSamples;
		const due =
			samples >= Math.max(4, this.denoisedAtSamples * 2) ||
			(paused && samples > this.denoisedAtSamples);
		if (!due) return;

		const src = this.renderer.domElement;
		const overlay = this.denoiseCanvas;
		if (!overlay || src.width === 0 || src.height === 0) return;

		// The aux buffers only change on camera/scene changes, which all reset
		// accumulation (invalidating the cache via hideDenoise) — so capture
		// once per accumulation cycle and reuse.
		let aux: { albedo: ImageData; normal: ImageData } | null = null;
		if (unet === this.unetAux) {
			try {
				if (
					!this.auxCache ||
					this.auxCache.albedo.width !== src.width ||
					this.auxCache.albedo.height !== src.height
				) {
					this.auxCache = this.captureAuxBuffers(src.width, src.height);
				}
				aux = this.auxCache;
			} catch (err) {
				console.warn('Aux buffer capture failed; falling back to color-only denoising:', err);
				this.auxAvailable = false;
				this.auxCache = null;
				void this.prepareUNet();
				return;
			}
		}

		this.denoiseBusy = true;
		this.denoiseState = 'denoising';

		this.captureCanvas.width = src.width;
		this.captureCanvas.height = src.height;
		const cctx = this.captureCanvas.getContext('2d', { willReadFrequently: true })!;
		cctx.drawImage(src, 0, 0);
		const image = cctx.getImageData(0, 0, src.width, src.height);

		if (overlay.width !== src.width || overlay.height !== src.height) {
			overlay.width = src.width;
			overlay.height = src.height;
		}
		const octx = overlay.getContext('2d')!;

		this.abortDenoise = unet.tileExecute({
			color: image,
			...(aux ? { albedo: aux.albedo, normal: aux.normal } : {}),
			progress: (_out, tileData, tile) => {
				if (tileData) octx.putImageData(tileData, tile.x, tile.y);
				overlay.style.opacity = '1';
			},
			done: () => {
				this.abortDenoise = null;
				this.denoiseBusy = false;
				this.denoisedAtSamples = samples;
				this.denoiseState = 'denoised';
			},
		});
	}

	/** Abort any in-flight pass and drop back to the live (noisy) render. */
	private hideDenoise() {
		this.abortDenoise?.();
		this.abortDenoise = null;
		this.denoiseBusy = false;
		this.denoisedAtSamples = 0;
		this.auxCache = null;
		if (this.denoiseCanvas) this.denoiseCanvas.style.opacity = '0';
		if (this.denoiseState === 'denoising' || this.denoiseState === 'denoised') {
			this.denoiseState = 'ready';
		}
	}

	async setDenoiseEnabled(enabled: boolean) {
		this.denoiseEnabled = enabled;
		if (!enabled) {
			this.hideDenoise();
			this.denoiseState = 'off';
			return;
		}
		if (!('gpu' in navigator)) {
			this.denoiseState = 'unsupported';
			return;
		}
		await this.prepareUNet();
	}

	setDenoiseAuxEnabled(enabled: boolean) {
		if (this.auxEnabled === enabled) return;
		this.auxEnabled = enabled;
		this.auxCache = null;
		if (!this.denoiseEnabled) return;
		// Drop the current overlay and re-denoise with the newly selected net.
		this.hideDenoise();
		void this.prepareUNet();
	}

	/** The net matching the current aux preference, if loaded. */
	private activeUNet(): UNet | null {
		return this.auxEnabled && this.auxAvailable ? this.unetAux : this.unetPlain;
	}

	/** Load (if needed) the net matching the current aux preference. */
	private async prepareUNet() {
		const wantAux = this.auxEnabled && this.auxAvailable;
		if (!this.activeUNet()) this.denoiseState = 'loading';
		let unet = await this.ensureUNet(wantAux);
		if (this.disposed) return;
		// Aux weights failed to load: auxAvailable is now false; fall back.
		if (!unet && wantAux) unet = await this.ensureUNet(false);
		if (this.disposed || !unet) return;
		if (this.denoiseEnabled && (this.denoiseState === 'loading' || this.denoiseState === 'off')) {
			this.denoiseState = 'ready';
		}
	}

	private async ensureUNet(aux: boolean): Promise<UNet | null> {
		const key = aux ? 'aux' : 'plain';
		if (!this.unetPromises[key]) {
			// Lazy: oidn-web pulls in tfjs, so only load it on first use.
			this.unetPromises[key] = import('oidn-web').then(({ initUNetFromURL }) =>
				initUNetFromURL(
					`${import.meta.env.BASE_URL}assets/${aux ? 'rt_ldr_alb_nrm' : 'rt_ldr'}.tza`,
					undefined,
					aux ? { aux: true } : undefined,
				),
			);
		}
		try {
			const unet = await this.unetPromises[key]!;
			if (this.disposed) return null;
			if (aux) this.unetAux = unet;
			else this.unetPlain = unet;
			return unet;
		} catch (err) {
			this.unetPromises[key] = null;
			if (aux) {
				console.warn('Aux denoiser weights failed to load; falling back to color-only:', err);
				this.auxAvailable = false;
				return null;
			}
			console.error('Denoiser failed to initialize:', err);
			if (this.denoiseEnabled) this.denoiseState = 'error';
			return null;
		}
	}

	/**
	 * Render noise-free albedo and normal passes of the current view — the
	 * denoiser's auxiliary inputs. They act as an edge map: the net sees where
	 * real material/geometry boundaries are even when the color input is pure
	 * noise. Albedo = per-mesh unlit base color (background white, per OIDN
	 * convention); normal = packed view-space normals from MeshNormalMaterial,
	 * whose 0.5*n+0.5 encoding is exactly what oidn-web expects (background =
	 * packed zero normal, 0x808080).
	 */
	private captureAuxBuffers(width: number, height: number): { albedo: ImageData; normal: ImageData } {
		const renderer = this.renderer;
		const prevToneMapping = renderer.toneMapping;
		const prevBackground = this.scene.background;
		const prevAutoClear = renderer.autoClear;
		const prevClearColor = renderer.getClearColor(new Color());
		const prevClearAlpha = renderer.getClearAlpha();

		renderer.toneMapping = NoToneMapping;
		this.scene.background = null;
		renderer.autoClear = true;

		// Render targets draw in linear working space regardless of the
		// renderer's output color space; an SRGB texture makes the GPU encode
		// on write so the readback matches the sRGB color capture. Normals
		// stay linear — their packing must not be gamma-encoded.
		const albedoRT = new WebGLRenderTarget(width, height);
		albedoRT.texture.colorSpace = SRGBColorSpace;
		const normalRT = new WebGLRenderTarget(width, height);

		try {
			// Albedo: swap every mesh's material for an unlit mirror of its base
			// color/map. (scene.overrideMaterial can't carry per-object colors.)
			const swapped: [Mesh, Material | Material[]][] = [];
			this.scene.traverse((obj) => {
				const mesh = obj as Mesh;
				if (!mesh.isMesh) return;
				const source = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
					| MeshPhysicalMaterial
					| MeshBasicMaterial;
				let mirror = this.basicMirrors.get(source);
				if (!mirror) {
					mirror = new MeshBasicMaterial();
					this.basicMirrors.set(source, mirror);
				}
				if (source.color) mirror.color.copy(source.color);
				const map = source.map ?? null;
				if (mirror.map !== map) {
					mirror.map = map;
					mirror.needsUpdate = true;
				}
				swapped.push([mesh, mesh.material]);
				mesh.material = mirror;
			});
			renderer.setClearColor(0xffffff, 1);
			renderer.setRenderTarget(albedoRT);
			renderer.render(this.scene, this.camera);
			for (const [mesh, material] of swapped) mesh.material = material;

			// Normals: a global override works — normals ignore per-object color.
			this.scene.overrideMaterial = this.normalMaterial;
			renderer.setClearColor(0x808080, 1);
			renderer.setRenderTarget(normalRT);
			renderer.render(this.scene, this.camera);
			this.scene.overrideMaterial = null;

			return {
				albedo: this.readTargetPixels(albedoRT, width, height),
				normal: this.readTargetPixels(normalRT, width, height),
			};
		} finally {
			this.scene.overrideMaterial = null;
			renderer.setRenderTarget(null);
			renderer.setClearColor(prevClearColor, prevClearAlpha);
			renderer.toneMapping = prevToneMapping;
			renderer.autoClear = prevAutoClear;
			this.scene.background = prevBackground;
			albedoRT.dispose();
			normalRT.dispose();
		}
	}

	/** Read back a render target, flipping rows (GL is bottom-up, ImageData top-down). */
	private readTargetPixels(rt: WebGLRenderTarget, width: number, height: number): ImageData {
		const buf = new Uint8Array(width * height * 4);
		this.renderer.readRenderTargetPixels(rt, 0, 0, width, height, buf);
		const flipped = new Uint8ClampedArray(width * height * 4);
		const row = width * 4;
		for (let y = 0; y < height; y++) {
			flipped.set(buf.subarray((height - 1 - y) * row, (height - y) * row), y * row);
		}
		return new ImageData(flipped, width, height);
	}

	private emit(mode: RenderMode) {
		this.onStatus?.({
			mode,
			samples: this.ready ? Math.floor(this.pathTracer.samples) : 0,
			elapsedMs: performance.now() - this.lastResetAt,
			denoise: this.denoiseState,
			denoisedAt: this.denoisedAtSamples,
			denoiseAux: this.auxEnabled && this.auxAvailable,
		});
	}

	setPathTracingEnabled(enabled: boolean) {
		this.pathTracer.enablePathTracing = enabled;
		if (!enabled) this.hideDenoise();
		if (enabled && this.ready) this.pathTracer.reset();
	}

	/** Toggle between path-traced render mode and the fast raster edit mode. */
	setEditMode(edit: boolean) {
		if (this.editing === edit) return;
		this.editing = edit;
		if (edit) {
			this.hideDenoise();
		} else if (this.ready) {
			if (this.objectsDirty) {
				// Visibility or geometry changed; rebuild the BVH (setScene skips
				// hidden meshes, refits moved geometry, and resets itself). This
				// also re-reads materials, so any material edits are covered too.
				this.objectsDirty = false;
				this.materialsDirty = false;
				this.pathTracer.setScene(this.scene, this.camera);
			} else {
				if (this.materialsDirty) {
					this.materialsDirty = false;
					this.pathTracer.updateMaterials();
				}
				this.pathTracer.updateCamera();
				this.pathTracer.reset();
			}
			this.lastResetAt = performance.now();
		}
	}

	private registerObject(object3d: Object3D, name: string, key: string = name) {
		const id = `obj-${++this.objectCounter}`;
		this.objects.set(id, { object3d, name, key, included: object3d.visible });
	}

	listObjects(): LabObject[] {
		return [...this.objects.entries()].map(([id, e]) => ({
			id,
			name: e.name,
			included: e.included,
			removable: this.library.find((i) => i.key === e.key)?.kind === 'imported',
		}));
	}

	setObjectIncluded(id: string, included: boolean) {
		const entry = this.objects.get(id);
		if (!entry || entry.included === included) return;
		entry.included = included;
		entry.object3d.visible = included; // instant in the raster edit view
		this.objectsDirty = true;
		this.emitObjects();
	}

	setOnObjectsChanged(cb: (objects: LabObject[]) => void) {
		this.objectsChanged = cb;
	}

	private emitObjects() {
		this.objectsChanged?.(this.listObjects());
	}

	getObjectTransform(id: string): LabTransform | null {
		const entry = this.objects.get(id);
		if (!entry) return null;
		const o = entry.object3d;
		return {
			position: [o.position.x, o.position.y, o.position.z],
			rotation: [o.rotation.x * RAD2DEG, o.rotation.y * RAD2DEG, o.rotation.z * RAD2DEG],
			scale: [o.scale.x, o.scale.y, o.scale.z],
		};
	}

	setObjectTransform(id: string, t: LabTransform) {
		const entry = this.objects.get(id);
		if (!entry) return;
		const o = entry.object3d;
		o.position.set(t.position[0], t.position[1], t.position[2]);
		o.rotation.set(t.rotation[0] * DEG2RAD, t.rotation[1] * DEG2RAD, t.rotation[2] * DEG2RAD);
		o.scale.set(t.scale[0], t.scale[1], t.scale[2]);
		// Live in the raster view; the traced BVH refits on return to render.
		this.objectsDirty = true;
	}

	/** Every standard/physical material under an object (deduped). */
	private materialsOf(obj: Object3D): MeshStandardMaterial[] {
		const found = new Set<MeshStandardMaterial>();
		obj.traverse((child) => {
			const mesh = child as Mesh;
			if (!mesh.isMesh || !mesh.material) return;
			const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
			for (const m of list) {
				if ((m as MeshStandardMaterial).isMeshStandardMaterial) {
					found.add(m as MeshStandardMaterial);
				}
			}
		});
		return [...found];
	}

	getObjectMaterial(id: string): LabMaterial | null {
		const entry = this.objects.get(id);
		if (!entry) return null;
		const mats = this.materialsOf(entry.object3d);
		if (!mats.length) return null;
		const m = mats[0];
		return {
			color: `#${m.color.getHexString()}`,
			shininess: 1 - m.roughness,
			reflectivity: m.metalness,
		};
	}

	setObjectMaterial(id: string, mat: LabMaterial) {
		const entry = this.objects.get(id);
		if (!entry) return;
		for (const m of this.materialsOf(entry.object3d)) {
			m.color.set(mat.color);
			m.roughness = 1 - mat.shininess;
			m.metalness = mat.reflectivity;
			// Scalar/color uniforms update without a shader recompile, so no
			// needsUpdate. Live in raster; the tracer re-reads on return.
		}
		this.materialsDirty = true;
	}

	setBounces(bounces: number) {
		this.pathTracer.bounces = bounces;
		if (this.ready) this.pathTracer.reset();
	}

	setRenderScale(scale: number) {
		this.pathTracer.renderScale = scale;
		if (this.ready) this.pathTracer.reset();
	}

	/** 0 means accumulate forever. */
	setMaxSamples(samples: number) {
		this.maxSamples = samples;
	}

	setEnvironmentIntensity(intensity: number) {
		this.envIntensity = intensity;
		// In edit mode (or mid-rebuild) we only update the light objects (the
		// raster view reads them directly); the tracer resyncs afterward.
		const syncTracer = this.ready && !this.editing && !this.buildingScene;
		if (this.patchMat) {
			// The geometric rooms have no environment; the slider scales the lamp
			// (both halves of the split, in the arealight room).
			const radiance = intensity * PATCH_RADIANCE;
			this.patchMat.emissiveIntensity = this.rectLight
				? radiance * FIXTURE_FRACTION
				: radiance;
			if (this.rectLight) {
				this.rectLight.intensity = radiance * (1 - FIXTURE_FRACTION);
				if (syncTracer) this.pathTracer.updateLights();
			}
			if (syncTracer) this.pathTracer.updateMaterials();
		} else {
			this.scene.environmentIntensity = intensity;
			if (syncTracer) this.pathTracer.updateEnvironment();
		}
	}

	/** Swap the room shell / environment, keeping all placed objects. */
	setRoom(kind: RoomKind) {
		if (!this.ready || kind === this.roomKind) return;
		this.hideDenoise();
		this.applyRoom(kind);
		if (this.editing) {
			// Raster shows it live; the traced BVH rebuilds on return to render.
			this.objectsDirty = true;
		} else {
			this.pathTracer.setScene(this.scene, this.camera);
			this.lastResetAt = performance.now();
		}
	}

	getRoom(): RoomKind | null {
		return this.roomKind;
	}

	/**
	 * Build (or rebuild) the room's lighting. 'room' bakes a generated HDR
	 * environment; the geometric rooms add a shell with an emissive patch or a
	 * RectAreaLight. Pure scene-graph mutation — the caller syncs the tracer.
	 */
	private applyRoom(kind: RoomKind) {
		// Tear down whatever the previous room installed.
		if (this.roomShell) {
			this.scene.remove(this.roomShell);
			disposeObject(this.roomShell);
			this.roomShell = null;
		}
		if (this.roomEnvTex) {
			this.roomEnvTex.dispose();
			this.roomEnvTex = null;
		}
		this.scene.environment = null;
		this.scene.background = null;
		this.patchMat = null;
		this.rectLight = null;

		if (kind === 'room') {
			const tex = this.makeRoomEnvironment();
			tex.mapping = EquirectangularReflectionMapping;
			this.roomEnvTex = tex;
			this.scene.environment = tex;
			this.scene.background = tex;
		} else {
			this.roomShell = this.makeRoomShell(kind === 'room-arealight');
			this.scene.add(this.roomShell);
		}

		this.roomKind = kind;
		// Re-apply the current light intensity to the freshly built room.
		this.setEnvironmentIntensity(this.envIntensity);
	}

	/** Capture the current editor scene as saveable data. */
	serializeScene(): SceneData {
		const objects: SceneObjectState[] = [];
		for (const [id, entry] of this.objects) {
			const material = this.getObjectMaterial(id);
			const transform = this.getObjectTransform(id);
			if (!material || !transform) continue;
			objects.push({ key: entry.key, included: entry.included, material, transform });
		}
		return {
			version: 1,
			room: this.roomKind ?? 'room-arealight',
			objects,
			camera: {
				position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
				target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
			},
		};
	}

	/** Parse each persisted import into a reusable template Object3D. */
	private async loadImports() {
		for (const rec of listImports()) {
			try {
				const template = await this.parseGLB(base64ToArrayBuffer(rec.glbBase64));
				this.importTemplates.set(rec.key, template);
				this.library.push({ key: rec.key, name: rec.name, kind: 'imported' });
			} catch (err) {
				console.warn('Failed to load imported object:', rec.name, err);
			}
		}
	}

	private async parseGLB(buffer: ArrayBuffer): Promise<Object3D> {
		const gltf = await new GLTFLoader().parseAsync(buffer, '');
		const model = gltf.scene;
		// Center on origin, resting on the floor; wrap in a group so the
		// object's own transform starts at identity (clean for the inspector).
		const bounds = new Box3().setFromObject(model);
		const center = bounds.getCenter(new Vector3());
		model.position.set(-center.x, -bounds.min.y, -center.z);
		const group = new Group();
		group.add(model);
		return group;
	}

	/** Import a .glb into the library (persisted) and add it to the scene. */
	async importGLB(buffer: ArrayBuffer, filename: string): Promise<void> {
		const template = await this.parseGLB(buffer);
		const key = `import-${Date.now().toString(36)}-${this.importCounter++}`;
		const name = filename.replace(/\.(glb|gltf)$/i, '').trim() || 'Imported';
		// Persist first so a quota failure aborts before we mutate state.
		saveImport({ key, name, glbBase64: arrayBufferToBase64(buffer) });
		this.importTemplates.set(key, template);
		this.library.push({ key, name, kind: 'imported' });

		// Add an instance (hidden) so it appears in the list immediately.
		const obj = this.cloneWithMaterials(template);
		obj.visible = false;
		this.registerObject(obj, name, key);
		this.scene.add(obj);
		this.objectsDirty = true;
		this.emitObjects();
	}

	/** Remove an imported object from the library (built-ins are permanent). */
	deleteLibraryItem(key: string) {
		const item = this.library.find((i) => i.key === key);
		if (!item || item.kind !== 'imported') return;
		this.library = this.library.filter((i) => i.key !== key);
		const template = this.importTemplates.get(key);
		if (template) {
			disposeObject(template);
			this.importTemplates.delete(key);
		}
		deleteImport(key);
		for (const [id, entry] of [...this.objects]) {
			if (entry.key === key) {
				this.scene.remove(entry.object3d);
				disposeObject(entry.object3d);
				this.objects.delete(id);
			}
		}
		this.objectsDirty = true;
		this.emitObjects();
	}

	removeLibraryObject(id: string) {
		const entry = this.objects.get(id);
		if (entry) this.deleteLibraryItem(entry.key);
	}

	/** Replace the whole scene with a saved (or new) editor scene. */
	applyScene(data: SceneData) {
		if (!this.ready) return;
		this.hideDenoise();
		this.buildEditorScene(data);
		this.emitObjects();
		if (this.editing) {
			this.objectsDirty = true;
		} else {
			this.pathTracer.setScene(this.scene, this.camera);
			this.lastResetAt = performance.now();
		}
	}

	/**
	 * Rebuild the scene from scratch: floor + object library + room + saved
	 * per-object state + camera. Starting from a clean slate means applyScene
	 * works identically no matter what was loaded before (a demo or another
	 * saved scene).
	 */
	private buildEditorScene(data: SceneData) {
		this.buildingScene = true;
		for (const child of [...this.scene.children]) {
			this.scene.remove(child);
			disposeObject(child);
		}
		this.objects.clear();
		this.objectCounter = 0;
		this.roomShell = null;
		this.patchMat = null;
		this.rectLight = null;
		if (this.roomEnvTex) {
			this.roomEnvTex.dispose();
			this.roomEnvTex = null;
		}
		this.roomKind = null;
		this.scene.environment = null;
		this.scene.background = null;

		const floor = new Mesh(
			new PlaneGeometry(ROOM_HALF * 2, ROOM_HALF * 2).rotateX(-Math.PI / 2),
			new MeshPhysicalMaterial({ color: 0x8c8c8c, roughness: 0.85 }),
		);
		this.scene.add(floor);

		// Instantiate the whole library (built-ins + imports), then apply state.
		this.instantiateLibrary();
		this.applyRoom(data.room);

		for (const [id, entry] of this.objects) {
			const saved = data.objects.find((o) => o.key === entry.key);
			const included = saved?.included ?? false;
			entry.included = included;
			entry.object3d.visible = included;
			if (saved?.material) this.setObjectMaterial(id, saved.material);
			if (saved?.transform) this.setObjectTransform(id, saved.transform);
		}

		if (data.camera) {
			this.camera.position.set(...data.camera.position);
			this.controls.target.set(...data.camera.target);
		}
		this.camera.updateProjectionMatrix();
		this.controls.update();
		this.buildingScene = false;
	}

	resize(width: number, height: number) {
		if (width === 0 || height === 0) return;
		this.renderer.setSize(width, height, false);
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		this.hideDenoise();
		if (this.ready) this.pathTracer.updateCamera();
	}

	/**
	 * Render the scene at a fixed square resolution and download it as a PNG.
	 * Independent of viewport/display: the renderer is temporarily resized to
	 * size×size at pixel-ratio 1 and a square camera, converged to
	 * EXPORT_SAMPLES, captured, then the interactive view is restored.
	 */
	async exportPNG(size: number, filename = 'pt-lab.png', onProgress?: (frac: number) => void) {
		if (!this.ready || this.exporting) return;
		this.exporting = true;
		this.hideDenoise();

		const logical = this.renderer.getSize(new Vector2());
		const prevPixelRatio = this.renderer.getPixelRatio();
		const prevAspect = this.camera.aspect;
		const prevRenderScale = this.pathTracer.renderScale;
		const prevEnabled = this.pathTracer.enablePathTracing;
		const prevPaused = this.pathTracer.pausePathTracing;

		this.renderer.setPixelRatio(1);
		this.renderer.setSize(size, size, false);
		this.camera.aspect = 1;
		this.camera.updateProjectionMatrix();
		this.pathTracer.renderScale = 1;
		this.pathTracer.enablePathTracing = true;
		this.pathTracer.pausePathTracing = false;
		this.pathTracer.updateCamera();
		this.pathTracer.reset();

		try {
			while (this.pathTracer.samples < EXPORT_SAMPLES && !this.disposed) {
				this.pathTracer.renderSample();
				onProgress?.(this.pathTracer.samples / EXPORT_SAMPLES);
				await new Promise(requestAnimationFrame);
			}
			if (this.disposed) return;
			onProgress?.(1);
			// Redraw and capture in the SAME tick: the WebGL drawing buffer isn't
			// preserved across composites, so an intervening frame would blank it.
			this.pathTracer.renderSample();
			await new Promise<void>((resolve) => {
				this.renderer.domElement.toBlob((blob) => {
					if (blob) {
						const url = URL.createObjectURL(blob);
						const a = document.createElement('a');
						a.href = url;
						a.download = filename;
						a.click();
						URL.revokeObjectURL(url);
					}
					resolve();
				});
			});
		} finally {
			this.renderer.setPixelRatio(prevPixelRatio);
			this.renderer.setSize(logical.x, logical.y, false);
			this.camera.aspect = prevAspect;
			this.camera.updateProjectionMatrix();
			this.pathTracer.renderScale = prevRenderScale;
			this.pathTracer.enablePathTracing = prevEnabled;
			this.pathTracer.pausePathTracing = prevPaused;
			this.pathTracer.updateCamera();
			this.pathTracer.reset();
			this.lastResetAt = performance.now();
			this.exporting = false;
		}
	}

	dispose() {
		this.disposed = true;
		cancelAnimationFrame(this.rafId);
		this.abortDenoise?.();
		this.unetPlain?.dispose();
		this.unetAux?.dispose();
		this.normalMaterial.dispose();
		this.controls.dispose();
		this.pathTracer.dispose();
		this.renderer.dispose();
	}
}
