# 部署手册 · AI Agent 执行版

> **读者是 AI Agent，不是人。**
> 本文把整套部署拆成"检查 → 动作 → 判据 → 失败分支"的可机读步骤，每一步都有明确的、由命令输出决定的成功判据。
> 人类读者也可用它做核对清单，但请以命令输出为准，不要以描述为准。
>
> 适用：Windows 10/11 x64 纯净机器，目标是把 AutoDoor 行为树 + DSH Agent + 视觉插件跑到可用状态。
>
> **本文存放在 autodoor-dsh-integration 仓库**：S6 需要的 12 个工具插件文件就在本仓库的 `autodoor_preset\` 目录，
> clone 本仓库即随手册一并获得；AutoDoor 本体（源码或打包版）另从主仓库 / 产物获取，见 S2 / S2'。

---

## 0. 执行契约

在开始任何动作前，Agent 必须先接受以下约束。这些约束优先于本文后续的任何步骤描述。

| 编号 | 约束 | 原因 |
|---|---|---|
| C1 | **不执行交互式命令**。任何会等待 stdin 的命令（`pause`、`Read-Host`、无 `-y` 的 npx 首次安装、`git rebase -i`）都必须加非交互参数或跳过 | Agent 无法响应提示，会永久挂起 |
| C2 | **每条命令都要检查退出码**。`$LASTEXITCODE` 非 0 时按该步骤的失败分支处理，不得"继续往下试试看" | 部署脚本最常见的失败是把错误当成功继续 |
| C3 | **判据以命令输出为准**，不以"看起来对了"为准。每个步骤的"成功判据"栏就是要 grep 的字符串或要比较的数值 | 自然语言描述会产生歧义 |
| C4 | **步骤全部幂等**。失败后可原样重跑该步，不需要先回滚 | 网络抖动是常态 |
| C5 | **遇到标了 ⛔ 的分支必须停下并报告**，不得自行猜测替代方案 | 这些分支会导致后续全盘错位 |
| C6 | **不要修改本文未提及的文件**。尤其不要改 `config/settings.json` 里的键名，也不要动 `%APPDATA%` 下的配置 | 配置结构有版本耦合 |
| C7 | 所有路径占位符见 §1.3，执行前必须先解析成真实路径 | 占位符混用会导致后面全线错位 |

### 报告格式

每个步骤结束后，输出一行：

```
[S<n>] PASS | 关键数值
[S<n>] FAIL | 现象 | 已尝试的分支 | 需要人介入的原因
```

全部结束后输出总表 + §4 的验收结果。

---

## 1. 前置探测

### 1.1 目标机基本信息

```powershell
$os = Get-CimInstance Win32_OperatingSystem
"OS      = $($os.Caption) $($os.Version)"
"ARCH    = $env:PROCESSOR_ARCHITECTURE"
"RAM_GB  = $([math]::Round($os.TotalVisibleMemorySize/1MB,1))"
"DISK_FREE_GB = $([math]::Round((Get-PSDrive C).Free/1GB,1))"
"IS_ADMIN = $((New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"
```

判据：

| 项 | 要求 | 不满足时 |
|---|---|---|
| OS | 含 `Windows 10` 或 `Windows 11` | ⛔ 停止，本项目仅支持 Windows |
| ARCH | `AMD64` | ⛔ 停止，不支持 ARM64 |
| RAM_GB | ≥ 8 | 警告，可继续但 OCR + 浏览器同时运行会吃力 |
| DISK_FREE_GB | ≥ 6（源码方案）/ ≥ 2（打包方案） | ⛔ 停止，清理磁盘 |
| IS_ADMIN | 安装阶段需 `True` | 提示提权；仅运行时不需要管理员 |

### 1.2 已有软件探测

```powershell
foreach ($c in 'python','node','npm','pnpm','git','tesseract','docker') {
  $p = Get-Command $c -ErrorAction SilentlyContinue
  if ($p) { "{0,-10} = {1}" -f $c, $p.Source } else { "{0,-10} = MISSING" -f $c }
}
python --version 2>&1
node --version 2>&1
```

记录每个结果，§2 的路径选择依赖它。

### 1.3 路径占位符（执行前必须解析）

```powershell
$AUTODOOR_ROOT = 'D:\workspace\autodoor_behavior_tree'   # AutoDoor 代码根（源码方案必填；打包方案下为解压后的产物目录）
$DSH_REPO      = 'D:\workspace\autodoor-dsh-integration' # 本仓库 clone 目标（S6 工具集来源，可按需改动）
$PROJECTS_ROOT = 'D:\auto_projects'                      # 自动化工程根（每个场景一个子目录）
$DSH_HOME      = Join-Path $env:USERPROFILE '.dsh'       # DSH 配置根
$PRESET_DIR    = Join-Path $DSH_HOME '.agent-presets\autodoor'
$PROFILE_DIR   = Join-Path $DSH_HOME 'profiles\web'
```

约束：
- 三个根路径**不得包含中文与空格**。Python 子进程编码与 `file://` URL 转义在边界情况下会出错。
- `$AUTODOOR_ROOT` 在**打包方案**下指向解压后的产物目录。

