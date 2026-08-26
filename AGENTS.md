# AGENTS.md

This repository contains an [Agent Skill](https://agentskills.io) for one-way syncing Obsidian notes to Feishu (飞书), Tencent ima (腾讯 ima), and Notion.

- **Skill**: `skills/obsidian-sync/SKILL.md`
- **Install**: `npx skills add luffysolution-svg/obsidian-sync`
- **Requirements**: Node.js ≥ 18；飞书需 `@larksuite/cli`；ima 需 Client ID / API Key（`node skills/obsidian-sync/scripts/ima_setup.cjs` 引导配置）；Notion 需 Internal Token（`node skills/obsidian-sync/scripts/notion_setup.cjs` 引导配置，国内需代理）
- **Key features**: 幂等同步 + Notion 增量哈希缓存（v1.5.0，`--force` 全量）；清理/回滚同步产物（v1.5.1：Notion `--clean` 递归归档、飞书 `drive +delete`、ima 客户端手动删）
- **Cross-platform**: 脚本全部 Node.js（`*.cjs`）跨平台；Windows 用 PowerShell（注意 npm.ps1 执行策略，改 `cmd /c`）、macOS/Linux 用 bash；环境检测 `scripts/env_check.ps1` / `env_check.sh`（输出字段一致）
- **Test**: `node --check skills/obsidian-sync/scripts/*.cjs`；`bash -n skills/obsidian-sync/scripts/env_check.sh`
