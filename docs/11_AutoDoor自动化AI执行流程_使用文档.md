# AutoDoor 自动化 AI 执行流程 — 整体说明与使用文档

> 面向使用者（在 DeepSeek Harness Agent 界面以自然语言对话驱动 AutoDoor 完成桌面自动化）的操作手册。
> 配套技术分析见 [10_DeepSeekHarness_AI驱动能力接入分析.md](./10_DeepSeekHarness_AI驱动能力接入分析.md)。

---

## 1. 这是什么

本方案把 **AutoDoor 行为树自动化系统**（Python，负责屏幕感知 OCR/图像、键鼠操作、消息总线）的能力，封装成 **DeepSeek Harness（DSH）Agent 的可调用工具**。用户在 Agent 界面用自然语言描述想要完成的自动化任务，AI（LLM）负责理解意图、编排工具调用、生成行为树并执行，最终在桌面上完成自动化。

一句话流程：

```
用户(GUI 对话：自然语言任务)
   │
   ▼
DSH Agent（LLM 意图理解 + 工具编排）
   │  8 个 autodoor_* 模型工具
   ▼
DSH Host 插件（Node.js，子进程桥接）
   │  venv python cli.py ...
   ▼
AutoDoor 引擎（headless 行为树运行）
   │  OCR / 图像匹配 → 键鼠操作 → 报警 / 总线 / 外部集成
   ▼
桌面自动化完成（或按轮询日志/统计汇报）
```

---

## 2. 工具全景（8 个 autodoor_* 工具）

当前开发完成并验证的 **8 个模型工具**，覆盖「规划 → 生成 → 校验 → 执行 → 监控 → 停止」全生命周期：

| 工具 | 作用 | 包装的 CLI | 耗时 |
|---|---|---|---|
| `autodoor_ai_create` | 自然语言 → 意图分析 → `plan.json`（任务概述/循环/阶段/窗口） | `ai plan <描述>` | 秒级（1 次 LLM） |
| `autodoor_list_nodes` | 列出全部 29 种节点规格（复合/条件/动作），供选型 | `ai nodes` | 秒级 |
| `autodoor_ai_pipeline` | **后台**执行 AI 流水线单阶段：plan/select/scan/generate/validate/test/refine | `ai <stage> <file>` | 秒级~数分钟（select/scan/refine 为长耗时 LLM，已后台化） |
| `autodoor_validate` | 校验 tree.json 结构（根节点/自引用/条件子节点/序列化） | `ai validate <tree>` | 秒级 |
| `autodoor_run` | **后台**运行行为树（headless），返回 runId | `run <tree> --headless` | 立即返回 |
| `autodoor_status` | 查询后台运行状态与已收集输出 | （进程内轮询） | 即时 |
| `autodoor_read_log` | 按字节偏移读取运行日志（含执行统计） | （进程内轮询） | 即时 |
| `autodoor_stop` | 停止后台运行（终止进程树） | （进程内终止） | 即时 |

> **长耗时命令全部后台化**：`autodoor_run` 与 `autodoor_ai_pipeline` 启动后立即返回 `runId`，不阻塞模型步骤；后续用 `autodoor_status` / `autodoor_read_log` 轮询、`autodoor_stop` 停止。这是实测 `ai select` 数分钟级 LLM 耗时后的关键设计。

---

## 3. 环境与前置条件

### 3.1 需要的组件

| 组件 | 位置 / 说明 |
|---|---|
| AutoDoor 工程 | `D:\workspace\autodoor_behavior_tree` |
| Python venv | `D:\workspace\autodoor_behavior_tree\venv\Scripts\python.exe`（Python 3.12.4） |
| CLI 入口 | `venv\Scripts\python.exe cli.py`（9 命令组：run/status/stop/schedule/daemon/remote/plugin/config/ai） |
| AI API Key（LLM） | 已配置：`ai.llm.api_key`（火山引擎 ark / deepseek-v4-flash），用于 `plan/select/refine` |
| AI API Key（VLM，可选） | `ai.vlm.api_key`，仅 `scan`（屏幕感知参数填充）需要，未配置则跳过该阶段 |
| DSH 动态插件 | `autd-3`（当前会话运行中，pkg-8 含完整 8 工具） |
| DSH 代理预设 | `autodoor`（`C:\Users\WINDOWS\.dsh\.agent-presets\autodoor\`，跨会话/跨重启可用，8 工具） |

### 3.2 使用方式 A：当前会话（动态插件已加载）

当前 Agent 会话已通过动态插件 `autd-3` 注册 8 个 `autodoor_*` 工具，**直接对话即可使用**。

### 3.3 使用方式 B：新会话 / 跨重启（推荐）

新建 Agent 会话时，选择预设 **`AutoDoor 自动化`（id: `autodoor`）**。该预设从 `standard` 复制而来（保留全部基础编码能力），并挂载 8 个 `autodoor_*` 工具。选择后该会话即可对话驱动自动化，且**进程重启后依然可用**。

---

## 4. 完整使用流程

### 4.1 标准流程（AI 全自动编排）

向 Agent 描述任务，AI 会自动按以下顺序编排工具（也可手动指定顺序）：

```
① autodoor_ai_create（任务描述）
   → 生成 .ai/plan.json（任务计划）
