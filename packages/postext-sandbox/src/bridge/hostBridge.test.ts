// The bridge over the Sandbox's real reducer and store (the tool tests'
// harness). Only storage is replaced — the project actions write to
// IndexedDB, which Node lacks — by stand-ins that dispatch what the real
// ones dispatch when a book is imported, switched to and removed.

import { describe, expect, it, vi } from 'vitest';
import { harness, chapter } from '../webmcp/tools/testHarness.js';
import type { SandboxStore } from '../context/SandboxContext.js';
import type { ProjectSummary } from '../storage/projects.js';
import { createHostBridge } from './hostBridge.js';

const summary = (id: string, origin?: string): ProjectSummary => ({
  id, name: `book ${id}`, createdAt: 1, updatedAt: 1, chapterCount: 1, ...(origin ? { origin } : {}),
});

function setup(projects: ProjectSummary[] = [], initial = {}) {
  const removed: string[] = [];
  const h = harness({ projects, ...initial }, {});
  const store = h.host.store;
  let counter = 0;
  const projectActions = {
    importBundleBytes: vi.fn(async (_bytes: Uint8Array, _name: string, opts?: { origin?: string }) => {
      const id = `p${++counter}`;
      store.dispatch({ type: 'UPSERT_PROJECT_SUMMARY', payload: summary(id, opts?.origin) });
      store.dispatch({ type: 'SET_ACTIVE_PROJECT', payload: { id } });
      store.dispatch({ type: 'SET_BOOK', payload: { chapters: [chapter('x', 'Imported', 'imported text')], activeChapterId: 'x' } });
      return id;
    }),
    remove: vi.fn(async (id: string) => {
      removed.push(id);
      store.dispatch({ type: 'REMOVE_PROJECT_SUMMARY', payload: id });
    }),
    bundleProject: vi.fn(async () => new Uint8Array([80, 75, 3, 4])),
  };
  const bridge = createHostBridge({
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    projectActions,
  } as unknown as Pick<SandboxStore, 'getSnapshot' | 'subscribe' | 'projectActions'>);
  return { h, store, bridge, projectActions, removed };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('subscribe', () => {
  it('reports a text edit once per change and not a change of the view', async () => {
    const { store, bridge } = setup();
    const heard = vi.fn();
    bridge.subscribe(heard);
    store.dispatch({ type: 'SET_PANEL', payload: 'markdown' });
    await settle();
    expect(heard).not.toHaveBeenCalled();
    store.dispatch({ type: 'SET_MARKDOWN', payload: 'edited' });
    await settle();
    expect(heard).toHaveBeenCalledTimes(1);
    store.dispatch({ type: 'SET_MARKDOWN', payload: 'edited' });
    await settle();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('reports a design change, and stops after the unsubscribe', async () => {
    const { store, bridge } = setup();
    const heard = vi.fn();
    const stop = bridge.subscribe(heard);
    store.dispatch({ type: 'SET_CONFIG', payload: { ...store.getSnapshot().config, locale: 'fr' } as never });
    await settle();
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    store.dispatch({ type: 'SET_MARKDOWN', payload: 'again' });
    await settle();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('does not report a chapter rebuilt with the same text', async () => {
    const { store, bridge } = setup();
    const heard = vi.fn();
    bridge.subscribe(heard);
    const s = store.getSnapshot();
    store.dispatch({ type: 'SET_BOOK', payload: { chapters: s.chapters.map((c) => ({ ...c })), activeChapterId: s.activeChapterId } });
    await settle();
    expect(heard).not.toHaveBeenCalled();
  });
});

describe('openBundle', () => {
  it('does not report the changes opening makes, but the edits after it', async () => {
    const { store, bridge, projectActions } = setup();
    const heard = vi.fn();
    bridge.subscribe(heard);
    const id = await bridge.openBundle(new Uint8Array([1]), { origin: 'book:abc' });
    await settle();
    expect(id).toBe('p1');
    expect(projectActions.importBundleBytes).toHaveBeenCalledWith(expect.any(Uint8Array), 'book.postext', { origin: 'book:abc' });
    expect(store.getSnapshot().markdown).toBe('imported text');
    expect(heard).not.toHaveBeenCalled();
    store.dispatch({ type: 'SET_MARKDOWN', payload: 'imported text, edited' });
    await settle();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('removes the earlier projects of the same origin and only those', async () => {
    const { bridge, removed } = setup([summary('old1', 'book:abc'), summary('old2', 'book:abc'), summary('other', 'book:zzz'), summary('mine')]);
    await bridge.openBundle(new Uint8Array([1]), { origin: 'book:abc' });
    expect(removed.sort()).toEqual(['old1', 'old2']);
  });

  it('waits for the store to load before it looks for earlier projects', async () => {
    const { h, store, bridge, projectActions } = setup([], { storeReady: false });
    const opened = bridge.openBundle(new Uint8Array([1]), { origin: 'book:abc' });
    await settle();
    expect(projectActions.importBundleBytes).not.toHaveBeenCalled();
    store.dispatch({ type: 'UPSERT_PROJECT_SUMMARY', payload: summary('old', 'book:abc') });
    store.dispatch({ type: 'SET_STORE_READY' } as never);
    await opened;
    expect(h.get().storeReady).toBe(true);
    expect(projectActions.remove).toHaveBeenCalledWith('old', { offScreen: true });
  });
});

describe('exportBundle', () => {
  it('hands back the bytes of the project actions', async () => {
    const { bridge } = setup();
    expect(await bridge.exportBundle()).toEqual(new Uint8Array([80, 75, 3, 4]));
  });
});
