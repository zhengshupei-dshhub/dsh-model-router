/**
 * 开局选模型：按用户消息的关键词，把当前会话切到最合适的模型。
 *
 * 通用性设计（v2.3.0）：
 * - 默认零配置：扫描运行时注册的所有 provider 与模型，按名字/模态自动识别能力；
 * - 显式配置（provider / models）始终优先，用来微调；
 * - 换 provider、换套餐、换厂商都不用改代码。
 *
 * 匹配逻辑：纯关键词，不发额外请求，零延迟、零成本。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const inject = ['sessionController']

/**
 * @typedef {Object} CatalogEntry
 * @property {string} provider
 * @property {string} id
 * @property {string} name
 * @property {string[]} modalities
 */

function readSnapshot() {
  const file = path.join(os.homedir(), '.dsh', 'quota-snapshot.json')
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const ageMs = Date.now() - (Date.parse(data.checkedAt) || 0)
    return { data, ageMs }
  } catch {
    return undefined
  }
}

/** 快照太旧就在后台刷一次（有冷却，避免每条消息都拉起来）。 */
let lastRefreshAt = 0
function refreshSnapshotInBackground(logger) {
  const now = Date.now()
  if (now - lastRefreshAt < 10 * 60_000) return
  lastRefreshAt = now
  try {
    const script = path.join(os.homedir(), 'DeepSeekHarness', 'dsh-automation', 'quota-guard', 'check.mjs')
    if (!fs.existsSync(script)) return
    const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch (error) {
    logger?.warn?.(`刷新余量快照失败：${error?.message ?? error}`)
  }
}

export const DEFAULTS = {
  enabled: true,
  // 'auto' = 扫描运行时的所有 provider 自动分配；也可以写死 provider id
  provider: 'auto',
  // 显式模型映射（键 → { provider, model }）；空对象 = 全部自动识别
  models: {},
  // 每轮用户消息都重新判断（目标没变不写）
  perTurn: true,
  // 超过这么多字符的输入直接上「长文本」模型
  longTextChars: 20000,
  // 套餐 5 小时窗口用到这个百分比就算「不可用」，开始降级
  planCeilingPercent: 95,
  // 快照超过这么多分钟没更新就视为「未知」，按可用处理（宁可 429 也不误扣费）
  snapshotStaleMinutes: 60,
  // 失败兜底：主 provider 请求报错时切到 fallback 并重试；不需要就设成 null
  fallbackOnError: true,
  fallbackErrorPattern: 'InvalidSubscription|InternalServiceError|5\\d\\d|429|ServiceUnavailable',
  fallback: null,
  // 额度不足时的中间降级（按积分计费，没有对应插件就设成 null）
  workbuddyFallback: null,
  workbuddyMaxTurn: 5,
  workbuddyMinCredits: 50,

  // 关键词规则：target 是模型映射里的键
  rules: [
    {
      id: 'reasoning',
      target: 'reasoning',
      match: ['数学', '算法', '证明', '证一下', '推导', '不等式', '逻辑证明', '复杂度', '最优解', '递推', '方程', '归纳法'],
    },
    {
      id: 'code-small',
      target: 'codeSmall',
      match: ['单文件', '小改', '补测试', '改个 bug', '修一个小 bug', '补个函数', '写个脚本', '样板', '改一下'],
    },
    {
      id: 'code',
      target: 'code',
      match: ['重构', '架构', '疑难', '调试', '报错', '多文件', '跨文件', '整个项目', '依赖冲突', '设计模式'],
    },
    {
      id: 'review',
      target: 'review',
      match: ['审查', 'review', '排查', '调查', '审计', '评审', '检查一下'],
    },
    {
      id: 'long-doc',
      target: 'longDoc',
      match: ['长文档', '通读', '整篇', '论文', 'pdf', '翻译整篇', '代码库', '大文件', '整本书', '全文'],
    },
    {
      id: 'vision',
      target: 'vision',
      match: ['截图', '看图', '图片', '照片', '这张图', '视频里', '识别一下', 'ocr', '这张'],
    },
    {
      id: 'writing',
      target: 'writing',
      match: ['文案', '剧本', '故事', '润色', '写一篇', '创作', '标题党', '小红书', '公众号', '口播'],
    },
    {
      id: 'light',
      target: 'light',
      match: ['格式转换', '提取', '分类', '重命名', '列一下', '改写标题', '批量', '转成', 'json', 'csv', '表格'],
    },
  ],
}

/** 模型映射的键（自动识别时每个键都要有候选）。 */
export const CAPABILITY_KEYS = [
  'default', 'reasoning', 'code', 'codeSmall', 'review', 'longDoc', 'vision', 'writing', 'light',
]

const NAME_HINTS = {
  light: ['mini', 'lite', 'flash-economy', 'nano', 'small'],
  codeSmall: ['mini', 'lite', 'flash', 'small'],
  code: ['code', 'codex', 'coder', 'pro'],
  review: ['pro', 'code', 'max'],
  longDoc: ['pro', 'max', 'ultra'],
  reasoning: ['o1', 'o3', 'r1', 'reason', 'think', 'pro', 'max'],
  writing: ['glm', 'gpt', 'claude', 'pro', 'gemini'],
  vision: ['vision', '-vl', 'vl-', 'vlm', 'image', 'multimodal'],
}

/** 名字里是否出现任一关键词。 */
function matchesName(entry, words) {
  const name = `${entry.id} ${entry.name}`.toLowerCase()
  return words.some((word) => name.includes(word.toLowerCase()))
}

/** 挑视觉模型：显式 vision 命名 > 强档(pro/max/ultra) > 非轻量档 > 第一个多模态。
 *  2026-11-06：原来取「第一个多模态」，结果 deepseek-flash（也是多模态、且是当前模型）
 *  被选中，看起来像"没切换"。强档优先能真正切到 doubao/kimi 这类专门的视觉模型。 */
function pickVision(list) {
  const multimodal = list.filter(isMultimodal)
  if (!multimodal.length) return undefined
  return (
    multimodal.find((entry) => matchesName(entry, NAME_HINTS.vision)) ??
    multimodal.find((entry) => matchesName(entry, ['pro', 'max', 'ultra'])) ??
    multimodal.find((entry) => !matchesName(entry, NAME_HINTS.light)) ??
    multimodal[0]
  )
}

function isMultimodal(entry) {
  if ((entry.modalities ?? []).some((modality) => modality === 'image')) return true
  return matchesName(entry, NAME_HINTS.vision)
}

/**
 * 从运行时模型目录自动识别「能力 → 模型」映射。纯函数，便于测试。
 * @param {CatalogEntry[]} catalog
 * @returns {Record<string, { provider: string, model: string }>}
 */
export function discoverModelMap(catalog) {
  const list = Array.isArray(catalog) ? catalog : []
  if (!list.length) return {}

  const findByName = (words) => list.find((entry) => matchesName(entry, words))
  const map = {}
  const assign = (key, entry) => {
    if (entry && !map[key]) map[key] = { provider: entry.provider, model: entry.id }
  }

  // 视觉：优先用显式标注 image 的，其次名字带 vision/vl 的
  assign('vision', pickVision(list))

  // 轻量/小改：名字带 mini/lite/flash 的
  assign('light', findByName(NAME_HINTS.light))
  assign('codeSmall', findByName(NAME_HINTS.codeSmall))

  // 代码/审查/长文/推理/写作：按各自提示词找，失败时逐级兜底
  assign('code', findByName(NAME_HINTS.code))
  assign('review', findByName(NAME_HINTS.review))
  assign('longDoc', findByName(NAME_HINTS.longDoc))
  assign('reasoning', findByName(NAME_HINTS.reasoning))
  assign('writing', findByName(NAME_HINTS.writing))

  // default：优先 pro，其次第一个
  assign('default', findByName(['pro', 'max', 'ultra']) ?? list[0])

  // 还缺的键全部用 default，保证每个 target 都能解析
  for (const key of CAPABILITY_KEYS) {
    if (!map[key]) map[key] = map.default
  }
  return map
}

/** 从 UserMessage 的 content 里拼出纯文本，并报告是否带了图片/文件附件。 */
export function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
  const attachments = blocks.filter((block) => block?.type === 'image' || block?.type === 'file').length
  return { text, attachments }
}

