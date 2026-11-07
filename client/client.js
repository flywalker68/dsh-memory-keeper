// dsh-memory-keeper · 网页半边：侧栏「🐟 记忆」+ 管理面板
// 只读宿主半边的 /memory-keeper/api/*，不写记忆、不碰会话。

window.__ModuleLoader__.load({
  id: 'dsh-memory-keeper',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { useState, useEffect, useRef } = React
    const h = React.createElement
    const PANEL_ID = 'memory-keeper'
    const API = '/memory-keeper/api'
    const inject = ['slots']

    const CSS = `
.mk-root{height:100%;overflow:auto;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);
  padding:var(--dsh-frame-top-clearance,24px) 0 40px;box-sizing:border-box;font-size:13px;line-height:1.6;
  font-family:var(--dsh-font-family-ui,inherit)}
.mk-wrap{max-width:880px;margin:0 auto;padding:0 24px}
.mk-hero{display:flex;align-items:center;gap:14px;padding:16px 18px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));
  background:var(--dsw-alias-bg-layer-1,#fff);margin-bottom:14px}
.mk-card{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:12px;padding:14px 16px;margin-bottom:12px;background:var(--dsw-alias-bg-layer-1,#fff)}
.mk-card h3{margin:0 0 8px;font-size:13px;font-weight:600}
.mk-row{display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px dashed var(--dsw-alias-border-l1,rgba(0,0,0,.06))}
.mk-row:last-child{border-bottom:0}
.mk-k{color:var(--dsw-alias-label-secondary,#57606a);flex:0 0 auto}
.mk-v{text-align:right;word-break:break-all}
.mk-muted{color:var(--dsw-alias-label-tertiary,#8b949e)}
.mk-btn{padding:6px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));
  background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:inherit;font:inherit;cursor:pointer;white-space:nowrap}
.mk-btn:hover{background:var(--dsw-alias-bg-layer-1,#fff)}
.mk-input{width:100%;box-sizing:border-box;padding:8px 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));
  background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:inherit;font:inherit;outline:none}
.mk-input:focus{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.3))}
.mk-item{padding:8px 0;border-bottom:1px dashed var(--dsw-alias-border-l1,rgba(0,0,0,.06))}
.mk-item:last-child{border-bottom:0}
.mk-meta{display:flex;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px;margin-bottom:2px}
.mk-badge{display:inline-block;padding:0 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f6f8fa);font-size:11px}
.mk-ok{color:#1a7f37}
.mk-warn{color:#bf8700}
.mk-bad{color:#cf222e}
.mk-none{color:var(--dsw-alias-label-tertiary,#8b949e);padding:6px 0}
.mk-tabs{display:flex;gap:4px;margin:0 0 12px;padding:4px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#f6f8fa);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.mk-tab{flex:1;padding:8px 10px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font:inherit;font-size:12.5px;cursor:pointer}
.mk-tab:hover{background:var(--dsw-alias-bg-layer-1,#fff)}
.mk-tab.on{background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.mk-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:12px}
.mk-stat{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:12px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1,#fff)}
.mk-stat .n{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.15}
.mk-stat .u{font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary,#8b949e);margin-left:2px}
.mk-stat .k{font-size:12px;color:var(--dsw-alias-label-secondary,#57606a);margin-top:3px}
.mk-chips{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;align-items:center}
.mk-chip{padding:4px 11px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));background:transparent;font:inherit;font-size:12px;cursor:pointer;color:var(--dsw-alias-label-secondary,#57606a)}
.mk-chip:hover{background:var(--dsw-alias-bg-layer-2,#f6f8fa)}
.mk-chip.on{background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:inherit;border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.28));font-weight:600}
.mk-badge.who-big{background:rgba(59,91,219,.13);color:#4c6ef5}
.mk-badge.who-small{background:rgba(214,51,108,.13);color:#d6336c}
.mk-w100{border-left:3px solid #f59f00;padding-left:12px}
`

    let injected = false
    function injectStyles() {
      if (injected) return
      injected = true
      const s = document.createElement('style')
      s.setAttribute('data-memory-keeper', '')
      s.textContent = CSS
      document.head.appendChild(s)
    }

    function MkIcon() {
      return h('span', { style: { fontSize: 15 } }, '🐟')
    }

    function fmtTime(ms) {
      if (!ms) return ''
      return new Date(ms).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }

    function MkPage() {
      injectStyles()
      const [data, setData] = useState(null)
      const [err, setErr] = useState('')
      const [q, setQ] = useState('')
      const [results, setResults] = useState(null)
      const [searching, setSearching] = useState(false)
      const [at, setAt] = useState(0)
      const [tun, setTun] = useState(null)
      const [tunMsg, setTunMsg] = useState('')
      const [imp, setImp] = useState(null)
      const [tab, setTab] = useState('overview')
      const [impFilter, setImpFilter] = useState('all')
      const [impQ, setImpQ] = useState('')

      const load = () => {
        fetch(API + '/state', { cache: 'no-store' })
          .then(r => r.json())
          .then(j => { setData(j); setErr(''); setAt(Date.now()) })
          .catch(e => setErr('连不上插件：' + e.message))
      }
      // 打开面板时跑一次就够：以前每 5 秒轮询，等于面板开着就一直重建状态卡（扫目录、读 7 天导出）。
      // 要看最新的，点右上角「↻ 刷新」。
      const loadTun = () => {
        fetch(API + '/tunables', { cache: 'no-store' })
          .then(r => r.json())
          .then(j => { if (j && j.ok) setTun(j) })
          .catch(() => { /* 面板 API 没起来就静默，不影响主功能 */ })
      }
      const loadImportant = () => {
        fetch(API + '/important', { cache: 'no-store' })
          .then(r => r.json())
          .then(j => { if (j && j.ok) setImp(j) })
          .catch(() => { /* 同上，静默 */ })
      }
      const saveTun = (patch) => {
        fetch(API + '/tunables', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
          .then(r => r.json())
          .then(j => {
            if (j && j.ok) { setTun(t => ({ ...(t || {}), ...j })); setTunMsg('已保存，下次检索生效') }
            else setTunMsg('保存失败：' + ((j && j.error) || '未知错误'))
          })
          .catch(e => setTunMsg('保存失败：' + e.message))
      }
      useEffect(() => { load(); loadTun(); loadImportant() }, [])

      const doSearch = () => {
        const query = q.trim()
        if (!query) { setResults([]); return }
        setSearching(true)
        fetch(API + '/search?q=' + encodeURIComponent(query), { cache: 'no-store' })
          .then(r => r.json())
          .then(j => { setResults(j.results || []); setSearching(false) })
          .catch(e => { setErr('搜索失败：' + e.message); setSearching(false) })
      }

      const openDiary = () => {
        fetch(API + '/open-diary', { cache: 'no-store' })
          .then(r => r.json())
          .then(j => { if (!j.ok) alert('打不开：' + (j.error || '未知错误')) })
          .catch(e => alert('打不开：' + e.message))
      }

      if (err) return h('div', { className: 'mk-root' }, h('div', { className: 'mk-wrap' }, h('div', { className: 'mk-card' }, err)))
      if (!data) return h('div', { className: 'mk-root' }, h('div', { className: 'mk-wrap mk-muted' }, '加载中…'))

      const TABS = [
        { id: 'overview', label: '概览' },
        { id: 'important', label: '重要的事' },
      ]
      const stats = [
        ['认识', data.daysKnown != null ? String(data.daysKnown) : '—', '天', data.firstSeen ? `初次 ${data.firstSeen}` : ''],
        ['日记', String(data.diaryTotal ?? '—'), '篇', ''],
        ['记忆', String(data.memoryKb ?? '—'), 'KB', ''],
        ['重要记忆', String(data.relations ?? '—'), '条', ''],
      ]
      const listRows = (items, kind) => {
        if (!items || items.length === 0) return [h('div', { className: 'mk-none', key: 'none' }, kind === 'forget' ? '没有候选，干净。' : '还没有记录。')]
        return items.map((x, i) => h('div', { className: 'mk-item', key: i },
          h('div', { className: 'mk-meta' },
            h('span', { className: 'mk-badge' }, kind === 'mention' ? `提过 ${x.count} 次` : `${x.now || x.date || ''}`),
            kind === 'mention' && x.score != null ? h('span', { className: 'mk-badge' }, `分数 ${x.score}`) : null,
            h('span', null, (x.file || '').split(/[\\\\/]/).pop() || ''),
            x.last ? h('span', null, fmtTime(x.last)) : null,
          ),
          h('div', null, x.text || x.line || ''),
        ))
      }
      // 重要的事：整页列出 13 关系片段（按重要度降序），支持按署名筛选 + 内容搜索（纯前端过滤）
      const impAll = (imp && imp.items) || []
      const impItems = impAll.filter((x) =>
        (impFilter === 'all' || x.who === impFilter) &&
        (!impQ.trim() || String(x.text || '').includes(impQ.trim())))
      const chipOf = (id, label) => h('button', {
        key: id, type: 'button',
        className: 'mk-chip' + (impFilter === id ? ' on' : ''),
        onClick: () => setImpFilter(id),
      }, label)
      const impPage = h('div', { className: 'mk-card' },
        h('h3', null, `重要的事${imp ? `（${impItems.length}${impItems.length === impAll.length ? '' : ' / ' + impAll.length} 条）` : ''}`),
        h('div', { className: 'mk-chips' },
          chipOf('all', `全部 ${impAll.length}`),
          chipOf('大肥鱼', `大肥鱼 ${impAll.filter((x) => x.who === '大肥鱼').length}`),
          chipOf('小肥鱼', `小肥鱼 ${impAll.filter((x) => x.who === '小肥鱼').length}`),
          h('input', {
            className: 'mk-input',
            style: { width: 170, padding: '5px 10px', fontSize: 12 },
            placeholder: '搜内容…',
            value: impQ,
            onChange: (e) => setImpQ(e.target.value),
          }),
        ),
        h('div', { className: 'mk-muted', style: { marginBottom: 12, fontSize: 12 } },
          '按〔重要度〕排序；永不降权。要细节时，用条目上的日期调 chat_search 翻那天的原话。'),
        imp
          ? (impItems.length
            ? impItems.map((x, i) => h('div', { className: 'mk-item' + (x.weight >= 90 ? ' mk-w100' : ''), key: i },
                h('div', { className: 'mk-meta' },
                  h('span', { className: 'mk-badge' }, x.date),
                  h('span', { className: 'mk-badge' }, `重要度 ${x.weight}`),
                  x.who ? h('span', { className: 'mk-badge ' + (x.who === '大肥鱼' ? 'who-big' : 'who-small') }, x.who) : (x.age != null ? h('span', null, x.age === 0 ? '今天' : `${x.age} 天前`) : null),
                ),
                h('div', { style: { lineHeight: 1.75 } }, x.text),
              ))
            : h('div', { className: 'mk-none' }, impQ || impFilter !== 'all' ? '没有匹配的条目。' : '还没有关系片段。'))
          : h('div', { className: 'mk-muted' }, '加载中…'),
      )

      return h('div', { className: 'mk-root' },
        h('div', { className: 'mk-wrap' },
          h('div', { className: 'mk-hero' },
            h('div', { style: { fontSize: 26 } }, '🐟'),
            h('div', null,
              h('div', { style: { fontWeight: 650, fontSize: 16 } }, '记忆'),
              h('div', { className: 'mk-muted' }, '长期记忆守门员：状态、检索、遗忘候选、回忆强化'),
            ),
            h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' } },
              at ? h('span', { className: 'mk-muted' }, `更新于 ${new Date(at).toLocaleTimeString('zh-CN', { hour12: false })}`) : null,
              h('button', { className: 'mk-btn', onClick: load, title: '重新读一次记忆状态' }, '↻ 刷新'),
              h('button', { className: 'mk-btn', onClick: openDiary, title: '打开日记目录' }, '📂 日记目录'),
            ),
          ),
          h('div', { className: 'mk-tabs', role: 'tablist' },
            ...TABS.map((t) => h('button', {
              key: t.id, type: 'button', role: 'tab',
              className: 'mk-tab' + (tab === t.id ? ' on' : ''),
              onClick: () => setTab(t.id),
            }, t.label)),
          ),
          tab === 'important' ? impPage : null,
          tab === 'overview' ? h(React.Fragment, null,
          h('div', { className: 'mk-stats' },
            ...stats.map(([k, n, u, sub], i) => h('div', { className: 'mk-stat', key: i },
              h('div', null, h('span', { className: 'n' }, n), h('span', { className: 'u' }, u)),
              h('div', { className: 'k' }, k),
              sub ? h('div', { className: 'u', style: { marginTop: 2, marginLeft: 0 } }, sub) : null,
            )),
          ),
          h('div', { className: 'mk-card' },
            h('h3', null, '返回层（省 token）'),
            h('div', { className: 'mk-muted', style: { marginBottom: 12, fontSize: 12 } },
              '只影响「给模型看多少」，不动检索与打分；拖完即存，下次检索就按新值。'),
            h('div', { style: { display: 'flex', justifyContent: 'space-between' } },
              h('span', { className: 'mk-k' }, '上下文行数'),
              h('span', { className: 'mk-v' }, `${tun ? tun.effective.contextLines : '—'} 行（0 = 不附，最省）`)),
            h('input', {
              type: 'range', min: 0, max: 3, step: 1, style: { width: '100%' },
              value: tun ? tun.effective.contextLines : 0,
              disabled: !tun,
              onChange: (e) => setTun(t => ({ ...t, effective: { ...t.effective, contextLines: Number(e.target.value) } })),
              onMouseUp: (e) => saveTun({ contextLines: Number(e.target.value) }),
              onTouchEnd: (e) => saveTun({ contextLines: Number(e.target.value) }),
            }),
            h('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: 12 } },
              h('span', { className: 'mk-k' }, '每条字数上限'),
              h('span', { className: 'mk-v' }, `${tun ? tun.effective.resultChars : '—'} 字`)),
            h('input', {
              type: 'range', min: 80, max: 1000, step: 20, style: { width: '100%' },
              value: tun ? tun.effective.resultChars : 400,
              disabled: !tun,
              onChange: (e) => setTun(t => ({ ...t, effective: { ...t.effective, resultChars: Number(e.target.value) } })),
              onMouseUp: (e) => saveTun({ resultChars: Number(e.target.value) }),
              onTouchEnd: (e) => saveTun({ resultChars: Number(e.target.value) }),
            }),
            h('div', { className: 'mk-muted', style: { marginTop: 10, fontSize: 12 } },
              '默认 1 行 / 400 字：一次检索约多 1.3K tokens（≈¥0.003）。嫌贵把上下文调 0，正文补全仍保留。'),
            tunMsg ? h('div', { className: 'mk-muted', style: { marginTop: 6, fontSize: 12 } }, tunMsg) : null,
          ),
          h('div', { className: 'mk-card' },
            h('h3', null, '搜索记忆'),
            h('input', {
              className: 'mk-input',
              placeholder: '输入关键词，回车搜索（比如：搬家、旅行、生日）',
              value: q,
              onChange: (e) => setQ(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') doSearch() },
            }),
            searching ? h('div', { className: 'mk-none' }, '搜索中…') : null,
            results === null ? null
              : results.length === 0 ? h('div', { className: 'mk-none' }, `没找到「${q}」——换个说法试试`)
                : h('div', { style: { marginTop: 8 } }, ...listRows(results.map(r => ({ ...r, now: `得分 ${r.score}` })), 'mention')),
          ),
          h('div', { className: 'mk-card' },
            h('h3', null, '记忆分层与遗忘'),
            h('div', { className: 'mk-muted', style: { marginBottom: 10, fontSize: 12 } },
              '重要记忆不自动淘汰；日记默认只检索最近 6 个月，更老的算忘了、按日期还能翻。'),
            h('div', { className: 'mk-row' },
              h('span', { className: 'mk-k' }, '人格骨架（05）'),
              h('span', { className: 'mk-v' }, '每次必读')),
            h('div', { className: 'mk-row' },
              h('span', { className: 'mk-k' }, '重要记忆（13）'),
              h('span', { className: 'mk-v' }, `${data.relations} 条 · 永不降权`)),
            h('div', { className: 'mk-row' },
              h('span', { className: 'mk-k' }, '日记'),
              h('span', { className: 'mk-v' }, '最近 6 个月进检索')),
            h('div', { className: 'mk-meta', style: { marginTop: 8, marginBottom: 4 } },
              h('span', { className: (data.hard || []).length ? 'mk-warn' : 'mk-ok' }, `降权候选（${(data.hard || []).length} 硬 / ${(data.soft || []).length} 软）`)),
            ...listRows((data.hard || []).length ? data.hard : data.soft, 'forget'),
          ),
          h('div', { className: 'mk-card' },
            h('h3', null, '最近被提起'),
            ...listRows(data.mentionsTop, 'mention'),
          ),
          h('div', { className: 'mk-card' },
            h('h3', null, '我自己想的'),
            (data.notes || []).length === 0 ? h('div', { className: 'mk-none' }, '（空）')
              : (data.notes || []).map((n, i) => h('div', { className: 'mk-item', key: i }, n)),
          ),
          ) : null,
        ),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, MkPage))
      slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 21, label: () => '记忆' }, MkIcon))
    }

    exports.apply = apply
    exports.inject = inject
    exports.MkPage = MkPage
    return module.exports
  },
})
