# AutoDoor 行为树在 DeepSeek Harness 中作为 AI 驱动能力的接入分析

> 结论先行：**可行，且已具备直接落地的条件**。AutoDoor 的底层自动化流程可以暴露为 DeepSeek Harness（DSH）Agent 的可调用能力，让用户在 Agent 界面用自然语言对话驱动 AutoDoor 完成自动化流程。
>
> **开发决策（2026-08 已定）**：
> - ✅ **路线 A（结构化模型工具插件）为后续开发主线**——在 DSH 中定义 Host 动态插件，用 `harness.registerTool` 封装 AutoDoor 能力为带 JSON Schema 的模型工具，内部经 `subprocess` 调用 venv Python CLI。
> - ❌ **路线 B（CLI 直接调用）放弃**——不做为对外交付形态；仅保留为开发期内部调试手段，不沉淀为正式能力。
> - 🔶 **路线 C（REST/WS 长驻服务桥）保留可能**——暂不开发，架构上预留，按需再启用。
>
> 本文档为分析报告，基于对本机实际环境的核验（2026-08 快照）。相关文档：[09_CLI插件与外部通信的AI拓展方向分析.md](./09_CLI插件与外部通信的AI拓展方向分析.md)、[04_消息总线与外部系统集成.md](../doc/04_消息总线与外部系统集成.md)。

---

## 1. 一句话架构

```
用户(GUI 对话) ──► DSH Agent(LLM 意图理解 / 工具编排)
                        │  harness.registerTool 注册的模型工具
                        ▼
                   DSH Host 插件(JS)
                        │  subprocess / fs / web 服务
                        ▼
                   AutoDoor Python 进程(cli.py / headless)
                        │  5 阶段 AI 流水线 + 行为树引擎
                        ▼
                   屏幕感知(OCR/图像) → 桌面操作(键鼠) → 总线/外部集成
```

关键点：**DSH 是 Node.js 宿主，AutoDoor 是独立 Python 工程，二者边界是「子进程 + 文件 + HTTP」**，Node 侧不能直接 import Python，但完全可以通过进程调用与文件交换打通。

---

## 2. 现状核验（本机实测事实）

以下均为本次分析中实际运行验证的结果：

| 事实项 | 结果 | 影响 |
|---|---|---|
| AutoDoor 独立 venv | `D:\workspace\autodoor_behavior_tree\venv\Scripts\python.exe`（Python 3.12.4） | 可直接作为子进程解释器，无需污染 DSH 环境 |
| CLI 入口 | `venv\Scripts\python.exe cli.py` 可用，9 大命令组齐全（run/status/stop/schedule/daemon/remote/plugin/config/ai） | 整条自动化链路均有命令行出口 |
| `autodoor-bt status` | 实测成功输出「未检测到运行中的守护进程」 | 最小调用已验证 |
| `autodoor-bt ai -h` | 实测列出 plan/select/scan/generate/validate/test/refine/nodes/create 9 个子命令 | AutoDoor 自带完整 AI 流水线 CLI |
| 中文编码 | 需 `PYTHONIOENCODING=utf-8`（否则 pwsh 管道下中文乱码） | 工具封装时须设置该环境变量 |
| venv 依赖缺口 | **fastapi / websockets / sse-starlette 未安装**（GUI/OCR 依赖正常） | REST/WS 服务模式需先 `pip install -r requirements.txt`；纯 `--headless` 运行与 AI 流水线不受影响 |
| DSH Host 工具注册 | `harness.registerTool(ctx, tool)` / `harness.defineTool(definition)` 已确认存在 | 可注册模型可见的结构化工具 |
| DSH Host 进程/文件能力 | `subprocess`（resolveExecutable/spawn）、`fs`（读写文本/目录）、`web`（HTTP fetch）服务已确认 | 插件内可安全调用 Python 子进程并读写 tree.json |
| DSH 后台任务 | `jobs` 服务（start/read/kill） | 长时运行的树可用后台 job 承载 |

---

## 3. 接入路线与开发决策

### 路线 A：结构化模型工具插件（✅ 主开发路线）

在 DSH 中定义一个 Host 动态插件，用 `harness.registerTool` 把 AutoDoor 的能力封装成**带 JSON Schema 的模型工具**，每个工具内部通过 `subprocess` 调用 venv Python CLI 并返回结构化结果。

拟注册工具清单（最小集）：