/**
 * 选出目标模型。纯函数，便于测试。
 * resolvedMap：已识别（或显式提供）的「键 → { provider, model }」。
 */
export function pickModel(text, config = {}, resolvedMap = {}) {
  const merged = { ...DEFAULTS, ...config }
  const source = String(text ?? '').toLowerCase()
  const attachments = Number(config.attachments ?? 0)

  const resolve = (target, rule) => {
    const hit = resolvedMap[target] ?? resolvedMap.default
    return hit ? { ...hit, rule } : null
  }

  if (attachments > 0) return resolve('vision', 'attachment')
  if (source.length > (merged.longTextChars ?? DEFAULTS.longTextChars)) return resolve('longDoc', 'long-text')

  for (const rule of merged.rules ?? []) {
    const hit = (rule.match ?? []).some((keyword) => keyword && source.includes(String(keyword).toLowerCase()))
    if (hit) return resolve(rule.target ?? 'default', rule.id ?? 'matched')
  }
  return resolve('default', 'default')
}

export function apply(ctx, config = {}) {
  const merged = { ...DEFAULTS, ...config }
  if (!merged.enabled) return

  const logger = ctx.logger?.('dsh-model-router')
  const lastChoice = new Map()
  const degradedTurn = new Map()

  // resolvedMap：显式 models 优先，否则等自动识别完成
  let resolvedMap = {}
  let discoveryPromise

  function discover() {
    if (discoveryPromise) return discoveryPromise
    discoveryPromise = (async () => {
      const llm = ctx.get?.('llm')
      if (!llm?.listProviders) return
      const catalog = []
      const providers = await llm.listProviders()
      for (const provider of providers) {
        const id = provider.id ?? provider.name
        if (!id) continue
        let models = []
        try {
          models = await llm.listModels(id)
        } catch {}
        for (const model of models ?? []) {
          catalog.push({
            provider: id,
            id: model.id,
            name: model.name ?? model.id,
            modalities: model.inputModalities ?? [],
          })
        }
      }
      const discovered = discoverModelMap(catalog)
      resolvedMap = { ...discovered, ...(merged.models ?? {}) }
      if (catalog.length) {
        logger?.info?.(`已识别 ${catalog.length} 个模型：${Object.entries(resolvedMap)
          .map(([key, value]) => `${key}=${value.model}`)
          .join(', ')}`)
      } else {
        logger?.warn?.('运行时没有可读的模型目录，路由保持空闲')
      }
    })().catch((error) => logger?.warn?.(`识别模型失败：${error?.message ?? error}`))
    return discoveryPromise
  }

  // 启动即扫，通常在第一条消息到达前完成。
  discover()

  ctx.on('agent/inbox/claimed', (payload) => {
    const turn = payload?.turn ?? 0
    if (turn !== 1 && !merged.perTurn) return
    const sessionId =
      payload?.agent?.session?.id ?? payload?.agent?.session?.header?.id ?? payload?.agent?.sessionId
    if (!sessionId) return

    Promise.resolve()
      .then(async () => {
        await discover()

        const { text, attachments } = textOf(payload?.message)
        const choice = pickModel(text, { ...merged, attachments }, resolvedMap)
        if (!choice) return

        // 显式 provider：不用自动识别的 provider 路径
        if (merged.provider !== 'auto') choice.provider = merged.provider

        const snapshot = readSnapshot()
        const stale = !snapshot || snapshot.ageMs > (merged.snapshotStaleMinutes ?? 60) * 60_000
        if (stale) refreshSnapshotInBackground(logger)
        const snap = snapshot?.data
        const fiveHour = (snap?.planPeriods ?? []).find((p) => p.label === '5h')
        const planOk = stale || !fiveHour ? true : fiveHour.percent < (merged.planCeilingPercent ?? 95)
        const credits = snap?.workbuddyCredits
        const creditsOk = typeof credits === 'number' ? credits >= (merged.workbuddyMinCredits ?? 50) : true
        const canUseWorkbuddy = turn <= (merged.workbuddyMaxTurn ?? 5)

        // 额度不足：WorkBuddy → fallback → 不动
        if (!planOk) {
          if (merged.workbuddyFallback && canUseWorkbuddy && creditsOk) {
            logger?.warn?.(`额度已用 ${fiveHour?.percent ?? '?'}%，降级到 WorkBuddy`)
            choice.provider = merged.workbuddyFallback.provider
            choice.model = merged.workbuddyFallback.model
            choice.rule = `${choice.rule}-plan-full→workbuddy`
          } else if (merged.fallback?.provider) {
            logger?.warn?.('额度满、WorkBuddy 不可用，降级到兜底 provider')
            choice.provider = merged.fallback.provider
            choice.model = merged.fallback.model
            choice.rule = `${choice.rule}-plan-full→fallback`
          } else {
            logger?.warn?.('所有额度都不可用，保持当前模型不动')
            return
          }
        }

        // WorkBuddy 目标：长会话绕开（小上下文模型会撑爆）
        if (
          merged.workbuddyFallback &&
          choice.provider === merged.workbuddyFallback.provider &&
          !canUseWorkbuddy
        ) {
          choice.provider = resolvedMap.default?.provider ?? choice.provider
          choice.model = resolvedMap.default?.model ?? choice.model
          choice.rule = `${choice.rule}-long-session`
        }

        const key = `${choice.provider}/${choice.model}`
        if (lastChoice.get(sessionId) === key) return
        lastChoice.set(sessionId, key)
        logger?.info?.(`选模型：session=${sessionId} turn=${turn} rule=${choice.rule} → ${key}`)

        await ctx.sessionController.selectModel({
          sessionId,
          provider: choice.provider,
          model: choice.model,
        })
      })
      .catch((error) => logger?.warn?.(`选模型失败：${error?.message ?? error}`))
  })

  // 主 provider 请求失败（抖动 / 5xx）时切到 fallback 并重试同一轮，每会话每轮只兜底一次。
  ctx.on('agent/request-error', async (payload, next) => {
    try {
      if (!merged.fallbackOnError || !merged.fallback?.provider) return next()
      const sessionId = payload?.agent?.id
      const turn = payload?.turn ?? 0
      if (!sessionId || degradedTurn.get(sessionId) === turn) return next()

      const failure = payload?.failure ?? {}
      const providerOk = merged.provider === 'auto' ? true : payload?.provider === merged.provider
      if (!providerOk) return next()
      const pattern = new RegExp(merged.fallbackErrorPattern ?? DEFAULTS.fallbackErrorPattern, 'i')
      if (!pattern.test(`${failure.code ?? ''} ${failure.message ?? ''}`)) return next()

      degradedTurn.set(sessionId, turn)
      await ctx.sessionController.selectModel({
        sessionId,
        provider: merged.fallback.provider,
        model: merged.fallback.model,
      })
      logger?.warn?.(
        `请求失败（${failure.code ?? failure.status ?? '?'}），已切到 ${merged.fallback.provider}/${merged.fallback.model} 并重试`,
      )
      return { kind: 'retry' }
    } catch (error) {
      logger?.warn?.(`兜底切换失败：${error?.message ?? error}`)
      return next()
    }
  })
}
