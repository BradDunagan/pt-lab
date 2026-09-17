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

/** Filename-safe slug of a scene name. */
function slug(name: string): string {
	return (
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'scene'
	);
}

/**
 * Download a scene as pretty-printed JSON — the same `SceneData` that Save
 * puts in localStorage, so an export can be pasted back in or kept in a repo.
 * Objects are referenced by library key: a scene using imported `.glb` models
 * needs those imports present to load, they do not travel in the file.
 */
export function exportSceneData(name: string, data: SceneData) {
	const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `${slug(name)}.pt-scene.json`;
	a.click();
	URL.revokeObjectURL(url);
}

/** A fresh scene: an area-light room with the light but no objects included. */
export function newSceneData(): SceneData {
	return { version: 1, room: 'room-arealight', objects: [], camera: null };
}
