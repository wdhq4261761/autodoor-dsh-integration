// AutoDoor 行为树驱动工具 — 本地 ESM 插件（路线A 持久化形态）
// 由 DSH 预设 agent.cordis.yml 通过绝对路径引用加载。
// 实现与动态插件 autd-3/pkg-4 等价：7 个模型工具 + 执行抽象层。
// 执行抽象层（execCli）当前走子进程调 venv CLI；路线C 切换为 HTTP 调用时只需替换此函数。
// 注意：本文件位于用户主目录预设，Node ESM 无法从文件位置解析 DSH 私有包，
// 因此用绝对 file:// URL 导入 dsh-tools。
import { defineTool } from 'file:///C:/Users/WINDOWS/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

export default {
  name: 'autodoor-tools',
  apply(ctx) {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) return
    const toolRegistry = ctx.get('tools')
    if (toolRegistry === undefined) return

    const PY = 'D:\\workspace\\autodoor_behavior_tree\\venv\\Scripts\\python.exe'
    const CLI = 'D:\\workspace\\autodoor_behavior_tree\\cli.py'
    const ROOT = 'D:\\workspace\\autodoor_behavior_tree'

    // runId -> { handle, startedAt, finished, exitCode, error }
    const runs = new Map()
    let runSeq = 0

    function makeRunId() {
      runSeq += 1
      return 'autodoor-' + runSeq
    }

    // 执行抽象层：当前实现 = 子进程调 CLI；路线C 切换为 HTTP 调用时只需替换本函数。
    function execCli(args, opts) {
      const handle = subprocess.spawn({
        argv: [PY, CLI].concat(args),
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

    // AI 流水线各阶段的命令构造（与动态插件 pkg-8 的 buildStageArgs 等价）
    function buildStageArgs(stage, args) {
      var rel = function (p) {
        if (!p) return ''
        return (p.indexOf('D:\\') === 0 || p.indexOf('C:\\') === 0) ? p : ROOT + '\\' + p.replace(/^[\\/]+/, '')
      }
      switch (stage) {
        case 'plan': return ['ai', 'plan', args.description || '']
        case 'select': return ['ai', 'select', rel(args.file || '.ai\\plan.json')]
        case 'scan': return ['ai', 'scan', rel(args.file || '.ai\\structure.json')]
        case 'generate': return ['ai', 'generate', rel(args.file || '.ai\\structure.json')]
        case 'validate': return ['ai', 'validate', rel(args.file)]
        case 'test': return ['ai', 'test', rel(args.file)]
        case 'refine': return ['ai', 'refine', rel(args.file)]
        default: return null
      }
    }

    // 后台启动一次执行（run / ai_pipeline 共用）
    function startBackground(cliArgs, prefix) {
      const handle = execCli(cliArgs)
      const runId = (function () { runSeq += 1; return (prefix || 'autodoor-') + runSeq })()
      const record = { handle: handle, startedAt: Date.now(), finished: false, exitCode: null, error: null }
      runs.set(runId, record)
      track(record)
      return { runId: runId, record: record }
    }

    var tools = [
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
        description: '以 headless 模式后台运行一个 AutoDoor 行为树，立即返回 runId（进程在插件生命周期内持续运行）。随后用 autodoor_status 查询状态、autodoor_read_log 读取日志、autodoor_stop 停止。注意：运行中的树会真实操作桌面（键鼠/OCR），请确认目标环境安全。',
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
            if (args.plugins) flags.push('--plugins')
            const handle = execCli(['run', args.treeFile, '--headless'].concat(flags))
            const runId = makeRunId()
            const record = { handle: handle, startedAt: Date.now(), finished: false, exitCode: null, error: null }
            runs.set(runId, record)
            track(record)
            return { runId: runId, pid: handle.pid, status: 'starting', hint: '用 autodoor_status 查询，autodoor_read_log 读日志，autodoor_stop 停止' }
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
        description: '列出 AutoDoor 全部可用节点类型的规格（复合/条件/动作/其他，共 29 种），含参数名/类型/默认值/说明。供模型为任务选型节点时参考。返回 { ok, stdout }，stdout 为结构化文本。',
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
        name: 'autodoor_ai_create',
        description: '将用户的自然语言任务描述交给 AutoDoor 内置 LLM 做意图分析，生成结构化任务计划 .ai/plan.json（含任务概述/循环配置/阶段列表/窗口绑定）。这是 AI 生成闭环的起点：生成 plan.json 后，可读取该文件了解规划，再配合 autodoor_list_nodes 选型。注意需要已配置 ai.llm.api_key。返回 { ok, planPath, stdout }。',
        parameters: {
          description: { type: 'string', description: '自然语言任务描述，例如：每 3 秒检测屏幕是否出现"发货成功"文字，出现则播放报警音并停止，重复 50 次', required: true },
        },
        output: { schema: { type: 'json' }, render: textRender },
        async execute(args, exec) {
          try {
            const r = await execSync(['ai', 'plan', args.description])
            return {
              ok: r.ok,
              exitCode: r.exitCode,
              planPath: 'D:\\workspace\\autodoor_behavior_tree\\.ai\\plan.json',
              stdout: r.stdout,
              stderr: r.stderr,
            }
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) }
          }
        },
      }),

      defineTool({
        name: 'autodoor_ai_pipeline',
        description: '后台执行 AutoDoor AI 流水线的单个无交互阶段，立即返回 runId（不阻塞）。阶段：plan(意图分析,参数description) / select(节点选型,输入plan.json) / scan(VLM屏幕感知,需vlm key) / generate(生成tree.json,无需LLM) / validate(校验tree.json) / test(试运行tree.json) / refine(迭代修正tree.json)。文件参数 file 可传绝对路径或相对 .ai 目录名（缺省用上一阶段产物）。用 autodoor_status 查询、autodoor_read_log 读日志、autodoor_stop 停止。注意 select/scan/refine 是数分钟级 LLM 长耗时操作。',
        parameters: {
          stage: { type: 'string', description: '阶段：plan/select/scan/generate/validate/test/refine', required: true },
          description: { type: 'string', description: 'plan 阶段的任务描述（其他阶段忽略）' },
          file: { type: 'string', description: '输入文件路径（绝对路径，或相对 .ai 的路径如 plan.json；缺省用上一阶段产物）' },
        },
        output: { schema: { type: 'json' }, render: textRender },
        async execute(args, exec) {
          try {
            const cliArgs = buildStageArgs(args.stage, args)
            if (cliArgs === null) return { ok: false, error: '未知阶段: ' + String(args.stage) }
            const started = startBackground(cliArgs, 'ai-')
            return { runId: started.runId, pid: started.record.handle.pid, stage: args.stage, status: 'starting', cmd: cliArgs.join(' '), hint: '用 autodoor_status 查询、autodoor_read_log 读日志' }
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
