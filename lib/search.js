// memory-keeper / search.js — 轻量本地检索：bigram 分词 + 词频打分（零依赖、零模型）
// 思路借鉴 feiyu-memory 的倒排索引 + dsh-fish-memory 的词表分级，但简化成"现算+打分"，
// 索引只存文本块（不存词表），检索时对候选块现算 bigram，几千块毫秒级。

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { decodeSessionFile, textOf, isNoise } from './recall.js'

// ── 提及记录（回忆强化）：检索命中一次，计数 +1；被提得多的记忆不该那么快被忘 ──
export function mentionKey(file, text) {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (t.length > 30) {
    // 30 字内找最后一个标点断，别把"人家"切成只剩一个"人"
    const cut = Math.max(
      t.lastIndexOf('。', 30), t.lastIndexOf('！', 30), t.lastIndexOf('？', 30),
      t.lastIndexOf('，', 30), t.lastIndexOf('；', 30), t.lastIndexOf('：', 30), t.lastIndexOf(' ', 30),
    )
    t = t.slice(0, cut > 10 ? cut + 1 : 30) + '…'
  }
  return file + '::' + t
}

export function loadMentions(file) {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  } catch { /* ignore */ }
  return {}
}

export function saveMentions(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
    return true
  } catch { return false }
}

export function bumpMentions(data, results, now = Date.now()) {
  for (const r of results) {
    const key = mentionKey(r.file, r.text)
    const cur = data[key] ?? { count: 0, last: 0 }
    cur.count += 1
    cur.last = now
    data[key] = cur
  }
  return data
}

/** 这条记忆被提过几次（用于遗忘候选过滤） */
export function mentionCount(mentions, file, text) {
  const key = mentionKey(file, text)
  return mentions[key]?.count ?? 0
}

/** 记一次「想起」：只更新最近搜索命中时间，不涨提及次数（自动信号，免手标） */
export function markSeen(mentions, results, now = Date.now()) {
  for (const r of results) {
    const key = mentionKey(r.file, r.text)
    const cur = mentions[key] ?? { count: 0, last: 0 }
    cur.lastSearch = now
    mentions[key] = cur
  }
  return mentions
}

/** 这条记忆最近一次被搜索命中的时间（没有就 0） */
export function mentionLastSearch(mentions, file, text) {
  return mentions[mentionKey(file, text)]?.lastSearch ?? 0
}

/**
 * 有效提及：主人消息里真的说到某条记忆（共享 ≥2 个 2 字词）才 +1。
 * 助手自己搜索、复述、摘要都不算——防虚增。
 */
export function bumpByUserText(mentions, userText) {
  const ug = grams(userText)
  if (ug.size === 0) return []
  const hit = []
  const now = Date.now()
  for (const key of Object.keys(mentions)) {
    const text = key.split('::')[1] ?? ''
    const kg = grams(text)
    let common = 0
    for (const g of kg.keys()) if (ug.has(g)) common++
    if (common >= 2) {
      mentions[key].count += 1
      mentions[key].last = now
      hit.push(key)
    }
  }
  return hit
}

const STOP = new Set(['的', '了', '是', '在', '和', '就', '都', '而', '及', '与', '着', '过', '也', '不', '有', '这', '那', '我', '你', '他', '她', '它', '们', '上', '下', '里', '会', '要', '把', '被', '让', '给', '对', '从', '到', '为', '以', '之', '其', '或', '很', '太', '更', '最', '又', '还', '再', '只', '才', '能', '可', '没', '想', '说', '做', '一', '个'])

/** 中文按标点/空白切段后取 2 字滑窗；单字段也收（低权重兜底）；英文/数字取单词。返回 Map<gram, count> */
export function grams(text) {
  const out = new Map()
  const s = String(text ?? '').toLowerCase()
  for (const w of s.match(/[a-z0-9_]{2,}/g) ?? []) out.set(w, (out.get(w) ?? 0) + 1)
  for (const seg of s.split(/[^\u4e00-\u9fff]+/)) {
    if (seg.length === 1) {
      if (!STOP.has(seg)) out.set(seg, (out.get(seg) ?? 0) + 1)
      continue
    }
    if (seg.length < 2) continue
    for (let i = 0; i + 2 <= seg.length; i++) {
      const g = seg.slice(i, i + 2)
      if (STOP.has(g)) continue
      out.set(g, (out.get(g) ?? 0) + 1)
    }
  }
  return out
}

