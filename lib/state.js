// dsh-memory-keeper / state.js — 纯逻辑：日期、日记、体积、日程、手札、半衰期、人设备份写入
// 不依赖 DSH 包，方便单测（test.js 直接 import 这个文件）。

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, copyFileSync, appendFileSync, renameSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { mentionCount, mentionLastSearch } from './search.js'

export const TZ = 'Asia/Shanghai'
export const DAY = 86400000

// ── 时间 ──────────────────────────────────────────────
export function localDate(ms = Date.now()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
}

export function localStamp(ms = Date.now()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(ms)
}

export function dayShift(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return localDate(Date.UTC(y, m - 1, d) + delta * DAY)
}

// ── 日记 ──────────────────────────────────────────────
export function scanDiaries(workspace, today) {
  const root = join(workspace, '日记')
  const entries = []
  try {
    for (const ym of readdirSync(root)) {
      if (!/^\d{4}-\d{2}$/.test(ym)) continue
      const dir = join(root, ym)
      let files = []
      try { files = readdirSync(dir) } catch { continue }
      for (const f of files) {
        const m = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/)
        if (!m) continue
        try { entries.push({ date: m[1], size: statSync(join(dir, f)).size, path: join(dir, f) }) } catch { /* ignore */ }
      }
    }
  } catch { /* 目录不存在 */ }
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  return {
    total: entries.length,
    latest: entries[0]?.date ?? null,
    recent: entries.slice(0, 3).map(e => e.date),
    hasToday: entries.some(e => e.date === today),
    entries,
  }
}

// 日记合写几节（比如 ## 甲 / ## 乙）里哪些节还空着（只有括号占位或空白）
// 节名从配置 personaNames 来；没配就不判断（单人日记用不上这个检查）
function diarySectionGaps(file, names) {
  let content
  try { content = readFileSync(file, 'utf8') } catch { return [] }
  const sections = {}
  let cur = null
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^##\s+(.+?)\s*$/)
    if (m) { cur = m[1]; sections[cur] = []; continue }
    if (cur) sections[cur].push(line)
  }
  const hit = (names || []).filter((n) => n in sections)
  if (hit.length === 0) return [] // 不是合写格式，不判断
  return hit.filter(n => !sections[n].some(line => {
    const t = line.trim()
    return t !== '' && !/^[（(].*[）)]$/.test(t)
  }))
}

// ── memory 体积 ────────────────────────────────────────
export function dirSizeKb(dir) {
  let total = 0
  const walk = (d, depth) => {
    if (depth > 6) return
    let ents
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const ent of ents) {
      const p = join(d, ent.name)
      try {
        if (ent.isDirectory()) walk(p, depth + 1)
        else if (ent.isFile()) total += statSync(p).size
      } catch { /* ignore */ }
    }
  }
  walk(dir, 0)
  return Math.round((total / 1024) * 10) / 10
}

// ── 正文体积：只算主库文件，跳过 _backups / archive / *.bak-* ────────
// "memory 的体积"该看正文；备份是历史，堆着不代表记忆变胖。
export function bodySizeKb(memoryDir) {
  const SKIP = new Set(['_backups', 'archive'])
  let total = 0
  const walk = (d, depth) => {
    if (depth > 6) return
    let ents
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const ent of ents) {
      const p = join(d, ent.name)
      try {
        if (ent.isDirectory()) { if (!SKIP.has(ent.name)) walk(p, depth + 1) }
        else if (ent.isFile()) {
          // 主目录里躺着的 `xx.md.bak-日期` 也是备份：以前被算进正文，让体积虚高近一倍
          if (ent.name.includes('.bak')) continue
          total += statSync(p).size
        }
      } catch { /* ignore */ }
    }
  }
  walk(memoryDir, 0)
  return Math.round((total / 1024) * 10) / 10
}

