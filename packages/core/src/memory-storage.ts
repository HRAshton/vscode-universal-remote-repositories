import type { OverlaySnapshot, OverlayStorage, RepositoryIdentity } from './types.js';

export class MemoryOverlayStorage implements OverlayStorage {
  private readonly values = new Map<string, OverlaySnapshot>();

  async get(identity: RepositoryIdentity, ref: string): Promise<OverlaySnapshot | undefined> {
    const value = this.values.get(storageKey(identity, ref));
    return value ? structuredClone(value) : undefined;
  }

  async set(identity: RepositoryIdentity, ref: string, snapshot: OverlaySnapshot): Promise<void> {
    this.values.set(storageKey(identity, ref), structuredClone(snapshot));
  }

  async clear(identity: RepositoryIdentity, ref: string): Promise<void> {
    this.values.delete(storageKey(identity, ref));
  }
}

export function overlayStorageKey(identity: RepositoryIdentity, ref: string): string {
  return `remote.overlay.v1.${encodeURIComponent(identity.adapterId)}/${encodeURIComponent(identity.repositoryId)}?ref=${encodeURIComponent(ref)}`;
}

function storageKey(identity: RepositoryIdentity, ref: string): string {
  return `${identity.adapterId}\0${identity.repositoryId}\0${ref}`;
}