const SKIP_DIRS = new Set(['_backups', 'archive', 'node_modules', '.git'])

// ── 对话记录（最近 7 天）特殊索引：按"**HH:MM [角色]**"切消息块 ──
const TZ = 'Asia/Shanghai'
function dateStr(ms) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
}
const CHAT_HEADER = /^\*\*\d{2}:\d{2} \[.+\]\*\*$/

export function chatChunks(file, text, maxChars = 300) {
  // 对话记录的文件名就是日期（2026-11-06.md）——聊天块没有行首日期，日期只能从文件名来，
  // 否则 beforeDate 对聊天块完全失效
  const fileDate = (String(file).match(/(\d{4}-\d{2}-\d{2})\.md$/) || [])[1] || null
  const lines = text.split('\n')
  const out = []
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (CHAT_HEADER.test(line)) {
      if (cur) out.push(cur)
      cur = { file, line: i + 1, text: line }
    } else if (cur) {
      if (line && !line.startsWith('#') && !/^[-=*═─]{3,}$/.test(line)) {
        cur.text += ' ' + line
      }
    }
  }
  if (cur) out.push(cur)
  return out
    .filter(c => c.text.length >= 6)
    // maxChars 默认 300：buildIndex 走默认值，索引里的 text 一个字节都不变（chunkKey = md5(text)，
    // 一动它向量全废）。readChatChunks 显式传大值——那条路只给 chat_search 现读现切、不进索引。
    .map(c => {
      const item = { ...c, text: c.text.slice(0, maxChars) }
      if (fileDate) item.date = fileDate
      return item
    })
}

/** 读最近 N 天的对话记录，切成消息块（不建常驻索引，现读现切——chat_search 用） */
export function readChatChunks(workspace, days = 7) {
  const root = join(workspace, '对话记录')
  if (!existsSync(root)) return []
  const floor = dateStr(Date.now() - days * 86400000)
  const chunks = []
  let months = []
  try { months = readdirSync(root, { withFileTypes: true }) } catch { return [] }
  for (const m of months) {
    if (!m.isDirectory()) continue
    const sub = join(root, m.name)
    let files = []
    try { files = readdirSync(sub) } catch { continue }
    for (const f of files) {
      const mm = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/)
      if (!mm || mm[1] < floor) continue
      let text = ''
      try { text = readFileSync(join(sub, f), 'utf8') } catch { continue }
      chunks.push(...chatChunks(join(sub, f), text, 2000))
    }
  }
  return chunks
}

/** 读某一天的对话记录（date: YYYY-MM-DD）；没有文件返回空 */
export function readChatDay(workspace, date) {
  const file = join(workspace, '对话记录', String(date).slice(0, 7), `${date}.md`)
  if (!existsSync(file)) return []
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return [] }
  // 和 readChatChunks(2000) / readChatDayFromLog(2000) 对齐：按日期翻老日记也是「现读现切」，
  // 300 会把长消息拦腰砍断，翻出来的「细节」只剩半截（这两路以前就是这么被落下的）
  return chatChunks(file, text, 2000)
}

/** 日期加减（YYYY-MM-DD） */
export function shiftDate(date, delta) {
  return dateStr(Date.parse(date + 'T00:00:00+08:00') + delta * 86400000)
}

// ── 兜底：直接读会话日志里某一天的对话 ────────────────────
// 对话记录是**次日**导出的，所以「今天/刚才」在导出文件里根本没写。
// 这条路径不依赖导出：解会话日志的 zstd，把那天的人话捞成和 readChatDay 一样的块。
const STAMP = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
})

