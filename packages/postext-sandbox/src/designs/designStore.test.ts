import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteSavedDesign,
  getSavedDesign,
  listSavedDesigns,
  onSavedDesignsChange,
  putSavedDesign,
  setSavedDesignStorage,
  type SavedDesign,
  type SavedDesignStorage,
} from './designStore.js';

const design = (id: string): SavedDesign => ({
  id,
  name: `Design ${id}`,
  parts: [],
  createdAt: 1,
  updatedAt: 2,
  bytes: new Uint8Array([1, 2, 3]).buffer,
});

function fakeStorage(): SavedDesignStorage & { rows: Map<string, SavedDesign> } {
  const rows = new Map<string, SavedDesign>();
  return {
    rows,
    list: vi.fn(async () => [...rows.values()]),
    get: vi.fn(async (id: string) => rows.get(id) ?? null),
    put: vi.fn(async (d: SavedDesign) => { rows.set(d.id, d); }),
    delete: vi.fn(async (id: string) => { rows.delete(id); }),
  };
}

afterEach(() => setSavedDesignStorage(null));

describe('saved design storage', () => {
  it('sends list/get/put/delete to the set storage and notifies listeners', async () => {
    const fake = fakeStorage();
    setSavedDesignStorage(fake);
    const listener = vi.fn();
    const off = onSavedDesignsChange(listener);

    await putSavedDesign(design('a'));
    expect(fake.put).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect((await listSavedDesigns()).map((d) => d.id)).toEqual(['a']);
    expect((await getSavedDesign('a'))?.name).toBe('Design a');
    expect(await getSavedDesign('missing')).toBeNull();
    await deleteSavedDesign('a');
    expect(fake.delete).toHaveBeenCalledWith('a');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(await listSavedDesigns()).toEqual([]);
    off();
  });

  it('does not notify when the storage fails, and surfaces the error', async () => {
    const fake = fakeStorage();
    fake.put = vi.fn(async () => { throw new Error('offline'); });
    setSavedDesignStorage(fake);
    const listener = vi.fn();
    const off = onSavedDesignsChange(listener);
    await expect(putSavedDesign(design('a'))).rejects.toThrow('offline');
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it('goes back to the default (IndexedDB) after setSavedDesignStorage(null)', async () => {
    const fake = fakeStorage();
    setSavedDesignStorage(fake);
    setSavedDesignStorage(null);
    // IndexedDB does not exist in node: the default rejects, and the fake is untouched.
    await expect(listSavedDesigns()).rejects.toThrow();
    expect(fake.list).not.toHaveBeenCalled();
  });
});
