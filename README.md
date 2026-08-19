# AutoDoor × DeepSeek Harness 集成开发成果（DSH 侧）

> 本仓库独立保存 **AutoDoor 自动化 AI 执行流程** 中属于 **DeepSeek Harness（DSH）侧** 的全部开发成果。
> AutoDoor 主仓库（`autodoor_behavior_tree`）不作改动；本仓库内容与主仓库分离管理。

---

## 1. 这是什么

把 AutoDoor 行为树自动化系统（Python）的能力，封装为 DSH Agent 可调用的 8 个模型工具（`autodoor_*`），
让用户在 Agent 界面用自然语言对话驱动桌面自动化。

```
用户(GUI 对话) → DSH Agent(LLM 工具编排) → DSH Host 插件(8 个 autodoor_* 工具)
                → venv python cli.py(子进程桥接) → AutoDoor 引擎(OCR/键鼠/报警) → 桌面自动化
```

## 2. 目录结构

```
dsh_integration/
├── autodoor_preset/          # DSH 代理预设（核心交付，安装到 DSH 后跨会话/跨重启可用）
│   ├── autodoor-tools-v2.mjs # 8 个工具的本地 ESM 插件（validate/run/status/stop/read_log/list_nodes/ai_create/ai_pipeline）
│   ├── agent.cordis.yml      # DSH 预设组合配置（引用上面的插件行）
│   └── preset.yml            # 预设元数据（显示名「AutoDoor 自动化」）
├── docs/                     # 开发文档（从 AutoDoor 主仓库 md/ 复制的副本）
│   ├── 10_DeepSeekHarness_AI驱动能力接入分析.md   # 技术分析与路线决策
│   └── 11_AutoDoor自动化AI执行流程_使用文档.md     # 面向使用者的操作手册
└── examples/                 # AI 流程实测产物示例（"发货成功检测"场景）
    ├── plan_fahuo_example.json   # 意图分析产物 plan.json
    └── tree_fahuo_example.json   # 生成的行为树 tree.json
```

## 3. 8 个工具一览

| 工具 | 作用 |
|---|---|
| `autodoor_ai_create` | 自然语言 → 意图分析 → `plan.json` |
| `autodoor_list_nodes` | 列出 29 种节点规格，供选型 |
| `autodoor_ai_pipeline` | **后台**执行 AI 流水线单阶段（plan/select/scan/generate/validate/test/refine） |
| `autodoor_validate` | 校验 tree.json 结构 |
| `autodoor_run` | **后台**运行行为树（headless），返回 runId |
| `autodoor_status` | 查询后台运行状态 |
| `autodoor_read_log` | 读取运行日志（含执行统计） |
| `autodoor_stop` | 停止后台运行 |

## 4. 安装到 DSH（使用方式）

将 `autodoor_preset/` 下的文件复制到 DSH 用户预设目录：

```
C:\Users\<用户名>\.dsh\.agent-presets\autodoor\
```

新建 Agent 会话时选择预设 **`AutoDoor 自动化`** 即可获得 8 个工具。

> 注意：`autodoor-tools-v2.mjs` 内硬编码了本机路径（`D:\workspace\autodoor_behavior_tree\...` 与
> npm-cache 中 `@deepseek-ai/dsh-tools` 的绝对 file:// 导入地址）。换机时需按目标环境更新这两处路径。

## 5. 开发历程（摘要）

1. **路线决策**：路线 A（结构化模型工具插件）为主开发主线；路线 B（CLI 直接调用）放弃；路线 C（HTTP 长驻桥）预留。
2. **第 1 步**：最小插件（5 工具 validate/run/status/stop/read_log）。
3. **第 2 步**：AI 闭环（+ list_nodes / ai_create）。
4. **第 3 步**：持久化为代理预设 `autodoor`（本地 ESM 插件 + agent.cordis.yml）。
5. **第 3.5 步**：完整 8 工具闭环（+ ai_pipeline 后台化 AI 流水线），端到端验证通过。

## 6. 相关链接

- AutoDoor 主仓库：`git@github.com:wdhq4261761/autodoor_behavior_tree.git`
- 本仓库：见 git remote