/** 会话目录名：`D:\deepseek harness\工作区` → `--D-deepseek~0020harness-~5DE5~4F5C~533A--` */
export function encodeSessionDir(workspace) {
  const s = String(workspace).replace(/:/g, '').replace(/[\\/]/g, '-')
  let out = ''
  for (const ch of s) {
    out += /[A-Za-z0-9-]/.test(ch) ? ch : '~' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')
  }
  return `--${out}--`
}

/** 从会话日志读某一天的对话（导出文件缺失时用）；找不到返回空数组 */
export function readChatDayFromLog(workspace, date) {
  const root = join(homedir(), '.dsh', 'sessions', encodeSessionDir(workspace))
  if (!existsSync(root)) return []
  let dirs = []
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { return [] }
  const chunks = []
  const seen = new Set()
  const floor = Date.parse(date + 'T00:00:00+08:00')
  for (const d of dirs) {
    const file = join(root, d.name, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    // 那天开始后就再没写过的会话，不可能有那天的内容——先跳过，省掉解压和解析
    try { if (statSync(file).mtimeMs < floor) continue } catch { continue }
    let records = []
    try { records = decodeSessionFile(file) } catch { continue }
    for (const r of records) {
      if (r.type !== 'user/message' && r.type !== 'assistant/message') continue
      if (typeof r.time !== 'number' || typeof r.seq !== 'number') continue
      const stamp = STAMP.format(r.time)
      if (stamp.slice(0, 10) !== date) continue
      const t = (textOf(r.data?.message) || '').trim()
      if (t.length < 6 || isNoise(t)) continue
      const key = `${r.seq}|${t.slice(0, 40)}`
      if (seen.has(key)) continue
      seen.add(key)
      chunks.push({
        file: `${basename(file)}·${d.name.slice(-8)}`,
        line: r.seq,
        // 不建常驻索引、现读现切，所以这里放开截断不影响 memory_search 的索引与排序；
        // 300 会把一段长消息拦腰砍断，"那时原话说了什么"就永远只看得见前半截。
        text: `[${stamp.slice(11, 16)}] ${r.type === 'user/message' ? '主人' : '我'}: ${t.slice(0, 2000)}`,
      })
    }
  }
  chunks.sort((a, b) => a.line - b.line)
  return chunks
}

/** 中文数字 → 整数（支持 三 / 十 / 十二 / 二十 / 二十三） */
function cnNum(s) {
  const d = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const t = String(s)
  if (t === '十') return 10
  let m = t.match(/^十([一二三四五六七八九])$/)
  if (m) return 10 + d[m[1]]
  m = t.match(/^([一二两三四五六七八九])十([一二三四五六七八九])?$/)
  if (m) return d[m[1]] * 10 + (m[2] ? d[m[2]] : 0)
  return d[t] || 0
}

/** 从查询里认日期指向：绝对日期 / 昨天前天大前天 / N 天前（阿拉伯与中文）/ 上周 / 上个月；认不出返回 null */
export function resolveQueryDate(query, today = dateStr(Date.now())) {
  const q = String(query || '')
  if (/大前天/.test(q)) return shiftDate(today, -3)
  if (/前天/.test(q)) return shiftDate(today, -2)
  if (/昨天|昨晚|昨儿/.test(q)) return shiftDate(today, -1)
  if (/今天|今晚|刚才|刚刚|今早/.test(q)) return today
  // N 天前（阿拉伯数字，如 3天前 / 15 天前）
  let m = q.match(/(\d{1,3})\s*天前/)
  if (m) return shiftDate(today, -Number(m[1]))
  // N 天前（中文数字，如 三天前 / 前两天 / 十天前）
  m = q.match(/([一二两三四五六七八九十]{1,3})\s*天前/)
  if (m) {
    const n = cnNum(m[1])
    if (n > 0) return shiftDate(today, -n)
  }
  // N 周前 / N 个星期前 → N×7 天前（如 一周前 / 两周前 / 3周前）
  m = q.match(/(\d{1,2}|[一二两三四五六七八九十]{1,2})\s*(?:个)?\s*(?:星期|礼拜|周)前/)
  if (m) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : cnNum(m[1])
    if (n > 0) return shiftDate(today, -n * 7)
  }
  // N 个月前 → N×30 天前（近似）
  m = q.match(/(\d{1,2}|[一二两三四五六七八九十]{1,2})\s*(?:个)?月前/)
  if (m) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : cnNum(m[1])
    if (n > 0) return shiftDate(today, -n * 30)
  }
  // 半个月前 → 15 天前
  if (/半个月前/.test(q)) return shiftDate(today, -15)
  // 上上周 / 上周 / 上星期 / 上礼拜 → 14 / 7 天前
  if (/上上(个)?(星期|礼拜|周)/.test(q)) return shiftDate(today, -14)
  if (/上(个)?(星期|礼拜|周)|上周/.test(q)) return shiftDate(today, -7)
  // 上个月 → 30 天前进（近似；要精确月份得另算）
  if (/上个?月/.test(q)) return shiftDate(today, -30)
  m = q.match(/(\d{4}-\d{2}-\d{2})/)
  if (m) return m[1]
  m = q.match(/(\d{1,2})月(\d{1,2})[日号]/)
  if (m) return `${today.slice(0, 4)}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`
  m = q.match(/(^|[^\d])(\d{1,2})-(\d{1,2})([^\d]|$)/)
  if (m) return `${today.slice(0, 4)}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`
  return null
}