---

## 2. 路径选择

部署前先决定走哪条路。两条路的产物能力不同，**不可混用**。

```
是否需要在目标机上改代码 / 加依赖 / 用 REST 接口？
├─ 是 → 源码方案（S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8）
└─ 否 → 打包方案（S1 → S2' → S4 → S5 → S6 → S7 → S8）
```

| 维度 | 源码方案 | 打包方案 |
|---|---|---|
| 目标机需装 Python | 是（3.12） | 否 |
| 目标机需装 Node | 是 | 是（DSH 必需） |
| 目标机准备耗时 | 15–30 分钟 | 1–2 分钟 |
| 可调试 | 是 | 否 |
| CLI 入口 | `venv\Scripts\python.exe cli.py <cmd>` | `autodoor-cli.exe <cmd>` |
| REST 支持 | 是 | 否 |

> 若 `$AUTODOOR_ROOT` 下同时存在 `venv\` 与 `autodoor-cli.exe`，优先用打包版（更快、更稳）。

---

## 3. 步骤

### S1 · 安装 Node.js 22

**目标**：满足 DSH 与 `dsh-vision-router` 的 Node 版本硬门槛。

```powershell
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
}
node --version
npm --version
```

**成功判据**：`node --version` 主版本号 ∈ {22, 24}，且 ≥ 22.19。

```
v22.22.2   ← PASS
v20.11.0   ← FAIL（低于 22.19，dsh-vision-router 会运行失败）
```

**失败分支**：

| 现象 | 处理 |
|---|---|
| winget 不可用 | ⛔ 停止，报告"需手工安装 Node 22 LTS"并给出 nodejs.org 链接 |
| 版本 < 22.19 | 卸载旧版后重装；不要尝试"凑合用"，vision-router 的 `engines` 会拒绝 |
| 安装后 `node` 仍不存在 | 重启 shell（PATH 未刷新），再判 |

**幂等**：是。已满足判据时跳过安装。

---

### S2 · 部署 AutoDoor 运行时（源码方案）

#### S2.1 获取代码

```powershell
if (-not (Test-Path $AUTODOOR_ROOT)) {
    git clone https://github.com/wdhq4261761/autodoor_behavior_tree.git $AUTODOOR_ROOT
}
Set-Location $AUTODOOR_ROOT
git log -1 --format="%h %s"
git status --short
```

**成功判据**：
- 目录存在且含 `cli.py`、`bt_core\`、`plugins\`
- `git status --short` 输出中应能看到 `plugins/vlm_vision/` 与 `bt_cli/commands/assets.py` 相关条目

> ⚠️ **上游 clone 不含本文所述的改造**（`assets` 命令、`vlm_vision` / `uia_bridge` 插件、多显示器坐标修复）。若 `git status --short` 为空且 `Test-Path plugins\vlm_vision` 为假，说明拿到的是未改造版本 → ⛔ 停止，报告"需使用改造后的代码目录"。

#### S2.2 建 venv 并装依赖

```powershell
Set-Location $AUTODOOR_ROOT
if (-not (Test-Path venv\Scripts\python.exe)) { python -m venv venv }
.\venv\Scripts\python.exe -m pip install --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple
.\venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

