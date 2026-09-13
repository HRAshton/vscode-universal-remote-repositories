# Contributing

Use Node.js 22 and pnpm 10. Run `pnpm install --frozen-lockfile`, then `pnpm run ci` before submitting a
change. Provider implementations must keep immutable reads pinned to commit IDs, normalize remote errors,
follow pagination, preserve credentials inside SecretStorage, and pass adapter contract tests.