/**
 * 遍历「会被索引进来的文件」——buildIndex / sourceFingerprint / loadOrBuild 三处共用，
 * 避免三个地方各写一份过滤规则然后慢慢漂移（2026-11-11 抽出来）。
 */
function forEachIndexableFile(dirs, recentChatDays, cb) {
  const chatFloor = dateStr(Date.now() - recentChatDays * 86400000)
  const walk = (dir) => {
    if (!existsSync(dir)) return
    let ents
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of ents) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue
        walk(p)
        continue
      }
      if (!ent.name.endsWith('.md')) continue
      // 文件名里的日期（日记 2026-11-06.md / 对话记录 2026-11-06.md）——块内没写行首日期时兜底
      const fileDate = (ent.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/) || [])[1] || null
      const isChat = dir.includes('对话记录')
      if (isChat) {
        // 只索引最近 N 天的对话记录（文件名即日期）
        const m = ent.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/)
        if (!m || m[1] < chatFloor) continue
      }
      cb(p, { isChat, fileDate })
    }
  }
  for (const d of dirs) walk(d)
}

/** 单个文件切块：对话记录按消息切，普通 .md 按行切。buildIndex 与增量重建共用。 */
function chunksOfFile(p, text, isChat, fileDate) {
  if (isChat) return chatChunks(p, text).map((c) => ({ ...c }))
  const chunks = []
  text.split('\n').forEach((line, i) => {
    const t = line.trim()
    if (t.length < 6 || t.startsWith('#') || /^[-=*═─]{3,}$/.test(t)) return
    if (t.startsWith('>')) return
    // 已被标记取代的旧条目不再进索引，免得翻旧账翻到过时版本
    if (t.includes('已被取代')) return
    // 日期字段：只在块开头匹配，兼容几种写法
    //   ① `- **2026-11-04** · 正文`
    //   ② `- **2026-11-03 · 标题**：正文`
    //   ③ `- **2026-11-04 续** · 正文`（带「续」）
    //   ④ `- **2026-10-29 08:40** · 正文`（带时间）
    //   ⑤ `- 2026-10-30 · 正文`（没加粗）
    //   ⑥ `| 2026-11-02 周一 | 表格行 ... |`
    // 括号里的日期（如 `- **授权（2026-10-26）**`）和正文中段的日期**不提取**——那是引用，不是块的时间
    // 日期：块内行首日期优先（更精确，且不误提正文引用的日期），文件名日期兜底。
    // 11-05 记过「文件名优先」，但块内行首已经只匹配行首，不会被正文引用带偏；
    // 反过来若用文件名覆盖，日记里引用旧事的条目会被标成写日记那天，反而错。
    const d = lineDate(t) || fileDate
    // （行首日期正则的唯一实现在 lineDate；返回层也用它，避免两处各写一份）
    const chunk = { file: p, line: i + 1, text: t.slice(0, 300) }
    if (d) chunk.date = d
    chunks.push(chunk)
  })
  return chunks
}

