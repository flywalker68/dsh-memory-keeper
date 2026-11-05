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

      const load = () => {
        fetch(API + '/state', { cache: 'no-store' })
          .then(r => r.json())
          .then(j => { setData(j); setErr(''); setAt(Date.now()) })
          .catch(e => setErr('连不上插件：' + e.message))
      }
      // 打开面板时跑一次就够：以前每 5 秒轮询，等于面板开着就一直重建状态卡（扫目录、读 7 天导出）。
      // 要看最新的，点右上角「↻ 刷新」。
      useEffect(() => { load() }, [])

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

      const stats = [
        ['认识', data.daysKnown != null ? `${data.daysKnown} 天（初次 ${data.firstSeen}）` : '—'],
        ['日记', `${data.diaryTotal} 篇`],
        ['记忆', `${data.memoryKb} KB`],
        ['关系片段', `${data.relations} 条`],
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
          h('div', { className: 'mk-card' },
            h('h3', null, '统计'),
            ...stats.map(([k, v], i) => h('div', { className: 'mk-row', key: i }, h('span', { className: 'mk-k' }, k), h('span', { className: 'mk-v' }, v))),
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
            h('h3', null, '遗忘候选', h('span', { className: 'mk-muted', style: { fontWeight: 400, marginLeft: 8 } }, '被提过 3 次以上的不报')),
            h('div', { className: 'mk-meta', style: { marginBottom: 4 } },
              h('span', { className: (data.hard || []).length ? 'mk-warn' : 'mk-ok' }, `硬线（${(data.hard || []).length}）`),
              h('span', { className: (data.soft || []).length ? 'mk-warn' : 'mk-ok' }, `软线（${(data.soft || []).length}）`),
            ),
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
