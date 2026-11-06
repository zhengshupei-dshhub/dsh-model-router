# Changelog

## 2.3.1 · 2026-11-06

### Fixed

- **带图片的消息「没切模型」**：自动识别视觉模型时取「目录里第一个多模态模型」，而 `deepseek-account/deepseek-flash` 自身也声明了 `["text","image"]`，于是被选中——它恰好就是当时正在用的模型，看起来像没切换。改为**强档优先**：显式 vision 命名 > pro/max/ultra > 非 flash/mini/lite > 第一个多模态。现在图片消息会切到 `arkcli-agent-plan/doubao-seed-2.1-pro` 这类真正的视觉模型。


