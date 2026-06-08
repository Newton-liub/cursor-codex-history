# cursor-codex-history（中文）

> 本仓库为 **AI 生成**（人工复核与测试）。
>
> 参考与灵感来源：
> - Linux.do 主题帖：https://linux.do/t/topic/1588536
> - Sworddust/codex-history：https://github.com/Sworddust/codex-history
>
> 商标与隶属关系声明：
> - 本项目为非官方项目，与 OpenAI、Anysphere 无隶属、无背书、无赞助关系。

`cursor-codex-history` 用于把 Cursor 与 Codex 的本地会话历史保存到外部历史仓库，并提供管理能力。

支持命令：
- `list`
- `preview`
- `export`
- `archive`
- `recover`
- `delete --force`
- `reindex`

## 语言切换

- [English](README.en.md)
- [中文](README.zh-CN.md)

## 外行友好说明

- [给外行看的安装说明和功能介绍](docs/给外行看的安装说明和功能介绍.md)

## 开源规范文档

- [LICENSE](LICENSE)
- [NOTICE](NOTICE)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [SECURITY.md](SECURITY.md)

## 设计说明

- **不会**写入 Cursor 内部数据库（`state.vscdb`）
- 读取来源：
  - `~/.cursor/projects/*/agent-transcripts/*/*.jsonl`
  - `~/.codex/sessions/**/*.jsonl`
- 写入外部历史仓库（默认）：`~/.cursor-codex-history`

目录结构：
- `raw/`
- `normalized/`
- `exports/`
- `archive/`
- `index.sqlite`

## 使用方式

快速安装：

```bash
bash scripts/install.sh --with-service
```

如果当前环境没有可用的 user systemd 会话，安装器会保留 skill 安装并跳过服务安装（给出警告）。
此时可先用：

```bash
bash scripts/install.sh --without-service
```

快速卸载：

```bash
bash scripts/uninstall.sh
```

CLI 常用命令：

```bash
npm run history -- reindex
npm run history -- list --limit 20
npm run history -- preview --session-id <id>
npm run history -- export --session-id <id> --output ./exports/<id>.md
npm run history -- archive --session-id <id>
npm run history -- recover --session-id <id>
npm run history -- delete --session-id <id> --force
```

安装后也可在任意目录直接运行：

```bash
node ~/.codex/skills/cursor-codex-history/scripts/history-cli.js list --limit 20 --json
```

启动同步守护进程（实时监听 + 每 10 分钟补偿扫描）：

```bash
npm run sync
```

只执行一次同步：

```bash
npm run sync -- --once
```

NPM 快捷命令：

```bash
npm run install:local
npm run install:service
npm run uninstall:local
```

## JSON 输出

在任意 CLI 命令后增加 `--json`，可获得机器可读输出。

## 安全约束

- `delete` 必须带 `--force`
- `export --output` 只能写到当前工作目录子路径
- 删除只影响外部历史仓库，不影响 Cursor/Codex 原始源日志

## 兼容性

- 当前支持 Linux/macOS 路径约定
- Windows 后续可补充

## 安装排障（基于真实安装问题）

- 报错 `target already exists`：使用 `--force` 重装。
- 提示 user systemd 不可用：先 `--without-service` 安装，后续在正常登录会话中执行 `bash scripts/install.sh --with-service --force`。
- 出现只读文件系统或无法写入 `~/.codex` / `~/.cursor-codex-history`：请在可写 HOME 的正常终端执行，或显式设置可写的 `CODEX_HOME` / `CURSOR_CODEX_HISTORY_HOME`。
