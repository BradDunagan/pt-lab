import {
	ACESFilmicToneMapping,
	Box3,
	BoxGeometry,
	CircleGeometry,
	DataTexture,
	EquirectangularReflectionMapping,
	FloatType,
	Group,
	LinearFilter,
	LinearSRGBColorSpace,
	Mesh,
	MeshPhysicalMaterial,
	PerspectiveCamera,
	PlaneGeometry,
	RGBAFormat,
	Scene,
	SphereGeometry,
	TorusKnotGeometry,
	Vector3,
	WebGLRenderer,
	type Object3D,
	type Texture,
} from 'three';
import { RectAreaLight } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { WebGLPathTracer } from 'three-gpu-pathtracer';

export type RenderMode = 'loading' | 'building-bvh' | 'raster' | 'pathtracing';

export interface LabStatus {
	mode: RenderMode;
	samples: number;
	elapsedMs: number;
}

export interface LabOptions {
	onStatus?: (status: LabStatus) => void;
}

const MODEL_URL = `${import.meta.env.BASE_URL}assets/damaged-helmet.glb`;
const ENV_URL = `${import.meta.env.BASE_URL}assets/royal_esplanade_1k.hdr`;

/** ?scene=procedural | room | room-emissive | room-arealight forces an alternate scene instead of the helmet. */
function sceneParam(): string | null {
	return new URLSearchParams(location.search).get('scene');
}

const ROOM_KINDS = ['room', 'room-emissive', 'room-arealight'];

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
	private patchMat: MeshPhysicalMaterial | null = null;
	private rectLight: RectAreaLight | null = null;

	constructor(canvas: HTMLCanvasElement, options: LabOptions = {}) {
		this.onStatus = options.onStatus;

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
		const geometricRoom = kind === 'room-emissive' || kind === 'room-arealight';
		const [envMap, model] = await Promise.all([
			kind === 'room'
				? Promise.resolve<Texture | null>(this.makeRoomEnvironment())
				: geometricRoom
					? Promise.resolve<Texture | null>(null)
					: new HDRLoader().loadAsync(ENV_URL),
			this.loadModel(),
		]);
		if (this.disposed) return;

		if (envMap) {
			envMap.mapping = EquirectangularReflectionMapping;
			this.scene.environment = envMap;
			this.scene.background = envMap;
		} else {
			// Geometric room: no environment at all — the only light in the
			// scene is the ceiling patch in the room shell.
			this.scene.add(this.makeRoomShell(kind === 'room-arealight'));
		}

		this.scene.add(model);

		const bounds = new Box3().setFromObject(model);
		const size = bounds.getSize(new Vector3());
		this.controls.target.set(0, size.y / 2, 0);
		this.controls.update();

		const floor = new Mesh(
			isRoom
				? // Real floor matching the room footprint; walls/ceiling exist only
					// in the environment map.
					new PlaneGeometry(ROOM_HALF * 2, ROOM_HALF * 2).rotateX(-Math.PI / 2)
				: new CircleGeometry(Math.max(size.x, size.z) * 3, 64).rotateX(-Math.PI / 2),
			new MeshPhysicalMaterial({ color: isRoom ? 0x8c8c8c : 0xdedede, roughness: 0.85 }),
		);
		this.scene.add(floor);

		this.emit('building-bvh');
		// Yield a frame so the status paints before the synchronous BVH build.
		await new Promise(requestAnimationFrame);
		if (this.disposed) return;

		this.pathTracer.setScene(this.scene, this.camera);
		this.ready = true;
		this.lastResetAt = performance.now();
		this.loop();
	}

	private async loadModel(): Promise<Object3D> {
		const kind = sceneParam();
		if (kind === 'procedural') return this.makeProceduralScene();
		if (ROOM_KINDS.includes(kind ?? '')) return this.makeTableScene();
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

	/** 2 x 1 m table at room center with a 10 cm red cube and a 5 cm gray ball. */
	private makeTableScene(): Object3D {
		const group = new Group();
		const tableMat = new MeshPhysicalMaterial({ color: 0x8a6a48, roughness: 0.6 });

		const top = new Mesh(new BoxGeometry(2, 0.05, 1), tableMat);
		top.position.y = 0.725;
		group.add(top);

		for (const [x, z] of [[-0.9, -0.4], [0.9, -0.4], [-0.9, 0.4], [0.9, 0.4]]) {
			const leg = new Mesh(new BoxGeometry(0.06, 0.7, 0.06), tableMat);
			leg.position.set(x, 0.35, z);
			group.add(leg);
		}

		const cube = new Mesh(
			new BoxGeometry(0.1, 0.1, 0.1),
			new MeshPhysicalMaterial({ color: 0xb01818, roughness: 0.4 }),
		);
		cube.position.set(-0.3, 0.8, 0);
		group.add(cube);

		const ball = new Mesh(
			new SphereGeometry(0.05, 48, 24),
			new MeshPhysicalMaterial({ color: 0xc8c8c8, roughness: 0.3 }),
		);
		ball.position.set(0.25, 0.8, 0.12);
		group.add(ball);

		return group;
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

		this.pathTracer.pausePathTracing =
			this.maxSamples > 0 && this.pathTracer.samples >= this.maxSamples;
		this.pathTracer.renderSample();

		if (this.pathTracer.samples < this.lastSamples) {
			this.lastResetAt = performance.now();
		}
		this.lastSamples = this.pathTracer.samples;

		this.emit(this.pathTracer.enablePathTracing ? 'pathtracing' : 'raster');
	};

	private emit(mode: RenderMode) {
		this.onStatus?.({
			mode,
			samples: this.ready ? Math.floor(this.pathTracer.samples) : 0,
			elapsedMs: performance.now() - this.lastResetAt,
		});
	}

	setPathTracingEnabled(enabled: boolean) {
		this.pathTracer.enablePathTracing = enabled;
		if (enabled && this.ready) this.pathTracer.reset();
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
		if (this.patchMat) {
			// The geometric rooms have no environment; the slider scales the lamp
			// (both halves of the split, in the arealight room).
			const radiance = intensity * PATCH_RADIANCE;
			this.patchMat.emissiveIntensity = this.rectLight
				? radiance * FIXTURE_FRACTION
				: radiance;
			if (this.rectLight) {
				this.rectLight.intensity = radiance * (1 - FIXTURE_FRACTION);
				if (this.ready) this.pathTracer.updateLights();
			}
			if (this.ready) this.pathTracer.updateMaterials();
		} else {
			this.scene.environmentIntensity = intensity;
			if (this.ready) this.pathTracer.updateEnvironment();
		}
	}

	resize(width: number, height: number) {
		if (width === 0 || height === 0) return;
		this.renderer.setSize(width, height, false);
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		if (this.ready) this.pathTracer.updateCamera();
	}

	savePNG(filename = 'pt-lab.png') {
		if (!this.ready) return;
		// Redraw, then capture in the same task so the buffer is still valid.
		this.pathTracer.renderSample();
		this.renderer.domElement.toBlob((blob) => {
			if (!blob) return;
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			a.click();
			URL.revokeObjectURL(url);
		});
	}

	dispose() {
		this.disposed = true;
		cancelAnimationFrame(this.rafId);
		this.controls.dispose();
		this.pathTracer.dispose();
		this.renderer.dispose();
	}
}