② autodoor_list_nodes（按需）
   → 获取 29 种节点规格供选型
③ autodoor_ai_pipeline stage=select
   → 生成 .ai/structure.json（节点结构，LLM 选型，数分钟）
④ autodoor_ai_pipeline stage=scan（可选，需 VLM key）
   → 生成 .ai/structure_filled.json（屏幕感知参数填充）
⑤ autodoor_ai_pipeline stage=generate
   → 生成 .ai/tree.json（行为树 JSON，纯规则生成，秒级）
⑥ autodoor_validate（.ai/tree.json）
   → 结构校验通过 ✓
⑦ autodoor_run（.ai/tree.json）
   → 返回 runId，后台执行
⑧ autodoor_status / autodoor_read_log（runId）
   → 轮询执行状态 / 读取日志与统计
⑨ autodoor_stop（runId，按需）
   → 提前停止
```

### 4.2 实际示例：检测"发货成功"并报警

**用户对话**：
> 每 3 秒检测屏幕是否出现"发货成功"文字，出现则播放报警音并停止，重复 50 次

**AI 自动执行的工具链与产物**（已实测通过）：

| 步骤 | 调用 | 结果 |
|---|---|---|
| 意图分析 | `autodoor_ai_create` | plan.json：`循环 是(3000ms, 50次)` + 2 阶段（detect OCR"发货成功" → act alarm）|
| 生成 | `autodoor_ai_pipeline stage=generate` | tree.json：`StartNode → SequenceNode(50次/3s) → OCRConditionNode("发货成功") → AlarmNode → StopTreeNode`（6 节点/5 连接）|
| 校验 | `autodoor_validate` | `校验通过 ✓ 节点数: 6 连接数: 5` |
| 运行 | `autodoor_run` | `runId: autodoor-1, pid: ...` |
| 状态 | `autodoor_status` | `running: true` |
| 日志 | `autodoor_read_log` | 完整执行统计（时长 / Tick 数 / 成功率 / 耗时节点）|
| 停止 | `autodoor_stop` | `ok: true` |

**生成的树结构示意**：

```
StartNode
└── SequenceNode (repeat_count=50, repeat_interval_ms=3000)
    ├── OCRConditionNode (keywords="发货成功")  →  AlarmNode (报警)  →  StopTreeNode (停止)
    └── DelayNode (1000ms)
