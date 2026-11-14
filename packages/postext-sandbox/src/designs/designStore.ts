/**
 * Saved designs (#1523). Each is kept as the bytes of its design file (a
 * `.postext` with no chapters, see `postext/bundle`'s `createDesignBundle`),
 * fonts and profiles inside, in a database of its own: the Sandbox's file
 * sweep keeps a font or a blob only while a book points at it, and a
 * design outlives the book it was saved from.
 */

import type { DesignPart } from 'postext';
import { moveLegacyTemplates } from './legacyTemplates.js';

/** A saved design. */
export interface SavedDesign {
  id: string;
  name: string;
  description?: string;
  /** The book it was saved from. */
  source?: string;
  parts: DesignPart[];
  createdAt: number;
  updatedAt: number;
  /** The design file. */
  bytes: ArrayBuffer;
}

const DB_NAME = 'postext-designs';
const DB_VERSION = 1;
const STORE = 'designs';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('Failed to open the design store'));
    };
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = op(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error ?? req.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  }));
}

const listeners = new Set<() => void>();
function changed(): void {
  for (const l of listeners) l();
}

/** Call `listener` after every change of the saved designs. */
export function onSavedDesignsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The templates postext 1.78 saved, moved to the saved designs once per
 *  page, before the designs are first read (see `legacyTemplates.ts`). A
 *  move that fails leaves them where they were, for the next page. */
let legacyMove: Promise<void> | null = null;
function moveLegacyOnce(): Promise<void> {
  legacyMove ??= moveLegacyTemplates((d) => run('readwrite', (s) => s.put(d)).then(() => undefined))
    .then((moved) => { if (moved > 0) changed(); }, () => undefined);
  return legacyMove;
}

/** A saved design without its file: what a list needs. */
export type SavedDesignSummary = Omit<SavedDesign, 'bytes'>;

/** Where saved designs live. The default is this browser's IndexedDB; a
 *  host can supply its own (a server database) with `setSavedDesignStorage`.
 *  Every method throws when it fails. */
export interface SavedDesignStorage {
  /** Saved designs, newest first. The files may be left out. */
  list(): Promise<SavedDesignSummary[]>;
  get(id: string): Promise<SavedDesign | null>;
  put(design: SavedDesign): Promise<void>;
  delete(id: string): Promise<void>;
}

const indexedDbStorage: SavedDesignStorage = {
  async list() {
    await moveLegacyOnce();
    const all = await run('readonly', (s) => s.getAll() as IDBRequest<SavedDesign[]>);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },
  async get(id) {
    await moveLegacyOnce();
    return (await run('readonly', (s) => s.get(id) as IDBRequest<SavedDesign | undefined>)) ?? null;
  },
  async put(d) {
    await run('readwrite', (s) => s.put(d));
  },
  async delete(id) {
    await run('readwrite', (s) => s.delete(id));
  },
};

let storage: SavedDesignStorage = indexedDbStorage;

/** Keep the saved designs in `next`; `null` goes back to IndexedDB. */
export function setSavedDesignStorage(next: SavedDesignStorage | null): void {
  storage = next ?? indexedDbStorage;
  changed();
}

/** Saved designs, newest first. */
export function listSavedDesigns(): Promise<SavedDesignSummary[]> {
  return storage.list();
}

export function getSavedDesign(id: string): Promise<SavedDesign | null> {
  return storage.get(id);
}

export async function putSavedDesign(d: SavedDesign): Promise<void> {
  await storage.put(d);
  changed();
}

export async function deleteSavedDesign(id: string): Promise<void> {
  await storage.delete(id);
  changed();
}

export function generateDesignId(): string {
  return `design-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
