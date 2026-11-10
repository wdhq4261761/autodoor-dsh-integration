// AutoDoor 行为树驱动工具 — 本地 ESM 插件（路线A 持久化形态）
// 由 DSH 预设 agent.cordis.yml 通过绝对路径引用加载。
// 实现与动态插件 autd-3/pkg-4 等价：12 个模型工具 + 执行抽象层。
// 执行抽象层（execCli）支持两种形态：源码版走 venv python 调 cli.py，
// 打包版直接调 autodoor-cli.exe；由 ROOT 下的文件存在性自动判定。
// 注意：本文件位于用户主目录预设，Node ESM 无法从文件位置解析 DSH 私有包，
// 因此改为「运行时解析」dsh-tools，不再绑死某个 npx 缓存路径。解析优先级：
//   1. 环境变量 AUTODOOR_DSH_TOOLS（显式指定 ...\dsh-tools\lib\index.js，最高优先级）
//   2. 当前运行中的 dsh 进程自身安装目录（由 process.argv 反推，与运行时版本必然一致）
//   3. 全局 npm / npx 缓存 / dsh profile 等常见位置（按 dsh-tools 版本从高到低）
// 这样升级 dsh、清空 npm 缓存、或改用全局安装后，本文件都无需修改。
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DSH_TOOLS_SEGMENTS = ['@deepseek-ai', 'dsh-tools', 'lib', 'index.js']

function safeDirs(parent) {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter(function (e) { return e.isDirectory() })
      .map(function (e) { return e.name })
  } catch (e) {
    return []
  }
}

// node_modules 目录 -> dsh-tools 入口文件（不存在则返回 undefined）
function toolsEntryIn(nodeModulesDir) {
  const entry = join(nodeModulesDir, ...DSH_TOOLS_SEGMENTS)
  return existsSync(entry) ? entry : undefined
}

