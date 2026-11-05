/**
 * 开局选模型：新会话的第一条用户消息里判断任务类型，
 * 然后用 sessionController.selectModel 把这个会话的模型切到白名单里最合适的一个。
 *
 * 设计取舍：
 * - 只在「每个会话的第一条消息」做一次，之后不干预（避免打断用户手动选择）；
 * - 纯关键词匹配，不发额外的分类请求（零成本、零延迟）；
 * - 任何一步失败都只写日志，不影响正常对话。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const inject = ['sessionController']

function readSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'quota-snapshot.json'), 'utf8'))
  } catch {
    return undefined
  }
}

const DEFAULTS = {
  enabled: true,
  // 是否每一轮用户消息都重新选模型（默认只在会话第一轮选一次）
  perTurn: false,
  // 免费包用尽后的降级顺序：先用套餐（订阅额度），再退 WorkBuddy（积分），都没有就不切
  planFallback: { provider: 'ark-agent-plan', model: 'deepseek-v4-flash-260801' },
  workbuddyFallback: { provider: 'workbuddy', model: 'hy3' },
  // 小上下文模型（WorkBuddy hy3）只允许在前几轮用；长会话一律绕开
  workbuddyMaxTurn: 5,
  // 套餐 5 小时窗口用到这个百分比就算「不可用」
  planCeilingPercent: 95,
  // WorkBuddy 积分低于这个值就不再往那切
  workbuddyMinCredits: 50,
  // 最后一档：按 token 计费的 DeepSeek 账号
  deepseekFallback: { provider: 'deepseek-account', model: 'deepseek-flash' },
  // 平台端点被拦（欠费/未开通）时，免费包模型对应的套餐替代
  packToPlan: {
    'kimi-k3-1-pro-261024': 'kimi-k3-260701',
    'deepseek-v4-pro-ga-260813': 'deepseek-v4-flash-260801',
    'deepseek-v4-flash-ga-260731': 'deepseek-v4-flash-260801',
    'deepseek-v4-1-flash-261017': 'deepseek-v4-flash-260801',
    'deepseek-v4-1-flash-economy-261017': 'deepseek-v4-flash-260801',
    'glm-5-2-260617': 'glm-5-3-260801',
    'glm-5-3-flash-260828': 'glm-5-3-flash-260901',
    'doubao-seed-2-1-pro-260915': 'doubao-seed-evolving-latest-version',
    'doubao-seed-2-1-lite-260915': 'doubao-seed-evolving-latest-version',
  },
  // 兜底：1M 上下文里最便宜的 deepseek-v4-flash（系数 0.5）
  default: { provider: 'workbuddy', model: 'hy3' },
  longTextChars: 20000,
  rules: [
    // 1) 硬推理：数学 / 算法 / 证明 / 复杂逻辑
    {
      id: 'reasoning',
      match: ['数学', '算法', '证明', '证一下', '推导', '不等式', '逻辑证明', '复杂度', '最优解', '递推', '方程', '归纳法'],
      provider: 'ark-free-pack',
      model: 'deepseek-v4-pro-ga-260813',
    },
    // 2) 单文件小改 / 补测试 / 样板代码
    {
      id: 'code-small',
      match: ['单文件', '小改', '补测试', '改个 bug', '修一个小 bug', '补个函数', '写个脚本', '样板', '改一下'],
      provider: 'ark-free-pack',
      model: 'deepseek-v4-flash-ga-260731',
    },
    // 3) 跨文件重构、架构设计、疑难 bug
    {
      id: 'code',
      match: ['重构', '架构', '疑难', '调试', '报错', '多文件', '跨文件', '整个项目', '依赖冲突', '设计模式'],
      provider: 'ark-free-pack',
      model: 'kimi-k3-1-pro-261024',
    },
    // 4) 代码审查 / 独立调查
    {
      id: 'review',
      match: ['审查', 'review', '排查', '调查', '审计', '评审', '检查一下'],
      provider: 'ark-free-pack',
      model: 'kimi-k3-1-pro-261024',
    },
    // 5) 长文档 / 论文 / 大代码库通读
    {
      id: 'long-doc',
      match: ['长文档', '通读', '整篇', '论文', 'pdf', '翻译整篇', '代码库', '大文件', '整本书', '全文'],
      provider: 'ark-free-pack',
      model: 'kimi-k3-1-pro-261024',
    },
    // 6) 看图 / 截图 / 视频理解
    {
      id: 'vision',
      match: ['截图', '看图', '图片', '照片', '这张图', '视频里', '识别一下', 'ocr', '这张'],
      provider: 'ark-free-pack',
      model: 'kimi-k3-1-pro-261024',
    },
    // 7) 中文文案 / 剧本 / 创意写作 —— GLM（订阅制，不另计费）
    {
      id: 'writing',
      match: ['文案', '剧本', '故事', '润色', '写一篇', '创作', '标题党', '小红书', '公众号', '口播'],
      provider: 'ark-free-pack',
      model: 'glm-5-2-260617',
    },
    // 8) 格式转换 / 抽取 / 分类 / 批量改写 —— 优先 WorkBuddy 免费模型（0 积分）
    {
      id: 'light',
      match: ['格式转换', '提取', '分类', '重命名', '列一下', '改写标题', '批量', '转成', 'json', 'csv', '表格'],
      provider: 'workbuddy',
      model: 'hy3',
    },
  ],
}


/** 读 quota-guard 落下的余量快照，返回某模型剩余百分比；读不到返回 undefined。 */
export function packCoverage(model, snapshot) {
  const packs = snapshot?.packs
  if (!Array.isArray(packs)) return undefined
  const hit = packs.find((p) => p.model === model || model.startsWith(p.model) || p.model.startsWith(model))
  return hit?.percent
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

  // 前置判断一：超长文本优先 1M 上下文的模型，避免中途被截断。
  if (source.length > longTextChars) {
    return {
      provider: merged.longDoc?.provider ?? 'ark-agent-plan',
      model: merged.longDoc?.model ?? 'kimi-k3-1-pro-261001',
      rule: 'long-text',
    }
  }
  // 前置判断二：带图片/文件时用视觉模型（默认模型本身支持图，这里显式点出来）。
  if (attachments > 0) {
    return {
      provider: merged.vision?.provider ?? 'ark-agent-plan',
      model: merged.vision?.model ?? 'kimi-k3-1-pro-261001',
      rule: 'attachment',
    }
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

  // 每个会话只路由一次；进程重启后重新计。
  const routed = new Set()
  const logger = ctx.logger?.('dsh-model-router')

  // 2026-11-05 修正：原来监听 session/event，把「插件加载后的第一条消息」当成
  // 「新会话的第一条消息」，结果把一条几十万 token 的老会话切到了 256k 上下文
  // 的模型上，直接 400（image+text exceed max message tokens）。
  // 现在只认 agent/inbox/claimed 且 turn === 1 —— 真正的会话第一轮。
  // 每个会话上一次选中的模型，用于「目标没变就不写」的节流。
  const lastChoice = new Map()

  ctx.on('agent/inbox/claimed', (payload) => {
    const turn = payload?.turn ?? 0
    // 默认只认第一轮；打开 perTurn 后每一轮都判断。
    if (turn !== 1 && !merged.perTurn) return
    const sessionId =
      payload?.agent?.session?.id ??
      payload?.agent?.session?.header?.id ??
      payload?.agent?.sessionId
    if (!sessionId) return
    // 首轮模式：每个会话只路由一次；perTurn 模式：只要目标模型没变就不重复写。
    if (!merged.perTurn && routed.has(sessionId)) return
    routed.add(sessionId)
    const event = { data: payload?.message }

    const { text, attachments } = textOf(event.data ?? payload?.message)
    const choice = pickModel(text, { ...merged, attachments })
    // 平台端点被拦（欠费/未开通）时，包里模型一律改走套餐等价物。
    if (choice.provider === 'ark-free-pack' && readSnapshot()?.packBlocked) {
      const alt = merged.packToPlan?.[choice.model]
      if (alt) {
        logger?.warn?.(`平台端点被拦，${choice.model} → 套餐 ${alt}`)
        choice.provider = 'ark-agent-plan'
        choice.model = alt
        choice.rule = `${choice.rule}-pack-blocked→plan`
      }
    }

    // WorkBuddy（hy3 上下文很小）只在短会话用，长会话改走 1M 的包模型。
    if (choice.provider === 'workbuddy' && (payload?.turn ?? 0) > (merged.workbuddyMaxTurn ?? 5)) {
      choice.provider = 'ark-free-pack'
      choice.model = 'deepseek-v4-flash-ga-260731'
      choice.rule = `${choice.rule}-long-session`
    }

    // 免费包余量不足时按 WorkBuddy → 套餐 → DeepSeek 账号 → 不切 的顺序降级。
    if (choice.provider === 'ark-free-pack') {
      const coverage = packCoverage(choice.model, readSnapshot())
      if (coverage !== undefined && coverage <= 0) {
        const snap = readSnapshot()
        const fiveHour = (snap?.planPeriods ?? []).find((p) => p.label === '5h')
        const planOk = fiveHour ? fiveHour.percent < (merged.planCeilingPercent ?? 95) : true
        const credits = snap?.workbuddyCredits
        const creditsOk = typeof credits === 'number' ? credits >= (merged.workbuddyMinCredits ?? 50) : true
        const canUseWorkbuddy = (payload?.turn ?? 0) <= (merged.workbuddyMaxTurn ?? 5)
        if (canUseWorkbuddy && creditsOk) {
          logger?.warn?.(`免费包 ${choice.model} 无余量，降级到 WorkBuddy ${merged.workbuddyFallback.model}`)
          choice.provider = merged.workbuddyFallback.provider
          choice.model = merged.workbuddyFallback.model
          choice.rule = `${choice.rule}-pack-empty→workbuddy`
        } else if (planOk) {
          logger?.warn?.(`免费包 ${choice.model} 无余量，降级到套餐 ${merged.planFallback.model}`)
          choice.provider = merged.planFallback.provider
          choice.model = merged.planFallback.model
          choice.rule = `${choice.rule}-pack-empty→plan`
        } else if (merged.deepseekFallback?.provider) {
          logger?.warn?.('包与套餐都不可用，最后才走 DeepSeek 账号（按 token 计费）')
          choice.provider = merged.deepseekFallback.provider
          choice.model = merged.deepseekFallback.model
          choice.rule = `${choice.rule}-pack-empty→deepseek`
        } else {
          logger?.warn?.('免费包无余量、套餐与 WorkBuddy 都不可用，保持当前模型不动')
          return
        }
      }
    }
    logger?.info?.(`开局选模型：session=${sessionId} rule=${choice.rule} → ${choice.provider}/${choice.model}`)

    // 目标模型没变就不打扰（尤其 perTurn 模式下，省掉重复写入）。
    if (lastChoice.get(sessionId) === choice.model) return
    lastChoice.set(sessionId, choice.model)

    Promise.resolve()
      .then(() =>
        ctx.sessionController.selectModel({
          sessionId,
          provider: choice.provider,
          model: choice.model,
        }),
      )
      .catch((error) => {
        // 选模型失败不影响对话本身。
        logger?.warn?.(`开局选模型失败：${error?.message ?? error}`)
      })
  })
}