| 工具名 | 对应 CLI | 用途 |
|---|---|---|
| `autodoor_list_nodes` | `ai nodes` | 列出全部 28+ 节点类型与规格（供模型选型） |
| `autodoor_ai_create` | `ai create <tree.json> [--task "…"]` | 完整 5 阶段 AI 生成：意图→选型→扫描→生成→迭代 |
| `autodoor_validate` | `ai validate <tree.json>` | 结构校验 |
| `autodoor_run` | `run <tree.json> --headless [--bus/--rest/--ws/--plugins]` | 运行自动化树 |
| `autodoor_status` | `status` | 查询运行/守护状态 |
| `autodoor_stop` | `stop [tree_id] [--all]` | 停止运行 |
| `autodoor_read_log` | 读取 `logs/run_log.txt` | 获取执行结果供模型分析 |

优点：
- 模型拿到的是**结构化 schema + 明确语义**，而不是裸 shell，减少乱试。
- 工具注册属于插件 Fiber，`cordis_stop`/更新后自动清理，无残留副作用。
- 与 DSH 既有工具体系（如 `pwsh`/`read`）天然互补：模型先用 `read` 读工程文档，再用 `autodoor_*` 执行。

要点（已通过 Inspect 确认的契约）：
- Host 插件用 `harness.registerTool(ctx, { name, description, parameters, execute })`；`execute` 返回 JSON 兼容结果。
- 调用 Python 用 `subprocess.spawn({ command, args, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, cwd })`，注意工具执行环境不保证有 `child_process` 全局，必须走 `subprocess` 服务。
- 长任务（`run --headless`、`ai create`）在 `execute` 里启动**后台 job** 并立即返回 jobId，由 `autodoor_status`/`autodoor_read_log` 后续轮询，避免阻塞模型步骤。

### 路线 B：CLI 直接调用（❌ 已放弃，仅开发期内部调试用）

曾经考虑让 Agent 直接用 `pwsh` 裸调 CLI：

```pwsh
$env:PYTHONIOENCODING='utf-8'
& D:\workspace\autodoor_behavior_tree\venv\Scripts\python.exe cli.py run D:\...\tree.json --headless
```

**放弃原因**：无结构 schema，模型依赖提示词记住 CLI 用法；输出解析靠模型自行处理；不稳定、难以作为长期对外交付的能力。**仅保留为开发期手工调试手段**（本会话可临时执行验证），不沉淀为正式形态、不做 skill、不写入交付文档。

### 路线 C：REST/WS 长驻服务桥（🔶 保留可能，暂不开发）

在 AutoDoor 侧以 `run --headless --rest --ws`（或 `daemon`）长驻服务，DSH 插件通过 HTTP 调用 `/api/v1/*`（trees/blackboard/nodes/events SSE），WebSocket 订阅 `bt.**.event.**` 事件流。

- **架构预留**：路线 A 的工具封装统一走「`subprocess` 调 CLI」抽象层；若将来切换到长驻服务，只需把该抽象层的实现从「子进程一次调用」替换为「HTTP 调用」，工具名与 schema 不变，对模型透明。
- **前置条件**：须向 venv 安装 fastapi/websockets/sse-starlette（当前缺失）。
- **适用场景**（将来需要时）：跨树编排、远程控制、事件驱动的 AI 响应、多人共享一个执行器。
- **当前状态**：不开发。设计上确保与路线 A 可平滑切换、互不冲突。

---

## 4. AI 智能化分工：两种协作模式

AutoDoor **自带**一套 5 阶段 AI 流水线（意图分析→节点选型→VLM 屏幕感知→生成→试运行迭代），DSH 的模型也具备意图理解与代码生成能力。二者可组合为两种模式：

| 模式 | 谁做意图/规划 | 谁做节点/坐标 | 谁做执行 | 适用场景 |
|---|---|---|---|---|
| **模式① 借壳执行**（推荐） | DSH 模型把用户需求转成简短任务描述，调用 `autodoor_ai_create` | AutoDoor 内置 LLM+VLM 流水线 | AutoDoor 引擎 | 用户零门槛，一句话建自动化 |
| **模式② DSH 主导** | DSH 模型直接编写 tree.json（读 `ai nodes` 规格） | DSH 模型填参数（可结合截图） | `autodoor_validate` + `autodoor_run` | 需要精细控制、或想绕开外部 LLM 依赖 |

实践中推荐**混合**：DSH 模型先判断任务复杂度——简单树直接模式②，复杂/含屏幕感知的任务走模式①。

---

## 5. 用户对话驱动示例（体验流）

> 用户在 Agent 界面输入："帮我做一个自动化：每 3 秒检查一次屏幕，如果出现'发货成功'四个字就播报警音，重复 50 次。"

DSH Agent 将依次调用：
1. `autodoor_list_nodes` → 确认存在 OCRConditionNode / AlarmNode / 组合节点；
2. `autodoor_ai_create`（携带任务描述）→ AutoDoor 生成 `tree.json`（含 OCR 区域与报警配置）；
3. `autodoor_validate` → 结构通过；
4. `autodoor_run --headless`（后台 job）→ 树开始执行；
5. 周期性 `autodoor_status` + `autodoor_read_log` → 向用户汇报进度/结果；
6. 失败时 `autodoor_read_log` 分析原因，必要时 `ai refine` 迭代修正。

