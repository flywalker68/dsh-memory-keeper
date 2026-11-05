// dsh-memory-keeper 单元测试：状态计算 + 人设备份写入
// 跑法：node test.js

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  localDate, dayShift, scanDiaries, dirSizeKb, parseSchedule,
  scanHandnotes, scanStale, buildStatus, backupAndWrite, scanFactConflicts, scanNotes, oldestRelation,
  pruneBackups,
} from './lib/state.js'
import { grams, buildIndex, searchMemory, loadOrBuild, bumpMentions, mentionCount, mentionKey, bumpByUserText, chatChunks, readChatChunks, markSeen, resolveQueryDate, readChatDay, shiftDate } from './lib/search.js'

const makeCfg = () => {
  const root = mkdtempSync(join(tmpdir(), 'mk-'))
  const workspace = join(root, 'ws')
  const memoryDir = join(root, 'memory')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(memoryDir, { recursive: true })
  return { root, workspace, memoryDir, agentsFile: join(root, 'AGENTS.md'), staleDays: 90 }
}
const clean = (cfg) => rmSync(cfg.root, { recursive: true, force: true })

test('localDate 是 YYYY-MM-DD 格式', () => {
  assert.match(localDate(), /^\d{4}-\d{2}-\d{2}$/)
})

test('dayShift 前进一天（含跨月）', () => {
  assert.equal(dayShift('2026-10-31', 1), '2026-11-01')
  assert.equal(dayShift('2026-11-01', -1), '2026-10-31')
})

test('scanDiaries 找到今天/最近篇', () => {
  const cfg = makeCfg()
  try {
    mkdirSync(join(cfg.workspace, '日记', '2026-10'), { recursive: true })
    writeFileSync(join(cfg.workspace, '日记', '2026-10', '2026-10-26.md'), 'x')
    writeFileSync(join(cfg.workspace, '日记', '2026-10', '2026-10-27.md'), 'y')
    const r = scanDiaries(cfg.workspace, '2026-10-27')
    assert.equal(r.total, 2)
    assert.equal(r.latest, '2026-10-27')
    assert.equal(r.hasToday, true)
    assert.deepEqual(r.recent, ['2026-10-27', '2026-10-26'])
  } finally { clean(cfg) }
})

test('dirSizeKb 统计文件大小', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, 'a.md'), 'x'.repeat(2048))
    const kb = dirSizeKb(cfg.memoryDir)
    assert.ok(kb >= 2 && kb <= 2.1, `got ${kb}`)
  } finally { clean(cfg) }
})

test('parseSchedule 命中今天/明天', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '07-日程.md'), [
      '# 日程',
      '- 2026-10-27 下午 体检',
      '- 2026-10-28 上午 上课',
      '- 2026-11-01 约人',
    ].join('\n'))
    const r = parseSchedule(cfg.memoryDir, '2026-10-27', '2026-10-28')
    assert.equal(r.today.length, 1)
    assert.ok(r.today[0].includes('体检'))
    assert.ok(r.tomorrow[0].includes('上课'))
  } finally { clean(cfg) }
})

test('scanHandnotes 找出超过 3 天的条目', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '08-手札.md'), [
      '## 2026-10-27',
      '- 今天的心情',
      '',
      '## 2026-10-21',
      '- 很久以前的一条',
    ].join('\n'))
    const r = scanHandnotes(cfg.memoryDir, '2026-10-27')
    assert.equal(r.sections.length, 2)
    assert.equal(r.stale.length, 1)
    assert.equal(r.stale[0].date, '2026-10-21')
  } finally { clean(cfg) }
})

test('scanStale 半衰期只报不删', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '05-自我.md'), [
      '## 关系片段',
      '- **2026-10-26** · 最近的事',
      '- **2025-01-01** · 很久以前的事',
      '- **2026-10-27 20:10** · 带时间的当前状态（不算片段）',
    ].join('\n'))
    const r = scanStale(cfg.memoryDir, '2026-10-27', 90)
    assert.equal(r.total, 2)
    assert.equal(r.stale.length, 1)
    assert.equal(r.stale[0].date, '2025-01-01')
  } finally { clean(cfg) }
})

