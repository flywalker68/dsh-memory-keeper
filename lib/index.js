// dsh-memory-keeper — 长期记忆守门员
//
// 1) 会话开始时通过 system prompt 注入「记忆状态卡」：日记 / memory 体积 / 日程 / 手札 / 半衰期候选
// 2) memory_check 工具：随时查同一份状态
// 3) persona_edit 工具：自主修改人设或规则——先备份到 memory/_backups/ 再写，变更记日志
//
// 设计原则：状态卡是「便利贴」，不是「任务清单」——只报事实和轻提示，不命令；
// 人设修改一律经 persona_edit，保证每次都能回档。

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DAY, localDate, buildStatus, resolvePersonaFile, backupAndWrite,
  scanNotes, scanStale, oldestRelation, iamSnapshot,
} from './state.js'
import { loadOrBuild, searchMemory, eligibleChunks, readChatChunks, readChatDay, readChatDayFromLog, resolveQueryDate, shiftDate, loadMentions, saveMentions, mentionKey, markSeen, rrfMerge, enrichResults, formatResultLines, clampTunables } from './search.js'
import { ensureChunkVectors, embedTexts, cos, chunkKey, vectorStatus } from './embedding.js'
import {
  decodeSessionFile, findSessionFile, extractTurns,
  loadRecall, saveRecall, clearRecall, recallBlock,
} from './recall.js'

export const name = 'memory-keeper'
// 工具注册依赖 tools 服务：不声明 inject 时 ctx.tools 取不到
// （DSH 日志里 "cannot get property tools without inject" 就是在说这个）
export const inject = ['tools']

export const Config = Schema.object({
  workspace: Schema.string().default('')
    .description('工作区路径（对话记录在它下面的「对话记录/」，索引写在「.tools/」）。留空 = 用启动时的工作目录；建议填绝对路径'),
  memoryDir: Schema.string().default(join(homedir(), '.dsh', 'memory'))
    .description('记忆库目录'),
  agentsFile: Schema.string().default(join(homedir(), '.dsh', 'AGENTS.md'))
    .description('全局规则文件（persona_edit 可改）'),
  staleDays: Schema.number().default(90)
    .description('半衰期：关系片段超过这么多天就列成候选（只报不删）'),
  refreshMinutes: Schema.number().default(5)
    .description('状态卡缓存时长（分钟）：每次组装 system prompt 时超过这个间隔才重算'),
  embeddingEnabled: Schema.boolean().default(true)
    .description('memory_search 是否加本地向量召回（bge-small-zh，懒加载）'),
  compressRecallEnabled: Schema.boolean().default(true)
    .description('压缩后补原文：把被摘要掉的最近几轮原话重新注入（维持到下次压缩）'),
  compressRecallTurns: Schema.number().default(10)
    .description('补原文最多取几轮（1 轮 ≈ 一来一回；轮数是主控）'),
  compressRecallPerMessageChars: Schema.number().default(1200)
    .description('补原文单条消息字数上限：超长回复只截开头，防止一条吃掉整轮额度'),
  compressRecallChars: Schema.number().default(12000)
    .description('补原文字数安全阀（正常不触发；触发则从最旧的整轮开始丢）'),
  minRelevanceScore: Schema.number().default(0.5)
    .description('向量最高余弦低于此值就判「本次没有可靠记忆」，而不是硬塞弱相关块（第一道防编造闸门）。0.5 是在 bge-small-zh-v1.5 + 502 块语料上标定的：无答案查询最高 0.447，有答案最低 0.565；换模型 / 改切块 / 大批量写入后要重新标定'),
  dateBoostEnabled: Schema.boolean().default(true)
    .description('日期软加分：查询里出现「三天前 / 上周 / 上个月 / 2026-11-01」这类时间词时，该日期的块排序提前。只影响排序，不改原始分、不影响 0.50 闸门；没有时间词的查询完全不触发'),
  dateBoost: Schema.number().default(0.1)
    .description('日期软加分幅度（0.1 = 排序分 ×1.1；前后一天给一半）。要小，别压过内容相关性'),
  resultChars: Schema.number().default(400)
    .description('memory_search 返回时每条给模型看的字数上限（命中会补整行）。只控显示预算，不影响检索与打分'),
  contextLines: Schema.number().default(1)
    .description('memory_search 命中后附几行上下文（前/后各 N 行，都过时间窗口）。0 = 不附，最省 token'),
  personaNames: Schema.array(Schema.string()).default([])
    .description('日记里「合写多节」的节名（如两个角色各写一节）。填了才会检查每节是否补全；不填就不判断'),
})