```

### 4.3 手动控制流程（AI 不自动，逐步执行）

也可要求 AI 逐步执行、每步确认。例如：
1. `autodoor_ai_create`（"登录网页"）→ 查看 plan.json
2. `autodoor_list_nodes` → 了解可用节点
3. 要求 AI 直接编写 tree.json（基于节点规格）→ `autodoor_validate`
4. `autodoor_run` → 确认环境安全后执行

---

## 5. 节点选型速查（29 种）

AI 选型时依据 `autodoor_list_nodes` 输出，常用节点与典型场景：

| 场景 | 节点 |
|---|---|
| 屏幕出现某文字 | `OCRConditionNode`（keywords/language/preprocess_mode） |
| 屏幕出现某图标/图片 | `ImageConditionNode`（template_path/threshold） |
| 屏幕颜色变化 | `ColorConditionNode`（target_color/tolerance） |
| 点击 | `MouseClickNode`（use_blackboard 读取检测位置） |
| 键盘 | `KeyPressNode` |
| 移动/拖拽 | `MouseMoveNode` |
| 输入文本 | `TextInputNode` |
| 延时 | `DelayNode` |
| 播放报警音 | `AlarmNode`（volume） |
| 停止当前树 | `StopTreeNode`（target_tree 留空） |
| 顺序/循环 | `SequenceNode`（repeat_count / repeat_interval_ms） |
| 任一成功即继续 | `SelectorNode` |
| 变量判断 | `VariableConditionNode` / `SetVariableNode` |
| 调外部脚本 | `ScriptNode` / `CodeNode` |
| HTTP 请求 / API 条件 | `HTTPRequestNode` / `APIConditionNode` |
| 消息总线发布 / 订阅 | `MessagePublishNode` / `MessageSubscribeNode` |

> 行为树语义：**条件节点检测成功才执行其子节点**；**StartNode 顺序执行子节点**；循环通过 `SequenceNode.repeat_count` + `repeat_interval_ms` 实现。

---

## 6. 文件产物（.ai/ 目录）

AI 流水线在 `D:\workspace\autodoor_behavior_tree\.ai\` 下产出中间文件：

| 文件 | 内容 | 生成阶段 |
|---|---|---|
| `plan.json` | 任务计划（task_summary/loop/phases/window） | `ai plan` / `ai_create` |
| `structure.json` | 节点结构（nodes + children + empty_params） | `ai select` |
| `structure_filled.json` | 屏幕感知填充后的结构 | `ai scan`（需 VLM） |
| `tree.json` | 最终可执行行为树 | `ai generate` |
| `test_report.json` | 试运行报告 | `ai test` |
| `screenshot.png` | 屏幕截图（scan 用） | `ai scan` |

---

## 7. 注意事项与安全

1. **运行会真实操作桌面**：`autodoor_run` 会移动鼠标、点击、输入、播放声音、OCR 截屏。**执行前请确认当前屏幕/窗口环境安全**，避免干扰正在使用的应用。
2. **`autodoor_run` 默认 headless**：不依赖 fastapi/websockets（这些服务包未安装，纯 headless 运行不受影响）。需要 REST/WS 模式时先 `pip install -r requirements.txt`。
3. **长耗时阶段已后台化**：`autodoor_ai_pipeline` 的 select/scan/refine 是数分钟级 LLM 调用，工具立即返回 runId，请用 `autodoor_status`/`read_log` 轮询而非反复重试。
4. **LLM 服务偶发慢/挂**：实测 `ai select` 在 ark 端偶发长时间无响应（10+ 分钟）。若长时间无进展，用 `autodoor_stop` 终止该 runId 后重试。
5. **交互式命令不可直接调用**：`ai create` 含多处 `input()` 确认，子进程下会提前终止。应使用单阶段 `ai plan` + 各阶段工具编排。
6. **中文编码**：工具已统一注入 `PYTHONIOENCODING=utf-8`，CLI 中文输出正常。
7. **后台任务生命周期**：插件/会话重启后，未完成的 runId 会失效（进程被终止）。跨重启的持续自动化请把行为树固化到 tree.json 后用 `autodoor_run` 重新执行。

---

## 8. 与 CLI 的对应关系（高级用户）

8 个工具本质是以下 CLI 命令的封装，高级用户可直接在终端使用：

| 工具 | CLI 等价 |
|---|---|
| `autodoor_ai_create` | `venv\Scripts\python.exe cli.py ai plan "<任务描述>"` |
| `autodoor_list_nodes` | `... ai nodes` |
| `autodoor_ai_pipeline` | `... ai <plan|select|scan|generate|validate|test|refine> [file]` |
| `autodoor_validate` | `... ai validate <tree.json>` |
| `autodoor_run` | `... run <tree.json> --headless` |

---

## 9. 故障排查速查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `autodoor_ai_create` 返回未配置 key 错误 | `ai.llm.api_key` 未配置 | `venv\Scripts\python.exe cli.py config set ai.llm.api_key "<key>"` |
| `ai scan` 报 VLM key 错误 | `ai.vlm.api_key` 未配置 | 配置 key，或跳过 scan（AI 会保持结构原样） |
| `autodoor_status` 报未知 runId | 会话重启 / 插件更新后 run 记录丢失 | 重新 `autodoor_run` |
| 日志中文乱码 | 环境变量缺失 | 工具已内置处理；手动 CLI 时加 `PYTHONIOENCODING=utf-8` |
| `autodoor_run` 后无日志 | 行为树短时运行已结束 | `read_log` 检查 `finished` 字段，看执行统计 |
| `ai select` 长时间无输出 | LLM 服务端慢/挂 | `autodoor_stop` 终止该 runId 后重试 |

---

## 10. 版本与演进

- **当前能力**：8 工具完整闭环（规划→生成→校验→执行→监控→停止）已端到端验证。
- **持久化**：`autodoor` 代理预设使能力跨会话、跨进程重启可用。
- **后续（路线 C，按需）**：把「执行抽象层」从子进程切换为 HTTP 长驻服务调用（需安装 fastapi/websockets），工具名与 schema 不变，用于跨树编排/远程控制/事件驱动场景。

---

*本文档随开发进度维护；工具行为变更时请同步更新第 2、4、5 节。*