test('scanStale 重要度 ≥60 的片段永不降权', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '05-自我.md'), [
      '## 关系片段',
      '- **2025-01-01** · 很重要的约定〔重要度 90〕',
      '- **2025-01-02** · 一般的事〔重要度 40〕',
      '- **2025-01-03** · 没标分数的事',
    ].join('\n'))
    const r = scanStale(cfg.memoryDir, '2026-10-27', 90)
    assert.equal(r.total, 3)
    assert.equal(r.stale.length, 2) // 90 那条被保护，40 和默认 50 的进候选
    assert.ok(!r.stale.some((x) => x.weight >= 60))
  } finally { clean(cfg) }
})

test('buildStatus 生成状态卡文本', () => {
  const cfg = makeCfg()
  try {
    mkdirSync(join(cfg.workspace, '日记', '2026-10'), { recursive: true })
    writeFileSync(join(cfg.workspace, '日记', '2026-10', '2026-10-26.md'), 'x')
    const r = buildStatus({
      today: '2026-10-27', tomorrow: '2026-10-28',
      workspace: cfg.workspace, memoryDir: cfg.memoryDir, staleDays: 90,
    })
    assert.ok(r.text.includes('记忆状态'))
    assert.ok(r.text.includes('昨天 2026-10-26 已写'))
    // 体积是体检指标：没到精简线（200 KB）时**不出现**，免得每次写文件都让 system prompt 前缀变一次
    assert.ok(!r.text.includes('memory：'))
    assert.equal(r.raw.sizeKb >= 0, true) // 数字本身仍然算着，memory_check 能查
  } finally { clean(cfg) }
})

test('buildStatus 正文跨过 200 KB 才提示 memory', () => {
  const cfg = makeCfg()
  try {
    mkdirSync(join(cfg.workspace, '日记', '2026-10'), { recursive: true })
    writeFileSync(join(cfg.workspace, '日记', '2026-10', '2026-10-26.md'), 'x')
    writeFileSync(join(cfg.memoryDir, 'big.md'), 'x'.repeat(201 * 1024))
    const r = buildStatus({
      today: '2026-10-27', tomorrow: '2026-10-28',
      workspace: cfg.workspace, memoryDir: cfg.memoryDir, staleDays: 90,
    })
    assert.ok(r.text.includes('memory：正文'))
    assert.ok(r.text.includes('到精简线'))
  } finally { clean(cfg) }
})

test('buildStatus 昨天日记缺、对话未导出时报未导出', () => {
  const cfg = makeCfg()
  try {
    const r = buildStatus({
      today: '2026-10-27', tomorrow: '2026-10-28',
      workspace: cfg.workspace, memoryDir: cfg.memoryDir, staleDays: 90,
    })
    assert.ok(r.text.includes('昨天对话：未导出'))
  } finally { clean(cfg) }
})

test('buildStatus 昨天日记完整时不报对话未导出', () => {
  const cfg = makeCfg()
  try {
    mkdirSync(join(cfg.workspace, '日记', '2026-10'), { recursive: true })
    writeFileSync(join(cfg.workspace, '日记', '2026-10', '2026-10-26.md'), '## 甲\n有内容\n\n## 乙\n也有内容\n')
    const r = buildStatus({
      today: '2026-10-27', tomorrow: '2026-10-28',
      workspace: cfg.workspace, memoryDir: cfg.memoryDir, staleDays: 90,
    })
    assert.ok(!r.text.includes('昨天对话：未导出'))
    assert.ok(r.text.includes('昨天 2026-10-26 已写'))
  } finally { clean(cfg) }
})

test('backupAndWrite replace：备份 + 写入 + 变更日志', () => {
  const cfg = makeCfg()
  try {
    const file = join(cfg.memoryDir, '05-自我.md')
    writeFileSync(file, '原来的人设\n第二行\n')
    const r = backupAndWrite({
      file, mode: 'replace', oldText: '原来的人设', newText: '新的人设', reason: '测试', cfg,
    })
    assert.equal(readFileSync(file, 'utf8'), '新的人设\n第二行\n')
    assert.ok(existsSync(r.backup))
    assert.ok(readFileSync(r.backup, 'utf8').includes('原来的人设'))
    assert.ok(readFileSync(join(cfg.memoryDir, '_backups', '_persona-changelog.md'), 'utf8').includes('测试'))
  } finally { clean(cfg) }
})

test('backupAndWrite replace：oldText 不唯一要报错', () => {
  const cfg = makeCfg()
  try {
    const file = join(cfg.memoryDir, '05-自我.md')
    writeFileSync(file, '同一句\n同一句\n')
    assert.throws(() => backupAndWrite({
      file, mode: 'replace', oldText: '同一句', newText: '改', cfg,
    }), /不唯一/)
  } finally { clean(cfg) }
})

