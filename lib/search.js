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

export function chatChunks(file, text) {
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
    .map(c => ({ ...c, text: c.text.slice(0, 300) }))
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
      chunks.push(...chatChunks(join(sub, f), text))
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
  return chatChunks(file, text)
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
        text: `[${stamp.slice(11, 16)}] ${r.type === 'user/message' ? '主人' : '我'}: ${t.slice(0, 300)}`,
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

/** 扫目录下所有 .md，按行切块（过滤标题/短行/分隔线）；对话记录按消息切块、只收最近 7 天 */
export function buildIndex(dirs, recentChatDays = 7) {
  const chunks = []
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
      const isChat = dir.includes('对话记录')
      if (isChat) {
        // 只索引最近 N 天的对话记录（文件名即日期）
        const m = ent.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/)
        if (!m || m[1] < chatFloor) continue
      }
      let text = ''
      try { text = readFileSync(p, 'utf8') } catch { continue }
      if (isChat) {
        chunks.push(...chatChunks(p, text))
        continue
      }
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
        const dm = /^-\s*\*{0,2}(20\d\d-\d\d-\d\d)(?:\s+\d{2}:\d{2})?(?:\s*续)?\*{0,2}\s*·/.exec(t)
          || /^\|\s*(20\d\d-\d\d-\d\d)(?:\s*周[一二三四五六日天])?\s*\|/.exec(t)
        const chunk = { file: p, line: i + 1, text: t.slice(0, 300) }
        if (dm) chunk.date = dm[1]
        chunks.push(chunk)
      })
    }
  }
  for (const d of dirs) walk(d)
  // 文档频率：每个 gram 出现在多少块里（IDF 用：越稀有越值钱）
  const df = new Map()
  for (const c of chunks) {
    for (const g of grams(c.text).keys()) df.set(g, (df.get(g) ?? 0) + 1)
  }
  return { builtAt: Date.now(), chunks, df: Object.fromEntries(df) }
}

/** 源文件指纹：只算「会被索引进来的文件」的路径+大小+mtime，跟 buildIndex 的过滤规则保持完全一致 */
export function sourceFingerprint(dirs, recentChatDays = 7) {
  const chatFloor = dateStr(Date.now() - recentChatDays * 86400000)
  const parts = []
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
      if (dir.includes('对话记录')) {
        const m = ent.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/)
        if (!m || m[1] < chatFloor) continue
      }
      try {
        const st = statSync(p)
        parts.push(`${p}|${st.size}|${Math.round(st.mtimeMs)}`)
      } catch { /* 读不到就算了 */ }
    }
  }
  for (const d of dirs) walk(d)
  parts.sort()
  return createHash('md5').update(parts.join('\n')).digest('hex').slice(0, 16)
}

/** 索引结构版本：改块结构（比如加 date 字段）就升一号，旧索引自动失效重建 */
export const INDEX_SCHEMA_VERSION = 2

/** 加载索引；源文件指纹或结构版本变了就重建 */
export function loadOrBuild(dirs, indexPath, refreshMs = 10 * 60 * 1000) {
  const fp = sourceFingerprint(dirs)
  let index = null
  try {
    if (existsSync(indexPath)) index = JSON.parse(readFileSync(indexPath, 'utf8'))
  } catch { index = null }
  if (index && Array.isArray(index.chunks) && index.df
      && index.sourceFingerprint === fp
      && index.schemaVersion === INDEX_SCHEMA_VERSION) {
    return { index, rebuilt: false }
  }
  index = buildIndex(dirs)
  index.sourceFingerprint = fp
  index.schemaVersion = INDEX_SCHEMA_VERSION
  try {
    mkdirSync(dirname(indexPath), { recursive: true })
    writeFileSync(indexPath, JSON.stringify(index), 'utf8')
  } catch { /* 写不进去也能用内存里的 */ }
  return { index, rebuilt: true }
}

/** 检索：IDF 加权打分（稀有词更值钱），钩子块加权。返回 top 条
 *  opts.boostDate：查询里解析出的日期（YYYY-MM-DD），命中的块**只加排序分**，不改原始分
 *  opts.dateBoost：加分幅度（默认 0.1 = 排序分 ×1.1；±1 天给一半）
 */
export function searchMemory(index, query, top = 5, opts = {}) {
  const boostDate = opts.boostDate || null
  const dateBoost = Number(opts.dateBoost ?? 0.1)
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
  for (const c of index.chunks ?? []) {
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