/** 文档频率：每个 gram 出现在多少块里（IDF 用：越稀有越值钱） */
function dfOfChunks(chunks) {
  const df = new Map()
  for (const c of chunks) {
    for (const g of grams(c.text).keys()) df.set(g, (df.get(g) ?? 0) + 1)
  }
  return Object.fromEntries(df)
}

/**
 * 对话记录进索引时只收最近几天（2026-11-11 试：当天 + 昨天）。
 * 原来默认 7 天且对话记录根本不进索引；改小是因为它跟日记一起混搜，
 * 收太多天会稀释检索。要改这个值，buildIndex / sourceFingerprint / loadOrBuild 三处必须一致
 * （都引用这个常量，别再写死 7）。
 */
export const CHAT_INDEX_DAYS = 2

/** 扫目录下所有 .md，按行切块（过滤标题/短行/分隔线）；对话记录按消息切块、只收最近 CHAT_INDEX_DAYS 天 */
export function buildIndex(dirs, recentChatDays = CHAT_INDEX_DAYS) {
  const chunks = []
  const perFile = {}
  forEachIndexableFile(dirs, recentChatDays, (p, meta) => {
    let text = ''
    try { text = readFileSync(p, 'utf8') } catch { return }
    let st
    try { st = statSync(p) } catch { return }
    const cs = chunksOfFile(p, text, meta.isChat, meta.fileDate)
    perFile[p] = { size: st.size, mtime: Math.round(st.mtimeMs), chunks: cs }
    chunks.push(...cs)
  })
  return { builtAt: Date.now(), chunks, df: dfOfChunks(chunks), perFile }
}

/** 源文件指纹：只算「会被索引进来的文件」的路径+大小+mtime，跟 buildIndex 的过滤规则保持完全一致 */
export function sourceFingerprint(dirs, recentChatDays = CHAT_INDEX_DAYS) {
  const parts = []
  forEachIndexableFile(dirs, recentChatDays, (p) => {
    try {
      const st = statSync(p)
      parts.push(`${p}|${st.size}|${Math.round(st.mtimeMs)}`)
    } catch { /* 读不到就算了 */ }
  })
  parts.sort()
  return createHash('md5').update(parts.join('\n')).digest('hex').slice(0, 16)
}

/** 索引结构版本：改块结构（比如加 date 字段）就升一号，旧索引自动失效重建 */
export const INDEX_SCHEMA_VERSION = 4

/**
 * 加载索引。源文件没变直接复用；变了**按文件增量重建**（2026-11-11 改：原来任何文件一变就全量重建）。
 * 增量依据：索引里存的 perFile[p] = { size, mtime, chunks }，逐文件比对。
 * 文件删除时 perFile 里不再出现，chunks 自然合并掉；df 仍然全量重算（几千块，毫秒级）。
 */
