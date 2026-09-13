import { BitbucketDataCenterAdapter } from '@remote/bitbucket-datacenter-adapter';
import { invalid } from '@remote/core';
import type * as vscode from 'vscode';
import { activateRemoteRepositories } from './runtime.js';

declare const __BITBUCKET_CONTEXT_PATH__: string;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const contextPath = normalizeContextPath(__BITBUCKET_CONTEXT_PATH__);
  const origin = globalThis.location.origin;
  if (!origin || origin === 'null') {
    throw invalid('The Data Center build must run from a same-origin browser page.');
  }
  const apiBaseUrl = new URL(`${contextPath}/rest/api/1.0/`, origin).toString();
  await activateRemoteRepositories(context, [new BitbucketDataCenterAdapter({ apiBaseUrl })]);
}

export function deactivate(): void {}

function normalizeContextPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  if (!trimmed.startsWith('/') || trimmed.includes('..') || trimmed.includes('?') || trimmed.includes('#')) {
    throw invalid('Bitbucket Data Center context path must be an absolute path such as /bitbucket.');
  }
  return trimmed.replace(/\/+$/u, '');
}
