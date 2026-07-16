import {
	ACESFilmicToneMapping,
	Box3,
	CircleGeometry,
	EquirectangularReflectionMapping,
	Group,
	Mesh,
	MeshPhysicalMaterial,
	PerspectiveCamera,
	Scene,
	SphereGeometry,
	TorusKnotGeometry,
	Vector3,
	WebGLRenderer,
	type Object3D,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
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

		const [envMap, model] = await Promise.all([
			new HDRLoader().loadAsync(ENV_URL),
			this.loadModel(),
		]);
		if (this.disposed) return;

		envMap.mapping = EquirectangularReflectionMapping;
		this.scene.environment = envMap;
		this.scene.background = envMap;

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
		this.scene.environmentIntensity = intensity;
		if (this.ready) this.pathTracer.updateEnvironment();
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