export function loadOrBuild(dirs, indexPath, refreshMs = 10 * 60 * 1000) {
  const fp = sourceFingerprint(dirs)
  let old = null
  try {
    if (existsSync(indexPath)) old = JSON.parse(readFileSync(indexPath, 'utf8'))
  } catch { old = null }
  if (old && Array.isArray(old.chunks) && old.df
      && old.sourceFingerprint === fp
      && old.schemaVersion === INDEX_SCHEMA_VERSION) {
    return { index: old, rebuilt: false }
  }

  let index
  if (old && old.schemaVersion === INDEX_SCHEMA_VERSION && old.perFile) {
    const perFile = {}
    let changed = 0
    let reused = 0
    forEachIndexableFile(dirs, CHAT_INDEX_DAYS, (p, meta) => {
      let st
      try { st = statSync(p) } catch { return }
      const size = st.size
      const mtime = Math.round(st.mtimeMs)
      const prev = old.perFile[p]
      if (prev && prev.size === size && prev.mtime === mtime) {
        perFile[p] = prev
        reused += 1
        return
      }
      let text = ''
      try { text = readFileSync(p, 'utf8') } catch { return }
      perFile[p] = { size, mtime, chunks: chunksOfFile(p, text, meta.isChat, meta.fileDate) }
      changed += 1
    })
    const chunks = []
    for (const p of Object.keys(perFile).sort()) chunks.push(...perFile[p].chunks)
    index = { builtAt: Date.now(), chunks, df: dfOfChunks(chunks), perFile, incremental: { reused, changed } }
  } else {
    index = buildIndex(dirs)
  }
  index.sourceFingerprint = fp
  index.schemaVersion = INDEX_SCHEMA_VERSION
  try {
    mkdirSync(dirname(indexPath), { recursive: true })
    writeFileSync(indexPath, JSON.stringify(index), 'utf8')
  } catch { /* 写不进去也能用内存里的 */ }
  return { index, rebuilt: true }
}

/**
 * 时间窗口的**唯一实现**：词面路和向量路都必须从这里取候选。
 *
 * 为什么抽出来：以前两路各写一遍过滤，改了一路忘了另一路——
 * 向量直接把未来记忆捞回来、分数虚高，而且完全静默（工具照常返回、日志无异常）。
 * 现在两路共用这一个函数 + 单独给它写测试，就不再靠「记得两边都改」。
 *
 * @param {Array} chunks  全量块
 * @param {string|null} beforeDate  YYYY-MM-DD；不传 = 不过滤（考试时点）
 * @param {string|null} afterDate   日记遗忘线 YYYY-MM-DD；不传 = 不过滤。
 *   只对**日记块**生效——早于它算「忘了」，不进检索；记忆文件（关系片段等）不受影响
 */
export function eligibleChunks(chunks, beforeDate, afterDate) {
  const list = chunks || []
  if (!beforeDate && !afterDate) return list
  // 没日期的块不参与判断（不知道它是什么时候的）——保留
  return list.filter((c) => {
    if (!c.date) return true
    if (beforeDate && c.date > beforeDate) return false
    if (afterDate && c.date < afterDate && String(c.file).includes('日记')) return false
    return true
  })
}

/** 从一行原文里提取块首日期（YYYY-MM-DD）；没有返回 null。
 *  与 buildIndex 的行首正则**同一份实现**——两处各写一遍，迟早重演「改一路忘一路」。 */
export function lineDate(line) {
  const t = String(line ?? '').trim()
  const m = /^-\s*\*{0,2}(20\d\d-\d\d-\d\d)(?:\s+\d{2}:\d{2})?(?:\s*续)?\*{0,2}\s*·/.exec(t)
    || /^\|\s*(20\d\d-\d\d-\d\d)(?:\s+周[一二三四五六日天])?\s*\|/.exec(t)
  return m ? m[1] : null
}

/** 这一行够不够格当块 / 邻居行（与 buildIndex 的过滤条件同一份实现） */
export function isChunkLine(line) {
  const t = String(line ?? '').trim()
  if (t.length < 6) return false
  if (t.startsWith('#')) return false
  if (/^[-=*═─]{3,}$/.test(t)) return false
  if (t.startsWith('>')) return false
  if (t.includes('已被取代')) return false
  return true
}

/** 返回层的时间窗口判定：这一行能否出现在返回里。
 *  规则与 eligibleChunks 一致——**没日期的保留**（不知道它是什么时候的，不冤枉它）。 */
export function lineAllowed(line, beforeDate) {
  if (!beforeDate) return true
  const d = lineDate(line)
  return !d || d <= beforeDate
}

