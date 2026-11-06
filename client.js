/**
 * 云图（Neural Cloud）· DSH 客户端（Web 面板 + 设置页）
 *
 * - sidebar.panellist：云图图标（点击打开面板）
 * - main key=neural-cloud：五区面板（人设 / 心情 / 记忆 / 时间 / 回顾）
 * - settings.section：设置页（四组接口表单，写回 Host）
 *
 * 面板走接口，不走内部函数：所有数据经同源 HTTP 调 Host 的 /neural-cloud/*
 * （不用 /api 前缀 —— 那个前缀归 Connection/Gateway，未认领的请求会 404）。
 * 样式只用主题 token（--dsw-alias-*），不引入任何 Harness 客户端包。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-neural-cloud',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    /* ------------------------------------------------------------ 文案 */

    const DICTS = {
      zh: {
        panelTitle: '云图',
        settingsTitle: '云图 · 记忆引擎',
        persona: '人设卡',
        personaEmpty: '还没有 persona.json —— 在记忆库同目录放一个 JSON 就能换人（名字 / 自称 / 称呼对方 / 口癖 / 底线）。',
        mood: '心情',
        moodEmpty: '还没有心情记录。',
        memory: '记忆',
        memoryTotal: '总计',
        memoryActive: '可用',
        byTier: '分档',
        pending: '计划中',
        searchPlaceholder: '问点什么，按相关度取回记忆…',
        search: '取回',
        refresh: '刷新',
        time: '时间',
        save: '保存',
        timeHint: '按现实时间显示；记忆时间戳同样用现实时间。',
        location: '位置',
        locationEmpty: '还没检测到位置（定时刷新中）。',
        locationAt: '更新于',
        locationChanges: '变化',
        hindsight: '回顾',
        hindsightEmpty: '还没有回顾记录。',
        hindsightByChat: '回顾由外挂的 hindsight 模型生成（默认本地 30B）；不点也能在对话里说「回顾一下」。',
        hindsightStats: '生成频次',
        generate: '生成回顾',
        generating: '整理中…',
        evidence: '证据',
        settingsIntro: '两组接口，全部可覆盖。向量留空 = 关闭向量通道；精排留空 = 不做精排。摘要与回顾由对话窗口生成，插件不代跑。所有 key 只存本地，不落日志、不进提示词。',
        groupEmbedding: '向量（空 = 关闭向量通道）',
        groupRerank: '精排（可选，cross-encoder 重排召回）',
        base: '接口地址',
        key: 'API Key',
        model: '模型',
        keyKept: '已配置（留空不改）',
        saved: '已保存',
        saveFailed: '保存失败',
        loadFailed: '加载失败',
        planPending: '计划中',
        planDone: '已经发生',
        planDropped: '已放弃',
        openItem: '点开看时间戳与命中理由',
        close: '收起',
        loading: '读取中…',
        why: '命中理由',
        score: '得分',
        eventTimeLabel: '发生时间',
        sceneLabel: '场景',
        createdAtLabel: '写入时间',
        cancel: '取消',
        editPersona: '编辑人设',
        personaHint: '随时可改，保存后立即生效',
        configTitle: '接口配置',
      },
      en: {
        panelTitle: 'Neural Cloud',
        settingsTitle: 'Neural Cloud · Memory',
        persona: 'Persona',
        personaEmpty: 'No persona.json yet — drop a JSON next to the memory store to swap her in.',
        mood: 'Mood',
        moodEmpty: 'No mood record yet.',
        memory: 'Memory',
        memoryTotal: 'Total',
        memoryActive: 'Active',
        byTier: 'By tier',
        pending: 'Planned',
        searchPlaceholder: 'Ask something, recall by relevance…',
        search: 'Recall',
        refresh: 'Refresh',
        time: 'Time',
        save: 'Save',
        timeHint: 'Real wall-clock time; memory stamps use it too.',
        location: 'Location',
        locationEmpty: 'No location detected yet (polling).',
        locationAt: 'Updated',
        locationChanges: 'Changes',
        hindsight: 'Hindsight',
        hindsightEmpty: 'No hindsight record yet.',
        hindsightByChat: 'Hindsight comes from the external hindsight model (local 30B by default); you can also just ask in chat.',
        hindsightStats: 'Runs',
        generate: 'Generate',
        generating: 'Writing…',
        evidence: 'Evidence',
        settingsIntro: 'Two endpoint groups, both optional. Empty embedding disables the vector lane; empty rerank skips reordering. Summaries and hindsight are generated in the chat window, not by this plugin. Keys stay local — never logged, never in prompts.',
        groupEmbedding: 'Embedding (empty = vector lane off)',
        groupRerank: 'Rerank (optional cross-encoder reordering)',
        base: 'Endpoint base',
        key: 'API Key',
        model: 'Model',
        keyKept: 'configured (leave blank to keep)',
        saved: 'Saved',
        saveFailed: 'Save failed',
        loadFailed: 'Load failed',
        planPending: 'planned',
        planDone: 'happened',
        planDropped: 'dropped',
        openItem: 'open for timestamp & hit reasons',
        close: 'collapse',
        loading: 'Loading…',
        why: 'Hit reasons',
        score: 'Score',
        eventTimeLabel: 'Event time',
        sceneLabel: 'Scene',
        createdAtLabel: 'Written at',
        cancel: 'Cancel',
        editPersona: 'Edit persona',
        personaHint: 'Editable anytime; saves take effect immediately',
        configTitle: 'Endpoints',
      },
    }

    function makeT(ctx) {
      try {
        const locale = ctx.get('locale')
        if (locale) {
          if (typeof locale.register === 'function') {
            for (const [lang, dict] of Object.entries(DICTS)) {
              try { locale.register('neural-cloud', lang, dict) } catch {}
            }
          }
          if (typeof locale.bind === 'function') return locale.bind('neural-cloud')
        }
      } catch {}
      return key => DICTS.zh[key] ?? key
    }

    /* ------------------------------------------------------------ API */

    async function api(method, path, body) {
      const res = await fetch('/neural-cloud' + path, {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
      })
      const text = await res.text()
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 120) || 'no body'}` }
      }
      try {
        return JSON.parse(text)
      } catch (e) {
        return { ok: false, error: `bad response: ${text.slice(0, 120)}` }
      }
    }

    /* ------------------------------------------------------------ 样式（只吃主题 token） */

    const CSS = `