test('backupAndWrite append：追加到末尾', () => {
  const cfg = makeCfg()
  try {
    const file = join(cfg.memoryDir, '08-手札.md')
    writeFileSync(file, '头\n')
    backupAndWrite({ file, mode: 'append', newText: '- 新的一条', cfg })
    assert.ok(readFileSync(file, 'utf8').endsWith('- 新的一条\n'))
  } finally { clean(cfg) }
})

test('scanFactConflicts 发现同一主题出现多条', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '05-自我.md'), [
      '- **2026-10-27** · 称呼：甲',
      '- **2026-10-28** · 称呼：乙',
      '- **2026-10-28** · 别的事',
    ].join('\n'))
    const r = scanFactConflicts(cfg.memoryDir)
    const c = r.find(x => x.topic === '称呼')
    assert.ok(c, '应该报称呼冲突')
    assert.equal(c.count, 2)
  } finally { clean(cfg) }
})

test('scanFactConflicts 已标「已被取代」的旧条不算', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '05-自我.md'), [
      '- **2026-10-27** · 称呼：甲（已被取代）',
      '- **2026-10-28** · 称呼：乙',
    ].join('\n'))
    const r = scanFactConflicts(cfg.memoryDir)
    assert.equal(r.find(x => x.topic === '称呼'), undefined)
  } finally { clean(cfg) }
})

test('scanFactConflicts 无日期的普通行不算', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '05-自我.md'), [
      '- 称呼：主人',
      '- 称呼：他',
    ].join('\n'))
    const r = scanFactConflicts(cfg.memoryDir)
    assert.equal(r.length, 0)
  } finally { clean(cfg) }
})

test('scanFactConflicts 不同主题各自计数', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '05-自我.md'), [
      '- **2026-10-27** · 称呼：甲',
      '- **2026-10-28** · 称呼：乙',
      '- **2026-10-28** · 作息：早睡',
      '- **2026-10-27** · 作息：熬夜',
    ].join('\n'))
    const r = scanFactConflicts(cfg.memoryDir)
    assert.equal(r.find(x => x.topic === '称呼').count, 2)
    assert.equal(r.find(x => x.topic === '作息').count, 2)
  } finally { clean(cfg) }
})

test('scanFactConflicts 文件不存在不崩', () => {
  const cfg = makeCfg()
  try {
    assert.doesNotThrow(() => scanFactConflicts(cfg.memoryDir))
    assert.equal(scanFactConflicts(cfg.memoryDir).length, 0)
  } finally { clean(cfg) }
})

test('scanFactConflicts 带时间的日期也认', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '01-用户画像.md'), [
      '- **2026-10-27 20:10** · 称呼：主人',
      '- **2026-10-28 09:00** · 称呼：主人（新写法）',
    ].join('\n'))
    const r = scanFactConflicts(cfg.memoryDir)
    assert.ok(r.find(x => x.topic === '称呼'))
  } finally { clean(cfg) }
})

test('scanFactConflicts 跨文件不合并、各自报', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '05-自我.md'), ['- **2026-10-28** · 称呼：乙'].join('\n'))
    writeFileSync(join(cfg.memoryDir, '01-用户画像.md'), ['- **2026-10-27** · 称呼：甲'].join('\n'))
    const r = scanFactConflicts(cfg.memoryDir)
    assert.equal(r.length, 0)
  } finally { clean(cfg) }
})

test('scanNotes 取最后三条', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '11-自己想的.md'), [
      '# 我自己想的',
      '- 第一条',
      '- 第二条',
      '- 第三条',
      '- 第四条',
    ].join('\n'))
    const notes = scanNotes(cfg.memoryDir, 3)
    assert.deepEqual(notes, ['第二条', '第三条', '第四条'])
  } finally { clean(cfg) }
})

test('buildStatus 有冲突时出现事实检查行', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '05-自我.md'), [
      '- **2026-10-27** · 称呼：甲',
      '- **2026-10-28** · 称呼：乙',
    ].join('\n'))
    const r = buildStatus({
      today: '2026-10-28', tomorrow: '2026-10-29',
      workspace: cfg.workspace, memoryDir: cfg.memoryDir, staleDays: 90,
    })
    assert.ok(r.text.includes('事实检查'), r.text)
    assert.ok(r.text.includes('称呼'))
  } finally { clean(cfg) }
})