/** 面板旋钮的三层取值：面板 JSON > profile 配置 > 默认值，并且**夹回安全区间**。
 *  前端滑块能被绕过，服务端必须自己夹一遍——一个 1e9 的 contextLines 能把上下文撑爆。 */
export function clampTunables(saved, defaults) {
  const pick = (v, fallback, min, max) => {
    if (v === undefined || v === null || v === '') return fallback
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
  }
  const d = defaults || {}
  return {
    contextLines: pick(saved?.contextLines, Number(d.contextLines ?? 1), 0, 5),
    resultChars: pick(saved?.resultChars, Number(d.resultChars ?? 400), 80, 2000),
  }
}

/** 返回层补全：给命中结果补上完整原文与上下文。
 *  - `full`：原文件整行。索引里的 `text` 是入库时截到 300 的，长行尾部在入库阶段就没了；
 *    命中块带着 `file`/`line`，这里回原文件取回来。
 *  - `context`：命中行的前一行、后一行，**必须过时间窗口**（和 eligibleChunks 同一规则）。
 *
 *  只加字段、**不改 `text`**：mentionKey 以 `text` 为键，动了它历史「被用上 N 次」会全部对不上。
 *  这条链不参与打分，所以不影响排序，也不影响既有评测基准。
 */
export function enrichResults(results, beforeDate, opts = {}) {
  const maxFull = Number(opts.maxFull ?? 2000)
  const maxContext = Number(opts.maxContext ?? 400)
  const contextLines = Math.max(0, Number(opts.contextLines ?? 1)) // 0 = 不附上下文（省 token）
  const list = Array.isArray(results) ? results : []
  const fileLines = new Map()
  const linesOf = (file) => {
    if (fileLines.has(file)) return fileLines.get(file)
    let arr = null
    try { arr = readFileSync(file, 'utf8').split('\n') } catch { arr = null }
    fileLines.set(file, arr)
    return arr
  }
  for (const r of list) {
    const arr = linesOf(r.file)
    if (!arr) continue // 文件被删 / 读不到：静默回退（结果里仍有 text）
    const rawLine = arr[r.line - 1]
    if (typeof rawLine !== 'string' || !isChunkLine(rawLine)) continue // 行号越界或被改动：同样回退
    const full = rawLine.trim()
    if (full.length > String(r.text ?? '').length) r.full = full.slice(0, maxFull)
    const ctx = []
    for (let d = 1; d <= contextLines; d++) {
      for (const idx of [r.line - 1 - d, r.line - 1 + d]) {
        const nb = arr[idx]
        if (typeof nb !== 'string' || !isChunkLine(nb)) continue
        if (!lineAllowed(nb, beforeDate)) continue // 未来行不许从旁路漏回来
        ctx.push(nb.trim().slice(0, maxContext))
      }
    }
    if (ctx.length) r.context = ctx
  }
  return list
}

/** 把命中结果拼成给模型看的文本行——**模型实际看到的是这里，不是 results 结构**。
 *  用 `full`（整行）而不是入库时截断的 `text`；上下文跟在后面。
 *  以前这里还有一次 `slice(0, 80)`：只往结构里加 full、不动这里，改动在真实对话里等于没发生。 */
export function formatResultLines(results, timesOf = () => 0, opts = {}) {
  const maxChars = Number(opts.maxChars ?? 400)
  return (Array.isArray(results) ? results : []).map((r, i) => {
    const body = String(r.full ?? r.text ?? '').slice(0, maxChars)
    const more = r.context?.length ? `\n    上下文：${r.context.join('\n    上下文：')}` : ''
    const used = typeof timesOf === 'function' ? timesOf(r) : 0
    // 对话记录进索引后和日记同名（都是 2026-11-10.md），label 不加前缀就分不清谁是谁
    const label = (String(r.file).includes('对话记录') ? '对话/' : '') + basename(r.file)
    return `${i + 1}. [${label}:${r.line}] ${body}（${r.score}${r.from?.length ? '，' + r.from.join('+') : ''}，被用上 ${used} 次）${more}`
  })
}

