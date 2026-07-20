// localStorage-backed store for imported objects. The object's .glb bytes are
// kept as base64 so imported primitives persist across reloads without being
// re-imported. Kept separate from the scene store (scenes reference library
// objects by key). Best for the small, uncompressed .glb files the editor
// targets; large/textured models can exceed the localStorage quota.
const STORAGE_KEY = 'pt-lab.library';

export interface StoredImport {
	key: string;
	name: string;
	glbBase64: string;
}

function readAll(): StoredImport[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? (JSON.parse(raw) as StoredImport[]) : [];
	} catch {
		return [];
	}
}

function writeAll(all: StoredImport[]) {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function listImports(): StoredImport[] {
	return readAll();
}

/** Throws if the quota is exceeded (caller surfaces the failure). */
export function saveImport(rec: StoredImport) {
	const all = readAll().filter((r) => r.key !== rec.key);
	all.push(rec);
	writeAll(all);
}

export function deleteImport(key: string) {
	writeAll(readAll().filter((r) => r.key !== key));
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	const chunk = 0x8000; // avoid arg-count limits on fromCharCode
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}
