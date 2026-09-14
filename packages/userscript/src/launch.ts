import { BitbucketDataCenterAdapter, encodeRepositoryId } from '@remote/bitbucket-datacenter-adapter';
import type { BitbucketPageContext } from './context.js';

export async function resolveLaunchRef(
  context: BitbucketPageContext,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<string> {
  if (context.ref) return context.ref;
  const adapter = new BitbucketDataCenterAdapter({ apiBaseUrl: apiBaseUrl(context), fetch: fetcher });
  const repository = await adapter.getRepository(repositoryId(context));
  if (!repository.defaultBranch) throw new Error('Bitbucket did not return a default branch.');
  return repository.defaultBranch;
}

export function createWorkbenchUrl(
  workbenchUrl: URL,
  context: BitbucketPageContext,
  ref: string,
  capability: string,
): URL {
  const url = new URL(workbenchUrl);
  const folderQuery = new URLSearchParams({
    ref,
    'remote-bb-dc-capability': capability,
    'remote-bb-dc-origin': context.origin,
  });
  url.searchParams.set('folder', `remote://bitbucket-datacenter/${repositoryId(context)}?${folderQuery}`);
  url.hash = new URLSearchParams({
    'remote-bb-dc-capability': capability,
    'remote-bb-dc-origin': context.origin,
  }).toString();
  return url;
}

export function apiBaseUrl(context: BitbucketPageContext): string {
  return new URL(`${context.contextPath}/rest/api/1.0/`, context.origin).toString();
}

export function launchContextKey(context: BitbucketPageContext): string {
  return JSON.stringify([
    context.origin,
    context.contextPath,
    context.project,
    context.repository,
    context.ref ?? '',
  ]);
}

function repositoryId(context: BitbucketPageContext): string {
  return encodeRepositoryId({ project: context.project, repository: context.repository });
}
