import { normalizePath } from '@remote/core';
import * as vscode from 'vscode';

export type RemoteUriDescriptor = {
  adapterId: string;
  repositoryId: string;
  ref: string;
  path: string;
};

export function createRemoteUri(adapterId: string, repositoryId: string, ref: string, path = ''): vscode.Uri {
  const normalized = normalizePath(path);
  if (!repositoryId || normalizePath(repositoryId) !== repositoryId || repositoryId.includes('/')) {
    throw new Error(`Invalid repository ID: ${repositoryId}`);
  }
  const segments = [repositoryId, ...normalized.split('/').filter(Boolean)];
  return vscode.Uri.from({
    scheme: 'remote',
    authority: adapterId,
    path: `/${segments.join('/')}`,
    query: `ref=${encodeURIComponent(ref)}`,
  });
}

export function parseRemoteUri(uri: vscode.Uri): RemoteUriDescriptor | undefined {
  if (uri.scheme !== 'remote' || !uri.authority) {
    return undefined;
  }
  const segments = uri.path.split('/').filter(Boolean);
  const repositoryId = segments.shift();
  const ref = new URLSearchParams(uri.query).get('ref');
  if (!repositoryId || !ref) {
    return undefined;
  }
  return {
    adapterId: uri.authority,
    repositoryId,
    ref,
    path: normalizePath(segments.join('/')),
  };
}

export function sessionKey(descriptor: Omit<RemoteUriDescriptor, 'path'>): string {
  return `${descriptor.adapterId}\0${descriptor.repositoryId}\0${descriptor.ref}`;
}
