import { describe, expect, it, vi } from 'vitest';
import { disconnectBridgePort } from './bridge-port.js';

describe('Bitbucket bridge port lifecycle', () => {
  it('notifies the client before closing a replaced port', () => {
    const operations: string[] = [];
    const port = {
      postMessage: vi.fn((value: unknown) => operations.push(`message:${JSON.stringify(value)}`)),
      close: vi.fn(() => operations.push('close')),
    } as unknown as MessagePort;

    disconnectBridgePort(port);

    expect(operations).toEqual(['message:{"type":"disconnect"}', 'close']);
  });
});
