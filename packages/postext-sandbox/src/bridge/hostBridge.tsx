'use client';

// A way for a host page to keep the book on screen in a store of its own
// (a server): hand it a `.postext` to open, take the book back as one, and
// hear about edits. Renderless, mounted inside the providers like the
// WebMCP tools; the host reaches it through `onBridgeReady`.

import { useEffect, useRef } from 'react';
import { useSandboxStore, type SandboxState, type SandboxStore } from '../context/SandboxContext.js';

export interface SandboxBookBridge {
  /** Open `bytes` (a `.postext`) as the book of `origin`, dropping the
   *  projects an earlier call left under the same origin, so the book is
   *  always what `bytes` hold and never a copy kept in the browser. The
   *  changes opening makes are not reported to `subscribe`. Resolves to
   *  the project's id once the book is on screen. */
  openBundle: (bytes: Uint8Array, opts: { origin: string }) => Promise<string>;
  /** The book on screen as a `.postext`, with what the Sandbox has so far. */
  exportBundle: () => Promise<Uint8Array>;
  /** Called when the book's text, design, resources or title differ from
   *  what they were; returns the function that stops it. */
  subscribe: (listener: () => void) => () => void;
}

type BridgeStore = Pick<SandboxStore, 'getSnapshot' | 'subscribe' | 'projectActions'>;

const READY_TIMEOUT_MS = 15_000;

interface Content {
  chapters: SandboxState['chapters'];
  config: SandboxState['config'];
  resources: SandboxState['resources'];
  name: string | undefined;
}

const contentOf = (s: SandboxState): Content => ({
  chapters: s.chapters,
  config: s.config,
  resources: s.resources,
  name: s.activeProjectId === null ? undefined : s.projects.find((p) => p.id === s.activeProjectId)?.name,
});

function sameContent(a: Content, b: Content): boolean {
  if (a.name !== b.name) return false;
  if (a.chapters !== b.chapters) {
    if (a.chapters.length !== b.chapters.length) return false;
    for (let i = 0; i < a.chapters.length; i++) {
      const x = a.chapters[i]!;
      const y = b.chapters[i]!;
      if (x !== y && (x.id !== y.id || x.title !== y.title || x.markdown !== y.markdown)) return false;
    }
  }
  // The reducer builds new objects for changes that leave the values as
  // they were (defaults applied on open), so references alone would report
  // an edit.
  if (a.config !== b.config && JSON.stringify(a.config) !== JSON.stringify(b.config)) return false;
  if (a.resources !== b.resources && JSON.stringify(a.resources) !== JSON.stringify(b.resources)) return false;
  return true;
}

function waitFor(store: BridgeStore, ready: (s: SandboxState) => boolean, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ready(store.getSnapshot())) return resolve();
    const stop = store.subscribe(() => {
      if (!ready(store.getSnapshot())) return;
      clearTimeout(timer);
      stop();
      resolve();
    });
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`The Sandbox did not become ready: ${what}`));
    }, READY_TIMEOUT_MS);
  });
}

export function createHostBridge(store: BridgeStore): SandboxBookBridge {
  const listeners = new Set<() => void>();
  let opening = 0;
  let seen = contentOf(store.getSnapshot());

  let unwatch: (() => void) | null = null;
  const onStoreChange = () => {
    const now = contentOf(store.getSnapshot());
    if (now.chapters === seen.chapters && now.config === seen.config && now.resources === seen.resources && now.name === seen.name) return;
    const changed = !sameContent(seen, now);
    seen = now;
    if (changed && opening === 0) for (const l of [...listeners]) l();
  };

  return {
    async openBundle(bytes, { origin }) {
      // Projects are listed once the store has loaded: before that the
      // earlier copy would not be found.
      await waitFor(store, (s) => s.storeReady && !s.booting, 'store ready');
      opening++;
      try {
        const earlier = store.getSnapshot().projects.filter((p) => p.origin === origin).map((p) => p.id);
        const id = await store.projectActions.importBundleBytes(bytes, 'book.postext', { origin });
        await waitFor(store, (s) => s.activeProjectId === id && !s.bookLoading, 'book on screen');
        for (const old of earlier) {
          if (old !== id) await store.projectActions.remove(old, { offScreen: true }).catch(() => undefined);
        }
        seen = contentOf(store.getSnapshot());
        return id;
      } finally {
        opening--;
      }
    },
    exportBundle: () => store.projectActions.bundleProject(),
    subscribe(listener) {
      if (listeners.size === 0) {
        seen = contentOf(store.getSnapshot());
        unwatch = store.subscribe(onStoreChange);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) { unwatch?.(); unwatch = null; }
      };
    },
  };
}

export function HostBridge({ onReady }: { onReady: (bridge: SandboxBookBridge) => void }) {
  const store = useSandboxStore();
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => {
    onReadyRef.current(createHostBridge(store));
  }, [store]);
  return null;
}
