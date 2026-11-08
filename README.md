# AutoDoor × DeepSeek Harness 集成开发成果（DSH 侧）

> 本仓库独立保存 **AutoDoor 自动化 AI 执行流程** 中属于 **DeepSeek Harness（DSH）侧** 的全部开发成果。
> AutoDoor 主仓库（`autodoor_behavior_tree`）不作改动；本仓库内容与主仓库分离管理。

---

## 1 这是什么

把 AutoDoor 行为树自动化系统（Python）的能力，封装为 DSH Agent 可调用的 **12 个模型工具**（`autodoor_*`），
让用户在 Agent 界面用自然语言对话驱动桌面自动化。

```
用户(GUI 对话) → DSH Agent(LLM 工具编排) → DSH Host 插件(12 个 autodoor_* 工具)
                → 源码版: venv python cli.py / 打包版: autodoor-cli.exe
                → AutoDoor 引擎(OCR / 视觉 / 键鼠 / 报警) → 桌面自动化
```

## 2 目录结构

```
dsh_integration/
├── start-dsh.bat             # 一键启动 DSH Web（双击即可，含 Node 版本检测）
├── autodoor_preset/          # DSH 代理预设（核心交付，安装到 DSH 后跨会话 / 跨重启可用）
│   ├── autodoor-tools-v2.mjs # 12 个工具的本地 ESM 插件
│   ├── agent.cordis.yml      # DSH 预设组合配置（引用上面的插件行）
│   └── preset.yml            # 预设元数据（显示名「AutoDoor 自动化」）
├── docs/                     # 开发与部署文档
│   ├── 10_DeepSeekHarness_AI驱动能力接入分析.md   # 技术分析与路线决策
│   ├── 11_AutoDoor自动化AI执行流程_使用文档.md     # 面向使用者的操作手册
│   └── 部署手册-AI-Agent执行版.md                  # 纯净 PC 从零部署（AI Agent 可直接执行）
└── examples/                 # AI 流程实测产物示例（「发货成功检测」场景）
    ├── plan_fahuo_example.json   # 意图分析产物 plan.json
    └── tree_fahuo_example.json   # 生成的行为树 tree.json
```

## 3 12 个工具一览

**能力发现**

| 工具 | 作用 |
| --- | --- |
| `autodoor_list_plugins` | 列出已加载插件及其节点（插件节点类型名形如 `插件名.节点类型`） |
| `autodoor_list_nodes` | 列出 29 种内置节点规格（参数名 / 类型 / 默认值 / 说明） |

**设计与落盘**

| 工具 | 作用 |
| --- | --- |
| `autodoor_generate` | 自然语言 → 意图分析 → 生成 `plan.json` / `structure.json` |
| `autodoor_save_structure` | 把 Agent 推理出的节点结构落盘为 tree.json |
| `autodoor_create_plugin` | 按模板生成一个插件骨架（plugin.json + main.py + nodes.py） |

**素材制作**

| 工具 | 作用 |
| --- | --- |
| `autodoor_assets_add` | 登记一条视觉素材：裁剪模板 PNG、提取主色、换算客户区坐标、写入 `assets/manifest.json`；支持 `refineColor` 把 VLM 粗框按颜色连通域精修 |
| `autodoor_assets_verify` | 校验 manifest 与模板文件一致性，返回逐条状态与错误 / 警告 |

**运行与观测**

| 工具 | 作用 |
| --- | --- |
| `autodoor_validate` | 校验 tree.json 结构（根节点为 Start、无自引用、条件节点需子节点、序列化往返） |
| `autodoor_run` | **后台**以 headless 运行行为树，立即返回 runId；检测到插件节点会自动加 `--plugins` |
| `autodoor_status` | 查询后台运行状态与已收集输出 |
| `autodoor_read_log` | 按字节偏移读取运行日志，支持增量拉取 |
| `autodoor_stop` | 停止后台运行（终止进程树） |

## 4 部署

**本仓库是部署 DSH 侧的完整入口**：clone 本仓库即可同时拿到部署手册和手册 S6 需要的全部工具插件文件。

```bash
git clone https://github.com/wdhq4261761/autodoor-dsh-integration.git
```

