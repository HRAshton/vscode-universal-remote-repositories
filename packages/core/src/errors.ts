export type RemoteErrorCode =
  | 'not-found'
  | 'conflict'
  | 'validation'
  | 'unsupported'
  | 'authentication'
  | 'permission'
  | 'rate-limit'
  | 'unavailable'
  | 'cancelled';

export class RemoteError extends Error {
  constructor(
    readonly code: RemoteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}

export class RemoteConflictError extends RemoteError {
  constructor(
    message: string,
    readonly expectedHead: string,
    readonly actualHead: string,
    readonly conflictingPaths: string[] = [],
  ) {
    super('conflict', message);
    this.name = 'RemoteConflictError';
  }
}

export function notFound(subject: string): RemoteError {
  return new RemoteError('not-found', `${subject} was not found.`);
}

export function invalid(message: string): RemoteError {
  return new RemoteError('validation', message);
}
