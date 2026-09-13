import { invalid } from './errors.js';

export function normalizePath(path: string): string {
  const normalized = path
    .replaceAll('\\', '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');
  if (!normalized) {
    return '';
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.length === 0)) {
    throw invalid(`Invalid repository path: ${path}`);
  }

  return segments.join('/');
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join('/'));
}

export function parentPath(path: string): string | null {
  const normalized = normalizePath(path);
  if (!normalized) {
    return null;
  }

  const separator = normalized.lastIndexOf('/');
  return separator < 0 ? '' : normalized.slice(0, separator);
}

export function baseName(path: string): string {
  const normalized = normalizePath(path);
  const separator = normalized.lastIndexOf('/');
  return separator < 0 ? normalized : normalized.slice(separator + 1);
}

export function isSameOrChild(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}
