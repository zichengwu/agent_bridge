# 最小示例项目

该目录是一个无外部依赖的本地项目，用于演示 Agent Bridge 的工作区、项目基线和验收命令。先在本目录初始化 Git 并提交基线，再把 `config/agent-bridge.example.yaml` 中的绝对路径指向本目录、独立 runtime 目录和这里的 `project-baseline.json`。

示例只证明无凭据合同与本地验证流程，不会启动真实 Provider。任务合同可从 `config/task-contracts/` 选择；把 `project_id`、`base_commit`、分支、验收命令和 `content_hash` 更新为当前项目事实后，再调用 MCP 工具。

```bash
npm run verify
```