test('oldestRelation 取最早一条和认识天数', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '05-自我.md'), [
      '- **2026-10-24** · 主人把本子交给人家的那天',
      '- **2026-10-17** · 主人指定自称"人家"的那天',
      '- **2026-10-21** · 改交接文档被纠正',
    ].join('\n'))
    const r = oldestRelation(cfg.memoryDir, '2026-10-28')
    assert.equal(r.date, '2026-10-17')
    assert.equal(r.days, 11)
    assert.ok(r.line.includes('自称'))
  } finally { clean(cfg) }
})

test('oldestRelation 没有片段返回 null', () => {
  const cfg = makeCfg()
  try {
    assert.equal(oldestRelation(cfg.memoryDir, '2026-10-28'), null)
  } finally { clean(cfg) }
})

test('buildStatus 正文到 200 KB 提示精简', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, 'big.md'), 'x'.repeat(210 * 1024))
    const r = buildStatus({
      today: '2026-10-28', tomorrow: '2026-10-29',
      workspace: cfg.workspace, memoryDir: cfg.memoryDir, staleDays: 90,
    })
    assert.ok(r.text.includes('正文到精简线'), r.text)
  } finally { clean(cfg) }
})

test('buildStatus 备份堆积 ≥300 KB 提示归档', () => {
  const cfg = makeCfg()
  try {
    const bak = join(cfg.memoryDir, '_backups')
    mkdirSync(bak, { recursive: true })
    writeFileSync(join(bak, '05-自我.md.202610281200-自己改.md'), 'x'.repeat(310 * 1024))
    writeFileSync(join(cfg.memoryDir, '01-用户画像.md'), '- 小文件')
    const r = buildStatus({
      today: '2026-10-28', tomorrow: '2026-10-29',
      workspace: cfg.workspace, memoryDir: cfg.memoryDir, staleDays: 90,
    })
    assert.ok(r.text.includes('该归档了'), r.text)
    assert.ok(r.text.includes('正文'), r.text)
  } finally { clean(cfg) }
})

test('buildStatus 30 天软线报遗忘候选（90 天硬线未触发）', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '05-自我.md'), [
      '- **2026-09-20** · 很久以前的事',
      '- **2026-10-27** · 最近的事',
    ].join('\n'))
    const r = buildStatus({
      today: '2026-10-28', tomorrow: '2026-10-29',
      workspace: cfg.workspace, memoryDir: cfg.memoryDir, staleDays: 90,
    })
    assert.ok(r.text.includes('遗忘候选'), r.text)
    assert.ok(!r.text.includes('半衰期：'), r.text)
  } finally { clean(cfg) }
})

test('buildStatus 90 天硬线优先于软线', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '05-自我.md'), [
      '- **2026-05-01** · 更老的事',
      '- **2026-09-20** · 30 天外的事',
    ].join('\n'))
    const r = buildStatus({
      today: '2026-10-28', tomorrow: '2026-10-29',
      workspace: cfg.workspace, memoryDir: cfg.memoryDir, staleDays: 90,
    })
    assert.ok(r.text.includes('半衰期：'), r.text)
    assert.ok(!r.text.includes('遗忘候选'), r.text)
  } finally { clean(cfg) }
})

test('grams 拆中文 bigram 和英文词', () => {
  const g = grams('搬家 QQ 桥')
  assert.ok(g.has('搬家'))
  assert.ok(g.has('qq'))
})

test('chatChunks 按消息头切块', () => {
  const text = [
    '# 对话',
    '**10:00 [主人]**',
    '你好呀',
    '**10:01 [我]**',
    '在呢在呢',
  ].join('\n')
  const chunks = chatChunks('/x/2026-10-28.md', text)
  assert.equal(chunks.length, 2)
  assert.ok(chunks[0].text.includes('你好呀'))
  assert.equal(chunks[0].line, 2)
  assert.ok(chunks[1].text.includes('在呢在呢'))
})

