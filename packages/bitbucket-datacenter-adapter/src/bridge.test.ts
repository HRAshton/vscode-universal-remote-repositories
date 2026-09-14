import type { AdapterCapabilities, RemoteAdapter } from '@remote/core';
import { describe, expect, it } from 'vitest';
import {
  BitbucketDataCenterBridgeServer,
  connectBitbucketDataCenterBridge,
  createBridgeLaunch,
  createBridgeLaunchFromQuery,
  relayBitbucketDataCenterBridge,
} from './bridge.js';

const capabilities: AdapterCapabilities = {
  writeFiles: false,
  manageBranches: true,
  createPullRequests: true,
  statuses: false,
  pipelines: false,
};

describe('Bitbucket Data Center bridge', () => {
  it('accepts only a well-formed launch fragment', () => {
    const url = new URL(
      'http://localhost:8080/#remote-bb-dc-capability=12345678901234567890123456789012&remote-bb-dc-origin=https%3A%2F%2Fstash.test',
    );
    expect(createBridgeLaunch(url)).toEqual({
      capability: '12345678901234567890123456789012',
      bitbucketOrigin: 'https://stash.test',
    });
    expect(
      createBridgeLaunch(
        new URL(
          'http://localhost:8080/#remote-bb-dc-capability=short&remote-bb-dc-origin=https%3A%2F%2Fstash.test',
        ),
      ),
    ).toBeUndefined();
    expect(
      createBridgeLaunchFromQuery(
        'ref=main&remote-bb-dc-capability=12345678901234567890123456789012&remote-bb-dc-origin=https%3A%2F%2Fstash.test',
      ),
    ).toEqual({
      capability: '12345678901234567890123456789012',
      bitbucketOrigin: 'https://stash.test',
    });
  });

  it('relays the opener port into an extension-host worker channel', async () => {
    const launch = {
      capability: 'abcdefghijklmnopqrstuvwxyz123456',
      bitbucketOrigin: 'https://stash.test',
    };
    const opener = {
      postMessage: (_message: unknown, _targetOrigin: string, transfer: Transferable[]) => {
        const port = transfer[0];
        if (!(port instanceof MessagePort)) throw new Error('Expected bridge message port.');
        new BitbucketDataCenterBridgeServer(
          {
            listRepositories: async () => [
              { id: 'one', name: 'One', description: '', defaultBranch: 'main' },
            ],
          } as RemoteAdapter,
          capabilities,
        ).attach(port);
      },
    } as unknown as Pick<Window, 'postMessage'>;
    const dispose = relayBitbucketDataCenterBridge(launch, opener);

    try {
      const adapter = await connectBitbucketDataCenterBridge({ launch });
      await expect(adapter.listRepositories()).resolves.toEqual([
        { id: 'one', name: 'One', description: '', defaultBranch: 'main' },
      ]);
    } finally {
      dispose();
    }
  });

  it('dispatches typed operations and rejects unknown operations', async () => {
    const { port1, port2 } = new MessageChannel();
    new BitbucketDataCenterBridgeServer(
      {
        listRepositories: async () => [{ id: 'one', name: 'One', description: '', defaultBranch: 'main' }],
      } as RemoteAdapter,
      capabilities,
    ).attach(port1);
    const messages: unknown[] = [];
    port2.onmessage = (event) => messages.push(event.data);
    port2.start();
    await waitFor(() => messages.length === 1);
    port2.postMessage({ type: 'request', id: 1, operation: 'listRepositories', arguments: [] });
    port2.postMessage({ type: 'request', id: 2, operation: 'fetch', arguments: ['https://evil.test'] });
    await waitFor(() => messages.length === 2);
    expect(messages).toEqual([
      { type: 'ready', version: 1, capabilities },
      {
        type: 'response',
        id: 1,
        result: [{ id: 'one', name: 'One', description: '', defaultBranch: 'main' }],
      },
    ]);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for bridge message.');
}