若需要跑测试验证环境完整性，再叠加测试依赖：

```powershell
.\venv\Scripts\python.exe -m pip install -r requirements-dev.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

`requirements-dev.txt` 含 `pytest` / `pytest-mock` / `httpx2`。其中 `httpx2` 是必须的——新版 starlette 的 `TestClient` 依赖它，缺了会让 `test_rest_server.py` 与 `test_sse.py` 共 11 项直接报错：

```
RuntimeError: The starlette.testclient module requires the httpx2 package
```

**成功判据**：

```powershell
.\venv\Scripts\python.exe -c "import cv2,numpy,PIL,win32api,pyautogui,imagehash,pywinauto,onnxruntime; print('core ok')"
```

输出 `core ok` 即通过。

> 国内网络务必带 `-i` 镜像。实测不走镜像时 `onnxruntime` 等大包可能十几分钟无进展；带镜像全新安装约 **145 秒**。

**失败分支**：

| 现象 | 处理 |
|---|---|
| `No matching distribution found for onnxruntime==1.19.0` | Python 版本不是 3.12 → ⛔ 停止，重建 venv |
| `numpy.core.multiarray failed to import` | opencv 与 numpy 版本不匹配 → 重装 `opencv-python-headless>=4.10.0` |
| 网络超时 | 重试该步（幂等）；连续 2 次失败 → 换镜像源 |

#### S2.3 环境自检

```powershell
Set-Location $AUTODOOR_ROOT
.\venv\Scripts\python.exe -m pytest tests\ -q
```

**成功判据**：`0 failed`。通过数 637–638、跳过 ≤1 属正常。

**已知的非问题**（不要误判为故障）：

| 现象 | 是否问题 | 说明 |
|---|---|---|
| 通过数是 637 而非 638 | 否 | 有 1 项因 `openpyxl` 未装而 skip（`excel_automation` 插件的可选依赖） |
| `opencv` 装出 5.0.0 而非 4.13 | 否 | 已实测 5.0.0 全绿；`>=4.10.0` 无上界 |
| `numpy` 装出 2.5.4 而非 2.5.2 | 否 | 补丁号差异，已验证兼容 |

**失败分支**：仅 `fastapi` 相关失败 → 装 `requirements-dev.txt`（含 `httpx2`）；出现 `ValueError: not enough values to unpack` 或 `'MagicMock' > 'int'` → 测试文件是未修复版本，⛔ 停止并换用改造版代码。

---

### S2' · 部署 AutoDoor 运行时（打包方案）

**目标**：解压即用，不装 Python。

```powershell
# 产物来自同版本的打包构建，目录名含版本号
# 版本号以主仓库 Releases 页最新 tag 为准（当前为 2.0.0），不要照抄示例里的旧目录名
$PKG = 'D:\apps\autodoor-behaviortree-2.0.0'
$AUTODOOR_ROOT = $PKG
Test-Path "$PKG\autodoor-cli.exe"
Test-Path "$PKG\plugins\vlm_vision\plugin.json"
Get-ChildItem "$PKG\plugins" -Directory | Select-Object -ExpandProperty Name
```

**成功判据**：

```powershell
& "$PKG\autodoor-cli.exe" plugin nodes
```

输出中同时包含 `vlm_vision` 与 `uia_bridge` 两个插件及其节点。

**失败分支**：

| 现象 | 处理 |
|---|---|
| `无已加载的插件` | `plugins\` 不在 exe 同级 → 从源码目录复制 |
| `No module named 'plugins'` | 产物来自未修复的构建 → ⛔ 停止，重新构建 |
| 执行节点才报 `pywinauto` 缺失 | 构建时未声明 hiddenimports → ⛔ 停止，重新构建 |

> 若产物目录里 `logs\` 存在且含本机测试日志，分发前应删除。

---

### S3 · 验证 AutoDoor 本体可用

```powershell
# 源码方案
Set-Location $AUTODOOR_ROOT
.\venv\Scripts\python.exe cli.py plugin nodes
.\venv\Scripts\python.exe cli.py assets list --project $PROJECTS_ROOT\demo