.nc-panel { padding: 20px 24px; max-width: 920px; margin: 0 auto; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.55; height: 100%; min-height: 0; overflow-y: auto; overflow-x: hidden; box-sizing: border-box; }
.nc-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; }
@media (max-width: 720px) { .nc-grid { grid-template-columns: 1fr; } }
.nc-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 14px 16px; }
.nc-card + .nc-card { margin-top: 12px; }
.nc-h2 { font-size: 15px; font-weight: 600; margin: 0 0 10px; color: var(--dsw-alias-label-primary); }
.nc-h3 { font-size: 12px; font-weight: 600; margin: 0 0 8px; color: var(--dsw-alias-label-secondary); letter-spacing: .04em; }
.nc-kv { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.nc-kv:last-child { border-bottom: none; }
.nc-kv .k { color: var(--dsw-alias-label-secondary); flex: 0 0 auto; }
.nc-kv .v { text-align: right; word-break: break-word; }
.nc-btn { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 5px 12px; font-size: 12px; cursor: pointer; flex: 0 0 auto; white-space: nowrap; }
.nc-btn:hover { border-color: var(--dsw-alias-brand-primary); }
.nc-btn.primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; }
.nc-btn:disabled { opacity: .5; cursor: default; }
.nc-input { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 6px 8px; font-size: 12px; box-sizing: border-box; }
.nc-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.nc-bar { display: flex; gap: 8px; align-items: center; }
.nc-bar .nc-input { flex: 1; }
.nc-item { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; cursor: pointer; background: var(--dsw-alias-bg-layer-1); }
.nc-item:hover { border-color: var(--dsw-alias-border-l2); }
.nc-item .head { display: flex; gap: 8px; align-items: baseline; }
.nc-tier { font-weight: 700; flex: 0 0 auto; }
.nc-tier.S { color: var(--dsw-alias-state-success-primary); }
.nc-tier.A { color: var(--dsw-alias-brand-primary); }
.nc-tier.B { color: var(--dsw-alias-state-warn-primary); }
.nc-tier.C { color: var(--dsw-alias-state-idle-primary); }
.nc-item .stamp { color: var(--dsw-alias-label-secondary); font-size: 11px; flex: 0 0 auto; }
.nc-item .detail { margin-top: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); border-top: 1px dashed var(--dsw-alias-border-l1); padding-top: 6px; }
.nc-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.nc-err { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.nc-panel-icon { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; background: none; border: none; padding: 0; cursor: pointer; color: var(--dsw-alias-label-secondary); }
.nc-panel-icon:hover { color: var(--dsw-alias-label-primary); }
.nc-settings { padding: 8px 0 24px; }
.nc-group { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
.nc-fields { display: grid; grid-template-columns: 2fr 2fr 1.4fr; gap: 10px; }
@media (max-width: 640px) { .nc-fields { grid-template-columns: 1fr; } }
.nc-field label { display: block; font-size: 11px; color: var(--dsw-alias-label-secondary); margin-bottom: 4px; }
.nc-field .nc-input { width: 100%; }
.nc-notice { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-bottom: 14px; }
.nc-fail { color: var(--dsw-alias-state-error-primary); font-size: 12px; margin-top: 8px; }
.nc-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.nc-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.nc-toolbar .nc-input { flex: 1; }
.nc-json { width: 100%; box-sizing: border-box; min-height: 140px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 8px; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; resize: vertical; }
.nc-json:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.nc-cfg-group { margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--dsw-alias-border-l1); }
.nc-cfg-group:first-of-type { border-top: none; padding-top: 0; margin-top: 4px; }
`

    /* ------------------------------------------------------------ 图标（自绘：云 + 记忆点） */

    function CloudIcon(props) {
      return h('svg', Object.assign({ viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, props),
        h('path', { d: 'M6.2 18.2a3.8 3.8 0 0 1-.6-7.56A5.4 5.4 0 0 1 16.2 9.2a4.1 4.1 0 0 1 .9 8.1' }),
        h('circle', { cx: 9, cy: 15.2, r: 1.15, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 13.4, cy: 13.2, r: 1.15, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 15.8, cy: 16.4, r: 0.8, fill: 'currentColor', stroke: 'none' }),
      )
    }

    /* ------------------------------------------------------------ 通用小件 */

    function Card(props) {
      return h('div', { className: 'nc-card' },
        h('div', { className: 'nc-h3' }, props.title),
        props.children)
    }

    function KV(props) {
      return h('div', { className: 'nc-kv' },
        h('span', { className: 'k' }, props.k),
        h('span', { className: 'v' }, props.v))
    }

    function Btn(props) {
      const cls = 'nc-btn' + (props.primary ? ' primary' : '')
      return h('button', { className: cls, onClick: props.onClick, disabled: props.disabled, type: 'button' }, props.children)
    }

    /* ------------------------------------------------------------ 记忆条目（可点开） */

    function MemItem(props) {
      const { item, t } = props
      const [open, setOpen] = useState(false)
      const plan = item.planState === 'pending' ? t('planPending') : item.planState === 'done' ? t('planDone') : item.planState === 'dropped' ? t('planDropped') : ''
      return h('div', { className: 'nc-item', onClick: () => setOpen(!open) },
        h('div', { className: 'head' },
          h('span', { className: 'nc-tier ' + (item.tier || 'C') }, item.tier || 'C'),
          h('span', {}, item.content),
          h('span', { className: 'stamp' }, item.stamp || ''),
          plan ? h('span', { className: 'stamp' }, `（${plan}）`) : null),
        open ? h('div', { className: 'detail' },
          KV({ k: t('why'), v: (item.why || []).join(', ') }),
          KV({ k: t('score'), v: String(item.score ?? 0) }),
          item.eventTime ? KV({ k: t('eventTimeLabel'), v: item.eventTime }) : null,
          item.scene ? KV({ k: t('sceneLabel'), v: item.scene }) : null,
          item.created ? KV({ k: t('createdAtLabel'), v: new Date(item.created).toLocaleString() }) : null,
        ) : null)
    }

    /* ------------------------------------------------------------ 面板（五区） */

    function PanelView(props) {
      const { t } = props
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [query, setQuery] = useState('')
      const [busy, setBusy] = useState(false)
      const [personaEditing, setPersonaEditing] = useState(false)
      const [personaDraft, setPersonaDraft] = useState('')
      const [personaMsg, setPersonaMsg] = useState('')
      const [cfgForm, setCfgForm] = useState(null)
      const [cfgMsg, setCfgMsg] = useState('')
      const [cfgSavedAt, setCfgSavedAt] = useState(0)
      const [hindsightBusy, setHindsightBusy] = useState(false)

      const load = useCallback(async (q) => {
        setBusy(true)
        try {
          const res = await api('GET', '/panel?query=' + encodeURIComponent(q || '') + '&limit=12')
          if (res && res.ok) { setData(res.panel); setError(null) }
          else setError((res && res.error) || t('loadFailed'))
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }, [t])

      useEffect(() => {
        load('')
        // 不再定时刷新：只在打开面板时拉一次，靠右上「刷新」按钮手动更新
        return () => {}
      }, [load])

      // 接口配置：面板内直接读一次（不随 30s 刷新覆盖用户输入）
      useEffect(() => {
        (async () => {
          try {
            const res = await api('GET', '/config')
            if (res && res.ok) {
              const c = res.config
              const next = {}
              for (const g of GROUPS) next[g] = { base: c[g].base || '', key: '', model: c[g].model || '', hasKey: Boolean(c[g].hasKey) }
              setCfgForm(next)
            }
          } catch {}
        })()
      }, [])

      const startEditPersona = async () => {
        setPersonaMsg('')
        try {
          const res = await api('GET', '/persona')
          const obj = (res && res.ok && res.persona) || {}
          setPersonaDraft(JSON.stringify(obj, null, 2))
        } catch {
          setPersonaDraft('{}')
        }
        setPersonaEditing(true)
      }

      const savePersona = async () => {
        setPersonaMsg('')
        try {
          const parsed = JSON.parse(personaDraft || '{}')
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是 JSON 对象')
          const res = await api('POST', '/persona', { persona: parsed })
          if (res && res.ok) {
            setPersonaEditing(false)
            await load('')
          } else setPersonaMsg((res && res.error) || t('saveFailed'))
        } catch (e) {
          setPersonaMsg(String((e && e.message) || e))
        }
      }

      const setCfgField = (g, f, v) => setCfgForm(prev => {
        const next = { ...prev }
        next[g] = { ...next[g], [f]: v }
        return next
      })

      const saveCfg = async () => {
        setCfgMsg('')
        try {
          const groups = {}
          for (const g of GROUPS) {
            groups[g] = {
              base: cfgForm[g].base,
              key: cfgForm[g].key ? cfgForm[g].key : null,
              model: cfgForm[g].model,
            }
          }
          const res = await api('POST', '/config', { groups })
          if (res && res.ok) {
            const c = res.config
            const next = {}
            for (const g of GROUPS) next[g] = { base: c[g].base || '', key: '', model: c[g].model || '', hasKey: Boolean(c[g].hasKey) }
            setCfgForm(next)
            setCfgSavedAt(Date.now())
          } else setCfgMsg((res && res.error) || t('saveFailed'))
        } catch (e) {
          setCfgMsg(String((e && e.message) || e))
        }
      }

      if (error && !data) {
        return h('div', { className: 'nc-panel' },
          h('div', { className: 'nc-err' }, `${t('loadFailed')}: ${error}`),
          Btn({ onClick: () => load('') }, t('refresh')))
      }

      const p = data

      const personaCard = p ? h(Card, { title: t('persona') },
        personaEditing
          ? h('div', {},
            h('textarea', {
              className: 'nc-json',
              value: personaDraft,
              placeholder: '{\n  "名字": "",\n  "自称": "我",\n  "称呼对方": "你"\n}',
              onChange: function (e) { setPersonaDraft(e.target.value) },
            }),
            h('div', { className: 'nc-bar', style: { marginTop: 8 } },
              h(Btn, { primary: true, onClick: savePersona }, t('save')),
              h(Btn, { onClick: function () { setPersonaEditing(false); setPersonaMsg('') } }, t('cancel'))),
            personaMsg ? h('div', { className: 'nc-err', style: { marginTop: 6 } }, personaMsg) : null)
          : h('div', {},
            p.persona && p.persona.length
              ? p.persona.map(function (row) { return h(KV, { key: row.key, k: row.key + (row.inPrompt ? ' ·' : ''), v: row.value }) })
              : h('div', { className: 'nc-muted' }, t('personaEmpty')),
            h('div', { className: 'nc-bar', style: { marginTop: 8 } },
              h(Btn, { onClick: startEditPersona }, t('editPersona')),
              h('span', { className: 'nc-hint' }, t('personaHint'))))) : null

      const moodCard = p ? h(Card, { title: t('mood') },
        p.mood
          ? h('div', {}, p.mood.line)
          : h('div', { className: 'nc-muted' }, t('moodEmpty'))) : null

      const memoryCard = p ? h(Card, { title: t('memory') },
        h(KV, { k: t('memoryTotal'), v: p.memory.total + ' / ' + t('memoryActive') + ' ' + p.memory.active }),
        h(KV, {
          k: t('byTier'),
          v: Object.entries(p.memory.byTier).map(function (e) { return e[0] + ' ' + e[1] }).join(' · ') || '—',
        }),
        h(KV, { k: t('pending'), v: String(p.memory.pending) }),
        h('div', { className: 'nc-hint' }, p.memory.note || ''),
        h('div', { style: { marginTop: 8 } },
          p.memory.items.length
            ? p.memory.items.map(function (item) { return h(MemItem, { key: item.id, item: item, t: t }) })
            : h('div', { className: 'nc-muted' }, t('loading')))) : null

      const doHindsight = async () => {
        setHindsightBusy(true)
        try {
          const res = await api('POST', '/hindsight', {})
          if (res && res.ok) { await load('') }
          else setError((res && res.error) || t('loadFailed'))
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setHindsightBusy(false)
        }
      }

      const timeCard = p ? h(Card, { title: t('time') },
        h('div', {}, p.time.line),
        h('div', { className: 'nc-hint', style: { marginTop: 6 } }, t('timeHint'))) : null

      const locationCard = p ? h(Card, { title: t('location') },
        p.location
          ? h('div', {},
            h('div', {}, p.location.line),
            h('div', { className: 'nc-hint', style: { marginTop: 4 } },
              t('locationAt') + ' ' + new Date(p.location.at).toLocaleTimeString()),
            p.location.changes && p.location.changes.length
              ? h('div', { className: 'nc-hint', style: { marginTop: 4 } },
                t('locationChanges') + '：' + p.location.changes.map(function (c) { return c.to }).join(' / '))
              : null)
          : h('div', { className: 'nc-muted' }, t('locationEmpty'))) : null

      const hindsightCard = p ? h(Card, { title: t('hindsight') },
        p.hindsight
          ? h('div', {},
            h('div', {}, p.hindsight.summary),
            h('div', { className: 'nc-hint', style: { marginTop: 6 } },
              t('evidence') + ': ' + (p.hindsight.evidenceIds || []).join(', ') + ' · ' + new Date(p.hindsight.at).toLocaleString()))
          : h('div', { className: 'nc-muted' }, t('hindsightEmpty')),
        h('div', { className: 'nc-bar', style: { marginTop: 8 } },
          h(Btn, { primary: true, disabled: hindsightBusy, onClick: doHindsight }, hindsightBusy ? t('generating') : t('generate'))),
        p.hindsightStats && p.hindsightStats.total
          ? h('div', { className: 'nc-hint', style: { marginTop: 6 } },
            t('hindsightStats') + '：今日 ' + p.hindsightStats.today + ' 次 · 共 ' + p.hindsightStats.total + ' 次 · 平均 ' + (p.hindsightStats.avgMs ? Math.round(p.hindsightStats.avgMs / 1000) + 's' : '—'))
          : null,
        h('div', { className: 'nc-hint', style: { marginTop: 6 } }, t('hindsightByChat'))) : null

      // ── 接口配置（面板内直接改，与设置页共用同一套 RPC）──
      const groupName = {
        embedding: t('groupEmbedding'),
        rerank: t('groupRerank'),
      }
      const cfgCard = h(Card, { title: t('configTitle') },
        cfgForm
          ? h('div', {},
            GROUPS.map(function (g) {
              return h('div', { className: 'nc-cfg-group', key: g },
                h('div', { className: 'nc-hint' }, groupName[g]),
                h('div', { className: 'nc-fields' },
                  h('div', { className: 'nc-field' },
                    h('label', {}, t('base')),
                    h('input', {
                      className: 'nc-input', value: cfgForm[g].base,
                      placeholder: 'https://api.deepseek.com/v1',
                      onChange: function (e) { setCfgField(g, 'base', e.target.value) },
                    })),
                  h('div', { className: 'nc-field' },
                    h('label', {}, t('key')),
                    h('input', {
                      className: 'nc-input', type: 'password', value: cfgForm[g].key,
                      placeholder: cfgForm[g].hasKey ? t('keyKept') : '',
                      onChange: function (e) { setCfgField(g, 'key', e.target.value) },
                    })),
                  h('div', { className: 'nc-field' },
                    h('label', {}, t('model')),
                    h('input', {
                      className: 'nc-input', value: cfgForm[g].model,
                      placeholder: 'gpt-4o-mini',
                      onChange: function (e) { setCfgField(g, 'model', e.target.value) },
                    }))))
            }),
            h('div', { className: 'nc-bar', style: { marginTop: 8 } },
              h(Btn, { primary: true, onClick: saveCfg }, t('save')),
              cfgSavedAt ? h('span', { className: 'nc-hint' }, t('saved') + ' ' + new Date(cfgSavedAt).toLocaleTimeString()) : null,
              cfgMsg ? h('span', { className: 'nc-err' }, cfgMsg) : null))
          : h('div', { className: 'nc-muted' }, t('loading')))

      return h('div', { className: 'nc-panel' },
        h('style', {}, CSS),
        h('div', { className: 'nc-toolbar' },
          h('input', {
            className: 'nc-input', value: query,
            placeholder: t('searchPlaceholder'),
            onChange: function (e) { setQuery(e.target.value) },
            onKeyDown: function (e) { if (e.key === 'Enter') load(query) },
          }),
          h(Btn, { primary: true, disabled: busy, onClick: function () { load(query) } }, t('search')),
          h(Btn, { disabled: busy, onClick: function () { load('') } }, t('refresh'))),
        error ? h('div', { className: 'nc-err' }, error) : null,
        !p ? h('div', { className: 'nc-muted' }, t('loading'))
          : h('div', {},
            h('div', { className: 'nc-grid' },
              h('div', {}, personaCard, moodCard, memoryCard),
              h('div', {}, timeCard, locationCard, hindsightCard)),
            h('div', { style: { marginTop: 12 } }, cfgCard)))
  }

    /* ------------------------------------------------------------ 设置页（四组接口） */

    const GROUPS = ['embedding', 'rerank']

    function SettingsView(props) {
      const { t } = props
      const [form, setForm] = useState(null)
      const [error, setError] = useState(null)
      const [savedAt, setSavedAt] = useState(0)

      useEffect(() => {
        (async () => {
          try {
            const res = await api('GET', '/config')
            if (res && res.ok) {
              const c = res.config
              const next = {}
              for (const g of GROUPS) next[g] = { base: c[g].base || '', key: '', model: c[g].model || '', hasKey: Boolean(c[g].hasKey) }
              setForm(next)
              setError(null)
            } else setError((res && res.error) || t('loadFailed'))
          } catch (e) {
            setError(String((e && e.message) || e))
          }
        })()
      }, [t])

      const setField = (g, f, v) => setForm(prev => {
        const next = { ...prev }
        next[g] = { ...next[g], [f]: v }
        return next
      })

      const save = async () => {
        setError(null)
        try {
          const groups = {}
          for (const g of GROUPS) {
            groups[g] = {
              base: form[g].base,
              key: form[g].key ? form[g].key : null,
              model: form[g].model,
            }
          }
          const res = await api('POST', '/config', { groups })
          if (res && res.ok) {
            setSavedAt(Date.now())
            const c = res.config
            const next = {}
            for (const g of GROUPS) next[g] = { base: c[g].base || '', key: '', model: c[g].model || '', hasKey: Boolean(c[g].hasKey) }
            setForm(next)
          } else setError((res && res.error) || t('saveFailed'))
        } catch (e) {
          setError(String((e && e.message) || e))
        }
      }

      const groupTitles = {
        embedding: t('groupEmbedding'),
        rerank: t('groupRerank'),
      }

      return h('div', { className: 'nc-panel nc-settings' },
        h('style', {}, CSS),
        h('div', { className: 'nc-notice' }, t('settingsIntro')),
        error ? h('div', { className: 'nc-fail' }, error) : null,
        !form ? h('div', { className: 'nc-muted' }, t('loading'))
          : h('div', {},
            GROUPS.map(g => h('div', { className: 'nc-group', key: g },
              h('div', { className: 'nc-h3' }, groupTitles[g]),
              h('div', { className: 'nc-fields' },
                h('div', { className: 'nc-field' },
                  h('label', {}, t('base')),
                  h('input', { className: 'nc-input', value: form[g].base, placeholder: 'https://api.deepseek.com/v1', onChange: e => setField(g, 'base', e.target.value) })),
                h('div', { className: 'nc-field' },
                  h('label', {}, t('key')),
                  h('input', { className: 'nc-input', type: 'password', value: form[g].key, placeholder: form[g].hasKey ? t('keyKept') : '', onChange: e => setField(g, 'key', e.target.value) })),
                h('div', { className: 'nc-field' },
                  h('label', {}, t('model')),
                  h('input', { className: 'nc-input', value: form[g].model, placeholder: 'gpt-4o-mini', onChange: e => setField(g, 'model', e.target.value) })),
              ))),
            h('div', { className: 'nc-bar' },
              Btn({ primary: true, onClick: save }, t('save')),
              savedAt ? h('span', { className: 'nc-muted' }, `${t('saved')} ${new Date(savedAt).toLocaleTimeString()}`) : null)))
    }

    /* ------------------------------------------------------------ 侧栏图标 */

    function PanelIconButton(props) {
      const { t, layout } = props
      return h('button', {
        className: 'nc-panel-icon',
        title: t('panelTitle'),
        type: 'button',
        onClick: () => { if (layout && typeof layout.selectPanel === 'function') layout.selectPanel('neural-cloud') },
      }, CloudIcon({}))
    }

    /* ------------------------------------------------------------ 注册 */

    return {
      inject: ['slots'],
      apply(ctx) {
        const t = makeT(ctx)
        const layout = ctx.get('layout')
        const disposers = []

        disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'neural-cloud', order: 50, label: () => t('panelTitle'),
        }, () => h(PanelIconButton, { t, layout }))))

        disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'neural-cloud',
        }, () => h(PanelView, { t }))))

        disposers.push(ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'neural-cloud', order: 90, label: () => t('settingsTitle'),
        }, () => h(SettingsView, { t }))))

        return () => { for (const d of disposers) { try { d() } catch {} } }
      },
    }
  },
})