---

## 6. 风险与限制

| 项 | 说明 | 缓解 |
|---|---|---|
| **桌面操作安全性** | 运行树会真实移动鼠标/键盘（属预期行为），但模型误触发可能干扰用户正在用的窗口 | 关键工具 `autodoor_run` 建议先经用户确认；树中 `bind_window` 限制目标窗口；提供 `--dry-run` 式校验 |
| **venv 服务依赖缺失** | REST/WS 模式需安装 fastapi 等 | 默认走 `--headless`（不依赖缺失包）；需要服务层时先 `pip install` |
| **Node↔Python 边界** | DSH 插件不能 import Python 对象，只能进程/文件/HTTP | 已按路线 A 设计为子进程调用 + 文件交换；路线 C 走 HTTP |
| **长任务生命周期** | `run --headless` 是前台阻塞进程，若在工具内直接 await 会卡住模型步骤 | ✅ 已实现后台化：`autodoor_run`/`autodoor_ai_pipeline` 均立即返回 runId + 轮询（status/read_log/stop），生命周期端到端验证通过 |
| **插件生命周期** | 动态插件定义仅存在于当前进程，进程重启即失效 | ✅ 已沉淀为**代理预设 `autodoor`**（见第 3 步）：本地 ESM 插件 + `agent.cordis.yml` 行，跨会话、跨进程重启仍可用 |
| **中文编码** | pwsh 管道下 CLI 中文输出乱码 | 统一注入 `PYTHONIOENCODING=utf-8` |
| **GUI 不可无头驱动** | Tkinter/CustomTkinter 界面无法在 headless 会话中打开 | 一律使用 `--headless` 模式 |

---

## 7. 落地路线图（以路线 A 为主线）

> **开发进度（2026-08 更新）**：第 1 步「最小可用插件」✅ 完成；第 2 步「AI 闭环」✅ 完成；第 3 步「持久化预设」✅ 完成。

1. **第 1 步（最小可用）✅ 已完成**：实现「路线 A」最小插件（`autd-3`）——注册 5 个工具 `autodoor_validate` / `autodoor_run` / `autodoor_status` / `autodoor_stop` / `autodoor_read_log`，全部走 `subprocess.spawn` 子进程 + 插件作用域 Map 管理后台任务（runId 轮询），并已建立**执行抽象层**（`execCli(args)`，当前实现=子进程调 venv CLI；将来路线 C 切换为 HTTP 调用时只需替换此函数）。端到端已验证：`venv python cli.py ai validate .ai/tree.json` 返回退出码 0 与「校验通过 ✓」。
2. **第 2 步（AI 闭环）✅ 已完成**：在 `autd-3` 追加 Package `pkg-4`（运行中 run-3），新增 2 个工具：
   - `autodoor_list_nodes` — 调用 `ai nodes`（无交互、退出码 0），返回全部 29 种节点规格（含参数/类型/默认值），供模型选型；
   - `autodoor_ai_create` — 调用 `ai plan <描述>`（单阶段无交互），将自然语言交给 AutoDoor 内置 LLM 做意图分析，生成 `.ai/plan.json`（含任务概述/循环/阶段/窗口绑定）。
   
   端到端已验证：`ai plan` 真实调用已配置 LLM（火山引擎 ark / deepseek-v4-flash）生成结构完整的 `.ai/plan.json`（退出码 0）。
   
   **设计要点**：`ai create` 是多处 `input()` 的**交互式命令**，子进程（stdin=ignore）下会在首个确认点提前终止，因此 `autodoor_ai_create` 不直接包装 `ai create`，而是包装无交互的单阶段 `ai plan`；完整 5 阶段（plan→select→scan→generate→test/refine）由模型基于 plan.json 逐阶段编排。
