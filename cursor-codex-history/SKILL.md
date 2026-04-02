name cursor-codex-history
description 在 Cursor/Codex 环境中管理本机历史会话，支持 list、preview、export、archive、recover、delete、reindex。
license MIT

# Cursor Codex History Skill

## 适用场景
- 列举、预览本机历史会话
- 导出会话为 Markdown
- 归档/恢复会话
- 删除外部历史仓库中的会话记录
- 重建历史索引（reindex）

## 触发条件（必须同时满足）
- 用户意图属于 `list/preview/export/archive/recover/delete/reindex` 之一
- 目标是 Cursor/Codex 本地历史数据
- 可通过 `node scripts/history-cli.js` 完成

## 禁止触发
- 模糊批量删除（没有明确 session-id）
- 执行白名单之外命令
- 操作当前工作目录与外部历史仓库之外的路径

## 操作白名单

### list

    node scripts/history-cli.js list [--source all|cursor|codex] [--status active|archived|all] [--limit N] [--json]

### preview

    node scripts/history-cli.js preview --session-id <id> [--max-messages N] [--json]

### export

    node scripts/history-cli.js export --session-id <id> --output <path.md> [--json]

### archive

    node scripts/history-cli.js archive --session-id <id> [--session-id <id> ...] [--force] [--json]

### recover

    node scripts/history-cli.js recover --session-id <id> [--session-id <id> ...] [--force] [--json]

### delete

    node scripts/history-cli.js delete --session-id <id> [--session-id <id> ...] --force [--json]

### reindex

    node scripts/history-cli.js reindex [--json]

## 删除护栏（强制）
1. 必须提供明确 session-id
2. 删除命令必须携带 `--force`
3. 删除前必须提醒：仅删除外部历史仓库数据，且不可恢复（除非外部备份）
4. 删除后返回摘要：`deletedFiles`、`details`

## 统一输出
- `command`
- `sessionIds`
- `result`
- `exitCode`
- 失败时：`reason`、`nextAction`

## 退出码
- `0` 成功
- `2` 参数错误
- `3` 目标不存在
- `4` 部分失败
- `5` 未处理异常
