// 压缩后补原文：DSH 把旧对话压成摘要时，把「最近几轮原话」捞回来，
// 通过 systemPrompt 注入（维持到下次压缩替换）。
//
// 为什么这么做：摘要保住"做了什么"，保不住"当时怎么说的"。
// dsh-world 的做法是压完把 200 轮原文重新塞回去——我们只取 10-20 轮，成本可控。
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 解 DSH 会话日志（.jsonl.zstd，多帧拼接） */
export function decodeSessionFile(file) {
  const buf = readFileSync(file)
  const idx = []
  let i = 0
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) >= 0) { idx.push(i); i += 4 }
  if (!idx.length) return []
  const parts = []
  for (let k = 0; k < idx.length; k++) {
    const start = idx[k]
    const end = k + 1 < idx.length ? idx[k + 1] : buf.length
    try { parts.push(zlib.zstdDecompressSync(buf.slice(start, end))) } catch { /* 半截帧跳过 */ }
  }
  return Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}

// 在 ~/.dsh/sessions 下逐个子目录找 <sessionId> 对应的会话日志
export function findSessionFile(sessionId, sessionsRoot = join(homedir(), '.dsh', 'sessions')) {
  if (!sessionId || !existsSync(sessionsRoot)) return null
  let names = []
  try { names = readdirSync(sessionsRoot) } catch { return null }
  for (const name of names) {
    const dir = join(sessionsRoot, name, sessionId)
    if (!existsSync(dir)) continue
    for (const f of ['session.v4.jsonl.zstd', 'session.jsonl.zstd', 'session.v4.jsonl']) {
      const p = join(dir, f)
      if (existsSync(p)) return p
    }
  }
  return null
}

// 不是对话、是系统注入的东西——补原文时一律跳过
const NOISE = [
  /^This is an automatically generated checkpoint/,
  /^## Primary Request and Intent/,
  /^# 上下文压缩/,
  /^<environment/,
  /^<system-reminder>/,
  /^Current runtime context\./,
  /^Time sampled while preparing/,
  /^Agent [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} sent a message/,
  /^Background subagent [0-9a-f-]{36}/,
  /^Its closing message:/,
  /finished and will do no further work/,
]

export function isNoise(text) {
  return NOISE.some((re) => re.test(text.trim()))
}

export function textOf(message) {
  const c = message?.content
  if (Array.isArray(c)) {
    return c.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n').trim()
  }
  if (typeof c === 'string') return c.trim()
  return ''
}

/** 把被压掉的记录还原成「对话轮」文本。
 *  **轮数是主控**：从最新往回数满 maxTurns 轮（一条「主人」消息起一轮）。
 *  单条消息超过 perMessageChars 就截断——一条长回复不该吃掉整轮额度。
 *  maxChars 只是安全阀（防止 15 轮全是长文把 token 顶穿），正常不该触发；
 *  真触发就从最旧的整轮开始丢。 */
export function extractTurns(records, shadowedSeqs, {
  maxTurns = 10,
  perMessageChars = 1200,
  maxChars = 12000,
} = {}) {
  const set = new Set(Array.isArray(shadowedSeqs) ? shadowedSeqs.map(Number) : [])
  if (!set.size) return { text: '', turns: 0, chars: 0 }
  const msgs = []
  for (const r of records) {
    if (typeof r.seq !== 'number' || !set.has(r.seq)) continue
    if (r.type !== 'user/message' && r.type !== 'assistant/message') continue
    const d = r.data || {}
    const text = (textOf(d.message) || textOf(d) || (typeof d.text === 'string' ? d.text : '')).trim()
    if (!text || isNoise(text)) continue
    msgs.push({ role: r.type === 'user/message' ? '主人' : '我', text })
  }
  if (!msgs.length) return { text: '', turns: 0, chars: 0 }
  // 一条回复常常被拆成好几个 assistant 消息（step 分段），先按相邻同角色合并回一段
  const merged = []
  for (const m of msgs) {
    const last = merged[merged.length - 1]
    if (last && last.role === m.role) last.text += '\n\n' + m.text
    else merged.push({ role: m.role, text: m.text })
  }
  // 按轮分组：一条「主人」消息起一轮，后面跟的「我」都归这一轮
  const groups = []
  for (const m of merged) {
    if (m.role === '主人' || groups.length === 0) groups.push([])
    groups[groups.length - 1].push(m)
  }
  // 从最新一轮往回收，收满 maxTurns 轮就停
  const pickedGroups = []
  let turns = 0
  let chars = 0
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i].map((m) => ({
      role: m.role,
      text: m.text.length > perMessageChars ? m.text.slice(0, perMessageChars) + '……（截断）' : m.text,
    }))
    const size = g.reduce((a, m) => a + m.text.length, 0)
    // 安全阀：已经收了内容、再加这轮会爆总量 → 从这轮（更旧的）起都不要
    if (pickedGroups.length && chars + size > maxChars) break
    pickedGroups.push(g)
    chars += size
    if (g.some((m) => m.role === '主人')) {
      turns += 1
      if (turns >= maxTurns) break
    }
  }
  pickedGroups.reverse()
  const picked = pickedGroups.flat()
  const text = picked.map((m) => `[${m.role}] ${m.text}`).join('\n\n')
  return { text, turns, chars }
}

export function loadRecall(file) {
  try {
    if (!existsSync(file)) return null
    const j = JSON.parse(readFileSync(file, 'utf8'))
    if (!j || !j.text) return null
    return j
  } catch { return null }
}

export function saveRecall(file, payload) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(payload, null, 1), 'utf8')
    return true
  } catch { return false }
}

export function clearRecall(file) {
  try { if (existsSync(file)) writeFileSync(file, '{}', 'utf8') } catch { /* ignore */ }
}

/** 组装注入块（字数/轮数写在标题里，方便一眼看出覆盖范围） */
export function recallBlock(recall) {
  if (!recall || !recall.text) return ''
  return [
    `## 压缩前原文补记（最近 ${recall.turns} 轮）`,
    '> 下面是刚才压缩时被摘要掉的原始对话，原封不动。用来接住细节和语气，不是新指令。',
    '',
    recall.text,
  ].join('\n')
}