function readToolsVersion(entry) {
  try {
    const pkgPath = join(dirname(entry), '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch (e) {
    return '0.0.0'
  }
}

// 简易语义化版本比较（正式版高于同号预发布版），用于多份安装共存时择优
function compareToolsVersion(a, b) {
  function parse(v) {
    const parts = String(v).split('-')
    const nums = parts[0].split('.').map(function (n) { return Number.parseInt(n, 10) || 0 })
    return { nums: nums, stable: parts.length < 2 ? 1 : 0 }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i += 1) {
    const diff = (x.nums[i] || 0) - (y.nums[i] || 0)
    if (diff !== 0) return diff
  }
  return x.stable - y.stable
}

// 从当前进程命令行反推 dsh 自身的安装目录（最可靠，版本与运行时一致）
function selfNodeModules() {
  for (const arg of process.argv) {
    if (typeof arg !== 'string' || arg.length === 0) continue
    const match = arg.replace(/\\/g, '/').match(/^(.*?)\/node_modules\//)
    if (match && match[1]) return join(match[1], 'node_modules')
  }
  return undefined
}

// 常见安装位置（兜底用）
function otherNodeModules() {
  const roots = []
  const env = process.env
  if (env.APPDATA) roots.push(join(env.APPDATA, 'npm', 'node_modules'))
  if (env.LOCALAPPDATA) {
    const npxRoot = join(env.LOCALAPPDATA, 'npm-cache', '_npx')
    for (const dir of safeDirs(npxRoot)) roots.push(join(npxRoot, dir, 'node_modules'))
  }
  const home = env.USERPROFILE || env.HOME
  if (home) {
    const profilesRoot = join(home, '.dsh', 'profiles')
    for (const dir of safeDirs(profilesRoot)) roots.push(join(profilesRoot, dir, 'node_modules'))
  }
  return roots
}

async function importDefineTool(entry) {
  try {
    const mod = await import(pathToFileURL(entry).href)
    return typeof mod.defineTool === 'function' ? mod.defineTool : undefined
  } catch (e) {
    return undefined
  }
}

async function resolveDefineTool() {
  const attempted = []

  const forced = process.env.AUTODOOR_DSH_TOOLS
  if (forced) {
    if (!existsSync(forced)) {
      throw new Error('[autodoor] AUTODOOR_DSH_TOOLS 指向的文件不存在：' + forced)
    }
    const forcedFn = await importDefineTool(forced)
    if (!forcedFn) {
      throw new Error('[autodoor] AUTODOOR_DSH_TOOLS 指向的模块未导出 defineTool：' + forced)
    }
    return { defineTool: forcedFn, entry: forced }
  }

  // 第一优先：当前运行中的 dsh 自带的 dsh-tools
  const ownEntry = selfNodeModules() ? toolsEntryIn(selfNodeModules()) : undefined
  if (ownEntry) {
    attempted.push(ownEntry)
    const fn = await importDefineTool(ownEntry)
    if (fn) return { defineTool: fn, entry: ownEntry }
  }

  // 兜底：其他安装位置，版本从高到低
  const fallbacks = otherNodeModules()
    .map(toolsEntryIn)
    .filter(function (entry, index, list) {
      return typeof entry === 'string' && list.indexOf(entry) === index
    })
    .sort(function (a, b) { return compareToolsVersion(readToolsVersion(b), readToolsVersion(a)) })

  for (const entry of fallbacks) {
    attempted.push(entry)
    const fn = await importDefineTool(entry)
    if (fn) return { defineTool: fn, entry: entry }
  }

  throw new Error(
    '[autodoor] 未能定位 @deepseek-ai/dsh-tools（defineTool），AutoDoor 工具无法注册。\n已尝试：\n' +
      (attempted.length ? attempted.map(function (p) { return '  - ' + p }).join('\n') : '  （无候选路径）') +
      '\n请确认 dsh 已正确安装，或设置环境变量 AUTODOOR_DSH_TOOLS 指向 ...\\@deepseek-ai\\dsh-tools\\lib\\index.js',
  )
}

// 解析失败时把真实原因落盘：Cordis 的预设审计只会报 "never started"，
// 会吞掉模块导入期的异常，排查时看不到根因。
let resolvedDshTools
try {
  resolvedDshTools = await resolveDefineTool()
} catch (error) {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '.'
    writeFileSync(
      join(home, '.dsh', 'autodoor-tools-error.log'),
      '[' + new Date().toISOString() + ']\n' + String((error && error.stack) || error) + '\n',
    )
  } catch (e) {
    /* 落盘失败时保留原始错误，不影响抛出 */
  }
  throw error
}
const defineTool = resolvedDshTools.defineTool
console.log('[autodoor] dsh-tools 已解析：' + resolvedDshTools.entry)

export default {
  name: 'autodoor-tools',
  apply(ctx) {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) return
    const toolRegistry = ctx.get('tools')
    if (toolRegistry === undefined) return

    // ── AutoDoor 位置解析 ──
    // 解析顺序（换机器时通常无需改本文件）：
    //   1. 环境变量 AUTODOOR_ROOT / AUTODOOR_CLI / AUTODOOR_PY
    //   2. 自动探测：ROOT 下存在 autodoor-cli.exe 时按打包版处理（不依赖 Python）
    //   3. 回退到源码版约定路径（venv\Scripts\python.exe + cli.py）
    // 打包版的 GUI 主程序是 console=false、没有 stdout 句柄，
    // 必须调用同目录的 autodoor-cli.exe，否则工具拿到的输出永远是空串。
    const ROOT = process.env.AUTODOOR_ROOT || 'D:\\workspace\\autodoor_behavior_tree'

    const _exeCli = join(ROOT, 'autodoor-cli.exe')
    const _detectedExe = existsSync(_exeCli)

    const CLI = process.env.AUTODOOR_CLI || (_detectedExe ? _exeCli : join(ROOT, 'cli.py'))
    const PY = process.env.AUTODOOR_PY || join(ROOT, 'venv', 'Scripts', 'python.exe')

    // 以最终 CLI 路径判断运行形态：.exe 结尾即打包版
    const USE_EXE = /\.exe$/i.test(CLI)
    console.log('[autodoor] root=' + ROOT + ' cli=' + CLI + ' mode=' + (USE_EXE ? 'packaged' : 'source'))

    // runId -> { handle, startedAt, finished, exitCode, error }
    const runs = new Map()
    let runSeq = 0

    function makeRunId() {
      runSeq += 1
      return 'autodoor-' + runSeq
    }

    // 执行抽象层：当前实现 = 子进程调 CLI；路线C 切换为 HTTP 调用时只需替换本函数。
    function execCli(args, opts) {
      const argv = USE_EXE ? [CLI].concat(args) : [PY, CLI].concat(args)
      const handle = subprocess.spawn({
        argv: argv,
        cwd: (opts && opts.cwd) || ROOT,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 1000000, spill: { maxBytes: 10000000 } },
          stderr: { maxBytes: 1000000, spill: { maxBytes: 10000000 } },
        },
        graceMs: 3000,
        env: { PYTHONIOENCODING: 'utf-8' },
      })
      return handle
    }

    // 同步执行并返回结构化结果（用于单阶段无交互命令）
    async function execSync(args) {
      const handle = execCli(args)
      const outcome = await handle.done
      const out = handle.collected.stdout ? (handle.collected.stdout.readFrom(0).text || '') : ''
      const err = handle.collected.stderr ? (handle.collected.stderr.readFrom(0).text || '') : ''
      return { ok: outcome.exitCode === 0, exitCode: outcome.exitCode, stdout: out, stderr: err }
    }

    function track(record) {
      record.handle.done.then(function (outcome) {
        record.finished = true
        record.exitCode = outcome.exitCode
      }).catch(function () {
        record.finished = true
        record.error = 'spawn-failed'
      })
    }

    function readOutputs(record) {
      var stdout = ''
      var stderr = ''
      var out = record.handle.collected.stdout
      var err = record.handle.collected.stderr
      if (out) stdout = out.readFrom(0).text || ''
      if (err) stderr = err.readFrom(0).text || ''
      return { stdout: stdout, stderr: stderr }
    }

    var textRender = function (args, value) {
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    }

    // 将 DSH agent 自主设计出的节点结构落盘为 .ai/structure.json。
    // 这是「智能交给 DSH」的关键：DSH agent（本身是 LLM）先在对话里推理出
    // structure JSON，再通过本函数持久化，供纯规则的 generate 阶段转成 tree.json。
    function saveStructure(structureObj, filename) {
      const aiDir = join(ROOT, '.ai')
      mkdirSync(aiDir, { recursive: true })
      const outPath = join(aiDir, filename || 'structure.json')
      writeFileSync(outPath, JSON.stringify(structureObj, null, 2), 'utf-8')
      return outPath
    }

    // ── 插件创建辅助 ─────────────────────────────────────────────
    // snake_case 名称 -> PascalCase 类名（math_expressions -> MathExpressions）
    function pascalCase(name) {
      return String(name || '')
        .split(/[_\-\s]+/)
        .filter(function (s) { return s.length > 0 })
        .map(function (s) { return s.charAt(0).toUpperCase() + s.slice(1) })
        .join('')
    }

    // 字符串安全转义为 Python 双引号字符串字面量
    function pyStr(s) {
      return '"' + String(s)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t') + '"'
    }

    // JS 值 -> Python 字面量（None / True / False / 数字 / 字符串）
    function pyValue(v) {
      if (v === null || v === undefined) return 'None'
      if (typeof v === 'boolean') return v ? 'True' : 'False'
      if (typeof v === 'number') return String(v)
      return pyStr(String(v))
    }

    var tools = [
      defineTool({
        name: 'autodoor_assets_add',
        description: '制作期登记一条视觉素材：从截图按 bbox 裁剪出模板 PNG、提取主色、换算客户区相对坐标，统一写入 assets/manifest.json。运行期 ImageConditionNode 读模板、ColorConditionNode 读主色，全程不联网。注意：VLM 的 grounding 精度实测只有 20~50px 且置信度不可靠，若 bbox 来自 VLM，务必同时传 refineColor 让它先外扩再按颜色连通域精修（实测可把误差收敛到 0~1px）。',
        parameters: {
          name: { type: 'string', description: '素材名，同时作为模板文件名', required: true },
          bbox: { type: 'string', description: '裁剪框 x1,y1,x2,y2（源图内像素坐标）', required: true },
          source: { type: 'string', description: '源图路径（与 capture 二选一）' },
          capture: { type: 'string', description: '直接截屏，格式 x1,y1,x2,y2（与 source 二选一）' },
          origin: { type: 'string', description: '源图左上角对应的屏幕坐标 x,y' },
          refineColor: { type: 'string', description: '精定位主色 #RRGGBB。给了它就会先外扩再用颜色连通域精修 bbox' },
          refineExpand: { type: 'number', description: '精定位外扩倍数，默认 3.0（小于 2 会因目标被截断而偏移）' },
          refineTolerance: { type: 'number', description: '精定位颜色容差，默认 50' },
          semantic: { type: 'string', description: '语义描述，便于后续人工核对与追溯' },
          color: { type: 'string', description: '直接指定主色 #RRGGBB；不给则自动提取' },
          hwnd: { type: 'number', description: '目标窗口句柄，用于换算客户区相对坐标' },
          project: { type: 'string', description: '项目根目录，默认 AutoDoor 根目录' },
        },
        output: { schema: { type: 'json' }, render: textRender },
        async execute(args, exec) {
          try {
            const a = ['assets', 'add', '--name', args.name, '--bbox', args.bbox]
            if (args.source) a.push('--source', args.source)
            if (args.capture) a.push('--capture', args.capture)
            if (args.origin) a.push('--origin', args.origin)
            if (args.refineColor) a.push('--refine-color', args.refineColor)
            if (args.refineExpand !== undefined) a.push('--refine-expand', String(args.refineExpand))
            if (args.refineTolerance !== undefined) a.push('--refine-tolerance', String(args.refineTolerance))
            if (args.semantic) a.push('--semantic', args.semantic)
            if (args.color) a.push('--color', args.color)
            if (args.hwnd) a.push('--hwnd', String(args.hwnd))
            if (args.project) a.push('--project', args.project)
            const r = await execSync(a)
            return { ok: r.ok, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) }
          }
        },
      }),

      defineTool({
        name: 'autodoor_assets_verify',
        description: '校验 assets/manifest.json 与模板文件的一致性：模板是否存在、尺寸是否与 bbox 一致、主色格式是否合法、坐标是否缺失。返回逐条状态与错误/警告列表。制作期落盘后、写 structure.json 之前建议跑一次。',
        parameters: {
          project: { type: 'string', description: '项目根目录，默认 AutoDoor 根目录' },
          manifest: { type: 'string', description: 'manifest 路径，默认 assets/manifest.json' },
        },
        output: { schema: { type: 'json' }, render: textRender },
        async execute(args, exec) {
          try {
            const a = ['assets', 'verify']
            if (args.project) a.push('--project', args.project)
            if (args.manifest) a.push('--manifest', args.manifest)
            const r = await execSync(a)
            return { ok: r.ok, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) }
          }
        },
      }),

      defineTool({
        name: 'autodoor_validate',
        description: '校验一个 AutoDoor 行为树 JSON 文件的结构是否正确（根节点为 Start、无自引用、条件节点需子节点、序列化往返）。返回 { ok, exitCode, stdout }。',
        parameters: {
          treeFile: { type: 'string', description: 'tree.json 的绝对路径', required: true },
        },
        output: { schema: { type: 'json' }, render: textRender },
        async execute(args, exec) {
          try {
            const r = await execSync(['ai', 'validate', args.treeFile])
            return { ok: r.ok, exitCode: r.exitCode, stdout: r.stdout }
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) }
          }
        },
      }),

      defineTool({
        name: 'autodoor_run',
        description: '以 headless 模式后台运行一个 AutoDoor 行为树，立即返回 runId（进程在插件生命周期内持续运行）。随后用 autodoor_status 查询状态、autodoor_read_log 读取日志、autodoor_stop 停止。注意：运行中的树会真实操作桌面（键鼠/OCR），请确认目标环境安全。若行为树引用了插件节点（type 形如「插件名.节点类型」），会自动启用 --plugins，无需手动指定；也可显式传 plugins: true。',
        parameters: {
          treeFile: { type: 'string', description: 'tree.json 的绝对路径', required: true },
          bus: { type: 'boolean', description: '启用消息总线' },
          rest: { type: 'boolean', description: '启用 REST 服务器（需安装 fastapi）' },
          ws: { type: 'boolean', description: '启用 WebSocket 服务器（需安装 websockets）' },
          plugins: { type: 'boolean', description: '启用插件系统' },
        },
        output: { schema: { type: 'json' }, render: textRender },
        async execute(args, exec) {
          try {
            const flags = []
            if (args.bus) flags.push('--bus')
            if (args.rest) flags.push('--rest')
            if (args.ws) flags.push('--ws')
            // 若树引用了带「插件名.节点类型」前缀的插件节点，自动启用 --plugins
            let usePlugins = !!args.plugins
            if (!usePlugins) {
              try {
                const t = JSON.parse(readFileSync(args.treeFile, 'utf-8').replace(/^\uFEFF/, ''))
                const types = Object.keys(t.nodes || {}).map(function (id) { return t.nodes[id].type })
                usePlugins = types.some(function (x) { return typeof x === 'string' && x.indexOf('.') >= 0 })
              } catch (e) { /* 读取失败时沿用显式参数 */ }
            }
            if (usePlugins) flags.push('--plugins')
            const handle = execCli(['run', args.treeFile, '--headless'].concat(flags))
            const runId = makeRunId()
            const record = { handle: handle, startedAt: Date.now(), finished: false, exitCode: null, error: null }
            runs.set(runId, record)
            track(record)
            return { runId: runId, pid: handle.pid, status: 'starting', plugins: usePlugins, hint: '用 autodoor_status 查询，autodoor_read_log 读日志，autodoor_stop 停止' }
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) }
          }
        },
      }),

      defineTool({
        name: 'autodoor_status',
        description: '查询一个 autodoor_run 启动的后台运行的当前状态与已收集输出。返回 { runId, running, finished, exitCode, stdout, stderr }。',
        parameters: {
          runId: { type: 'string', description: 'autodoor_run 返回的 runId', required: true },
        },
        output: { schema: { type: 'json' }, render: textRender },
        async execute(args, exec) {
          const record = runs.get(args.runId)
          if (!record) return { ok: false, error: '未知 runId（插件运行期间创建的后台任务才可查询）' }
          const out = readOutputs(record)
          return {
            runId: args.runId,
            pid: record.handle.pid,
            running: !record.finished,
            finished: !!record.finished,
            exitCode: record.exitCode,
            error: record.error,
            stdout: out.stdout,
            stderr: out.stderr,
          }
        },
      }),

      defineTool({
        name: 'autodoor_stop',
        description: '停止一个 autodoor_run 启动的后台运行（终止其进程树）。返回 { ok, runId, status }。',
        parameters: {
          runId: { type: 'string', description: '要停止的 runId', required: true },
        },
        output: { schema: { type: 'json' }, render: textRender },
        async execute(args, exec) {
          const record = runs.get(args.runId)
          if (!record) return { ok: false, error: '未知 runId' }
          try { record.handle.terminate() } catch (e) { /* noop */ }
          return { ok: true, runId: args.runId, status: 'stopping' }
        },
      }),

      defineTool({
        name: 'autodoor_read_log',
        description: '从指定字节偏移读取 autodoor_run 后台运行的执行日志（stdout）。返回 { text, nextOffset, lossy, finished }，nextOffset 可作下次读取的 offset。',
        parameters: {
          runId: { type: 'string', description: 'runId', required: true },
          offset: { type: 'integer', description: 'stdout 字节偏移，首次 0' },
        },
        output: { schema: { type: 'json' }, render: textRender },
        async execute(args, exec) {
          const record = runs.get(args.runId)
          if (!record) return { ok: false, error: '未知 runId' }
          const off = args.offset || 0
          const reader = record.handle.collected.stdout
          const read = reader ? reader.readFrom(off) : { text: '', nextOffset: off, lossy: false }
          return {
            runId: args.runId,
            text: read.text || '',
            nextOffset: read.nextOffset,
            lossy: !!read.lossy,
            finished: !!record.finished,
          }
        },
      }),

      defineTool({
        name: 'autodoor_list_nodes',
        description: '列出 AutoDoor 全部「内置」节点类型的规格（复合/条件/动作/其他，共 29 种），含参数名/类型/默认值/说明。这是你（DSH agent）自主设计自动化行为树的第一步：先读这份节点清单，理解每个节点能做什么、有哪些参数，然后由你直接在对话里推理出节点结构，用 autodoor_save_structure 落盘。注意：内置节点之外，AutoDoor 还支持「插件节点」（如表达式计算、偏移移动、原地点击、Excel 读写、YOLO 检测等），请额外调用 autodoor_list_plugins 查看；插件节点在 structure 里的 type 必须写成「插件名.节点类型」（如 math_expressions.ExpressionNode）。返回 { ok, stdout }，stdout 为结构化文本。',
        parameters: {},
        output: { schema: { type: 'json' }, render: textRender },
        async execute(args, exec) {
          try {
            const r = await execSync(['ai', 'nodes'])
            return { ok: r.ok, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) }
          }
        },
      }),

      defineTool({
        name: 'autodoor_list_plugins',
        description: '列出 AutoDoor 已安装插件的全部能力：插件名、作者、描述，以及每个插件提供的节点类型（带「插件名.节点类型」前缀）和参数 schema。这是「接入插件能力」的关键：当内置 29 个节点无法满足需求（例如需要四则运算、相对偏移移动、原地点击、Excel 读写、YOLO 检测等），先调用本工具查看已有插件是否已提供该能力，避免重复造轮子。在 structure.json 中引用插件节点时，type 必须使用返回的带前缀完整名（如 math_expressions.ExpressionNode）。返回 { ok, stdout }。',
        parameters: {},
        output: { schema: { type: 'json' }, render: textRender },
        async execute(args, exec) {
          try {
            const r = await execSync(['plugin', 'nodes'])
            return { ok: r.ok, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) }
          }
        },
      }),

      defineTool({
        name: 'autodoor_create_plugin',
        description: '自主创建一个新的 AutoDoor 插件并接入插件系统。当内置节点和已有插件都无法满足某个功能缺陷时，用它把自定义节点能力落盘到 plugins/{name}/（生成 plugin.json、nodes.py、main.py、__init__.py），创建后自动重新扫描验证插件可被发现。插件节点运行时类型为「{name}.{节点类型}」。\n\n节点基类（base_class）决定实现哪个方法：\n- ActionNode：实现 _execute_action(self, context)，成功返回 NodeStatus.SUCCESS，失败 NodeStatus.FAILURE；用 context.blackboard.get/set 读写黑板、context.execute_mouse_move / execute_mouse_click 操作鼠标。\n- ConditionNode：实现 _check_condition(self, context)，返回 True/False（注意方法名是 _check_condition，不是 _check；基类中它是 @abstractmethod，写成 _check 会在实例化时抛 TypeError）。\n- CompositeNode：实现 _tick(self, context)。\n\ncode 字段是一段完整的 Python 类定义（不含 import，import 已自动生成）。示例 ActionNode 的 code：\n  class MyNode(ActionNode):\n      NODE_TYPE = "MyNode"\n      def _execute_action(self, context):\n          context.blackboard.set("result", 42)\n          return NodeStatus.SUCCESS\n\n返回 { ok, pluginName, pluginDir, className, nodeTypes, verified, stdout }。',
        parameters: {
          name: { type: 'string', description: '插件名（snake_case，同时是目录名，如 my_math）', required: true },
          display_name: { type: 'string', description: '插件显示名（中文，如「我的计算」）', required: true },
          description: { type: 'string', description: '插件功能描述', required: true },
          version: { type: 'string', description: '版本号，默认 1.0.0' },
          author: { type: 'string', description: '作者，默认 AutoDoor Team' },
          category: { type: 'string', description: '分类，默认 general' },
          nodes: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
            description: '节点定义数组。每项：{ type(节点类名), display_name, description, base_class("ActionNode"/"ConditionNode"/"CompositeNode"), icon(可选), code(完整类定义源码), schema(可选 [{key,label,type,default}]) }',
            required: true,
          },
        },
        output: { schema: { type: 'json' }, render: textRender },
        async execute(args, exec) {
          try {
            const name = String(args.name || '').trim()
            if (!/^[a-z0-9_]+$/.test(name)) {
              return { ok: false, error: 'name 必须是 snake_case（小写字母/数字/下划线），当前: ' + name }
            }
            const nodes = Array.isArray(args.nodes) ? args.nodes : []
            if (nodes.length === 0) {
              return { ok: false, error: 'nodes 必须是非空数组，每项至少含 type 与 code' }
            }
            for (const n of nodes) {
              if (!String(n.type || '').trim() || !String(n.code || '').trim()) {
                return { ok: false, error: '每个节点必须提供非空的 type 与 code，问题项: ' + JSON.stringify({ type: n && n.type }) }
              }
            }

            const pluginDir = join(ROOT, 'plugins', name)
            mkdirSync(pluginDir, { recursive: true })

            const displayName = String(args.display_name || name)
            const description = String(args.description || '')
            const version = String(args.version || '1.0.0')
            const author = String(args.author || 'AutoDoor Team')
            const category = String(args.category || 'general')
            const cls = pascalCase(name) + 'Plugin'

            // 1) plugin.json
            const manifest = {
              name: name,
              display_name: displayName,
              version: version,
              author: author,
              description: description,
              category: category,
              entry: 'main.py',
              class: cls,
            }
            writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 4) + '\n', 'utf-8')

            // 2) __init__.py
            writeFileSync(join(pluginDir, '__init__.py'), '"""' + displayName + ' 插件"""\n', 'utf-8')

            // 3) nodes.py
            const typeNames = nodes.map(function (n) { return String(n.type).trim() })
            const nodesPyHeader = [
              '# plugins/' + name + '/nodes.py',
              'from bt_core.nodes import ActionNode, ConditionNode, CompositeNode',
              'from bt_core.status import NodeStatus',
              'from bt_utils.log_manager import LogManager',
              '',
              '',
            ].join('\n')
            const codeBlocks = nodes.map(function (n) {
              return String(n.code || '').trim()
            })
            writeFileSync(join(pluginDir, 'nodes.py'), nodesPyHeader + codeBlocks.join('\n\n\n') + '\n', 'utf-8')

            // 4) main.py
            const ml = []
            ml.push('# plugins/' + name + '/main.py')
            ml.push('from bt_plugins.base import BasePlugin')
            ml.push('from plugins.' + name + '.nodes import ' + typeNames.join(', '))
            ml.push('')
            ml.push('')
            ml.push('class ' + cls + '(BasePlugin):')
            ml.push('    """' + displayName + '插件"""')
            ml.push('')
            ml.push('    def get_nodes(self):')
            ml.push('        return {')
            for (const n of nodes) {
              ml.push('            ' + pyStr(String(n.type)) + ': ' + String(n.type) + ',')
            }
            ml.push('        }')
            ml.push('')
            ml.push('    def get_node_schemas(self):')
            ml.push('        return {')
            for (const n of nodes) {
              const schema = Array.isArray(n.schema) ? n.schema : []
              const arr = schema.map(function (s) {
                return '{' +
                  "'key': " + pyStr(s && s.key !== undefined ? s.key : '') + ', ' +
                  "'label': " + pyStr(s && s.label !== undefined ? s.label : '') + ', ' +
                  "'type': " + pyStr(s && s.type !== undefined ? s.type : 'text') + ', ' +
                  "'default': " + pyValue(s && s.default !== undefined ? s.default : '') +
                  '}'
              })
              ml.push('            ' + pyStr(String(n.type)) + ': [' + arr.join(', ') + '],')
            }
            ml.push('        }')
            ml.push('')
            ml.push('    def get_node_display_info(self):')
            ml.push('        return {')
            for (const n of nodes) {
              ml.push('            ' + pyStr(String(n.type)) + ': {')
              ml.push('                "display_name": ' + pyStr(String(n.display_name || n.type)) + ',')
              ml.push('                "description": ' + pyStr(String(n.description || '')) + ',')
              ml.push('                "category": "plugin",')
              ml.push('                "icon": ' + pyStr(String(n.icon || '')) + ',')
              ml.push('            },')
            }
            ml.push('        }')
            writeFileSync(join(pluginDir, 'main.py'), ml.join('\n') + '\n', 'utf-8')

            // 5) 验证：重新扫描插件，确认新插件可被发现（加载失败会体现在 stderr/stdout 中）
            const r = await execSync(['plugin', 'nodes'])
            const found = r.stdout.indexOf(name + '.') >= 0
            return {
              ok: found,
              pluginName: name,
              pluginDir: pluginDir,
              className: cls,
              nodeTypes: typeNames.map(function (t) { return name + '.' + t }),
              verified: found,
              stdout: r.stdout,
              stderr: r.stderr,
            }
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) }
          }
        },
      }),

      defineTool({
        name: 'autodoor_save_structure',
        description: '把你在对话中自主设计出的节点结构（structure）落盘为 .ai/structure.json，供后续 autodoor_generate 生成可执行行为树。这是「AI 自主设计」的核心步骤：你不需要调用任何外部 LLM，而是自己推理出结构。structure 是一个对象，必须含 nodes 数组；每个节点含 id(唯一字符串)、type(必须是 autodoor_list_nodes 返回的合法节点类型名)、config(该节点参数，可省略)、children(子节点 id 数组，叶子节点为 [])。根节点必须是 StartNode，且 nodes[0] 必须是根。可传 targetFilename 覆盖默认文件名。返回 { ok, structurePath, nodeCount }。',
        parameters: {
          structure: { type: 'object', additionalProperties: true, description: '节点结构对象 { nodes: [{ id, type, config?, children }] }', required: true },
          targetFilename: { type: 'string', description: '落盘文件名，默认 structure.json' },
        },
        output: { schema: { type: 'json' }, render: textRender },
        async execute(args, exec) {
          try {
            const s = args.structure
            if (!s || typeof s !== 'object' || !Array.isArray(s.nodes) || s.nodes.length === 0) {
              return { ok: false, error: 'structure 必须含非空 nodes 数组' }
            }
            const root = s.nodes[0]
            if (!root || root.type !== 'StartNode') {
              return { ok: false, error: 'nodes[0] 必须是 StartNode 根节点，当前: ' + (root && root.type) }
            }
            const path = saveStructure(s, args.targetFilename || 'structure.json')
            return { ok: true, structurePath: path, nodeCount: s.nodes.length, nodeTypes: s.nodes.map(function (n) { return n.type }) }
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) }
          }
        },
      }),

      defineTool({
        name: 'autodoor_generate',
        description: '纯规则地把 structure.json（由 autodoor_save_structure 落盘，或指定 file）转换为可执行的 tree.json（自动计算布局坐标、补全元数据、做结构校验）。此步骤不调用任何 LLM。默认输入 .ai/structure.json，输出 .ai/tree.json。返回 { ok, treePath, nodeCount, connectionCount, stdout }。',
        parameters: {
          file: { type: 'string', description: 'structure.json 路径（绝对路径，或相对 .ai 的文件名如 structure.json；缺省用 .ai/structure.json）' },
        },
        output: { schema: { type: 'json' }, render: textRender },
        async execute(args, exec) {
          try {
            const rel = function (p) {
              if (!p) return ''
              return (p.indexOf('D:\\') === 0 || p.indexOf('C:\\') === 0) ? p : ROOT + '\\' + p.replace(/^[\\/]+/, '')
            }
            const file = rel(args.file || '.ai\\structure.json')
            const r = await execSync(['ai', 'generate', file])
            const treePath = join(ROOT, '.ai', 'tree.json')
            let parsed = null
            try { parsed = JSON.parse(readFileSync(treePath, 'utf-8').replace(/^\uFEFF/, '')) } catch (e) { /* ignore */ }
            return {
              ok: r.ok,
              exitCode: r.exitCode,
              treePath: treePath,
              nodeCount: parsed && parsed.nodes ? Object.keys(parsed.nodes).length : null,
              connectionCount: parsed && parsed.connections ? parsed.connections.length : null,
              stdout: r.stdout,
              stderr: r.stderr,
            }
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) }
          }
        },
      }),
    ]

    // 注册全部工具；disposer 由 ctx.effect 持有，插件停止时自动注销。
    tools.forEach(function (tool) {
      ctx.effect(function () { return toolRegistry.register(tool) })
    })

    // 插件停止时终止所有仍存活的后台子进程，保证副作用可逆。
    ctx.effect(function () {
      return function () {
        runs.forEach(function (record) {
          try { record.handle.terminate() } catch (e) { /* noop */ }
        })
      }
    })
  },
}