// ── 备份轮转：同一源文件只留最近 keep 份，更早的移进 archive/backups（不删）──
export function pruneBackups(backupDir, sourceBase, keep = 2, archiveDir) {
  if (!existsSync(backupDir)) return []
  let ents
  try { ents = readdirSync(backupDir, { withFileTypes: true }) } catch { return [] }
  const mine = ents
    .filter(e => e.isFile() && e.name.startsWith(sourceBase + '.'))
    .map(e => e.name)
    .sort() // 文件名里的时间戳决定新旧，字典序即时间序
  const old = mine.slice(0, Math.max(0, mine.length - keep))
  if (old.length === 0) return []
  const moved = []
  try { mkdirSync(archiveDir, { recursive: true }) } catch { return [] }
  for (const name of old) {
    const from = join(backupDir, name)
    const to = join(archiveDir, name)
    if (existsSync(to)) continue // 归档里已有同名（同一分钟改两次），不动
    try { renameSync(from, to); moved.push(name) } catch { /* ignore */ }
  }
  return moved
}

// ── 日程 ──────────────────────────────────────────────
export function parseSchedule(memoryDir, today, tomorrow) {
  const file = join(memoryDir, '07-日程.md')
  if (!existsSync(file)) return { today: [], tomorrow: [] }
  let lines = []
  try { lines = readFileSync(file, 'utf8').split('\n') } catch { return { today: [], tomorrow: [] } }
  const pick = (d) => {
    const out = []
    const [, m, dd] = d.split('-')
    const mmdd = `${m}-${dd}`
    const cn = `${Number(m)}月${Number(dd)}日`
    for (const raw of lines) {
      const line = raw.trim()
      if (line === '' || line.startsWith('<!--') || line.startsWith('<!--') || line.startsWith('#')) continue
      if (line.includes(d) || line.includes(mmdd) || line.includes(cn)) {
        out.push(line.replace(/^[-*]\s*/, '').slice(0, 120))
      }
    }
    return out.slice(0, 3)
  }
  return { today: pick(today), tomorrow: pick(tomorrow) }
}

// ── 手札（只活三天）──────────────────────────────────────
export function scanHandnotes(memoryDir, today) {
  const file = join(memoryDir, '08-手札.md')
  if (!existsSync(file)) return { stale: [], sections: [] }
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return { stale: [], sections: [] } }
  const heads = []
  const re = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/gm
  let m
  while ((m = re.exec(text)) !== null) heads.push({ date: m[1], index: m.index })
  const sections = []
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length
    const body = text.slice(h.index, end)
    const items = body.split('\n').filter(l => {
      const t = l.trim()
      return t.startsWith('-') && !t.includes('（空）')
    }).length
    if (items > 0) sections.push({ date: h.date, items })
  })
  const stale = sections.filter(s => Math.floor((Date.parse(today) - Date.parse(s.date)) / DAY) > 3)
  return { stale, sections }
}

// ── 半衰期：05 关系片段里超过 staleDays 的条目（只报不删）──
// mentions：被检索命中过（回忆过）的片段，提过 ≥3 次的不再进遗忘候选——回忆本身就是加固
// 重要度：条目末尾标〔重要度 85〕；≥60（必要/不可忘记）永不降权，没标的按 50 算
export function weightOf(text) {
  const m = /重要度\s*(\d{1,3})/.exec(String(text || ''))
  if (!m) return 50
  const w = Number(m[1])
  return Number.isFinite(w) ? Math.max(0, Math.min(100, w)) : 50
}

export function scanStale(memoryDir, today, staleDays, mentions = {}) {
  const file = join(memoryDir, '05-自我.md')
  if (!existsSync(file)) return { total: 0, stale: [] }
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return { total: 0, stale: [] } }
  const all = []
  const re = /^\s*-\s*\*\*(\d{4}-\d{2}-\d{2})\*\*\s*·\s*(.+)$/gm
  let m
  while ((m = re.exec(text)) !== null) {
    const age = Math.floor((Date.parse(today) - Date.parse(m[1])) / DAY)
    all.push({ date: m[1], age, line: m[2].trim().slice(0, 60), raw: m[0].trim(), weight: weightOf(m[0]) })
  }
  // 用整行原文做 key（与 memory_search 索引块文本一致），否则"日期前缀/正文"两套写法会让计数永远对不上
  // 免提醒：手标过 ≥3 次，或最近 30 天内被搜索命中过（自动想起）
  const hot = (x) => {
    if (mentionCount(mentions, file, x.raw) >= 3) return true
    const seen = mentionLastSearch(mentions, file, x.raw)
    return seen > 0 && Date.now() - seen < 30 * 86400000
  }
  return { total: all.length, stale: all.filter(x => x.age > staleDays && !hot(x) && x.weight < 60) }
}

