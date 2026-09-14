export type BitbucketPageContext = {
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