export async function apply(ctx, config = {}) {
  const cfg = {
    workspace: config.workspace || process.cwd(),
    memoryDir: config.memoryDir || join(homedir(), '.dsh', 'memory'),
    agentsFile: config.agentsFile || join(homedir(), '.dsh', 'AGENTS.md'),
    staleDays: Number(config.staleDays ?? 90),
    refreshMinutes: Number(config.refreshMinutes ?? 5),
    embeddingEnabled: config.embeddingEnabled !== false,
    compressRecallEnabled: config.compressRecallEnabled !== false,
    compressRecallTurns: Number(config.compressRecallTurns ?? 10),
    compressRecallPerMessageChars: Number(config.compressRecallPerMessageChars ?? 1200),
    compressRecallChars: Number(config.compressRecallChars ?? 12000),
    minRelevanceScore: Number(config.minRelevanceScore ?? 0.5),
    dateBoostEnabled: config.dateBoostEnabled !== false,
    dateBoost: Number(config.dateBoost ?? 0.1),
    resultChars: Number(config.resultChars ?? 400),
    contextLines: Number(config.contextLines ?? 1),
    personaNames: Array.isArray(config.personaNames) ? config.personaNames : [],
  }
  const LOG = join(homedir(), '.dsh', 'memory-keeper.log')
  const RECALL_FILE = join(homedir(), '.dsh', 'compress-recall.json')
  // 面板旋钮（返回层 token 预算）：存独立 JSON，优先级高于 profile 配置。
  // 为什么不让面板直接改 cordis.patch.yml：那是宿主启动配置，写坏了整份 profile 起不来；
  // 独立文件写坏了最多是回落到默认值。
  const TUNABLES_FILE = join(homedir(), '.dsh', 'memory-keeper-tunables.json')
  const readTunables = () => {
    try {
      const j = JSON.parse(readFileSync(TUNABLES_FILE, 'utf8'))
      return j && typeof j === 'object' ? j : {}
    } catch { return {} }
  }
  const writeTunables = (patch) => {
    const next = { ...readTunables(), ...patch }
    for (const k of Object.keys(next)) if (next[k] === null || next[k] === undefined) delete next[k]
    try { writeFileSync(TUNABLES_FILE, JSON.stringify(next, null, 2), 'utf8') } catch { /* 写不进去就用旧值，不炸 */ }
    return next
  }
  /** 面板值 > profile 配置 > 默认值（夹回安全区间，见 clampTunables） */
  const effectiveTun = () => clampTunables(readTunables(), { contextLines: cfg.contextLines, resultChars: cfg.resultChars })
  const INDEX_FILE = join(cfg.workspace, '.tools', 'memory-index.json')
  const VECTOR_FILE = join(cfg.workspace, '.tools', 'memory-vectors.json')
  const MENTIONS_FILE = join(cfg.memoryDir, '_mentions.json')
  const searchDirs = [cfg.memoryDir, join(cfg.workspace, '日记')]
  const log = (level, ...args) => {
    try { appendFileSync(LOG, `[${new Date().toISOString()}] ${level} ${args.join(' ')}\n`, 'utf8') } catch { /* ignore */ }
  }
  log('INFO', 'apply() 进入')
  log('INFO', `workspace=${cfg.workspace} memoryDir=${cfg.memoryDir}`)
  // workspace 配错（比如落到 profile 目录）不会报错，只会表现为「日记 0 篇、搜不到东西」，
  // 所以启动时先探一眼、不像工作区就在日志里喊一声。
  try {
    const looksLikeWorkspace = existsSync(join(cfg.workspace, '对话记录')) || existsSync(join(cfg.workspace, '日记'))
    if (!looksLikeWorkspace) {
      log('WARN', `workspace=${cfg.workspace} 下没有「对话记录/」或「日记/」，可能配错了——请在插件配置里显式填 workspace 绝对路径`)
    }
  } catch { /* 探测失败不影响启动 */ }

  // ── 压缩后补原文：监听 compaction/summary，把被摘要掉的最近几轮原话捞回来 ──
  // 摘要保住"做了什么"，保不住"当时怎么说的"。捞回来的原文写进缓存文件，
  // systemPrompt 那边用函数形式每轮现读——不靠定时器，也不在乎重启时机。
  const handleCompact = (session, event) => {
    if (!cfg.compressRecallEnabled) return
    try {
      const d = event?.data || {}
      const seqs = Array.isArray(d.shadowedSeqs) && d.shadowedSeqs.length
        ? d.shadowedSeqs.map(Number)
        : (d.shadowedRange && typeof d.shadowedRange.start === 'number' && typeof d.shadowedRange.end === 'number'
          ? Array.from({ length: d.shadowedRange.end - d.shadowedRange.start + 1 }, (_, k) => d.shadowedRange.start + k)
          : [])
      if (!seqs.length) { log('WARN', '压缩事件没带 shadowedSeqs/shadowedRange，跳过补原文'); return }
      const sid = session?.id || session?.sessionId || d.sessionId || ''
      const file = findSessionFile(sid)
      if (!file) { log('WARN', `补原文：找不到会话日志 session=${sid || '(空)'}`); return }
      const records = decodeSessionFile(file)
      const got = extractTurns(records, seqs, {
        maxTurns: cfg.compressRecallTurns,
        perMessageChars: cfg.compressRecallPerMessageChars,
        maxChars: cfg.compressRecallChars,
      })
      if (!got.text) { log('WARN', `补原文：${seqs.length} 条被压记录里没捞出对话`); return }
      saveRecall(RECALL_FILE, {
        sessionId: sid,
        compactedAt: new Date().toISOString(),
        shadowedTokens: d.shadowedTokenCount ?? null,
        turns: got.turns,
        chars: got.chars,
        text: got.text,
      })
      log('INFO', `补原文：${got.turns} 轮 / ${got.chars} 字（被压 ${seqs.length} 条，token≈${d.shadowedTokenCount ?? '?'}）`)
    } catch (error) {
      log('WARN', '补原文失败：' + (error?.message || error))
    }
  }
  try {
    ctx.effect(() => {
      const off = ctx.on('session/event', (session, event) => {
        const t = event && event.type
        if (t === 'compaction/summary') handleCompact(session, event)
      })
      return () => { try { if (typeof off === 'function') off() } catch { /* ignore */ } }
    }, 'memory-keeper: 压缩后补原文')
    log('INFO', '已挂压缩补原文')
  } catch (error) {
    log('WARN', '挂压缩补原文失败：' + (error?.message || error))
  }

  const build = () => {
    try { iamSnapshot(cfg.memoryDir) } catch { /* ignore */ }
    return buildStatus({
      today: localDate(),
      tomorrow: localDate(Date.now() + DAY),
      workspace: cfg.workspace,
      memoryDir: cfg.memoryDir,
      staleDays: cfg.staleDays,
      mentions: loadMentions(MENTIONS_FILE),
      personaNames: cfg.personaNames,
    })
  }

  // ── memory_check 工具 ─────────────────────────────────
  try {
    ctx.tools.register(defineTool({
      name: 'memory_check',
      description: '查看长期记忆状态：日记进度、memory 体积与精简阈值、日程今天/明天、手札过期、半衰期候选；顺带返回当前会话消息数——会话一长就该写交接了。会话开始时也会自动注入同样的状态卡。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            today: { type: 'string' },
            diaryTotal: { type: 'number' },
            diaryToday: { type: 'boolean' },
            diaryYesterday: { type: 'boolean' },
            diaryGaps: { type: 'array', items: { type: 'string' } },
            memoryKb: { type: 'number' },
            memoryBackupsKb: { type: 'number' },
            scheduleToday: { type: 'array', items: { type: 'string' } },
            scheduleTomorrow: { type: 'array', items: { type: 'string' } },
            handnoteStale: { type: 'number' },
            staleCandidates: { type: 'number' },
            sessionMessages: { type: 'number' },
            sessionTurns: { type: 'number' },
            handoffHint: { type: 'string' },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.text }]
        },
      },
      async execute(_args, exec) {
        const r = build()
        // 会话轮数/消息数：消息多 ≠ 上下文满，只作参考；真实百分比以界面为准
        let messages = 0
        let turns = 0
        try {
          const log = exec?.agent?.session?.log
          if (Array.isArray(log)) {
            messages = log.length
            turns = log.filter(e => e?.type === 'turn/start').length
          } else if (Array.isArray(exec?.agent?.session?.messages)) {
            messages = exec.agent.session.messages.length
          }
        } catch { /* ignore */ }
        const handoffHint = (turns >= 80 || messages >= 2500)
          ? `- 交接提醒：会话已经 ${turns} 轮 / ${messages} 条消息。上下文百分比以主人界面为准（插件拿不到），他要是说"有点长了"，就写一笔交接`
          : ''
        const text = handoffHint === '' ? r.text : `${r.text}\n${handoffHint}`
        return {
          text,
          today: r.raw.today,
          diaryTotal: r.raw.diaries.total,
          diaryToday: r.raw.diaries.hasToday,
          diaryYesterday: r.raw.yesterdayWritten,
          diaryGaps: r.raw.diaryGaps,
          memoryKb: r.raw.sizeKb,
          memoryBackupsKb: r.raw.backupsKb,
          scheduleToday: r.raw.schedule.today,
          scheduleTomorrow: r.raw.schedule.tomorrow,
          handnoteStale: r.raw.handnotes.stale.length,
          staleCandidates: r.raw.stale.stale.length,
          sessionMessages: messages,
          sessionTurns: turns,
          handoffHint,
        }
      },
    }))
    log('INFO', '已注册工具 memory_check')
  } catch (error) {
    log('WARN', '注册 memory_check 失败', error?.message ?? String(error))
  }

  // ── persona_edit 工具（自主改人设，自动备份）────────────
  try {
    ctx.tools.register(defineTool({
      name: 'persona_edit',
      description: '修改人设或记忆文件（05/01/07/08/00/AGENTS 等）：先自动备份到 memory/_backups/，再写入，并把变更记进 _persona-changelog.md。自主调整性格或规则时必须走这个工具，保证每次都能回档。',
      parameters: {
        file: {
          type: 'string',
          required: true,
          description: '05 / 01 / 07 / 08 / 00 / AGENTS，或一个绝对路径',
        },
        mode: {
          type: 'string',
          required: true,
          enum: ['replace', 'append'],
          description: 'replace = 替换（oldText 必须唯一匹配）；append = 追加到文件末尾',
        },
        oldText: {
          type: 'string',
          description: 'replace 模式要替换的原文（务必带足够上下文，确保唯一）',
        },
        newText: {
          type: 'string',
          required: true,
          description: '新内容',
        },
        reason: {
          type: 'string',
          description: '为什么改（写进变更日志，方便以后回看）',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file: { type: 'string' },
            backup: { type: 'string' },
            bytes: { type: 'number' },
            moved: { type: 'array', items: { type: 'string' } },
          },
        },
        render(_args, value) {
          const extra = value.moved?.length ? `；归档了 ${value.moved.length} 份旧备份` : ''
          return [{ type: 'text', text: `已改 ${value.file}（${value.bytes} bytes）；备份：${value.backup}${extra}` }]
        },
      },
      async execute(args) {
        const target = resolvePersonaFile(args.file, cfg)
        const result = backupAndWrite({
          file: target,
          mode: args.mode,
          oldText: args.oldText,
          newText: args.newText,
          reason: args.reason,
          cfg,
        })
        log('INFO', `persona_edit ${target} ${args.mode}`)
        return result
      },
    }))
    log('INFO', '已注册工具 persona_edit')
  } catch (error) {
    log('WARN', '注册 persona_edit 失败', error?.message ?? String(error))
  }

  // ── memory_search 工具：bigram 分词检索（轻量、零模型）──────
  try {
    ctx.tools.register(defineTool({
      name: 'memory_search',
      description: '按意思找旧记忆：把查询按字拆成 2 字词组，扫 memory 和日记打分，返回最相关的几段（文件+行号+原文）。问"记过的事 / 对主人的印象 / 偏好"用它；问"那天说过什么、原话"用 chat_search。换说法（同义词）仍可能漏，漏了就补几个关键词再搜。',
      parameters: {
        query: { type: 'string', required: true, description: '想找的东西，几个关键词或一句话都行' },
        top: { type: 'number', description: '返回几条（默认 10）。20 题检索集实测：hit@5 70%、hit@10 80%——答案块常排在 6~10 名，别只取 5 条' },
        beforeDate: { type: 'string', description: '只搜这个日期（YYYY-MM-DD）及之前的记忆；不传 = 不限。用于「只看某个截止点之前」的场景（评测 / 回看历史时点）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            rebuilt: { type: 'boolean' },
            results: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  file: { type: 'string' },
                  line: { type: 'number' },
                  text: { type: 'string' },
                  score: { type: 'number' },
                  date: { type: 'string' },
                  hits: { type: 'number' },
                  why: { type: 'array', items: { type: 'string' } },
                  from: { type: 'array', items: { type: 'string' } },
                  full: { type: 'string' },
                  context: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.text }]
        },
      },
      async execute(args) {
        const top = args.top ?? 10
        const beforeDate = args.beforeDate || null
        const { index, rebuilt } = loadOrBuild(searchDirs, INDEX_FILE)
        // 查询里带时间词才触发日期软加分；不带时间词的查询，排序跟以前完全一样
        const boostDate = cfg.dateBoostEnabled ? resolveQueryDate(args.query) : null
        let results = searchMemory(index, args.query, top, { boostDate, dateBoost: cfg.dateBoost, beforeDate: args.beforeDate })
        let vectorUsed = false
        let v1 = null // 向量最高余弦；null = 没跑向量（纯词面模式不设闸门）
        if (cfg.embeddingEnabled) {
          try {
            const vecMap = await ensureChunkVectors(index, VECTOR_FILE, log)
            if (vecMap && vecMap.size) {
              const [qv] = await embedTexts([args.query])
              const scored = []
              // 候选集跟词面路共用 eligibleChunks——时间窗口只有一处实现，
              // 不再靠「记得两边都改」。漏一路的话未来记忆会静默漏回来。
              for (const c of eligibleChunks(index.chunks, beforeDate)) {
                const v = vecMap.get(chunkKey(c))
                if (v) scored.push({ c, s: cos(qv, v) })
              }
              scored.sort((a, b) => b.s - a.s)
              v1 = scored[0]?.s ?? 0
              const vecResults = scored.slice(0, top * 4).map((x) => {
                const item = {
                  file: x.c.file, line: x.c.line, text: x.c.text,
                  score: Math.round(x.s * 100) / 100, hits: 0, why: [],
                }
                if (x.c.date) item.date = x.c.date // 没日期就不加这个键：带 undefined 的键会让工具的 JSON 校验失败
                return item
              })
              if (vecResults.length) {
                results = rrfMerge(results, vecResults, top)
                vectorUsed = true
              }
            }
          } catch (error) {
            log('WARN', '向量检索失败，回退词面：' + (error?.message || error))
          }
        }
        // ── 第一道防编造闸门 ──
        // 向量最高分都低于阈值，说明库里没有像样的东西；此时清空结果，
        // 明确告诉模型"没有可靠记忆"，而不是把低分弱相关块硬塞进去诱它编。
        // （0.5 是 bge-small-zh-v1.5 + 502 块语料上标定的：无答案查询 ≤0.447，有答案 ≥0.565）
        let fallback = false
        if (v1 !== null && v1 < cfg.minRelevanceScore) {
          fallback = true
          results = []
          log('INFO', `memory_search「${args.query}」兜底：向量最高 ${v1.toFixed(3)} < ${cfg.minRelevanceScore}`)
        }
        // 命中即「想起」：只记最近搜索时间，不涨提及次数（手标仍是加固主线）
        const mentions = loadMentions(MENTIONS_FILE)
        if (results.length && !saveMentions(MENTIONS_FILE, markSeen(mentions, results.slice(0, 3)))) {
          log('WARN', '「最近想起」没写进去（_mentions.json）——这次算白记')
        }
        const times = (r) => mentions[mentionKey(r.file, r.text)]?.count ?? 0
        // 返回层补全：给命中补整行原文与上下文（不碰检索，实现见 enrichResults）。
        // 旋钮每次现读：面板里改完立刻生效，不用重启，也不用动 cordis.patch.yml。
        // **必须在 lines 之前**：lines 渲染的就是 full / context，先拼行再补等于白做。
        const tun = effectiveTun()
        enrichResults(results, beforeDate, { contextLines: tun.contextLines, maxContext: tun.resultChars })
        const lines = fallback
          ? ['本次没有可靠记忆。如果回答需要过去的事实，请明确说"人家没记到"，不要推测、不要编。']
          : results.length === 0
            ? [`没找到「${args.query}」——换个说法或补几个关键词再试；也可以先用 grep 兜底。`]
            : formatResultLines(results, times, { maxChars: tun.resultChars })
        // 检索到 ≠ 里面有答案：治「把相关块当答案拼」——实测的三种翻车正好是
        // 拿同话题下别的对象属性、别的编号数值、相近字段当答案
        const caution = results.length && !fallback
          ? '\n\n以下是相关记忆，**检索到相关内容不代表其中包含答案**。请核对它们是否直接回答了这个具体问题；不要把同一话题下别的对象属性、别的编号数值、或相近字段当作答案。若没有直接回答，就说「没记到」，不要用相关内容拼凑。若这几块之间互相冲突（同一件事出现不同说法），要明确点出冲突是什么、说明哪个无法确定——不要只把两种说法并列就结束。如果问的是「现在到哪一步了」「还在不在」这类状态，以**日期最新的那条**为准；更早的说法可能只是当时的旧状态，别拿旧状态当现状。'
          : ''
        // 向量状态要**直接写在结果里**：装没装好、有没有降级，用户看一眼返回就知道，
        // 不用翻 README、也不用翻日志。
        let vecTag = ''
        if (vectorUsed) vecTag = '（向量+词面）'
        else if (cfg.embeddingEnabled) vecTag = '（仅词面：向量检索失败——多半是 sharp 没装好，见 README「sharp」那节）'
        else vecTag = '（仅词面：向量检索已关闭）'
        log('INFO', `memory_search "${args.query}" → ${results.length} 条${vecTag}${fallback ? '（兜底）' : ''}`)
        // 统一剔掉值为 undefined 的键：DSH 的 lossless JSON 校验不接受它，
        // 而这类键很容易在「加字段时忘了判空」的地方冒出来（这个坑踩过两次）。
        const cleanResults = results.map((r) => {
          for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k]
          return r
        })
        return {
          text: `检索「${args.query}」：${fallback ? '未找到可靠记忆' : results.length + ' 条'}` + vecTag + (rebuilt ? '（索引刚重建）' : '') + '\n' + lines.join('\n') + caution,
          rebuilt,
          results: cleanResults,
        }
      },
    }))
    log('INFO', '已注册工具 memory_search')
  } catch (error) {
    log('WARN', '注册 memory_search 失败', error?.message ?? String(error))
  }

  // ── chat_search 工具：翻对话原文（不建常驻索引，现读现切）──────
  try {
    ctx.tools.register(defineTool({
      name: 'chat_search',
      description: '翻对话原文：按意思搜最近 N 天（默认 7 天）的对话记录，返回命中的消息段（文件+行号+原文）。问"那天说过什么""原话""上次聊的"时用它；memory_search 只搜提炼过的记忆和日记。',
      parameters: {
        query: { type: 'string', required: true, description: '想找的话或关键词' },
        top: { type: 'number', description: '返回几条（默认 5）' },
        days: { type: 'number', description: '翻最近几天（默认 7）' },
        date: { type: 'string', description: '指定某一天（YYYY-MM-DD），优先按那天搜；查询里带"昨天/前天"也会自动认' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            results: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  file: { type: 'string' },
                  line: { type: 'number' },
                  text: { type: 'string' },
                  score: { type: 'number' },
                  hits: { type: 'number' },
                  why: { type: 'array', items: { type: 'string' } },
                  date: { type: 'string' },
                },
              },
            },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.text }]
        },
      },
      async execute(args) {
        const q = String(args.query || '')
        const top = args.top ?? 5
        const days = Math.max(1, Math.min(30, Math.floor(Number(args.days ?? 7))))
        // 明确日期（参数或查询里的"昨天/前天"）→ 先按那天筛；否则按相关性
        const target = args.date ? String(args.date) : (resolveQueryDate(q) || null)
        let results = []
        let usedDate = null
        let relaxed = ''
        let fromLog = false
        if (target) {
          usedDate = target
          let chunks = readChatDay(cfg.workspace, target)
          // 对话记录是次日导出的：当天/刚聊过的在导出文件里没有，改读会话日志
          if (!chunks.length) {
            chunks = readChatDayFromLog(cfg.workspace, target)
            fromLog = chunks.length > 0
          }
          results = searchMemory({ chunks }, q, top)
          if (!results.length) {
            // 兜底别给空手：放宽到前后各一天再搜一次（主人可能记错了一天）
            const before = shiftDate(target, -1)
            const after = shiftDate(target, 1)
            results = searchMemory({ chunks: [...readChatDay(cfg.workspace, before), ...readChatDay(cfg.workspace, after)] }, q, top)
            if (results.length) relaxed = `（${target} 没命中，放宽到前后一天）`
          }
        } else {
          let chunks = readChatChunks(cfg.workspace, days)
          // 导出永远比今天慢一天：把今天的对话从会话日志补进来，否则"刚才说过的"搜不到
          const todayChunks = readChatDayFromLog(cfg.workspace, localDate())
          if (todayChunks.length) { chunks = [...chunks, ...todayChunks]; fromLog = true }
          results = searchMemory({ chunks }, q, top)
          // 同分时新的排前面（文件名里带日期）
          results.sort((a, b) => b.score - a.score || (a.file < b.file ? 1 : a.file > b.file ? -1 : 0))
        }
        const scope = (usedDate ? `指定日期 ${usedDate}${relaxed}` : `最近 ${days} 天`) + (fromLog ? '，含会话日志' : '')
        const lines = results.length === 0
          ? [`没找到「${q}」——${usedDate ? '那天和前后一天都没有' : '范围内没有'}；换个说法，或把 days 放大再试。`]
          : results.map((r, i) => `${i + 1}. [${basename(r.file)}:${r.line}] ${r.text.slice(0, 400)}（${r.score}）`)
        log('INFO', `chat_search "${q}" ${usedDate ? 'date=' + usedDate : 'days=' + days}${relaxed ? '（放宽）' : ''} → ${results.length} 条`)
        // 跟 memory_search 一样的兜底：undefined 键会让工具的 JSON 校验失败
        const cleanChat = results.map((r) => {
          for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k]
          return r
        })
        return { text: `对话原文检索「${q}」（${scope}）：${results.length} 条\n` + lines.join('\n'), results: cleanChat }
      },
    }))
    log('INFO', '已注册工具 chat_search')
  } catch (error) {
    log('WARN', '注册 chat_search 失败', error?.message ?? String(error))
  }

  // ── memory_touch 工具：只记"真的用上了"，不猜 ────────────
  // 旧版在 session/event 里拿用户消息自动搜、撞词就 +1——某个常用词会一次刷十几条，
  // 把"被叫名字"误当成"想起某件事"。词面判断不了意图，所以自动通道砍掉：
  // 由我在翻旧账、引用某段时手动标（输入 memory_search 结果的 file+line），一次 +1。
  try {
    ctx.tools.register(defineTool({
      name: 'memory_touch',
      description: '确认某条记忆被真正用上了（回忆即加固）：翻旧账、引用某段记忆后，用 memory_search 结果里的 file 和 line 调一次，该条提及次数 +1；提过 3 次后不再进遗忘候选。只给"真的用上"的标，不猜。',
      parameters: {
        file: { type: 'string', required: true, description: '记忆文件绝对路径（memory_search 结果里的 file）' },
        line: { type: 'number', required: true, description: '行号（memory_search 结果里的 line，从 1 开始）' },
        note: { type: 'string', description: '可选：这次为什么用上它（写进日志）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            file: { type: 'string' },
            line: { type: 'number' },
            count: { type: 'number' },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.text }]
        },
      },
      async execute(args) {
        const lineNo = Math.floor(Number(args.line))
        if (!Number.isFinite(lineNo) || lineNo < 1) throw new Error('line 必须是 ≥1 的整数')
        if (!existsSync(args.file)) throw new Error('文件不存在：' + args.file)
        const lines = readFileSync(args.file, 'utf8').split('\n')
        if (lineNo > lines.length) throw new Error(`行号越界：${basename(args.file)} 只有 ${lines.length} 行`)
        const text = lines[lineNo - 1].trim()
        if (!text) throw new Error('该行是空行，不记')
        const mentions = loadMentions(MENTIONS_FILE)
        const key = mentionKey(args.file, text)
        const cur = mentions[key] ?? { count: 0, last: 0 }
        cur.count += 1
        cur.last = Date.now()
        mentions[key] = cur
        if (!saveMentions(MENTIONS_FILE, mentions)) {
          throw new Error('提及没写进去（_mentions.json），这次没记上')
        }
        log('INFO', `memory_touch ${basename(args.file)}:${lineNo} → 第 ${cur.count} 次` + (args.note ? `（${args.note}）` : ''))
        return {
          text: `已记一笔：${basename(args.file)}:${lineNo} 被用上第 ${cur.count} 次`,
          file: args.file,
          line: lineNo,
          count: cur.count,
        }
      },
    }))
    log('INFO', '已注册工具 memory_touch')
  } catch (error) {
    log('WARN', '注册 memory_touch 失败', error?.message ?? String(error))
  }

  // ── 面板 API（网页半边用）────────────────────────────
  // webServer 服务可能比插件晚就绪：用 ctx.inject 等它出现再注册（直接 ctx.get 会拿到 undefined）
  try {
    ctx.inject(['webServer'], (wctx) => {
      try {
        const webServer = wctx.webServer
        if (!webServer || typeof webServer.register !== 'function') {
          log('WARN', 'webServer 没有 register，面板 API 不可用')
          return
        }
        // 用 wctx.effect 包注册：热重载时旧路由自动注销，否则会 duplicate exact route。
        // 旧版本插件留下过没有 disposer 的路由，重启前可能仍占着路径——遇到重复就跳过、只记日志。
        const safeRegister = (route, label) => {
          try {
            wctx.effect(() => webServer.register(route), label)
          } catch (error) {
            log('WARN', `注册面板路由失败（可能旧实例残留，重启 DSH 后清）：${route.path} ${error?.message ?? error}`)
          }
        }
        safeRegister({
          kind: 'exact',
          path: '/memory-keeper/api/state',
          handler: (req, res) => {
            try {
              const today = localDate()
              const mentions = loadMentions(MENTIONS_FILE)
              const r = build()
              const oldest = oldestRelation(cfg.memoryDir, today)
              const hard = scanStale(cfg.memoryDir, today, cfg.staleDays, mentions).stale
              const soft = scanStale(cfg.memoryDir, today, 30, mentions).stale
              const nowMs = Date.now()
              const recencyOf = (last) => {
                const d = Math.max(0, (nowMs - (last || nowMs)) / 86400000)
                return d < 1 ? 1 : d < 7 ? 0.8 : d < 30 ? 0.5 : 0.2
              }
              const top = Object.entries(mentions)
                .filter(([, v]) => (v.count || 0) > 0) // 只列真被提起的；搜索命中不算
                .map(([k, v]) => {
                  const [file, text] = k.split('::')
                  const score = Math.round((v.count * (0.6 + 0.4 * recencyOf(v.last))) * 100) / 100
                  return { file, text, count: v.count, last: v.last, score }
                })
                .sort((a, b) => b.score - a.score)
                .slice(0, 12)
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({
                ok: true,
                today,
                diaryTotal: r.raw.diaries.total,
                memoryKb: r.raw.sizeKb,
                backupsKb: r.raw.backupsKb,
                relations: scanStale(cfg.memoryDir, today, cfg.staleDays, {}).total,
                daysKnown: oldest ? oldest.days : null,
                firstSeen: oldest ? oldest.date : null,
                notes: scanNotes(cfg.memoryDir, 3),
                hard,
                soft,
                mentionsTop: top,
              }))
            } catch (error) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: String(error) }))
            }
          },
        }, 'memory-keeper: /api/state')
        safeRegister({
          kind: 'exact',
          path: '/memory-keeper/api/search',
          handler: (req, res) => {
            try {
              const url = new URL(req.url, 'http://localhost')
              const q = url.searchParams.get('q') || ''
              const { index } = loadOrBuild(searchDirs, INDEX_FILE)
              const results = q ? searchMemory(index, q, 8) : []
              const mentions = loadMentions(MENTIONS_FILE)
              const out = results.map(r => ({ ...r, mentions: mentions[mentionKey(r.file, r.text)]?.count ?? 0 }))
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: true, q, results: out }))
            } catch (error) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: String(error) }))
            }
          },
        }, 'memory-keeper: /api/search')
        // 打开日记目录（固定路径，不接受参数——防误开别的目录）
        safeRegister({
          kind: 'exact',
          path: '/memory-keeper/api/open-diary',
          handler: (req, res) => {
            try {
              const dir = join(cfg.workspace, '日记')
              if (!existsSync(dir)) {
                res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, error: '日记目录不存在：' + dir }))
                return
              }
              spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref()
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: true, dir }))
            } catch (error) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: String(error) }))
            }
          },
        }, 'memory-keeper: /api/open-diary')
        // 返回层旋钮：GET 读当前值，POST 改（写独立 JSON，不碰 profile 配置）
        safeRegister({
          kind: 'exact',
          path: '/memory-keeper/api/tunables',
          handler: (req, res) => {
            const send = (code, obj) => {
              res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify(obj))
            }
            if (req.method === 'GET') {
              const t = readTunables()
              return send(200, {
                ok: true,
                saved: t,
                effective: effectiveTun(),
                defaults: { contextLines: cfg.contextLines, resultChars: cfg.resultChars },
                file: TUNABLES_FILE,
              })
            }
            if (req.method !== 'POST') return send(405, { ok: false, error: 'method not allowed' })
            let body = ''
            req.on('data', (c) => { body += c })
            req.on('end', () => {
              try {
                const j = JSON.parse(body || '{}')
                const patch = {}
                // 服务端也要夹一遍：前端滑块能被绕过，别让一个 1e9 把上下文撑爆
                if (j.contextLines !== undefined) {
                  const n = Number(j.contextLines)
                  patch.contextLines = Number.isFinite(n) ? Math.min(5, Math.max(0, Math.round(n))) : 0
                }
                if (j.resultChars !== undefined) {
                  const n = Number(j.resultChars)
                  patch.resultChars = Number.isFinite(n) ? Math.min(2000, Math.max(80, Math.round(n))) : 400
                }
                const saved = writeTunables(patch)
                log('INFO', `面板旋钮更新 ${JSON.stringify(patch)} → 生效 ${JSON.stringify(effectiveTun())}`)
                send(200, { ok: true, saved, effective: effectiveTun() })
              } catch (error) {
                send(400, { ok: false, error: String(error) })
              }
            })
          },
        }, 'memory-keeper: /api/tunables')
        log('INFO', '已注册面板 API：/memory-keeper/api/*')
      } catch (error) {
        log('WARN', '注册面板 API 失败', error?.message ?? String(error))
      }
    })
  } catch (error) {
    log('WARN', '注入 webServer 失败', error?.message ?? String(error))
  }

  // ── system prompt：记忆状态卡 + 压缩前原文补记 ──────────
  // text 用函数而不是字符串：每次组装 system prompt 时现算（学 dsh-world），
  // 这样不用定时器、不用重启，也不依赖"压缩事件正好在插件活着的时候发生"。
  // 状态卡有 1 分钟缓存——build() 会扫目录，不能每轮都跑。
  try {
    ctx.inject(['systemPrompt'], (sctx) => {
      let cached = { text: '', at: 0 }
      const ttl = Math.max(1, cfg.refreshMinutes) * 60000
      const statusText = () => {
        const now = Date.now()
        if (cached.text && now - cached.at < ttl) return cached.text
        try {
          cached = { text: build().text, at: now }
        } catch { /* 保留上一次的值 */ }
        return cached.text
      }
      sctx.effect(() => {
        const dispose = sctx.systemPrompt.section({
          name: 'memory-keeper:status',
          order: 490,
          interpolate: false,
          text: statusText,
        })
        // 补原文：读 4KB 的缓存文件，比状态卡还轻，可以每轮现读；
        // 内容为空就返回空串（section 不显示）。
        // order 故意排在状态卡**前面**（480 < 490）：它在两次压缩之间完全不变，
        // 稳定内容放前面才能进缓存前缀；而压缩那一刻它跟着变，正好搭上"上下文本来就要全重建"的便车。
        const recallText = () => {
          if (!cfg.compressRecallEnabled) return ''
          try { return recallBlock(loadRecall(RECALL_FILE)) } catch { return '' }
        }
        const recallDispose = sctx.systemPrompt.section({
          name: 'memory-keeper:compress-recall',
          order: 480,
          interpolate: false,
          text: recallText,
        })
        return () => { dispose(); recallDispose() }
      }, 'memory-keeper: 记忆状态卡')
      log('INFO', '已注入 system prompt 补原文(480) + 状态卡(490)')
    })
  } catch (error) {
    log('WARN', '注入状态卡失败', error?.message ?? String(error))
  }

  return () => log('INFO', 'memory-keeper 卸载')
}
