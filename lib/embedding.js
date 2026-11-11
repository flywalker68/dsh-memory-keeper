// 本地向量检索：bge-small-zh（@xenova/transformers，懒加载）
// 只做「把文字变向量」和存储；检索排序在 search.js 里合并。
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const MODEL_DIR = join(here, '..', 'models')
const MODEL_NAME = 'Xenova/bge-small-zh-v1.5'

let pipePromise = null
let unavailable = ''

export function vectorStatus() {
  return { available: !unavailable, error: unavailable || null, model: MODEL_NAME }
}

async function getPipe() {
  if (pipePromise) return pipePromise
  pipePromise = (async () => {
    const { env, pipeline } = await import('@xenova/transformers')
    env.remoteHost = 'https://hf-mirror.com'
    env.cacheDir = MODEL_DIR
    return pipeline('feature-extraction', MODEL_NAME, { quantized: true })
  })().catch((e) => {
    unavailable = e?.message || String(e)
    throw e
  })
  return pipePromise
}

/** 批量算向量；失败抛错（调用方回退词面） */
export async function embedTexts(texts, batch = 32) {
  const pipe = await getPipe()
  const out = []
  for (let i = 0; i < texts.length; i += batch) {
    const r = await pipe(texts.slice(i, i + batch), { pooling: 'mean', normalize: true })
    out.push(...r.tolist())
  }
  return out
}

/** 余弦相似度（向量已归一化，点积即可） */
export function cos(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

// ── 远程 Qwen（2026-11-11 加）：API 优先、失败回退本地 bge-small ──────────────
// 用 node:https 而不是 fetch：undici 在这台机器上报本地证书错，https 正常。
import https from 'node:https'

export const QWEN_EMBED_MODEL = 'qwen3.7-text-embedding'
export const QWEN_RERANK_MODEL = 'qwen3.7-text-rerank'
// 1024 维：2026-11-11 实测 1024 与 2560 的 hit@10 基本持平（94.3% vs 93.7%），
// 而 1024 的存储只有一半（2346 块约 9 MB），检索也快。别再改回 2560 除非重测。
export const QWEN_DIMS = 1024

function httpsJson(url, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = JSON.stringify(body)
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: timeoutMs,
    }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 160)}`))
        try { resolve(JSON.parse(d)) } catch (e) { reject(new Error('bad json: ' + d.slice(0, 120))) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

/** 远程 Qwen embedding；失败抛错，调用方回退本地 */
export async function qwenEmbedTexts(texts, opts = {}) {
  const { apiKey, model = QWEN_EMBED_MODEL, dimensions = QWEN_DIMS, timeoutMs = 5000, batch = 10 } = opts
  if (!apiKey) throw new Error('qwen: no api key')
  const out = []
  for (let i = 0; i < texts.length; i += batch) {
    const j = await httpsJson(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings',
      { model, input: texts.slice(i, i + batch), dimensions },
      { Authorization: 'Bearer ' + apiKey }, timeoutMs,
    )
    out.push(...j.data.map((d) => d.embedding))
  }
  return out
}

/** 远程 Qwen rerank；返回 [{index, relevance_score}]；失败抛错，调用方跳过重排 */
export async function qwenRerank(query, docs, opts = {}) {
  const { apiKey, model = QWEN_RERANK_MODEL, topN = 10, timeoutMs = 5000 } = opts
  if (!apiKey) throw new Error('qwen: no api key')
  const j = await httpsJson(
    'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank',
    { model, input: { query, documents: docs }, parameters: { return_documents: false, top_n: topN } },
    { Authorization: 'Bearer ' + apiKey }, timeoutMs,
  )
  return j.output.results
}

/** Qwen 块向量缓存（独立文件，与本地 bge 缓存并存）；apiKey 缺失/失败返回 null */
export async function ensureChunkVectorsQwen(index, cacheFile, opts = {}, log = () => {}) {
  const { apiKey } = opts
  if (!apiKey) return null
  const chunks = index.chunks || []
  if (!chunks.length) return new Map()
  const cache = loadVectorCache(cacheFile)
  // 维度变了（比如 2560 → 1024）旧向量长度不对，余弦会算错——必须整份重建
  const items = (cache.dims && cache.dims !== QWEN_DIMS) ? {} : (cache.items && typeof cache.items === 'object' ? cache.items : {})
  const missing = []
  for (const c of chunks) {
    const k = chunkKey(c)
    if (!items[k]) missing.push({ c, k })
  }
  if (missing.length) {
    const t0 = Date.now()
    const vecs = await qwenEmbedTexts(missing.map((m) => m.c.text), opts)
    missing.forEach((m, i) => { items[m.k] = f32ToB64(vecs[i]) })
    saveVectorCache(cacheFile, { model: QWEN_EMBED_MODEL, dims: QWEN_DIMS, items })
    log('INFO', `Qwen 向量补算 ${missing.length} 块（${Date.now() - t0}ms）`)
  }
  const map = new Map()
  for (const c of chunks) {
    const k = chunkKey(c)
    if (items[k]) map.set(k, b64ToF32(items[k]))
  }
  return map
}

export function chunkKey(c) {
  const h = createHash('md5').update(String(c.text || '')).digest('hex').slice(0, 12)
  return `${c.file}:${c.line}:${h}`
}

const f32ToB64 = (arr) => Buffer.from(new Float32Array(arr).buffer).toString('base64')
function b64ToF32(s) {
  const buf = Buffer.from(s, 'base64')
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return new Float32Array(ab)
}

/** 加载向量缓存 */
export function loadVectorCache(file) {
  try {
    if (!existsSync(file)) return { model: MODEL_NAME, items: {} }
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { model: MODEL_NAME, items: {} }
  }
}

export function saveVectorCache(file, cache) {
  try {
    writeFileSync(file, JSON.stringify(cache), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 确保 index.chunks 都有向量；只算新增/变化的块。
 * 返回 Map<chunkKey, Float32Array>；不可用时返回 null。
 */
export async function ensureChunkVectors(index, cacheFile, log = () => {}) {
  if (unavailable) return null
  const chunks = index.chunks || []
  if (!chunks.length) return new Map()
  const cache = loadVectorCache(cacheFile)
  const items = cache.items && typeof cache.items === 'object' ? cache.items : {}
  const missing = []
  for (const c of chunks) {
    const k = chunkKey(c)
    if (!items[k]) missing.push({ c, k })
  }
  if (missing.length) {
    const t0 = Date.now()
    const vecs = await embedTexts(missing.map((m) => m.c.text))
    missing.forEach((m, i) => { items[m.k] = f32ToB64(vecs[i]) })
    saveVectorCache(cacheFile, { model: MODEL_NAME, items })
    log('INFO', `向量补算 ${missing.length} 块（${Date.now() - t0}ms）`)
  }
  const map = new Map()
  for (const c of chunks) {
    const k = chunkKey(c)
    if (items[k]) map.set(k, b64ToF32(items[k]))
  }
  return map
}

/** 清掉不属于当前 index 的旧向量（防止缓存无限增长） */
export function pruneVectorCache(index, cacheFile) {
  try {
    const cache = loadVectorCache(cacheFile)
    const live = new Set((index.chunks || []).map(chunkKey))
    const items = {}
    for (const k of Object.keys(cache.items || {})) if (live.has(k)) items[k] = cache.items[k]
    saveVectorCache(cacheFile, { model: MODEL_NAME, items })
  } catch { /* ignore */ }
}