3. **第 3 步（持久化）✅ 已完成**：沉淀为**代理预设（agent preset）`autodoor`**，使 7 个工具跨会话、跨进程重启仍可用。
   - 位置：`C:\Users\WINDOWS\.dsh\.agent-presets\autodoor\`（用户预设根，从 `standard` 预设 `copy` 而来，保留全部基础编码能力）。
   - 结构：`agent.cordis.yml`（composition，追加一行）＋ `autodoor-tools-v2.mjs`（本地 ESM 插件）＋ `preset.yml`（显示名「AutoDoor 自动化」）。
   - 关键机制：DSH 预设插件行的 `name` 支持**绝对路径**——Cordis 以 Node ESM `import()` 加载该 `.mjs`，`export default` 一个 Cordis 插件对象（`{ name, apply(ctx) }`），在 `apply` 内用 `ctx.get('subprocess')` + `ctx.get('tools')` 解析 host 服务，经 `defineTool` + `ctx.tools.register` 注册 7 个工具（与动态插件 autd-3/pkg-4 代码等价）。
   - **踩坑记录**（供后续维护）：
     1. 预设环境**没有**动态插件的 `harness` 全局——必须 `import { defineTool } from ...` + `ctx.tools.register`，不能用 `harness.defineTool/registerTool`。
     2. 本地 `.mjs` 位于用户主目录，Node ESM **无法从文件位置解析 DSH 私有包**（`~/.dsh` 向上没有 harness 的 node_modules）——`import` 需用绝对 `file:///` URL 指向 `@deepseek-ai/dsh-tools/lib/index.js`。
     3. 变量名冲突：`const tools = ctx.get('tools')` 与工具数组 `var tools = [...]` 撞名，报 `Identifier 'tools' has already been declared`——注册服务改名为 `toolRegistry`。
     4. **Node ESM 缓存**：首次加载失败的 `.mjs` 会留缓存，改文件后需换文件名（v2）强制重载。
   - **验证**：`agentPresets.standingKeyFor('autodoor')` mount 通过；`tools.schemas(standingKey)` 确认作用域内可见全部 7 个 `autodoor_*` 工具；`autodoor_validate`（退出码 0 校验通过）与 `autodoor_ai_create`（LLM 真实解析出循环/阶段）端到端实测通过。
3.5. **第 3.5 步（完整闭环）✅ 已完成**：打通并端到端验证「自然语言 → 行为树 → 后台执行」的 **8 工具完整闭环**。
    - 动态插件 `autd-3/pkg-8`（运行中 run-7）注册完整 8 工具：`validate` / `run` / `status` / `stop` / `read_log` / `list_nodes` / `ai_create` / **`ai_pipeline`**。
    - **新增 `autodoor_ai_pipeline`**：把 AI 流水线的 plan/select/scan/generate/validate/test/refine 各阶段**后台化**执行（立即返回 runId，用 status/read_log 轮询）——这是实测 `ai select` 发现 select/scan/refine 是**数分钟级 LLM 长耗时**操作后的关键设计。
    - **踩坑（重要）**：cordis_define 的 existing 模式是**追加** Package，但 `cordis_run update` 是**整体切换**到目标 Package——pkg-7 只写了 `ai_pipeline` 一个工具，update 后原 7 工具全部丢失。**每个新 Package 必须包含完整工具集**（pkg-8 已修复）。
    - **端到端验证**（真实场景「每 3 秒检测"发货成功"→ 报警 → 停止，重复 50 次」）：
      - `ai_create` → plan.json：循环(3000ms/50次) + 2 阶段（OCR 检测 → 报警）✅
      - `ai_pipeline stage=generate` → tree.json：StartNode → SequenceNode(50次/3s) → OCRConditionNode("发货成功") → AlarmNode → StopTreeNode（6 节点/5 连接）✅
      - `validate` → 校验通过 ✓（6 节点 5 连接）✅
      - `run` → runId；`status` → running=true；`read_log` → 完整执行统计（10025ms/217 tick）；`stop` → 幂等终止 ✅
      - **注**：`ai select` 实测在 ark LLM 端挂起 10+ 分钟（CPU 0、established 连接无响应）被手动终止——属 LLM 服务端偶发慢/挂，已用后台化 + 轮询规避；`generate`（无 LLM 纯规则生成）瞬时完成。
4. **第 4 步（路线 C 预留，按需）**：若出现跨树编排/远程控制/事件驱动需求，把「执行抽象层」从子进程切换为 HTTP 长驻服务调用，工具名与 schema 保持不变。

---

## 8. 参考契约（Inspect 已核验）

- DSH Host 工具注册：`harness.registerTool(ctx, tool)`、`harness.defineTool(definition)`（Builtin `harness`）。
- DSH Host 进程：`subprocess.spawn(spec)`、`subprocess.resolveExecutable(command, env)`（Service `subprocess`）。
- DSH Host 文件：`fs.readText/writeText/editText/listDir`（Service `fs`）。
- DSH Host 后台任务：`jobs.start/read/kill/wait`（Service `jobs`）。
- DSH Host HTTP：`web.fetch(request)`（Service `web`）。
- AutoDoor CLI：`cli.py` 9 命令组；`ai` 组 9 子命令（含 `create` 完整流程）。
- AutoDoor REST（若启用）：`/api/v1/health、auth/*、trees/*、blackboard/*、nodes/*、events/stream(SSE)`。
- AutoDoor 消息总线主题：`bt.{tree_id}.event.**`、`bt.{tree_id}.data.blackboard.changed`。