# 打包方案
& "$AUTODOOR_ROOT\autodoor-cli.exe" plugin nodes
& "$AUTODOOR_ROOT\autodoor-cli.exe" assets list --project $PROJECTS_ROOT\demo
```

**成功判据**：
- `plugin nodes` 列出 ≥ 4 个插件，且含 `vlm_vision`（3 节点）与 `uia_bridge`（2 节点）
- 无 `[PluginLoader] 导入插件模块失败` 字样
- `assets list` 正常返回（空工程输出空列表也算通过）

**失败分支**：见 S2' 表格。

---

### S4 · 初始化 DSH

```powershell
# 首次运行会创建 %USERPROFILE%\.dsh 与 profiles\web
npx -y --registry=https://registry.npmmirror.com @deepseek-ai/dsh web
```

> 该命令会启动 Web 服务并常驻。Agent 应以"后台启动 → 探测端口 → 关闭"的方式验证，不要阻塞等待。
>
> **人工启动走脚本**：仓库根目录的 `start-dsh.bat` 等价于上面这条命令，已固定版本（`DSH_VER=0.2.1-rc.5`）并带 Node 检测，
> 适合真人双击启动。Agent 自己执行时仍用上面的 `npx` 命令（需要后台启动 + 探测端口）。
> 注意该文件为 GBK 编码 + CRLF 换行，改动时不要存成 UTF-8（也不要用 GitHub 网页编辑器编辑它）。

**成功判据**：
- `$DSH_HOME\profiles\web\package.json` 存在
- `$DSH_HOME\profiles\web\cordis.patch.yml` 存在

```powershell
Test-Path (Join-Path $DSH_HOME 'profiles\web\package.json')
Test-Path (Join-Path $DSH_HOME 'profiles\web\cordis.patch.yml')
```

**失败分支**：

| 现象 | 处理 |
|---|---|
| npx 卡在 `Ok to proceed? (y)` | 加 `-y`（本文命令已含）；若仍卡，先 `npm cache verify` 再试 |
| 端口占用 | 换端口启动或先结束占用进程 |
| 无网络 | ⛔ 停止，DSH 无离线安装包 |

**幂等**：是。已初始化时直接启动即可。

---

### S5 · 安装视觉插件 dsh-vision-router

```powershell
npx -y --registry=https://registry.npmmirror.com @deepseek-ai/dsh plugin --profile web add dsh-vision-router@3.1.2
```

**成功判据**：

```powershell
$VR = Join-Path $PROFILE_DIR 'node_modules\dsh-vision-router'
Test-Path $VR
(Get-Content (Join-Path $PROFILE_DIR 'package.json') -Raw) -match 'dsh-vision-router'
```

两项均为真，且 `package.json` 的 `dsh.profile.bundles` 中包含 `dsh-vision-router`。

**失败分支**：

| 现象 | 处理 |
|---|---|
| `ERR_PNPM_UNSUPPORTED_ENGINE` | Node 版本不达标 → 回 S1 |
| 装上了但 bundles 里没有 | 手工在 `package.json` 的 `dsh.profile.bundles` 数组补一项 `"dsh-vision-router"` |

**验证运行时自检**：

```powershell
node (Join-Path $VR 'lib\doctor-cli-p0.js')
```

**成功判据**：输出含 `✓` 且无 `✗`。

---

### S6 · 部署 AutoDoor 工具插件（12 个工具）

**目标**：让 Agent 能通过工具调用 AutoDoor，而不是靠拼命令行。

```powershell
New-Item -ItemType Directory -Force -Path $PRESET_DIR | Out-Null
# 工具集二选一来源：
#   A. clone 本仓库（推荐，autodoor-dsh-integration）
#      git clone https://github.com/wdhq4261761/autodoor-dsh-integration.git $DSH_REPO
#      $DSH_REPO = '<clone目标目录>'
#   B. 已有 AutoDoor 改造源码目录时直接用 $AUTODOOR_ROOT\dsh_integration（内容与本仓库同步）
$SRC = if (Test-Path "$AUTODOOR_ROOT\dsh_integration\autodoor_preset\autodoor-tools-v2.mjs") {
         "$AUTODOOR_ROOT\dsh_integration\autodoor_preset"
       } elseif ($DSH_REPO -and (Test-Path "$DSH_REPO\autodoor_preset\autodoor-tools-v2.mjs")) {
         "$DSH_REPO\autodoor_preset"
       } else { $null }
