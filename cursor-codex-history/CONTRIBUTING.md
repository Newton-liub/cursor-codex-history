# Contributing

Thanks for your interest in improving `cursor-codex-history`.

## Ways to Contribute

- Report bugs
- Improve docs
- Add tests
- Propose features
- Submit fixes

## Before You Start

- Search existing issues/PRs first to avoid duplicates.
- For large changes, open an issue first to discuss scope and design.

## Development Setup

```bash
cd cursor-codex-history
npm test
```

No external runtime dependencies are required beyond Node.js (>=22).

## Pull Request Guidelines

- Keep PRs focused and small.
- Add or update tests for behavior changes.
- Update docs when user-facing behavior changes.
- Preserve safety guarantees:
  - `delete` must require `--force`
  - do not mutate Cursor internal DB
  - keep path safety restrictions intact

## Commit & Review Notes

- Prefer clear commit messages.
- Include context in PR description:
  - what changed
  - why it changed
  - how to test

## Licensing

By contributing, you agree your contributions are licensed under the MIT License in [LICENSE](LICENSE).
