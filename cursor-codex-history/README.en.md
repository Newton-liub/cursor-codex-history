# cursor-codex-history (English)

> This repository is **AI-generated** (with human review and testing).
>
> References and inspiration:
> - Linux.do topic: https://linux.do/t/topic/1588536
> - Sworddust/codex-history: https://github.com/Sworddust/codex-history
>
> Trademark / affiliation notice:
> - This is an unofficial project and is not affiliated with, endorsed by, or sponsored by OpenAI or Anysphere.

`cursor-codex-history` saves Codex conversation history from Cursor and Codex local rollouts into an external store.

It supports:
- `list`
- `preview`
- `export`
- `archive`
- `recover`
- `delete --force`
- `reindex`

## Language

- [English](README.en.md)
- [中文](README.zh-CN.md)

## Beginner Guide

- [Beginner-friendly Chinese guide](docs/给外行看的安装说明和功能介绍.md)

## Open Source Docs

- [LICENSE](LICENSE)
- [NOTICE](NOTICE)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [SECURITY.md](SECURITY.md)

## Design

- Does **not** write to Cursor internal DB (`state.vscdb`)
- Reads from:
  - `~/.cursor/projects/*/agent-transcripts/*/*.jsonl`
  - `~/.codex/sessions/**/*.jsonl`
- Writes to external store (default): `~/.cursor-codex-history`

Store layout:
- `raw/`
- `normalized/`
- `exports/`
- `archive/`
- `index.sqlite`

## Usage

Quick install:

```bash
bash scripts/install.sh --with-service
```

If your environment has no user systemd session, installer will keep skill install and skip service with warnings.
In that case, use:

```bash
bash scripts/install.sh --without-service
```

Quick uninstall:

```bash
bash scripts/uninstall.sh
```

CLI usage:

```bash
npm run history -- reindex
npm run history -- list --limit 20
npm run history -- preview --session-id <id>
npm run history -- export --session-id <id> --output ./exports/<id>.md
npm run history -- archive --session-id <id>
npm run history -- recover --session-id <id>
npm run history -- delete --session-id <id> --force
```

From any directory (after install), you can also run:

```bash
node ~/.codex/skills/cursor-codex-history/scripts/history-cli.js list --limit 20 --json
```

Run sync daemon (watch + periodic full scan every 10 min):

```bash
npm run sync
```

One-shot sync:

```bash
npm run sync -- --once
```

NPM shortcuts:

```bash
npm run install:local
npm run install:service
npm run uninstall:local
```

## JSON Mode

Add `--json` to any CLI command for machine-readable output.

## Safety

- `delete` requires `--force`
- `export --output` is restricted to current working directory subtree
- delete only removes external history store data, not original Cursor/Codex source files

## Compatibility

- Linux/macOS path conventions supported
- Windows can be added later

## Install Troubleshooting

- `target already exists`: re-run with `--force`.
- `systemd user session is unavailable`: install with `--without-service` first; later run `bash scripts/install.sh --with-service --force` in a normal login session.
- `read-only filesystem` or cannot write `~/.codex` / `~/.cursor-codex-history`: run in a normal shell with writable home directory (or set writable `CODEX_HOME` / `CURSOR_CODEX_HISTORY_HOME`).