if (-not $SRC) { throw '未找到 autodoor-tools-v2.mjs：请先 clone autodoor-dsh-integration 仓库或补齐源码目录' }
Copy-Item "$SRC\autodoor-tools-v2.mjs" $PRESET_DIR -Force
Copy-Item "$SRC\agent.cordis.yml" $PRESET_DIR -Force
Copy-Item "$SRC\preset.yml" $PRESET_DIR -Force
Get-ChildItem $PRESET_DIR
```

> 三个文件的角色：`autodoor-tools-v2.mjs` 是唯一被真正加载的插件本体；`agent.cordis.yml` 是预设组合配置（供阅读与旧版回退）；
> `preset.yml` 是预设元数据（显示名 / 描述）。DSH 0.2.x 不扫描 `.agent-presets` 目录，后两个不会自动生效，
> 但保持三个齐全，与 README 第 5 节及仓库目录一致，旧版 DSH 也能直接用。

> **⚠️ 工具集文件的来源（必读）**
>
> `dsh_integration\` 目录**不在** AutoDoor 主仓库的版本控制内（`.gitignore` 明确排除，属独立仓库）。
> 因此：
> - 从 GitHub `clone` AutoDoor 主仓库**拿不到**这三个文件；
> - 走打包方案时，产物里也不含（只有源码与配置，不进 exe）。
>
> 正确来源是**本仓库（autodoor-dsh-integration）**：
>
> ```powershell
> git clone https://github.com/wdhq4261761/autodoor-dsh-integration.git $DSH_REPO
> Test-Path "$DSH_REPO\autodoor_preset\autodoor-tools-v2.mjs"
> ```
>
> 若为 `False`，说明 clone 不完整（或仓库不可达），需先补齐再继续。

**配置 AutoDoor 位置**（工具集已支持环境变量，通常不需要改代码）：

工具集解析顺序为「`AUTODOOR_CLI` → `AUTODOOR_ROOT` 下自动探测 `autodoor-cli.exe` → 源码版约定路径」。因此只需在启动 DSH 的同一环境中设置根目录：

```powershell
# 源码方案
[Environment]::SetEnvironmentVariable('AUTODOOR_ROOT', $AUTODOOR_ROOT, 'User')

# 打包方案（同一变量即可，工具会自己发现 autodoor-cli.exe）
[Environment]::SetEnvironmentVariable('AUTODOOR_ROOT', $AUTODOOR_ROOT, 'User')
```

> 设置的是 User 级变量，需**新开进程**才生效（DSH 重启一次即可）。
> 只有需要绕过自动探测时，才显式设 `AUTODOOR_CLI`。

**成功判据**：

```powershell
node --check (Join-Path $PRESET_DIR 'autodoor-tools-v2.mjs')
(Select-String -Path (Join-Path $PRESET_DIR 'autodoor-tools-v2.mjs') -Pattern "name: 'autodoor_" -AllMatches).Matches.Count
(Get-ChildItem $PRESET_DIR -File).Count
```

第一项无输出（语法 OK），第二项 = **12**，第三项 = **3**（三个文件都到位）。

> 若第二项 < 12，说明拿到的是旧版工具集（8 个工具），⛔ 停止并换用配套版本——旧版缺 `ai` / `assets` 相关工具，会导致校验与素材流程不可用。

---

### S7 · 在 profile 中注册预设

**这是最容易失败的一步。** 三个必须知道的事实：

1. DSH 0.2.x **不再自动扫描** `.agent-presets\` 目录。文件放在那里不会被加载。
2. 必须在 `$PROFILE_DIR\cordis.patch.yml` 里显式声明 `@deepseek-ai/dsh-agent-preset`。
3. 引用本地 ESM 文件**必须用 `file:///` 前缀**（三斜杠），否则 Cordis 只报 `never started`，真实异常在 `$DSH_HOME\autodoor-tools-error.log`。

