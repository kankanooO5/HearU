# HearU 项目状态

HearU 当前使用 Cloudflare Workers + Static Assets，并通过 Cloudflare Vite Plugin 统一构建和部署。

Cloudflare Worker 名称：hearu

线上地址：
https://hearu.yufangying03.workers.dev

## 实时语音识别

浏览器使用 getUserMedia 获取单声道麦克风音频。

AudioWorklet 负责采集 Float32 音频帧。主线程将音频连续重采样至 16 kHz、编码为 PCM16，并以约 100 ms 一帧通过 AssemblyAI Streaming v3 WebSocket 发送。

AssemblyAI partial Turn 作为完整识别快照进入 CaptionEngine.partial()。

final Turn 进入 complete() 并锁定字幕。

意大利语使用 universal-streaming-multilingual。
中文输入使用 whisper-rt。

停止会话时发送 Terminate，等待最后结果后再关闭 WebSocket。

## 翻译

稳定原文通过 TranslationQueue 发送到 /api/translate。

Cloudflare Worker 使用 DeepSeek Chat Completions 和 deepseek-flash 完成翻译，并以 JSON 对象返回与输入一一对应的译文数组。

意大利语输入译为中文。
中文输入译为意大利语。

## Worker API

当前 Worker 提供：
- /api/status
- /api/transcription-token
- /api/translate

当前环境密钥：
- ASSEMBLYAI_API_KEY
- DEEPSEEK_API_KEY

浏览器只获取 AssemblyAI 短时 Streaming token，不获取长期 API 密钥。

## 存储与恢复

MediaRecorder 独立保存约 30 秒一片的原始录音。

IndexedDB 保存课程、字幕和录音数据。

实时 WebSocket 断线后使用指数退避重新获取 token 并连接。

断线期间没有成功发送的音频不会补传，本地录音不受影响。

## 当前验证状态

自动测试共 9 项，覆盖：
- CaptionEngine partial snapshot 与 final locking
- TranslationQueue
- AudioWorklet / PCM16 / AssemblyAI WebSocket
- AssemblyAI Turn 事件
- AssemblyAI 临时 token Worker
- DeepSeek 翻译 Worker
- API 配置与同源保护

以下命令均已通过：
node --test tests/*.test.mjs
npm run build

Cloudflare 已成功部署当前版本。

AssemblyAI 临时 token 接口已在线验证。
DeepSeek 翻译接口已在线验证。

Mac Safari 已完成真实端到端验证，麦克风、实时字幕和中文翻译均正常工作。

## 下一阶段

仍需重点验证：
- iPhone Safari / 主屏幕 PWA
- 60–120 分钟课堂连续运行
- Wi-Fi / 蜂窝网络切换
- 网络抖动后的字幕连续性
- 真实课堂噪声条件下的识别延迟
- AssemblyAI turn detection 与实际课堂断句体验