/** 检索：IDF 加权打分（稀有词更值钱），钩子块加权。返回 top 条
 *  opts.boostDate：查询里解析出的日期（YYYY-MM-DD），命中的块**只加排序分**，不改原始分
 *  opts.dateBoost：加分幅度（默认 0.1 = 排序分 ×1.1；±1 天给一半）
 *  opts.beforeDate：时间窗口（YYYY-MM-DD）——只搜「日期不晚于它」的块（走 eligibleChunks）。
 *     不传 = 不过滤（默认行为不变）。没日期的块**不参与判断**（不知道它是什么时候的）。
 *  opts.afterDate：日记的「遗忘线」（YYYY-MM-DD）——早于它的**日记块**跳过（记忆文件不受影响）。
 *     不传 = 不过滤。
 */
export function searchMemory(index, query, top = 5, opts = {}) {
  const boostDate = opts.boostDate || null
  const dateBoost = Number(opts.dateBoost ?? 0.1)
  const beforeDate = opts.beforeDate || null
  const afterDate = opts.afterDate || null
  const qg = grams(query)
  const qkeys = [...qg.keys()]
  if (qkeys.length === 0) return []
  const N = (index.chunks || []).length || 1
  const df = index.df || {}
  // 下限 0.01：记忆库只有 1 个块时 log(2/2)=0，会导致任何查询都返回空——
  // 而「刚装完只写一条记忆试试」正好撞这个。给个下限，单块库也能搜出来。
  const idf = (g) => Math.max(0.01, Math.log((N + 1) / (1 + (df[g] ?? 0))))
  const isSingle = (g) => /^[\u4e00-\u9fff]$/.test(g)
  const scored = []
  for (const c of eligibleChunks(index.chunks, beforeDate, afterDate)) {
    const cg = grams(c.text)
    let hit = 0
    let score = 0
    const why = []
    for (const k of qkeys) {
      if (!cg.has(k)) continue
      if (isSingle(k)) { score += idf(k) * 0.25; continue } // 单字兜底：低权重，不算有效命中
      hit += 1
      const part = idf(k)
      score += part
      why.push([k, part])
    }
    if (score <= 0) continue
    const hookBonus = c.text.includes('〔钩子') ? 0.3 : 0
    const finalScore = Math.round((score + hookBonus) * 100) / 100
    // 日期软加分：只影响排序（_rank），score 保持原样——原始分不掺日期权重
    let rank = finalScore
    if (boostDate && c.date) {
      const days = Math.abs(Date.parse(c.date) - Date.parse(boostDate)) / 86400000
      if (days === 0) rank = finalScore * (1 + dateBoost)
      else if (days <= 1) rank = finalScore * (1 + dateBoost / 2)
    }
    const item = {
      file: c.file,
      line: c.line,
      text: c.text,
      score: finalScore,
      _rank: rank,
      hits: hit,
      why: why.sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]),
    }
    if (c.date) item.date = c.date // 没日期就不加这个键：带 undefined 的键会让工具的 JSON 校验失败
    scored.push(item)
  }
  scored.sort((a, b) => b._rank - a._rank)
  const out = scored.slice(0, top)
  for (const x of out) delete x._rank
  return out
}

/** RRF 融合：词面排名 + 向量排名，1/(k+rank) 相加后重排（保留原 score 用于显示） */
export function rrfMerge(wordResults, vecResults, top = 5, k = 60) {
  const map = new Map()
  const keyOf = (r) => `${r.file}:${r.line}`
  const add = (r, rank, tag) => {
    const key = keyOf(r)
    const cur = map.get(key) || { r, rrf: 0, from: [] }
    cur.rrf += 1 / (k + rank + 1)
    if (!cur.from.includes(tag)) cur.from.push(tag)
    map.set(key, cur)
  }
  wordResults.forEach((r, i) => add(r, i, 'word'))
  vecResults.forEach((r, i) => add(r, i, 'vec'))
  return [...map.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, top)
    .map((x) => ({ ...x.r, from: x.from }))
}
