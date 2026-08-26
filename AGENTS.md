# AGENTS.md

This repository contains an [Agent Skill](https://agentskills.io) for one-way syncing Obsidian notes to Feishu (飞书), Tencent ima (腾讯 ima), and Notion.

- **Skill**: `skills/obsidian-sync/SKILL.md`
- **Install**: `npx skills add luffysolution-svg/obsidian-sync`
- **Requirements**: Node.js ≥ 18；飞书需 `@larksuite/cli`；ima 需 Client ID / API Key（`node skills/obsidian-sync/scripts/ima_setup.cjs` 引导配置）；Notion 需 Internal Token（`node skills/obsidian-sync/scripts/notion_setup.cjs` 引导配置，国内需代理）
