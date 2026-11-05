/**
 * 开局选模型：按用户消息的关键词，把当前会话切到套餐里最合适的模型。
 *
 * 2026-11-05 重写：Agent Plan 改用官方 `arkcli helper` 接入，
 * provider 变成 `arkcli-agent-plan`，模型是公开短名（doubao-seed-2.1-pro 等），
 * 不再是之前手配的版本号 id。
 *
 * 设计取舍：
 * - 纯关键词匹配，不发额外的分类请求（零成本、零延迟）；
 * - 每轮都判断（perTurn），但目标没变就不写；
 * - 套餐 5 小时额度接近上限时，按 WorkBuddy → DeepSeek 账号 → 不动 降级；
 * - 任何一步失败都只写日志，不影响正常对话。
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

const PROVIDER = 'arkcli-agent-plan'

export const DEFAULTS = {
  enabled: true,
  // 每轮用户消息都重新判断（目标没变不写）
  perTurn: true,
  // 套餐 5 小时窗口用到这个百分比就算「不可用」，开始降级
  planCeilingPercent: 95,
  // 降级第二档：WorkBuddy（积分制），hy3 上下文小，只在前几轮用
  workbuddyFallback: { provider: 'workbuddy', model: 'hy3' },
  workbuddyMaxTurn: 5,
  workbuddyMinCredits: 50,
  // 降级第三档：按 token 计费的 DeepSeek 账号
  deepseekFallback: { provider: 'deepseek-account', model: 'deepseek-flash' },
  // 套餐请求失败（订阅抖动 / 5xx）时，自动切到 DeepSeek 账号并重试同一轮
  fallbackOnError: true,
  // 命中这些错误才兜底（套餐端点抖动为主）
  fallbackErrorPattern: 'InvalidSubscription|InternalServiceError|5\\d\\d|429|ServiceUnavailable',
  // 快照超过这么多分钟没更新就视为「未知」：宁可走套餐（最多 429），也不倒向按量计费
  snapshotStaleMinutes: 60,
  // 超过这个字符数直接上 1M 上下文的模型
  longTextChars: 20000,
  default: { provider: PROVIDER, model: 'doubao-seed-2.1-pro' },
  vision: { provider: PROVIDER, model: 'kimi-k3.1-pro' },
  rules: [
    // 1) 硬推理：数学 / 算法 / 证明
    {
      id: 'reasoning',
      match: ['数学', '算法', '证明', '证一下', '推导', '不等式', '逻辑证明', '复杂度', '最优解', '递推', '方程', '归纳法'],
      provider: PROVIDER,
      model: 'deepseek-v4-pro',
    },
    // 2) 单文件小改 / 补测试 / 样板代码
    {
      id: 'code-small',
      match: ['单文件', '小改', '补测试', '改个 bug', '修一个小 bug', '补个函数', '写个脚本', '样板', '改一下'],
      provider: PROVIDER,
      model: 'deepseek-v4.1-flash',
    },
    // 3) 跨文件重构 / 架构 / 疑难 bug
    {
      id: 'code',
      match: ['重构', '架构', '疑难', '调试', '报错', '多文件', '跨文件', '整个项目', '依赖冲突', '设计模式'],
      provider: PROVIDER,
      model: 'kimi-k3.1-pro',
    },
    // 4) 代码审查 / 独立调查
    {
      id: 'review',
      match: ['审查', 'review', '排查', '调查', '审计', '评审', '检查一下'],
      provider: PROVIDER,
      model: 'kimi-k3.1-pro',
    },
    // 5) 长文档 / 论文 / 大代码库通读
    {
      id: 'long-doc',
      match: ['长文档', '通读', '整篇', '论文', 'pdf', '翻译整篇', '代码库', '大文件', '整本书', '全文'],
      provider: PROVIDER,
      model: 'kimi-k3.1-pro',
    },
    // 6) 看图 / 截图 / 视频理解
    {
      id: 'vision',
      match: ['截图', '看图', '图片', '照片', '这张图', '视频里', '识别一下', 'ocr', '这张'],
      provider: PROVIDER,
      model: 'kimi-k3.1-pro',
    },
    // 7) 中文文案 / 剧本 / 创意写作
    {
      id: 'writing',
      match: ['文案', '剧本', '故事', '润色', '写一篇', '创作', '标题党', '小红书', '公众号', '口播'],
      provider: PROVIDER,
      model: 'glm-5.3',
    },
    // 8) 格式转换 / 抽取 / 分类 / 批量改写
    {
      id: 'light',
      match: ['格式转换', '提取', '分类', '重命名', '列一下', '改写标题', '批量', '转成', 'json', 'csv', '表格'],
      provider: PROVIDER,
      model: 'deepseek-v4.1-flash-economy',
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

/** 按顺序匹配规则，返回第一条命中的取舍；都没命中就返回默认。纯函数，便于测。 */
export function pickModel(text, config = {}) {
  const merged = { ...DEFAULTS, ...config }
  const source = String(text ?? '').toLowerCase()
  const attachments = Number(config.attachments ?? 0)
  const longTextChars = Number(merged.longTextChars ?? DEFAULTS.longTextChars)

  // 带图片/文件：用支持视觉的模型
  if (attachments > 0) {
    return { ...merged.vision, rule: 'attachment' }
  }
  // 超长文本：用 1M 上下文的模型
  if (source.length > longTextChars) {
    return { ...merged.vision, rule: 'long-text' }
  }
  for (const rule of merged.rules ?? []) {
    const hit = (rule.match ?? []).some((keyword) => keyword && source.includes(String(keyword).toLowerCase()))
    if (hit && rule.provider && rule.model) {
      return { provider: rule.provider, model: rule.model, rule: rule.id ?? 'matched' }
    }
  }
  return { ...merged.default, rule: 'default' }
}

