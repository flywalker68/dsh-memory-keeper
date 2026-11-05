#!/usr/bin/env node
/**
 * 把对话历史（jsonl）导入成记忆库（md），让插件能检索。
 *
 * 用法：
 *   node scripts/import-history.mjs <输入目录或 .jsonl> <输出目录>
 *
 * 例：
 *   node scripts/import-history.mjs ./histories ./memory
 *
 * 输入每行的字段（中英文都认）：
 *   轮次 / turn          第几轮
 *   逻辑时间 / now        时间（ISO 字符串）
 *   用户消息 / text       用户说了什么
 *   助手回复 / reply      助手回了什么（可选）
 *
 * 输出：每个输入文件一个 md，按日期分节，每轮一行。
 *       行格式 `- **YYYY-MM-DD** · [第N轮] 用户说了什么（回：助手说了什么）`
 *       —— 这个格式插件认（块开头有日期，能参与时间检索）。
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'

const [, , input, output] = process.argv
if (!input || !output) {
  console.error('用法: node scripts/import-history.mjs <输入目录或 .jsonl> <输出目录>')
  console.error('例:   node scripts/import-history.mjs ./histories ./memory')
  process.exit(1)
}
if (!existsSync(input)) {
  console.error(`输入不存在: ${input}`)
  process.exit(1)
}

// 收集输入文件
const files = []
if (statSync(input).isDirectory()) {
  for (const f of readdirSync(input)) if (f.endsWith('.jsonl')) files.push(join(input, f))
} else {
  files.push(input)
}
if (files.length === 0) {
  console.error('没找到 .jsonl 文件')
  process.exit(1)
}

mkdirSync(output, { recursive: true })

const pick = (row, ...keys) => {
  for (const k of keys) if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k]
  return ''
}

let totalRows = 0
for (const f of files) {
  const name = basename(f, extname(f))
  let rows
  try {
    rows = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch (e) {
    console.error(`${name}: 解析失败，跳过（${e.message}）`)
    continue
  }

  // 按日期分组
  const byDay = new Map()
  for (const r of rows) {
    const time = String(pick(r, '逻辑时间', 'now', 'time'))
    const day = time.slice(0, 10) || 'unknown'
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(r)
  }

  const lines = [`# ${name}`, '', `> 由 scripts/import-history.mjs 从 ${basename(f)} 导入（${rows.length} 轮）`, '']
  for (const [day, list] of [...byDay.entries()].sort()) {
    lines.push(`## ${day}`, '')
    for (const r of list) {
      const turn = pick(r, '轮次', 'turn')
      const user = String(pick(r, '用户消息', 'text', 'content')).replace(/\s+/g, ' ').trim()
      const reply = String(pick(r, '助手回复', 'reply', 'response')).replace(/\s+/g, ' ').trim().slice(0, 140)
      if (!user) continue
      const head = `- **${day}** · ${turn ? `[第${turn}轮] ` : ''}${user}`
      lines.push(reply ? `${head}（回：${reply}）` : head)
      lines.push('')
    }
  }

  const out = join(output, `${name}.md`)
  writeFileSync(out, lines.join('\n'), 'utf8')
  totalRows += rows.length
  console.log(`${name}: ${rows.length} 轮 → ${out}`)
}

console.log(`\n完成：${files.length} 个文件、${totalRows} 轮 → ${output}`)
console.log(`下一步：把 ${output} 配成插件的 memoryDir，或者直接在外面套一层（插件会扫这个目录下所有 .md）。`)
