import type * as vscode from 'vscode';

const BITBUCKET_TOKEN_KEY = 'remote.bitbucket.apiToken';
const BITBUCKET_EMAIL_KEY = 'remote.bitbucket.email';

export class BitbucketCredentialStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  getToken(): Thenable<string | undefined> {
    return this.secrets.get(BITBUCKET_TOKEN_KEY);
  }

  getEmail(): Thenable<string | undefined> {
    return this.secrets.get(BITBUCKET_EMAIL_KEY);
  }

  setToken(token: string): Thenable<void> {
    return this.secrets.store(BITBUCKET_TOKEN_KEY, token);
  }

  setEmail(email: string): Thenable<void> {
    return this.secrets.store(BITBUCKET_EMAIL_KEY, email);
  }

  clearToken(): Thenable<void> {
    return this.secrets.delete(BITBUCKET_TOKEN_KEY);
  }

  clearEmail(): Thenable<void> {
    return this.secrets.delete(BITBUCKET_EMAIL_KEY);
  }
}