编辑 `$PROFILE_DIR\cordis.patch.yml`，**在数组末尾追加**（不要整体覆盖，里面有模型配置）：

```yaml
- insert:
    - id: preset-autodoor
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: autodoor
        name: AutoDoor 自动化
        description: 功能完整的编码 Agent，含 AutoDoor 行为树驱动工具
        order: 50
        plugins:
          - id: autodoor-tools
            name: 'file:///C:/Users/<用户名>/.dsh/.agent-presets/autodoor/autodoor-tools-v2.mjs'
```

**成功判据**：

```powershell
$patch = Join-Path $PROFILE_DIR 'cordis.patch.yml'
Select-String -Path $patch -Pattern 'preset-autodoor'
Select-String -Path $patch -Pattern 'file:///'
```

两项都有匹配。若 `file:///` 那一行的用户名与实际不符 → 改成本机用户名。

**失败分支**：

| 现象 | 处理 |
|---|---|
| 预设列表里看不到 AutoDoor | 检查是否写成了 `file://`（两斜杠）或 `file://C:`（少了斜杠） |
| 工具调用报 `never started` | 查 `$DSH_HOME\autodoor-tools-error.log` 的真实堆栈 |
| YAML 解析报错 | 用 `python -c "import yaml,sys;yaml.safe_load(open(r'<path>',encoding='utf-8').read().split('---')[0])"` 粗验缩进 |

---

### S8 · 端到端联调

**目标**：证明"Agent → 工具 → AutoDoor → 真实桌面"这条链条完整。

#### S8.1 建立工程目录

```powershell
New-Item -ItemType Directory -Force -Path "$PROJECTS_ROOT\smoke" | Out-Null
```

#### S8.2 生成并校验一棵树

```powershell
# 用 CLI 的 ai generate 或手写；此处以手写最小树为例
$tree = @'
{
  "version": "2.1",
  "format_type": "behavior_tree",
  "root_node": "n0",
  "nodes": {
    "n0": {"id":"n0","type":"StartNode","name":"开始","enabled":true,"config":{},"children":["n1"]},
    "n1": {"id":"n1","type":"SequenceNode","name":"主序列","enabled":true,"config":{},"children":["n2"]},
    "n2": {"id":"n2","type":"ImageConditionNode","name":"模板检测","enabled":true,
           "config":{"template_path":"tpl.png","threshold":75},"children":[]}
  },
  "connections":[{"parent_id":"n0","child_id":"n1"},{"parent_id":"n1","child_id":"n2"}]
}
'@
Set-Content -Path "$PROJECTS_ROOT\smoke\tree.json" -Value $tree -Encoding utf8

# 校验
& "$AUTODOOR_ROOT\autodoor-cli.exe" ai validate "$PROJECTS_ROOT\smoke\tree.json"
```

**成功判据**：输出 `校验通过 ✓`，并给出正确的节点数与连接数。

> 根节点必须是 `StartNode`，connection 必须用 `parent_id` / `child_id` 字段。用 `from` / `to` 会报"connection 的 parent_id 'None' 不存在"。

#### S8.3 验证 UIA 在真实环境可用

