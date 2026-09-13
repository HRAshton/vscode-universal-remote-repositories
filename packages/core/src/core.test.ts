import { describe, expect, it } from 'vitest';
import {
  decodeBase64,
  encodeBase64,
  MemoryOverlayStorage,
  normalizePath,
  overlayStorageKey,
  RemoteError,
} from './index.js';

describe('core utilities', () => {
  it('normalizes safe repository paths and rejects traversal', () => {
    expect(normalizePath('/src\\index.ts/')).toBe('src/index.ts');
    expect(() => normalizePath('../secret')).toThrow(RemoteError);
  });

  it('round-trips binary overlay content', () => {
    const content = new Uint8Array([0, 1, 127, 128, 255]);
    expect(decodeBase64(encodeBase64(content))).toEqual(content);
  });

  it('isolates overlay storage by adapter, repository, and ref', async () => {
    const storage = new MemoryOverlayStorage();
    const identity = { adapterId: 'fake', repositoryId: 'demo' };
    const snapshot = { version: 1 as const, baseCommit: 'c1', entries: {}, deletedPaths: [], renames: [] };
    await storage.set(identity, 'main', snapshot);

    expect(await storage.get(identity, 'main')).toEqual(snapshot);
    expect(await storage.get(identity, 'other')).toBeUndefined();
    expect(overlayStorageKey(identity, 'main')).toBe('remote.overlay.v1.fake/demo?ref=main');
  });
});
