export const SHELL_SEGMENT = '__remote-vscode__';

export type BitbucketPageContext = {
  provider: 'bitbucket-datacenter';
  origin: string;
  contextPath: string;
  project: string;
  repository: string;
  ref?: string;
};

export function parseBitbucketPage(url: URL): BitbucketPageContext | undefined {
  try {
    const segments = url.pathname.split('/').filter(Boolean);
    const projectsIndex = segments.indexOf('projects');
    if (projectsIndex < 0 || segments[projectsIndex + 2] !== 'repos') return undefined;
    const project = segments[projectsIndex + 1];
    const repository = segments[projectsIndex + 3];
    if (!project || !repository) return undefined;
    const browseIndex = projectsIndex + 4;
    const ref =
      segments[browseIndex] === 'browse' ? url.searchParams.get('at')?.trim() || undefined : undefined;
    return {
      provider: 'bitbucket-datacenter',
      origin: url.origin,
      contextPath: `/${segments.slice(0, projectsIndex).join('/')}`.replace(/^\/$/u, ''),
      project: decodeURIComponent(project),
      repository: decodeURIComponent(repository),
      ...(ref ? { ref } : {}),
    };
  } catch {
    return undefined;
  }
}

export function isShellPage(url: URL): boolean {
  return url.pathname.split('/').filter(Boolean).at(-1) === SHELL_SEGMENT;
}

export function createShellUrl(context: BitbucketPageContext): URL {
  const url = new URL(`${context.contextPath}/${SHELL_SEGMENT}/`, context.origin);
  url.hash = encodeURIComponent(JSON.stringify(context));
  return url;
}

export function parseShellContext(url: URL): BitbucketPageContext | undefined {
  try {
    const value = JSON.parse(decodeURIComponent(url.hash.slice(1))) as unknown;
    if (!value || typeof value !== 'object') return undefined;
    const context = value as Partial<BitbucketPageContext>;
    if (
      context.provider !== 'bitbucket-datacenter' ||
      context.origin !== url.origin ||
      typeof context.contextPath !== 'string' ||
      typeof context.project !== 'string' ||
      !context.project ||
      typeof context.repository !== 'string' ||
      !context.repository
    ) {
      return undefined;
    }
    const parsed: BitbucketPageContext = {
      provider: context.provider,
      origin: context.origin,
      contextPath: context.contextPath,
      project: context.project,
      repository: context.repository,
      ...(typeof context.ref === 'string' && context.ref ? { ref: context.ref } : {}),
    };
    if (createShellUrl(parsed).pathname !== url.pathname) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function parseShellPage(url: URL): BitbucketPageContext | undefined {
  return isShellPage(url) ? parseShellContext(url) : undefined;
}