| 部署内容 | 位置 | 说明 |
| --- | --- | --- |
| 部署手册（AI Agent 执行版） | [`docs/部署手册-AI-Agent执行版.md`](docs/部署手册-AI-Agent执行版.md) | 面向 AI Agent 的可机读步骤，人类可当核对清单；覆盖纯净 Windows PC 从零到端到端联调 |
| 12 个工具插件（手册 S6 所需程序） | [`autodoor_preset/`](autodoor_preset/) | `autodoor-tools-v2.mjs` / `agent.cordis.yml` / `preset.yml` |
| 预设运行说明与路径配置 | 本文 §5 | `AUTODOOR_ROOT` / `AUTODOOR_CLI` / `AUTODOOR_PY` |
| AutoDoor 本体 | [autodoor_behavior_tree 主仓库](https://github.com/wdhq4261761/autodoor_behavior_tree) | 源码方案 clone + venv，或用同版本打包产物 |

手册步骤概览（S1–S8，均带成功判据与失败分支）：

```
S1 Node.js 22 → S2/S2' AutoDoor 运行时（源码 / 打包二选一） → S3 本体验证
→ S4 初始化 DSH → S5 视觉插件 → S6 安装 12 工具（本仓库 autodoor_preset）
→ S7 profile 注册预设 → S8 端到端联调
```

## 5 安装到 DSH（仅预设部分，跳过完整部署时看这节）

把 `autodoor_preset/` 下的三个文件复制到 DSH 用户预设目录：

```
C:\Users\<用户名>\.dsh\.agent-presets\autodoor\
├── autodoor-tools-v2.mjs
├── agent.cordis.yml
└── preset.yml
```

新建 Agent 会话时选择预设 **「AutoDoor 自动化」** 即可获得 12 个工具。

### 5.1 路径配置

插件支持两种运行形态，由 `AUTODOOR_ROOT` 下的文件存在性自动判定，也可用环境变量显式指定：

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `AUTODOOR_ROOT` | AutoDoor 根目录（源码版是项目根，打包版是 exe 所在目录） | 脚本内默认值 |
| `AUTODOOR_CLI` | 直接指定 CLI 可执行文件（打包版） | `<ROOT>/autodoor-cli.exe` |
| `AUTODOOR_PY` | 直接指定 Python 解释器（源码版） | `<ROOT>/venv/Scripts/python.exe` |

判定规则：

1. `AUTODOOR_CLI` 存在 → 直接调用该 exe
2. `<ROOT>/autodoor-cli.exe` 存在 → 按打包版处理，**不依赖 Python**
3. 否则 → 按源码版处理，用 `AUTODOOR_PY` 或 `<ROOT>/venv/Scripts/python.exe` 调 `cli.py`

> 换机时只需设置 `AUTODOOR_ROOT`，不必再改脚本内的硬编码路径。
> 打包版务必调用同目录的 `autodoor-cli.exe` 而非图形版 exe——图形版没有 stdout，工具拿到的输出永远是空串。

### 5.2 一键启动 DSH（start-dsh.bat）

不想敲 `npx` 命令的话，**clone 本仓库后回到仓库根目录，双击 `start-dsh.bat`** 即可启动 DSH Web。
等价于 `npx -y --registry=https://registry.npmmirror.com @deepseek-ai/dsh web`，但多做了三件事：

1. **版本固定** `DSH_VER=0.2.1-rc.5`——与部署手册和教程录屏同版本，避免 npm `latest` 升级后界面 / 插件行为对不上；想跟新版改脚本里的 `set "DSH_VER=..."` 一行即可
2. **Node 检测**——没装 Node 或版本低于 22 时不再闪退，而是停在窗口里给出下载地址（nodejs.org）与升级提示，与视觉插件的 Node 22 硬门槛对齐
3. **`call npx` + 退出码处理**——失败时打印退出码与三类常见原因（网络不通 / 端口占用 / 版本过低），不再无提示退出

脚本会 `cd` 到 `%USERPROFILE%` 再启动：DSH 配置在 `%USERPROFILE%\.dsh`，与工作目录无关；若留在仓库根目录启动，DSH 会把整个仓库当项目根。

> ⚠️ **改动此文件必须保存为 ANSI / GBK 编码 + CRLF 换行**（仓库已用 `.gitattributes` 强制 checkout 为 CRLF）。
> cmd.exe 按字节读 `.bat` 且不认 UTF-8 声明，存成 UTF-8 后中文会被切碎当命令执行，报一堆 `'xxx' 不是内部或外部命令`。
> **不要用 GitHub 网页编辑器修改此文件**——网页端默认存 UTF-8，一保存就乱码。

> Agent / 自动化场景请继续用部署手册 S4 的 `npx` 命令（需要后台启动 + 端口探测），双击脚本适合真人操作。

## 6 开发历程（摘要）

1. **路线决策**：路线 A（结构化模型工具插件）为主开发主线；路线 B（CLI 直接调用）放弃；路线 C（HTTP 长驻桥）预留。
2. **第 1 步**：最小插件（5 工具 validate / run / status / stop / read_log）。
3. **第 2 步**：AI 闭环（+ list_nodes / generate）。
4. **第 3 步**：持久化为代理预设 `autodoor`（本地 ESM 插件 + agent.cordis.yml）。
5. **第 3.5 步**：完整 8 工具闭环（+ 后台 AI 流水线），端到端验证通过。
6. **第 4 步（AutoDoor V2.0.0）**：扩到 12 工具，新增素材制作（`assets_add` / `assets_verify`）、插件脚手架（`create_plugin`）、能力发现（`list_plugins`）与 `save_structure`；执行层改为双形态自适应，支持免安装包直接调用。

## 7 相关链接

| 仓库 | 地址 | 说明 |
| --- | --- | --- |
| AutoDoor 主仓库（行为树引擎本体） | <https://github.com/wdhq4261761/autodoor_behavior_tree> | 源码部署 clone 此仓库，或使用其 Releases 的打包产物；本仓库的 12 个工具全部通过其 CLI（`cli.py` / `autodoor-cli.exe`）驱动引擎 |
| 本仓库（DSH 集成） | <https://github.com/wdhq4261761/autodoor-dsh-integration> | DSH 代理预设 + 12 个模型工具 + 部署手册；`dsh_integration\` 目录在主仓库中不入库，仅在此处分发 |

> 版本配套：两边仓库按同号 tag 对应（AutoDoor V2.0.0 ↔ 本仓库 v2.0.0）。预设依赖 CLI 的具体命令，
> 主仓库大版本升级后请同步更新本仓库并重新打 tag。
