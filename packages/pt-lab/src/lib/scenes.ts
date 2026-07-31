// localStorage-backed store for named editor scenes. Plain data only — the
// SceneData shape (room + per-object state + camera) is owned by pathtracer.ts.
import type { SceneData } from './pathtracer';

const STORAGE_KEY = 'pt-lab.scenes';

function readAll(): Record<string, SceneData> {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? (JSON.parse(raw) as Record<string, SceneData>) : {};
	} catch {
		return {};
	}
}

function writeAll(all: Record<string, SceneData>) {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function listSceneNames(): string[] {
	return Object.keys(readAll()).sort((a, b) => a.localeCompare(b));
}

export function loadSceneData(name: string): SceneData | null {
	return readAll()[name] ?? null;
}

export function saveSceneData(name: string, data: SceneData) {
	const all = readAll();
	all[name] = data;
	writeAll(all);
}

export function deleteSceneData(name: string) {
	const all = readAll();
	delete all[name];
	writeAll(all);
}

/** A fresh scene: an area-light room with the light but no objects included. */
export function newSceneData(): SceneData {
	return { version: 1, room: 'room-arealight', objects: [], camera: null };
}
