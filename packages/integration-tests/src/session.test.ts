import { MemoryOverlayStorage, RemoteConflictError, RepositorySession } from '@remote/core';
import { FakeRemoteAdapter } from '@remote/fake-adapter';
import { describe, expect, it } from 'vitest';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('repository session', () => {
  it('merges and persists overlay changes, then clears them after commit', async () => {
    const adapter = new FakeRemoteAdapter();
    const storage = new MemoryOverlayStorage();
    const session = await RepositorySession.open(adapter, 'demo', 'main', storage);
    await session.writeFile('README.md', encoder.encode('local edit'), { create: false, overwrite: true });
    await session.writeFile('new.txt', encoder.encode('new file'), { create: true, overwrite: false });

    const reopened = await RepositorySession.open(adapter, 'demo', 'main', storage);
    expect(decoder.decode(await reopened.readFile('README.md'))).toBe('local edit');
    expect((await reopened.getChanges()).map((change) => change.type).sort()).toEqual(['added', 'modified']);

    const commit = await reopened.commit('Save overlay');
    expect(reopened.hasChanges).toBe(false);
    expect(decoder.decode(await adapter.readFile('demo', commit.id, 'new.txt'))).toBe('new file');
  });

  it('rebases overlays when remote changes do not overlap', async () => {
    const adapter = new FakeRemoteAdapter();
    const session = await RepositorySession.open(adapter, 'demo', 'main', new MemoryOverlayStorage());
    await session.writeFile('README.md', encoder.encode('local'), { create: false, overwrite: true });
    const remote = await adapter.applyRemoteCommit('demo', 'main', 'Remote guide', [
      { path: 'docs/guide.md', content: encoder.encode('remote') },
    ]);

    expect(await session.refresh()).toEqual({ previousHead: 'c0002', remoteHead: remote.id, conflicts: [] });
    expect(session.baseCommit).toBe(remote.id);
    expect(decoder.decode(await session.readFile('README.md'))).toBe('local');
  });

  it('keeps overlays and marks conflicts when remote changes overlap', async () => {
    const adapter = new FakeRemoteAdapter();
    const session = await RepositorySession.open(adapter, 'demo', 'main', new MemoryOverlayStorage());
    await session.writeFile('README.md', encoder.encode('local'), { create: false, overwrite: true });
    await adapter.applyRemoteCommit('demo', 'main', 'Remote README', [
      { path: 'README.md', content: encoder.encode('remote') },
    ]);

    const result = await session.refresh();
    expect(result.conflicts).toEqual(['README.md']);
    expect(decoder.decode(await session.readFile('README.md'))).toBe('local');
    await expect(session.commit('Must fail')).rejects.toBeInstanceOf(RemoteConflictError);
  });

  it('detects remote files added below a locally deleted directory', async () => {
    const adapter = new FakeRemoteAdapter();
    const session = await RepositorySession.open(adapter, 'demo', 'main', new MemoryOverlayStorage());
    await session.delete('docs', true);
    await adapter.applyRemoteCommit('demo', 'main', 'Add nested remote file', [
      { path: 'docs/new.md', content: encoder.encode('remote') },
    ]);

    expect((await session.refresh()).conflicts).toEqual(['docs/new.md']);
    expect(session.baseCommit).toBe('c0002');
  });

  it('reduces rename followed by delete to a source deletion', async () => {
    const adapter = new FakeRemoteAdapter();
    const session = await RepositorySession.open(adapter, 'demo', 'main', new MemoryOverlayStorage());
    await session.rename('README.md', 'README.txt', false);
    await session.delete('README.txt', false);

    expect(await session.getChanges()).toEqual([{ path: 'README.md', type: 'deleted', originalPath: null }]);
  });

  it('supports create, delete, rename, and discard without mutating remote state early', async () => {
    const adapter = new FakeRemoteAdapter();
    const session = await RepositorySession.open(adapter, 'demo', 'main', new MemoryOverlayStorage());
    const base = session.baseCommit;
    await session.createDirectory('notes');
    await session.writeFile('notes/a.txt', encoder.encode('a'), { create: true, overwrite: false });
    await session.rename('notes/a.txt', 'notes/b.txt', false);
    await session.delete('docs', true);
    expect((await session.getChanges()).map((change) => change.type).sort()).toEqual(['deleted', 'renamed']);
    expect(await adapter.readFile('demo', base, 'docs/guide.md')).toBeDefined();
    await session.discardAll();
    expect(session.hasChanges).toBe(false);
  });
});
