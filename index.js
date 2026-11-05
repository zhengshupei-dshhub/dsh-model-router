/**
 * 开局选模型：按用户消息的关键词，把当前会话切到最合适的模型。
 *
 * 通用性设计（2026-11-05 v2.2.0）：
 * - provider / 模型名全部来自配置，默认值是我们这套 Agent Plan（arkcli-agent-plan）；
 * - 别人用 Coding Plan、OpenAI、Anthropic 或自建端点，只改 config 里的 provider 和 models；
 * - 配置里没写、但运行时注册了别的 provider 时，会自动找一个能提供同名模型的 provider；
 * - 多出来的两档降级（WorkBuddy / DeepSeek 账号）也可以关掉，只留套餐。
 *
 * 匹配逻辑：纯关键词，不发额外请求，零成本、零延迟。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const inject = ['sessionController']

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
  // 主 provider：换套餐就改这里（Coding Plan 一般是 arkcli-coding-plan）
  provider: 'arkcli-agent-plan',
  // provider 不匹配时，是否自动找一个能提供同名模型的 provider
  autoDetectProvider: true,
  // 每轮用户消息都重新判断（目标没变不写）
  perTurn: true,
  // 超过这么多字符的输入直接上「长文本」模型
  longTextChars: 20000,
  // 套餐 5 小时窗口用到这个百分比就算「不可用」，开始降级
  planCeilingPercent: 95,
  // 包/套餐快照超过这么多分钟没更新就视为「未知」，按可用处理（宁可 429 也不误扣费）
  snapshotStaleMinutes: 60,
  // 失败兜底：套餐请求报错时切到 fallback 并重试同一轮
  fallbackOnError: true,
  fallbackErrorPattern: 'InvalidSubscription|InternalServiceError|5\\d\\d|429|ServiceUnavailable',
  // 兜底目标（按需改；不想要按量计费就把 fallback 设为 null）
  fallback: { provider: 'deepseek-account', model: 'deepseek-flash' },
  // 额度不足时的降级链：workbuddy（积分）→ fallback（上面那个）
  workbuddyFallback: { provider: 'workbuddy', model: 'hy3' },
  workbuddyMaxTurn: 5,
  workbuddyMinCredits: 50,

  // ── 模型映射：别人换 provider 时主要改这里 ──
  models: {
    default: 'doubao-seed-2.1-pro',
    reasoning: 'deepseek-v4-pro',
    code: 'kimi-k3.1-pro',
    codeSmall: 'deepseek-v4.1-flash',
    review: 'kimi-k3.1-pro',
    longDoc: 'kimi-k3.1-pro',
    vision: 'kimi-k3.1-pro',
    writing: 'glm-5.3',
    light: 'deepseek-v4.1-flash-economy',
  },

  // 关键词规则：target 指向上面 models 里的键
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
 * 返回 { provider, model, rule }；provider 取配置值。
 */
export function pickModel(text, config = {}) {
  const merged = { ...DEFAULTS, ...config, models: { ...DEFAULTS.models, ...(config.models ?? {}) } }
  const source = String(text ?? '').toLowerCase()
  const attachments = Number(config.attachments ?? 0)
  const provider = merged.provider
  const modelOf = (key) => merged.models[key] ?? merged.models.default
  const pick = (target, rule) => ({ provider, model: modelOf(target), rule })

  // 带图片/文件 → 视觉模型
  if (attachments > 0) return pick('vision', 'attachment')
  // 超长文本 → 长上下文模型
  if (source.length > (merged.longTextChars ?? DEFAULTS.longTextChars)) return pick('longDoc', 'long-text')

  for (const rule of merged.rules ?? []) {
    const hit = (rule.match ?? []).some((keyword) => keyword && source.includes(String(keyword).toLowerCase()))
    if (hit) return pick(rule.target ?? 'default', rule.id ?? 'matched')
  }
  return pick('default', 'default')
}

