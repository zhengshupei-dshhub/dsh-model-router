# dsh-model-router

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**开局选模型**插件：读你发的这条消息，按关键词判断任务类型，把当前会话切到最合适的模型。

不产生任何额外模型调用——纯本地关键词匹配，零延迟、零成本。

## 它做什么

```
你的消息 ──关键词匹配──> 任务类型 ──> sessionController.selectModel(...)
                                        └─> 该会话切模型，界面标签同步变
```

- 默认**每轮都判断**，但目标模型没变就不写，不打扰你手动选择；
- 带图片/附件 → 视觉模型；超长文本（默认 2 万字以上）→ 长上下文模型；
- 套餐额度接近上限时按「WorkBuddy → 兜底 provider → 不动」降级；
- 套餐请求报错（订阅抖动 / 5xx / 429）时，自动切到兜底 provider 并重试同一轮。

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

### Agent Plan（默认，本仓库作者的环境）

用 `arkcli helper` 接好后，provider 叫 `arkcli-agent-plan`，默认配置直接可用：

```yaml
- id: model-router
  config:
    provider: arkcli-agent-plan
```

### Coding Plan / 其他火山套餐

模型名基本一致，只改 provider：

```yaml
- id: model-router
  config:
    provider: arkcli-coding-plan   # 换成你实际注册的 provider id
```

### 其他厂商（OpenAI / Anthropic / 自建端点）

把模型名换成你那边的 id 即可，provider 用 DSH 里注册的那个：

```yaml
- id: model-router
  config:
    provider: my-openai
    models:
      default: gpt-5.6
      reasoning: o5
      code: gpt-5.6-codex
      codeSmall: gpt-5.6-mini
      review: gpt-5.6
      longDoc: gpt-5.6
      vision: gpt-5.6-vision
      writing: gpt-5.6
      light: gpt-5.6-mini
    fallback: null            # 不需要兜底就设成 null
    workbuddyFallback: null   # 没装 WorkBuddy 插件也设成 null
```

### 完整可配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `provider` | `arkcli-agent-plan` | 主 provider id |
| `autoDetectProvider` | `true` | 配置的 provider 不存在时，自动找能提供同名模型的 provider |
| `perTurn` | `true` | 每轮都判断（false = 只在会话第一轮） |
| `models` | 见下 | 任务类型 → 模型 id 映射 |
| `rules` | 中文关键词表 | 关键词 → 任务类型 |
| `longTextChars` | `20000` | 超过这个字符数走 `longDoc` 模型 |
| `planCeilingPercent` | `95` | 套餐 5 小时用量超过它就开始降级 |
| `snapshotStaleMinutes` | `60` | 余量快照超过这么久没更新就按「可用」处理 |
| `fallback` | `deepseek-account/deepseek-flash` | 失败兜底与额度兜底的目标 |
| `fallbackOnError` | `true` | 套餐报错时是否自动兜底重试 |
| `fallbackErrorPattern` | `InvalidSubscription\|InternalServiceError\|5\d\d\|429\|ServiceUnavailable` | 命中才兜底 |
| `workbuddyFallback` | `workbuddy/hy3` | 额度不足时的中间档（积分制） |
| `workbuddyMaxTurn` | `5` | WorkBuddy 只在前几轮用（hy3 上下文小） |
| `workbuddyMinCredits` | `50` | 积分低于此值不再往 WorkBuddy 切 |

### 默认模型映射

| 键 | 默认模型 | 触发场景 |
|---|---|---|
| `default` | `doubao-seed-2.1-pro` | 兜底 |
| `reasoning` | `deepseek-v4-pro` | 数学/算法/证明 |
| `code` | `kimi-k3.1-pro` | 重构/调试/跨文件 |
| `codeSmall` | `deepseek-v4.1-flash` | 单文件小改/补测试 |
| `review` | `kimi-k3.1-pro` | 审查/排查/审计 |
| `longDoc` | `kimi-k3.1-pro` | 长文档/论文/代码库 |
| `vision` | `kimi-k3.1-pro` | 截图/图片/视频 |
| `writing` | `glm-5.3` | 文案/剧本/润色 |
| `light` | `deepseek-v4.1-flash-economy` | 格式转换/提取/分类 |

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
