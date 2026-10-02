# 听见 · 实时双语课堂字幕

Mac 课堂在线同传 PWA。主要用于意大利语课堂：原文通过流式语音识别实时更新，中文翻译在语音段落稳定后异步跟随。iPhone 提供 Conversation 入口。

## 运行

安装依赖：npm ci
生产构建：npm run build
部署：npm run deploy

生产构建由 Cloudflare Vite Plugin 统一生成前端静态资源与 Worker。正式 API 密钥只保存在 Cloudflare Worker 环境中，浏览器不会接触长期密钥。

当前线上地址：
https://hearu.yufangying03.workers.dev

## 当前架构

实时语音链路：

麦克风
→ AudioWorklet
→ Float32 音频
→ 16 kHz PCM16
→ AssemblyAI Streaming WebSocket
→ partial / final Turn
→ CaptionEngine

翻译链路：

稳定原文
→ TranslationQueue
→ Cloudflare Worker
→ DeepSeek Chat Completions
→ 中文 / 意大利语译文

Cloudflare Worker 提供三个 API：
- /api/status
- /api/transcription-token
- /api/translate

ASSEMBLYAI_API_KEY 用于签发短时 Streaming token。
DEEPSEEK_API_KEY 用于翻译请求。

## 关键逻辑

- AudioWorklet 只负责采集麦克风 Float32 音频。
- 主线程连续重采样至 16 kHz，并编码为 PCM16，以约 100 ms 的二进制音频帧发送给 AssemblyAI。
- AssemblyAI partial Turn 是当前语音段落的完整识别快照，因此 CaptionEngine 使用 partial() 替换当前活动字幕，而不是把 partial 当作字符增量追加。
- final Turn 到达后字幕才锁定，并进入翻译队列。
- 意大利语实时识别使用 universal-streaming-multilingual。
- 中文输入使用 whisper-rt。
- ASR 与翻译相互独立。翻译失败不会停止麦克风采集和实时识别。
- 网络中断后会重新获取短时 AssemblyAI token 并建立新的 WebSocket。
- 断线期间未成功发送的实时音频不会补传，但本地 MediaRecorder 录音仍独立保存。
- 停止识别时先向 AssemblyAI 发送 Terminate，等待最后识别结果后再关闭连接。
- IndexedDB 持续保存会话、字幕和约 30 秒一片的音频。

## 验证

完整测试：
node --test tests/*.test.mjs

生产构建：
npm run build

当前自动测试共 9 项，覆盖 CaptionEngine、AssemblyAI Streaming 客户端和 Worker API。

当前版本已经完成 Mac Safari 线上端到端验证：

麦克风
→ AssemblyAI 实时字幕
→ DeepSeek 翻译

仍需继续验证 iPhone Safari、60–120 分钟课堂连续运行、网络切换恢复，以及真实课堂环境下的延迟和断句表现。
