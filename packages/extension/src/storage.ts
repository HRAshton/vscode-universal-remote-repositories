import {
  decodeBase64,
  overlayStorageKey,
  type OverlaySnapshot,
  type OverlayStorage,
  type RepositoryIdentity,
} from '@remote/core';
import type * as vscode from 'vscode';

export class MementoOverlayStorage implements OverlayStorage {
  constructor(private readonly memento: vscode.Memento) {}

  async get(identity: RepositoryIdentity, ref: string): Promise<OverlaySnapshot | undefined> {
    const value: unknown = this.memento.get(overlayStorageKey(identity, ref));
    return isOverlaySnapshot(value) ? structuredClone(value) : undefined;
  }

  async set(identity: RepositoryIdentity, ref: string, snapshot: OverlaySnapshot): Promise<void> {
    await this.memento.update(overlayStorageKey(identity, ref), snapshot);
  }

  async clear(identity: RepositoryIdentity, ref: string): Promise<void> {
    await this.memento.update(overlayStorageKey(identity, ref), undefined);
  }
}

function isOverlaySnapshot(value: unknown): value is OverlaySnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const entries = candidate.entries;
  const renames = candidate.renames;
  return (
    candidate.version === 1 &&
    typeof candidate.baseCommit === 'string' &&
    candidate.baseCommit.length > 0 &&
    Boolean(entries) &&
    typeof entries === 'object' &&
    Object.values(entries as Record<string, unknown>).every(isOverlayEntry) &&
    Array.isArray(candidate.deletedPaths) &&
    candidate.deletedPaths.every((path) => typeof path === 'string') &&
    Array.isArray(renames) &&
    renames.every(isRenameRecord)
  );
}

function isOverlayEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const entry = value as Record<string, unknown>;
  if ((entry.type !== 'file' && entry.type !== 'directory') || typeof entry.contentBase64 !== 'string') {
    return false;
  }
  if (entry.type === 'directory') {
    return entry.contentBase64 === '';
  }
  try {
    decodeBase64(entry.contentBase64);
    return true;
  } catch {
    return false;
  }
}

function isRenameRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const rename = value as Record<string, unknown>;
  return typeof rename.from === 'string' && typeof rename.to === 'string';
}