export function apply(ctx, config = {}) {
  const merged = { ...DEFAULTS, ...config }
  if (!merged.enabled) return

  const logger = ctx.logger?.('dsh-model-router')
  const lastChoice = new Map()

  ctx.on('agent/inbox/claimed', (payload) => {
    const turn = payload?.turn ?? 0
    if (turn !== 1 && !merged.perTurn) return
    const sessionId =
      payload?.agent?.session?.id ??
      payload?.agent?.session?.header?.id ??
      payload?.agent?.sessionId
    if (!sessionId) return

    const { text, attachments } = textOf(payload?.message)
    const choice = pickModel(text, { ...merged, attachments })

    const snapshot = readSnapshot()
    const stale = !snapshot || snapshot.ageMs > (merged.snapshotStaleMinutes ?? 60) * 60_000
    if (stale) refreshSnapshotInBackground(logger)
    const snap = snapshot?.data
    const fiveHour = (snap?.planPeriods ?? []).find((p) => p.label === '5h')
    // 快照过期时按「套餐可用」处理：误判的代价是 429（免费），
    // 反过来误判会直接切到按量计费的 DeepSeek 账号。
    const planOk = stale || !fiveHour ? true : fiveHour.percent < (merged.planCeilingPercent ?? 95)
    const credits = snap?.workbuddyCredits
    const creditsOk = typeof credits === 'number' ? credits >= (merged.workbuddyMinCredits ?? 50) : true
    const canUseWorkbuddy = turn <= (merged.workbuddyMaxTurn ?? 5)

    // 套餐额度不够：WorkBuddy → DeepSeek 账号 → 不动
    if (choice.provider === PROVIDER && !planOk) {
      if (canUseWorkbuddy && creditsOk) {
        logger?.warn?.(`套餐 5h 已用 ${fiveHour?.percent ?? '?'}%，降级到 WorkBuddy`)
        choice.provider = merged.workbuddyFallback.provider
        choice.model = merged.workbuddyFallback.model
        choice.rule = `${choice.rule}-plan-full→workbuddy`
      } else if (merged.deepseekFallback?.provider) {
        logger?.warn?.('套餐满、WorkBuddy 不可用，最后走 DeepSeek 账号（按 token 计费）')
        choice.provider = merged.deepseekFallback.provider
        choice.model = merged.deepseekFallback.model
        choice.rule = `${choice.rule}-plan-full→deepseek`
      } else {
        logger?.warn?.('所有额度都不可用，保持当前模型不动')
        return
      }
    }

    // WorkBuddy 目标：长会话一律绕开（hy3 上下文很小，会把长会话撑爆）
    if (choice.provider === 'workbuddy' && !canUseWorkbuddy) {
      choice.provider = PROVIDER
      choice.model = merged.default.model
      choice.rule = `${choice.rule}-long-session→plan`
    }

    logger?.info?.(`选模型：session=${sessionId} turn=${turn} rule=${choice.rule} → ${choice.provider}/${choice.model}`)

    // 目标模型没变就不写
    if (lastChoice.get(sessionId) === `${choice.provider}/${choice.model}`) return
    lastChoice.set(sessionId, `${choice.provider}/${choice.model}`)

    Promise.resolve()
      .then(() => ctx.sessionController.selectModel({ sessionId, provider: choice.provider, model: choice.model }))
      .catch((error) => logger?.warn?.(`选模型失败：${error?.message ?? error}`))
  })

  // 套餐端点抖动（InvalidSubscription / 5xx）时：切到 DeepSeek 账号并重试同一轮。
  // 每个会话每轮只兜底一次，避免死循环把重试次数烧光。
  const degradedTurn = new Map()

  ctx.on('agent/request-error', async (payload, next) => {
    try {
      if (!merged.fallbackOnError) return next()
      const provider = payload?.provider
      if (provider !== PROVIDER) return next()
      const sessionId = payload?.agent?.id
      const turn = payload?.turn ?? 0
      if (!sessionId || degradedTurn.get(sessionId) === turn) return next()

      const failure = payload?.failure ?? {}
      const text = `${failure.code ?? ''} ${failure.message ?? ''}`
      const pattern = new RegExp(merged.fallbackErrorPattern ?? DEFAULTS.fallbackErrorPattern, 'i')
      if (!pattern.test(text)) return next()

      degradedTurn.set(sessionId, turn)
      const target = merged.deepseekFallback
      await ctx.sessionController.selectModel({ sessionId, provider: target.provider, model: target.model })
      logger?.warn?.(`套餐请求失败（${failure.code ?? failure.status ?? '?'}），已切到 ${target.provider}/${target.model} 并重试`)
      return { kind: 'retry' }
    } catch (error) {
      logger?.warn?.(`兜底切换失败：${error?.message ?? error}`)
      return next()
    }
  })
}