test('readChatChunks 只读最近 N 天', () => {
  const cfg = makeCfg()
  try {
    // 用相对日期，别写死——原来写 2026-10-28，等到「最近 7 天」滑过去就被过滤掉了
    const d = new Date(Date.now() - 3 * 86400000)
    const recent = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const dir = join(cfg.workspace, '对话记录', recent.slice(0, 7))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${recent}.md`), '**10:00 [主人]**\n旧事原文')
    writeFileSync(join(dir, '2026-09-01.md'), '**10:00 [主人]**\n很早的事')
    const chunks = readChatChunks(cfg.workspace, 7)
    assert.equal(chunks.length, 1)
    assert.ok(chunks[0].text.includes('旧事原文'))
  } finally { clean(cfg) }
})

test('buildIndex 扫 md、过滤标题短行，跳过 _backups', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '05-自我.md'), [
      '# 标题不索引',
      '这是一段足够长的正文，值得被索引。',
      '短',
      '> 引言也不索引',
    ].join('\n'))
    mkdirSync(join(cfg.memoryDir, '_backups'), { recursive: true })
    writeFileSync(join(cfg.memoryDir, '_backups', 'old.md'), '备份文件不应该被索引到。')
    const idx = buildIndex([cfg.memoryDir])
    assert.equal(idx.chunks.length, 1)
    assert.ok(idx.chunks[0].text.includes('足够长'))
  } finally { clean(cfg) }
})

test('searchMemory 命中并排序、钩子加权', () => {
  const index = {
    chunks: [
      { file: 'a.md', line: 1, text: '〔钩子：搬家、西安、擀面皮〕' },
      { file: 'b.md', line: 2, text: '中午搬家，XRH66 那套拆了。' },
      { file: 'c.md', line: 3, text: '今天天气不错。' },
    ],
  }
  const r = searchMemory(index, '搬家', 5)
  assert.equal(r.length, 2)
  assert.equal(r[0].file, 'a.md')
  assert.ok(r[0].score > r[1].score)
})

test('loadOrBuild 写入索引并能复用', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '05-自我.md'), '这是一段足够长的正文，值得索引。')
    const idxPath = join(cfg.root, 'idx.json')
    const first = loadOrBuild([cfg.memoryDir], idxPath)
    assert.equal(first.rebuilt, true)
    const second = loadOrBuild([cfg.memoryDir], idxPath)
    assert.equal(second.rebuilt, false)
  } finally { clean(cfg) }
})

test('bumpMentions 累计提及次数', () => {
  const data = {}
  const r = [{ file: 'a.md', text: '搬家那天拆了 XRH66' }]
  bumpMentions(data, r)
  bumpMentions(data, r)
  assert.equal(mentionCount(data, 'a.md', '搬家那天拆了 XRH66'), 2)
})

test('scanStale 跳过被反复提及的片段', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '05-自我.md'), [
      '- **2026-05-01** · 被提过很多次的事',
      '- **2026-05-02** · 没人提的事',
    ].join('\n'))
    const file = join(cfg.memoryDir, '05-自我.md')
    const mentions = {}
    // key 用整行原文（与 memory_search 索引块一致，见 scanStale 注释）
    for (let i = 0; i < 3; i++) bumpMentions(mentions, [{ file, text: '- **2026-05-01** · 被提过很多次的事' }])
    const r = scanStale(cfg.memoryDir, '2026-10-28', 90, mentions)
    assert.equal(r.stale.length, 1)
    assert.ok(r.stale[0].line.includes('没人提'))
  } finally { clean(cfg) }
})

test('bumpByUserText 只在主人消息共享 ≥2 个词时 +1', () => {
  const mentions = {}
  const text = '搬家那天拆了 XRH66 那套'
  bumpMentions(mentions, [{ file: 'a.md', text }])
  const before = mentionCount(mentions, 'a.md', text)
  // 像主人真说到："你上次搬家拆了很多东西吧"（共享 搬家/拆了 等）
  bumpByUserText(mentions, '你上次搬家拆了很多东西吧')
  assert.equal(mentionCount(mentions, 'a.md', text), before + 1)
  // 只提一个词（两个字）→ 不算有效提及
  const mid = mentionCount(mentions, 'a.md', text)
  bumpByUserText(mentions, '搬家')
  assert.equal(mentionCount(mentions, 'a.md', text), mid)
  // 完全无关 → 不动
  bumpByUserText(mentions, '今天天气不错')
  assert.equal(mentionCount(mentions, 'a.md', text), mid)
})

test('pruneBackups 只留最近 keep 份，旧的移 archive/backups', () => {
  const cfg = makeCfg()
  try {
    const bak = join(cfg.memoryDir, '_backups')
    mkdirSync(bak, { recursive: true })
    const base = '05-自我.md'
    for (const t of ['202610281000', '202610281100', '202610281200', '202610281300']) {
      writeFileSync(join(bak, `${base}.${t}-自己改.md`), 'x')
    }
    const archive = join(cfg.memoryDir, 'archive', 'backups')
    const moved = pruneBackups(bak, base, 2, archive)
    assert.equal(moved.length, 2)
    assert.ok(existsSync(join(archive, `${base}.202610281000-自己改.md`)))
    assert.ok(existsSync(join(archive, `${base}.202610281100-自己改.md`)))
    assert.ok(!existsSync(join(bak, `${base}.202610281000-自己改.md`)))
    assert.ok(existsSync(join(bak, `${base}.202610281300-自己改.md`)))
  } finally { clean(cfg) }
})


test('scanStale 最近被搜索命中过的片段也不报', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '05-自我.md'), [
      '- **2026-05-01** · 最近搜索命中过的事',
      '- **2026-05-02** · 没人搜的事',
    ].join('\n'))
    const file = join(cfg.memoryDir, '05-自我.md')
    const mentions = {}
    markSeen(mentions, [{ file, text: '- **2026-05-01** · 最近搜索命中过的事' }])
    const r = scanStale(cfg.memoryDir, '2026-10-28', 90, mentions)
    assert.equal(r.stale.length, 1)
    assert.ok(r.stale[0].line.includes('没人搜'))
  } finally { clean(cfg) }
})

test('resolveQueryDate 认日期指向', () => {
  assert.equal(resolveQueryDate('昨晚吃了什么', '2026-10-31'), '2026-10-30')
  assert.equal(resolveQueryDate('前天的事', '2026-10-31'), '2026-10-29')
  assert.equal(resolveQueryDate('大前天', '2026-10-31'), '2026-10-28')
  assert.equal(resolveQueryDate('2026-10-30 说了啥'), '2026-10-30')
  assert.equal(resolveQueryDate('10月30号', '2026-10-31'), '2026-10-30')
  assert.equal(resolveQueryDate('随便聊聊'), null)
})

test('readChatDay 只读指定那天，shiftDate 跨月正确', () => {
  const cfg = makeCfg()
  try {
    mkdirSync(join(cfg.workspace, '对话记录', '2026-10'), { recursive: true })
    writeFileSync(join(cfg.workspace, '对话记录', '2026-10', '2026-10-30.md'), '**09:00 [主人]**\n早吃了 滑蛋饭\n')
    const chunks = readChatDay(cfg.workspace, '2026-10-30')
    assert.equal(chunks.length, 1)
    assert.ok(chunks[0].text.includes('滑蛋饭'))
    assert.equal(readChatDay(cfg.workspace, '2026-10-29').length, 0)
    assert.equal(shiftDate('2026-11-01', -1), '2026-10-31')
    assert.equal(shiftDate('2026-10-31', 1), '2026-11-01')
  } finally { clean(cfg) }
})

test('mentionKey 超长文本在标点处截断，不切半个词', () => {
  const long = '还有 10-20 那条——他说那是他真正意义上的第一条鱼。人家不拿它当模板，但当故事读。'
  const k = mentionKey('x.md', long)
  assert.ok(k.endsWith('…'))
  assert.ok(k.includes('第一条鱼。'))
  assert.ok(!k.endsWith('人…'))
})

test('单块记忆库也能搜出来（IDF 下限）', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '记忆.md'), '- 用户喜欢喝无糖美式，下午三点后不碰咖啡\n')
    const index = buildIndex([cfg.memoryDir])
    assert.equal(index.chunks.length, 1)
    const r = searchMemory(index, '无糖美式', 5)
    assert.ok(r.length >= 1, '单块库应该能搜到，不该返回空')
  } finally { clean(cfg) }
})

test('beforeDate 过滤掉未来的块（词面路径）', () => {
  const cfg = makeCfg()
  try {
    writeFileSync(join(cfg.memoryDir, '记忆.md'),
      '- **2026-10-01** · 项目代号蓝鲸在码头\n- **2026-12-01** · 项目代号蓝鲸在仓库\n')
    const index = buildIndex([cfg.memoryDir])
    const all = searchMemory(index, '项目代号蓝鲸', 5)
    assert.equal(all.length, 2, '不过滤时两块都该在')
    const filtered = searchMemory(index, '项目代号蓝鲸', 5, { beforeDate: '2026-11-01' })
    assert.equal(filtered.length, 1, '过掉 11-01 之后的块')
    assert.ok(String(filtered[0].date) <= '2026-11-01')
  } finally { clean(cfg) }
})