export function apply(ctx, config = {}) {
  const merged = { ...DEFAULTS, ...config, models: { ...DEFAULTS.models, ...(config.models ?? {}) } }
  if (!merged.enabled) return

  const logger = ctx.logger?.('dsh-model-router')
  const lastChoice = new Map()
  const degradedTurn = new Map()
  let activeProvider = merged.provider
  let detected = false

  /** 配置的 provider 不在运行时注册表里时，找一个能提供同名模型的 provider。 */
  async function resolveProvider() {
    if (detected) return activeProvider
    detected = true
    if (!merged.autoDetectProvider) return activeProvider
    const llm = ctx.get?.('llm')
    if (!llm?.listProviders) return activeProvider
    try {
      const providers = await llm.listProviders()
      const ids = providers.map((p) => p.id ?? p.name).filter(Boolean)
      if (ids.includes(activeProvider)) return activeProvider
      // 逐个问：谁能提供 models.default
      for (const id of ids) {
        try {
          const models = await llm.listModels(id)
          if ((models ?? []).some((m) => m.id === merged.models.default)) {
            logger?.warn?.(`provider ${activeProvider} 不存在，改用 ${id}`)
            activeProvider = id
            return id
          }
        } catch {}
      }
      logger?.warn?.(`没有找到能提供 ${merged.models.default} 的 provider，保持 ${activeProvider}`)
    } catch (error) {
      logger?.warn?.(`探测 provider 失败：${error?.message ?? error}`)
    }
    return activeProvider
  }

  ctx.on('agent/inbox/claimed', (payload) => {
    const turn = payload?.turn ?? 0
    if (turn !== 1 && !merged.perTurn) return
    const sessionId =
      payload?.agent?.session?.id ?? payload?.agent?.session?.header?.id ?? payload?.agent?.sessionId
    if (!sessionId) return

    const { text, attachments } = textOf(payload?.message)
    const choice = pickModel(text, { ...merged, attachments })

    const snapshot = readSnapshot()
    const stale = !snapshot || snapshot.ageMs > (merged.snapshotStaleMinutes ?? 60) * 60_000
    if (stale) refreshSnapshotInBackground(logger)
    const snap = snapshot?.data
    const fiveHour = (snap?.planPeriods ?? []).find((p) => p.label === '5h')
    const planOk = stale || !fiveHour ? true : fiveHour.percent < (merged.planCeilingPercent ?? 95)
    const credits = snap?.workbuddyCredits
    const creditsOk = typeof credits === 'number' ? credits >= (merged.workbuddyMinCredits ?? 50) : true
    const canUseWorkbuddy = turn <= (merged.workbuddyMaxTurn ?? 5)

    // 套餐额度不够：WorkBuddy → fallback → 不动
    if (!planOk) {
      if (canUseWorkbuddy && creditsOk) {
        logger?.warn?.(`套餐 5h 已用 ${fiveHour?.percent ?? '?'}%，降级到 WorkBuddy`)
        choice.provider = merged.workbuddyFallback.provider
        choice.model = merged.workbuddyFallback.model
        choice.rule = `${choice.rule}-plan-full→workbuddy`
      } else if (merged.fallback?.provider) {
        logger?.warn?.('套餐满、WorkBuddy 不可用，降级到兜底 provider')
        choice.provider = merged.fallback.provider
        choice.model = merged.fallback.model
        choice.rule = `${choice.rule}-plan-full→fallback`
      } else {
        logger?.warn?.('所有额度都不可用，保持当前模型不动')
        return
      }
    }

    // WorkBuddy 目标：长会话绕开（hy3 上下文很小）
    if (choice.provider === merged.workbuddyFallback.provider && !canUseWorkbuddy) {
      choice.provider = activeProvider
      choice.model = merged.models.default
      choice.rule = `${choice.rule}-long-session→plan`
    }

    const key = `${choice.provider}/${choice.model}`
    if (lastChoice.get(sessionId) === key) return
    lastChoice.set(sessionId, key)
    logger?.info?.(`选模型：session=${sessionId} turn=${turn} rule=${choice.rule} → ${key}`)

    Promise.resolve()
      .then(async () => {
        const provider = await resolveProvider()
        await ctx.sessionController.selectModel({
          sessionId,
          provider: provider === merged.provider ? choice.provider : provider,
          model: choice.model,
        })
      })
      .catch((error) => logger?.warn?.(`选模型失败：${error?.message ?? error}`))
  })

  // 套餐请求失败（订阅抖动 / 5xx）时切到 fallback 并重试同一轮，每会话每轮只兜底一次。
  ctx.on('agent/request-error', async (payload, next) => {
    try {
      if (!merged.fallbackOnError || !merged.fallback?.provider) return next()
      if (payload?.provider !== merged.provider) return next()
      const sessionId = payload?.agent?.id
      const turn = payload?.turn ?? 0
      if (!sessionId || degradedTurn.get(sessionId) === turn) return next()

      const failure = payload?.failure ?? {}
      const pattern = new RegExp(merged.fallbackErrorPattern ?? DEFAULTS.fallbackErrorPattern, 'i')
      if (!pattern.test(`${failure.code ?? ''} ${failure.message ?? ''}`)) return next()

      degradedTurn.set(sessionId, turn)
      await ctx.sessionController.selectModel({
        sessionId,
        provider: merged.fallback.provider,
        model: merged.fallback.model,
      })
      logger?.warn?.(
        `套餐请求失败（${failure.code ?? failure.status ?? '?'}），已切到 ${merged.fallback.provider}/${merged.fallback.model} 并重试`,
      )
      return { kind: 'retry' }
    } catch (error) {
      logger?.warn?.(`兜底切换失败：${error?.message ?? error}`)
      return next()
    }
  })
}
