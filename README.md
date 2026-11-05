# dsh-model-router

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**开局选模型**插件：读你发的这条消息，按关键词判断任务类型，把当前会话切到最合适的模型。

不产生任何额外模型调用——纯本地关键词匹配，零延迟、零成本。

## 它做什么

```
插件启动 ──扫描运行时所有 provider 与模型──> 按名字/模态识别能力（vision/code/pro…）
你的消息 ──关键词匹配──> 任务类型 ──> sessionController.selectModel(...)
                                        └─> 该会话切模型，界面标签同步变
```

**零配置即可用**：不管你接的是火山 Agent Plan、Coding Plan，还是 OpenAI、Anthropic、自建
OpenAI 兼容端点，插件启动时会自动列出全部 provider 的模型，按 id/名字和上报的输入模态
判断每个模型适合干什么（带 image 模态或名字带 vision/vl → 看图；带 mini/lite/flash →
轻量；带 code/codex → 写代码；带 pro/max/ultra → 复杂任务），并据此建立映射。

- 默认每轮都判断，但目标模型没变就不写，不打扰你的手动选择；
- 带图片/附件 → 视觉模型；超长文本（默认 2 万字以上）→ 长上下文模型；
- 额度接近上限时按配置的降级链处理（默认只有“保持不动”，需要才加）；
- 主 provider 请求报错（订阅抖动 / 5xx / 429）时，配了 fallback 才兜底重试。

## 安装

```bash
# 方式一：插件管理器里填仓库地址
git+https://github.com/zhengshupei-dshhub/dsh-model-router.git

# 方式二：本地克隆后装
git clone https://github.com/zhengshupei-dshhub/dsh-model-router.git
# 然后在 DSH 的插件页安装本地目录
```

装完后在 `cordis.patch.yml`（或插件配置面板）里按你的套餐改配置，重启生效。

## 配置

### 默认：什么都不写

装好插件、重启即可。自动识别的结果会写在日志里（`已识别 N 个模型：default=…, code=…`）。

### 固定到某个 provider

```yaml
- id: model-router
  config:
    provider: arkcli-coding-plan   # 不自动探测，只用这个 provider
```

### 精确指定模型（其他厂商 / 自建端点）

```yaml
- id: model-router
  config:
    models:
      default: { provider: my-openai, model: gpt-5.6 }
      reasoning: { provider: my-openai, model: o5 }
      code: { provider: my-openai, model: gpt-5.6-codex }
      codeSmall: { provider: my-openai, model: gpt-5.6-mini }
      review: { provider: my-openai, model: gpt-5.6 }
      longDoc: { provider: my-openai, model: gpt-5.6 }
      vision: { provider: my-openai, model: gpt-5.6-vision }
      writing: { provider: my-openai, model: gpt-5.6 }
      light: { provider: my-openai, model: gpt-5.6-mini }
```

显式配置只覆盖对应键，其余仍自动识别。

### 需要按量兜底 / WorkBuddy 降级时

默认两项都关闭（`fallback: null`、`workbuddyFallback: null`），需要才配：

```yaml
- id: model-router
  config:
    fallback: { provider: my-paid-provider, model: my-model }
    fallbackOnError: true
    workbuddyFallback: { provider: workbuddy, model: hy3 }
```

### 完整可配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `provider` | `auto` | `auto` 自动探测；写死 provider id 则只用它 |
| `models` | `{}` | 显式「键 → { provider, model }」，覆盖自动识别 |
| `autoDetectProvider` | `true` | 是否扫描运行时模型目录 |
| `perTurn` | `true` | 每轮都判断（false = 只在会话第一轮） |
| `rules` | 中文关键词表 | 关键词 → 任务类型 |
| `longTextChars` | `20000` | 超过这个字符数走 `longDoc` |
| `planCeilingPercent` | `95` | 快照里 5h 用量超过它才开始降级 |
| `snapshotStaleMinutes` | `60` | 余量快照超过这么久没更新就按「可用」处理 |
| `fallback` | `null` | 失败/额度兜底的目标；不想要就保持 null |
| `fallbackOnError` | `true` | 请求报错时是否自动兜底重试（fallback 非 null 才生效） |
| `fallbackErrorPattern` | `InvalidSubscription\|InternalServiceError\|5\d\d\|429\|ServiceUnavailable` | 命中才兜底 |
| `workbuddyFallback` | `null` | 额度不足时的积分降级档 |
| `workbuddyMaxTurn` | `5` | 积分档只在前几轮用（小上下文模型） |
| `workbuddyMinCredits` | `50` | 积分低于此值不再往那切 |

### 能力键与识别提示

自动识别时，每个键按如下顺序找：名字命中提示词 → 上级键兜底 → default：

| 键 | 名字提示（节选） |
|---|---|
| `vision` | 模型上报 image 模态；或名字含 `vision` / `-vl` / `vlm` |
| `light` / `codeSmall` | `mini` / `lite` / `flash` / `nano` |
| `code` / `review` | `code` / `codex` / `pro` |
| `longDoc` | `pro` / `max` / `ultra` |
| `reasoning` | `o1` / `o3` / `r1` / `reason` / `pro` |
| `writing` | `glm` / `gpt` / `claude` / `gemini` / `pro` |
| `default` | `pro` / `max` / 目录第一个 |

## 关键词规则

规则按顺序匹配，**先命中先用**，所以「具体规则」要排在「通用规则」前面（例如 `codeSmall` 在 `code` 之前）。完整列表见 `index.js` 的 `DEFAULTS.rules`，可以直接在配置里覆盖它。

## 依赖

- **必需**：DSH 的 `sessionController` 服务（内置）。
- **可选**：`llm` 服务（用于自动探测 provider）、WorkBuddy 插件（积分降级档）、额度快照
  `~/.dsh/quota-snapshot.json`（没有就按「额度充足」处理，不做降级）。

## 已知边界

- 关键词匹配是启发式，做不到语义理解；
- 会话中途换模型会影响连贯性，所以默认只在**任务类型变化**时才切；
- 兜底会带来真实计费（`fallback` 指向按 token 计费的 provider 时），不需要就设 `fallbackOnError: false` 或 `fallback: null`。

## License

MIT