// ── 「初次相遇」：05 关系片段里最早的一条（借鉴 SurfCore 的"最初"锚点）──
export function oldestRelation(memoryDir, today) {
  const file = join(memoryDir, '05-自我.md')
  if (!existsSync(file)) return null
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return null }
  const re = /^\s*-\s*\*\*(\d{4}-\d{2}-\d{2})\*\*\s*·\s*(.+)$/gm
  let m
  let first = null
  while ((m = re.exec(text)) !== null) {
    if (first === null || m[1] < first.date) first = { date: m[1], line: m[2].trim().slice(0, 40) }
  }
  if (first === null) return null
  return { ...first, days: Math.floor((Date.parse(today) - Date.parse(first.date)) / DAY) }
}

// ── 我自己想的（自己长出来的判断，不是转述）──────────────
export function scanNotes(memoryDir, limit = 3) {
  const file = join(memoryDir, '11-自己想的.md')
  if (!existsSync(file)) return []
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return [] }
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('- '))
    .map(l => l.slice(2).trim())
    .filter(Boolean)
    .slice(-limit)
}

// ── 事实检查：会变的事实主题出现多条时提醒（只报不改）────────
export const FACT_TOPICS = ['称呼', '作息', '日程', '偏好', '身体', '身份', '角色', '习惯']

export function scanFactConflicts(memoryDir) {
  const out = []
  // 扫所有 md（原来硬编码两个文件名，别人的记忆库文件名不一样就永远查不到）
  let files = []
  try { files = readdirSync(memoryDir).filter((f) => f.endsWith('.md')) } catch { files = [] }
  for (const file of files) {
    const p = join(memoryDir, file)
    if (!existsSync(p)) continue
    let text = ''
    try { text = readFileSync(p, 'utf8') } catch { continue }
    const byTopic = new Map()
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line.startsWith('- ')) continue
      if (line.includes('已被取代')) continue
      // 只认带日期的条目（`- **YYYY-MM-DD** · 正文`）：普通描述行不算，避免误报
      const m = line.match(/^\-\s*\*\*(\d{4}-\d{2}-\d{2})[^*]*\*\*\s*·\s*(.+)$/)
      if (!m) continue
      const body = m[2]
      const date = m[1]
      for (const topic of FACT_TOPICS) {
        if (body.includes(topic)) {
          if (!byTopic.has(topic)) byTopic.set(topic, [])
          byTopic.get(topic).push(`${file.replace(/\.md$/, '')} ${date}`)
        }
      }
    }
    for (const [topic, where] of byTopic) {
      if (where.length >= 2) out.push({ topic, count: where.length, where })
    }
  }
  return out
}

// ── 人设漂移：最近 30 条回复 vs 之前 30 条，看括号/尾巴/八股有没有变 ──
// 上次算完之后「输入长什么样」：导出是整天写一次，文件不动就没必要重读重算
const driftCache = { key: '', value: null }