```powershell
& "$AUTODOOR_ROOT\autodoor-cli.exe" plugin nodes | Select-String 'uia_bridge'
```

再用一个含 `uia_bridge.UIAStateNode` 的树对真实窗口做一次断言。**注意**：`run --headless` 会持续运行不自动退出，必须用超时包裹：

```powershell
$p = Start-Process -FilePath "$AUTODOOR_ROOT\autodoor-cli.exe" -ArgumentList 'run',"$PROJECTS_ROOT\smoke\tree_uia.json",'--headless' -PassThru -NoNewWindow
Start-Sleep -Seconds 8
if (-not $p.HasExited) { $p.Kill() }
Get-Content "$AUTODOOR_ROOT\logs\run_log.txt" -Tail 20
```

**成功判据**：日志中该节点状态为 `success`（或按预期 `failure`），且无 `ModuleNotFoundError`。

#### S8.4 在 DSH 会话内验证工具

重启 DSH → 切到 `AutoDoor 自动化` 预设 → 让 Agent 调用一次只读工具：

```
autodoor_list_nodes  → 应返回节点清单
autodoor_status      → 应返回运行状态
```

**成功判据**：工具返回结构化结果而非 "tool not found" 或超时。

> 若视觉工具（`vision_*`）不可用：这些工具需要会话内开启"识图"开关，且要在**新的**会话中才生效。仅装好插件不等于会话可用。

---

## 4. 验收清单

全部完成后逐项判定，**任一项 FAIL 即整体不通过**。

| # | 检查 | 命令 | 通过判据 |
|---|---|---|---|
| 1 | Node 版本 | `node --version` | ≥ v22.19 |
| 2 | AutoDoor 依赖 | `python -c "import cv2,pywinauto"` | 无异常 |
| 3 | 插件加载 | `<CLI> plugin nodes` | 含 `vlm_vision` + `uia_bridge`，无"导入失败" |
| 4 | 树校验 | `<CLI> ai validate tree.json` | `校验通过 ✓` |
| 5 | 素材命令 | `<CLI> assets list --project <dir>` | 正常返回 |
| 6 | DSH 初始化 | `Test-Path $PROFILE_DIR\cordis.patch.yml` | `True` |
| 7 | 视觉插件 | `Test-Path $PROFILE_DIR\node_modules\dsh-vision-router` | `True` |
| 8 | doctor 自检 | `node ...\lib\doctor-cli-p0.js` | 含 `✓`，无 `✗` |
| 9 | 工具数量 | `Select-String ... -Pattern "name: 'autodoor_"` | 12 |
| 10 | 环境变量 | `[Environment]::GetEnvironmentVariable('AUTODOOR_ROOT','User')` | 返回实际根目录 |
| 11 | 预设注册 | `Select-String cordis.patch.yml -Pattern 'preset-autodoor'` | 有匹配 |
| 12 | 端到端 | DSH 会话内调 `autodoor_list_nodes` | 返回节点清单 |

> **打包方案（S2'）跳过第 2 项**：该方案不装 Python，`cv2` / `pywinauto` 已随 exe 打包，命令必然报 ModuleNotFoundError。
> 此时按 **11 项**判定，输出 `验收: 11/11 PASS`；其余 11 项判据不变。

输出：

```
验收: 12/12 PASS
```

---

## 5. 故障处置表

按"现象 → 根因 → 动作"组织。**先查表再动手**，不要试错。

### 5.1 AutoDoor 侧

