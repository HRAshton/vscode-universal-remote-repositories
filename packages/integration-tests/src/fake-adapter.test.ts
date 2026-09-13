import { RemoteConflictError } from '@remote/core';
import { FakeRemoteAdapter } from '@remote/fake-adapter';
import { describe, expect, it } from 'vitest';
import { describeAdapterContract } from './adapter-contract.js';

describeAdapterContract('fake', () => new FakeRemoteAdapter());

describe('fake adapter atomicity', () => {
  it('atomically rejects concurrent stale-parent commits', async () => {
    const adapter = new FakeRemoteAdapter();
    const expectedHead = await adapter.resolveRef('demo', 'main');
    const changes = [{ path: 'README.md', content: new TextEncoder().encode('winner') }];

    const results = await Promise.allSettled([
      adapter.commit('demo', 'main', 'first', expectedHead, changes),
      adapter.commit('demo', 'main', 'second', expectedHead, changes),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(RemoteConflictError);
    expect(await adapter.resolveRef('demo', 'main')).toBe(fulfilled[0]?.value.id);
  });
});