export function personaDrift(workspace) {
  try {
    const root = join(workspace, '对话记录')
    if (!existsSync(root)) return null
    const months = readdirSync(root).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort().slice(-2)
    const files = []
    for (const m of months) {
      const dir = join(root, m)
      if (!existsSync(dir)) continue
      for (const f of readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort()) files.push(join(dir, f))
    }
    const picked = files.slice(-7)
    // 指纹 = 路径 + mtime + size。文件没变就直接用上次结果（每 5 分钟算一次 → 一天算一次）
    const key = picked.map((f) => {
      try { const s = statSync(f); return `${f}|${s.mtimeMs}|${s.size}` } catch { return f }
    }).join('\n')
    if (key === driftCache.key) return driftCache.value
    const reps = []
    for (const f of picked) {
      let t = ''
      try { t = readFileSync(f, 'utf8') } catch { continue }
      // 对话记录导出文件里带一行「## 工作区：<路径>」，从那儿往后才是正文
      const hm = t.match(/^## 工作区：.+$/m)
      const body = hm ? t.slice(t.indexOf(hm[0])) : ''
      const re = /\*\*\d{2}:\d{2} \[我\]\*\*\n\n([\s\S]*?)(?=\n\*\*\d{2}:\d{2} \[|$)/g
      let m
      while ((m = re.exec(body))) { const x = m[1].trim(); if (x) reps.push(x) }
    }
    if (reps.length < 60) { driftCache.key = key; driftCache.value = null; return null }
    const rate = (arr, re) => (arr.length ? (100 * arr.filter((r) => re.test(r)).length) / arr.length : 0)
    const st = (arr) => ({
      ba: rate(arr, /记得吗|人家记下了|人家认|希望对你有帮助|总的来说|首先|其次|综上所述/),
      kuo: rate(arr, /（[^）\n]{1,30}）/),
      wave: rate(arr, /[~～]/),
      emo: rate(arr, /🌊|🐟|（尾巴|（耳朵/),
    })
    const a = st(reps.slice(-60, -30))
    const b = st(reps.slice(-30))
    const tips = []
    if (b.ba - a.ba > 15) tips.push(`八股腔 +${Math.round(b.ba - a.ba)}pp`)
    if (Math.abs(b.kuo - a.kuo) > 15) tips.push(`括号动作 ${b.kuo > a.kuo ? '+' : ''}${Math.round(b.kuo - a.kuo)}pp`)
    if (a.wave - b.wave > 15) tips.push(`波浪号 -${Math.round(a.wave - b.wave)}pp`)
    if (a.emo - b.emo > 15) tips.push(`尾巴动作 -${Math.round(a.emo - b.emo)}pp`)
    const result = { tips, n: reps.length }
    driftCache.key = key
    driftCache.value = result
    return result
  } catch { return null }
}

// ── 「我是谁」版本快照：节内容变了就存一版到 archive/我是谁历史.md ──
export function iamSnapshot(memoryDir) {
  try {
    const selfFile = join(memoryDir, '05-自我.md')
    const histFile = join(memoryDir, 'archive', '我是谁历史.md')
    let text = ''
    try { text = readFileSync(selfFile, 'utf8') } catch { return null }
    const lines = text.split('\n')
    const start = lines.findIndex((l) => /^## 我是谁\s*$/.test(l))
    if (start < 0) return null
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) { if (/^## /.test(lines[i])) { end = i; break } }
    const cur = lines.slice(start + 1, end).join('\n').trim()
    if (!cur) return null
    let hist = ''
    try { hist = readFileSync(histFile, 'utf8') } catch { /* 首次 */ }
    const blocks = hist.split(/\n---\n/).map((b) => b.trim()).filter((b) => b.startsWith('## '))
    const last = blocks.length ? blocks[blocks.length - 1] : ''
    const lastBody = last.replace(/^## \d{4}-\d{2}-\d{2}\n+/, '').trim()
    if (lastBody === cur) return { changed: false, version: blocks.length }
    if (!hist) hist = '# 我是谁 · 历史版本\n'
    hist = hist.replace(/\s+$/, '') + `\n\n---\n\n## ${localDate()}\n\n${cur}\n`
    mkdirSync(dirname(histFile), { recursive: true })
    writeFileSync(histFile, hist, 'utf8')
    return { changed: true, version: blocks.length + 1 }
  } catch { return null }
}

// ── 状态卡 ────────────────────────────────────────────
export function buildStatus(env) {
  const { today, tomorrow, workspace, memoryDir, staleDays, mentions = {} } = env
  const diaries = scanDiaries(workspace, today)
  const sizeKb = bodySizeKb(memoryDir)
  const backupsKb = dirSizeKb(join(memoryDir, '_backups'))
  const archiveKb = dirSizeKb(join(memoryDir, 'archive'))
  const schedule = parseSchedule(memoryDir, today, tomorrow)
  const handnotes = scanHandnotes(memoryDir, today)
  const stale = scanStale(memoryDir, today, staleDays, mentions)
  const soft = scanStale(memoryDir, today, 30, mentions).stale
  const notes = scanNotes(memoryDir, 3)
  const conflicts = scanFactConflicts(memoryDir)
  const hhmm = localStamp().slice(11, 16)

  const lines = []
  lines.push('## 记忆状态（memory-keeper）')
  lines.push(`今天 ${today}`)
  const oldest = oldestRelation(memoryDir, today)
  if (oldest) lines.push(`- 认识：${oldest.days} 天（初次 ${oldest.date}）`)
  // 日记是「今天写昨天」：按昨天的文件判断，不看今天有没有文件
  const yesterday = dayShift(today, -1)
  const yEntry = (diaries.entries ?? []).find(e => e.date === yesterday)
  const todayEntry = (diaries.entries ?? []).find(e => e.date === today)
  // 日记合写多节时，看每节是否补全（节名来自配置 personaNames，没配就跳过）
  const pNames = env?.personaNames || []
  const yGaps = yEntry ? diarySectionGaps(yEntry.path, pNames) : []
  let diaryLine
  if (yEntry) {
    diaryLine = `- 日记：共 ${diaries.total} 篇；昨天 ${yesterday} 已写`
    if (yGaps.length) diaryLine += `，但${yGaps.map(n => `${n}节`).join('、')}还空着（该补全）`
  } else {
    diaryLine = `- 日记：共 ${diaries.total} 篇；昨天 ${yesterday} 未写（最近 ${diaries.latest ?? '无'}）`
  }
  if (todayEntry && diarySectionGaps(todayEntry.path, pNames).length) {
    diaryLine += '；今天有快照（正文明天写）'
  }
  lines.push(diaryLine)

  // 昨天日记还没写/没补全时，顺带看昨天对话导出没有（写日记前该先导出）
  const convoFile = join(workspace, '对话记录', yesterday.slice(0, 7), `${yesterday}.md`)
  const convoExported = existsSync(convoFile)
  if ((yEntry ? yGaps.length > 0 : true) && !convoExported) {
    lines.push(`- 昨天对话：未导出（写日记前先 export-convo ${yesterday}）`)
  }
  // 体积是体检指标，不是每轮决策依据：平时**不显示**——否则每写一个记忆文件就变一次，
  // system prompt 前缀跟着变、缓存全废。只在跨过精简线时才出现。要精确值用 memory_check。
  const sizeNote = sizeKb >= 500 ? '（正文超 500 KB，必须精简）'
    : sizeKb >= 200 ? '（正文到精简线）'
      : ''
  if (sizeNote) {
    lines.push(`- memory：正文 ${sizeKb} KB` + (backupsKb >= 300 ? `（备份 ${backupsKb} KB，该归档了）` : '') + sizeNote)
  } else if (backupsKb >= 300) {
    lines.push(`- memory：备份 ${backupsKb} KB，该归档了（正文 ${sizeKb} KB）`)
  }
  const fmt = (arr) => (arr.length ? arr.join('；') : '无')
  lines.push(`- 日程：今天 ${fmt(schedule.today)}；明天 ${fmt(schedule.tomorrow)}`)
  if (handnotes.stale.length > 0) {
    lines.push(`- 手札：${handnotes.stale.map(s => `${s.date}（${s.items} 条）`).join('、')} 超过 3 天，可清`)
  }
  if (notes.length > 0) {
    lines.push(`- 我自己想的：${notes.join('；')}`)
  }
  for (const c of conflicts.slice(0, 2)) {
    lines.push(`- 事实检查：${c.topic} 出现 ${c.count} 次（${c.where.join('、')}）——旧的该标「已被取代」`)
  }
  if (stale.stale.length > 0) {
    lines.push(`- 半衰期：${stale.stale.length} 条关系片段超过 ${staleDays} 天（只报不删）：`
      + stale.stale.slice(0, 3).map(x => `${x.date} ${x.line}（重要度${x.weight}）`).join(' / '))
  } else if (soft.length > 0) {
    lines.push(`- 遗忘候选：${soft.length} 条关系片段超过 30 天没新动作——看看要不要标「旧」：`
      + soft.slice(0, 3).map(x => `${x.date} ${x.line}（重要度${x.weight}）`).join(' / '))
  } else {
    lines.push(`- 半衰期：无候选（关系片段 ${stale.total} 条）`)
  }
  // 人格卡长度：05 + AGENTS 合计（去空白字符数）；健康区 8k~12k，超 15k 才提醒
  try {
    const agentsPath = env.agentsFile || join(memoryDir, '..', 'AGENTS.md')
    let chars = 0
    for (const p of [join(memoryDir, '05-自我.md'), agentsPath]) {
      try { chars += readFileSync(p, 'utf8').replace(/\s/g, '').length } catch { /* ignore */ }
    }
    if (chars > 15000) lines.push(`- 人格卡：${chars} 字，偏长了（健康 8k~12k，超 15k 容易「记不住自己是谁」）——该收了`)
  } catch { /* ignore */ }
  try {
    const drift = personaDrift(workspace)
    if (drift && drift.tips.length) lines.push(`- 人设：有漂移信号（${drift.tips.join('；')}）——发之前自检一下`)
  } catch { /* ignore */ }
  return { text: lines.join('\n'), raw: { today, tomorrow, yesterday, diaries, sizeKb, backupsKb, archiveKb, schedule, handnotes, stale, yesterdayWritten: !!yEntry, diaryGaps: yGaps, convoExported } }
}

// ── 人设/规则文件：改名 + 备份 + 写入 ───────────────────
export function resolvePersonaFile(key, cfg) {
  const map = {
    '00': '00-索引.md', '01': '01-主人画像.md', '03': '03-工作档案.md',
    '04': '04-环境经验.md', '05': '05-自我.md', '07': '07-日程.md', '08': '08-日常规则.md',
  }
  const k = String(key ?? '').trim()
  if (map[k]) return join(cfg.memoryDir, map[k])
  if (/^agents$/i.test(k)) return cfg.agentsFile
  return k
}

export function backupAndWrite({ file, mode, oldText, newText, reason, cfg }) {
  if (!existsSync(file)) throw new Error(`文件不存在：${file}`)
  const original = readFileSync(file, 'utf8')
  let next
  if (mode === 'replace') {
    if (typeof oldText !== 'string' || oldText === '') throw new Error('replace 模式需要 oldText')
    const first = original.indexOf(oldText)
    if (first < 0) throw new Error('oldText 在文件中找不到')
    if (original.indexOf(oldText, first + 1) >= 0) throw new Error('oldText 不唯一，请给更长的上下文')
    next = original.slice(0, first) + newText + original.slice(first + oldText.length)
  } else if (mode === 'append') {
    next = original.replace(/\s*$/, '') + '\n' + String(newText).replace(/\s*$/, '') + '\n'
  } else {
    throw new Error(`未知 mode：${mode}`)
  }
  const backupDir = join(cfg.memoryDir, '_backups')
  mkdirSync(backupDir, { recursive: true })
  const stamp = localStamp().replace(/[-: ]/g, '').slice(0, 12)
  const backup = join(backupDir, `${basename(file)}.${stamp}-自己改.md`)
  copyFileSync(file, backup)
  // 轮转：同一文件只留最近 2 份，更早的移进 archive/backups（不删）
  const moved = pruneBackups(backupDir, basename(file), 2, join(cfg.memoryDir, 'archive', 'backups'))
  writeFileSync(file, next, 'utf8')
  appendFileSync(
    join(backupDir, '_persona-changelog.md'),
    `- ${localStamp()} · ${basename(file)} · ${mode}${reason ? ' · ' + reason : ''} · 备份 ${basename(backup)}`
    + (moved.length ? ` · 归档 ${moved.length} 份旧备份` : '') + '\n',
    'utf8',
  )
  return { file, backup, bytes: Buffer.byteLength(next, 'utf8'), moved }
}