| 现象 | 根因 | 动作 |
|---|---|---|
| `No module named 'pywinauto'` | 依赖缺失 | `pip install pywinauto` |
| `numpy.core.multiarray failed to import` | opencv 与 numpy ABI 不匹配 | `pip install --force-reinstall "opencv-python-headless>=4.10.0"` |
| 插件列表为空 | `plugins\` 位置不对 | 确认 `plugins\` 与 `cli.py`（或 `autodoor-cli.exe`）同级 |
| `No module named 'plugins'` | 打包产物缺 sys.path 修复 | 用本文对应版本的代码重新构建 |
| `校验失败：根节点必须是 StartNode` | 树格式错 | 根节点改 `StartNode`，connection 用 `parent_id`/`child_id` |
| 检测点位置整体偏移 1920px | 多显示器负原点未修复 | 确认用的是改造版（`bt_core/nodes.py` 的 `_adjust_position` 含三分支） |
| `run --headless` 不退出 | 设计如此（引擎循环） | 用超时包裹，或由 `stop` 命令终止 |
| 打包版 CLI 无任何输出 | 用了 GUI 版 exe | 换 `autodoor-cli.exe` |
| 中文输出乱码 | 管道编码 | 用改造版（`cli.py` 含 `_ensure_utf8_stdio`），或设 `PYTHONIOENCODING=utf-8` |

### 5.2 DSH 侧

| 现象 | 根因 | 动作 |
|---|---|---|
| 预设列表里没有 AutoDoor | 未在 `cordis.patch.yml` 注册 | 按 S7 追加配置 |
| 工具调用 `never started` | ESM 路径缺 `file:///` | 补三斜杠，并查 `autodoor-tools-error.log` |
| 工具调用超时 | 路径指向了不存在的 Python/exe | 核对 `autodoor-tools-v2.mjs` 顶部常量 |
| 视觉工具不可见 | 会话未开"识图" | 会话内开启该开关 |
| `vision_*` 工具报 429 | 免费端点限流 | 降频或用缓存；这是限流不是故障 |
| doctor 报 engine 不支持 | Node < 22.19 | 升级 Node |

### 5.3 环境权限侧

| 现象 | 根因 | 动作 |
|---|---|---|
| 键鼠模拟无效 | 目标窗口以管理员运行，脚本非管理员 | 以同等或更高权限运行 |
| DD 驱动加载失败 | 未提权 / 驱动未安装 | 管理员运行一次，按提示装驱动 |
| 截图全黑 | 受保护内容（DRM / UAC 安全桌面） | 属系统限制，无法绕过 |
| 截图尺寸与分辨率不符 | 多显示器虚拟桌面 | 正常现象；坐标以虚拟桌面原点为基准（改造版已处理） |

---

## 6. 回滚

### 6.1 只回滚 AutoDoor 代码

```powershell
Set-Location $AUTODOOR_ROOT
git stash push -u -m "deploy-backup"    # 先备份改造
git checkout -- .
git stash list                          # 确认备份存在
```

> 不要用 `git clean -fdx`：它会连 `venv\`、`plugins\`、工程数据一起删掉，且不可恢复。

### 6.2 卸载 DSH 侧改动

```powershell
# 1) 从 cordis.patch.yml 删除 preset-autodoor 整段（保留模型配置等其他行）
# 2) 可选：移除视觉插件
npx -y --registry=https://registry.npmmirror.com @deepseek-ai/dsh plugin --profile web remove dsh-vision-router
```

### 6.3 完全清理

```powershell
# 先确认路径，再删。这两个目录含会话历史与模型配置，删前请人确认
# Remove-Item -Recurse -Force $PRESET_DIR
# Remove-Item -Recurse -Force $PROFILE_DIR
```

---

## 附录 · Agent 执行时的高频误判

| 误判 | 事实 |
|---|---|
| "`plugin nodes` 能列出节点，说明插件完全可用" | 不够。`pywinauto` 是延迟导入，必须真正执行一次 UIA 节点 |
| "DSH 装好插件就能用视觉工具" | 不够。要开"识图"开关，且需新会话 |
| "把文件放进 `.agent-presets` 就会被加载" | 0.2.x 起不扫描该目录，必须写 `cordis.patch.yml` |
| "`run --headless` 跑完会自己退出" | 不会。引擎持续运行，必须外部超时 |
| "打包版的 exe 和 CLI 版是同一个入口" | 不是。GUI 版无 stdout，脚本必须用 `autodoor-cli.exe` |
| "`校验通过` 说明节点都能跑" | 只说明反序列化成功，不代表运行时行为正确 |
