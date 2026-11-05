/**
 * 开局选模型：新会话的第一条用户消息里判断任务类型，
 * 然后用 sessionController.selectModel 把这个会话的模型切到白名单里最合适的一个。
 *
 * 设计取舍：
 * - 只在「每个会话的第一条消息」做一次，之后不干预（避免打断用户手动选择）；
 * - 纯关键词匹配，不发额外的分类请求（零成本、零延迟）；
 * - 任何一步失败都只写日志，不影响正常对话。
 */

export const inject = ['sessionController']

const DEFAULTS = {
  enabled: true,
  // 是否每一轮用户消息都重新选模型（默认只在会话第一轮选一次）
  perTurn: false,
  // 兜底：1M 上下文里最便宜的 deepseek-v4-flash（系数 0.5）
  default: { provider: 'ark-agent-plan', model: 'deepseek-v4-flash-260801' },
  longTextChars: 20000,
  rules: [
    // 1) 硬推理：数学 / 算法 / 证明 / 复杂逻辑
    {
      id: 'reasoning',
      match: ['数学', '算法', '证明', '证一下', '推导', '不等式', '逻辑证明', '复杂度', '最优解', '递推', '方程', '归纳法'],
      provider: 'ark-agent-plan',
      model: 'deepseek-v4-pro-ga-260801',
    },
    // 2) 单文件小改 / 补测试 / 样板代码
    {
      id: 'code-small',
      match: ['单文件', '小改', '补测试', '改个 bug', '修一个小 bug', '补个函数', '写个脚本', '样板', '改一下'],
      provider: 'ark-agent-plan',
      model: 'deepseek-v4-flash-260801',
    },
    // 3) 跨文件重构、架构设计、疑难 bug
    {
      id: 'code',
      match: ['重构', '架构', '疑难', '调试', '报错', '多文件', '跨文件', '整个项目', '依赖冲突', '设计模式'],
      provider: 'ark-agent-plan',
      model: 'kimi-k3-1-pro-261001',
    },
    // 4) 代码审查 / 独立调查
    {
      id: 'review',
      match: ['审查', 'review', '排查', '调查', '审计', '评审', '检查一下'],
      provider: 'ark-agent-plan',
      model: 'kimi-k3-1-pro-261001',
    },
    // 5) 长文档 / 论文 / 大代码库通读
    {
      id: 'long-doc',
      match: ['长文档', '通读', '整篇', '论文', 'pdf', '翻译整篇', '代码库', '大文件', '整本书', '全文'],
      provider: 'ark-agent-plan',
      model: 'kimi-k3-1-pro-261001',
    },
    // 6) 看图 / 截图 / 视频理解
    {
      id: 'vision',
      match: ['截图', '看图', '图片', '照片', '这张图', '视频里', '识别一下', 'ocr', '这张'],
      provider: 'ark-agent-plan',
      model: 'kimi-k3-1-pro-261001',
    },
    // 7) 中文文案 / 剧本 / 创意写作 —— GLM（订阅制，不另计费）
    {
      id: 'writing',
      match: ['文案', '剧本', '故事', '润色', '写一篇', '创作', '标题党', '小红书', '公众号', '口播'],
      provider: 'ark-agent-plan',
      model: 'glm-5-3-260801',
    },
    // 8) 格式转换 / 抽取 / 分类 / 批量改写
    {
      id: 'light',
      match: ['格式转换', '提取', '分类', '重命名', '列一下', '改写标题', '批量', '转成', 'json', 'csv', '表格'],
      provider: 'ark-agent-plan',
      model: 'deepseek-v4-flash-260801',
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
