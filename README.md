# MemoryCast

MemoryCast 是一个 **AI + FSRS + 听力复习** 的个人学习系统。

AI 测试、Web 随身听和 watchOS 随身听都可以点击 **「⏳ 7天不出现」**：暂停自动抽取当前卡片，并跳过正在排队的同卡片自适应题；知识库可提前 **「恢复复习」**。暂停仅保存 `hidden_until`，不会清除 FSRS 复习记录或重写原计划，7 天后自动恢复。

它把笔记变成可复习的知识卡片，再通过 **随身听、AI 测试、记忆游戏、间隔重复** 帮你持续巩固。

```text
笔记 / 图片 / PDF / 语音
          ↓
        AI 整理
          ↓
       知识卡片
          ↓
  听力复习 + FSRS
          ↓
 AI 测试 / 游戏巩固
```

## 核心功能

- **AI 整理笔记**：文字、图片、PDF、语音都可转成知识卡片
- **原始笔记保留**：支持搜索、编辑、删除、朗读，并与卡片关联
- **FSRS 间隔重复**：根据记忆状态自动安排复习时间
- **随身听模式**：连续播放高优先级知识点，支持歌词式字幕和倍速
- **单知识点循环 10 遍**：随身听中可直接开启 `↻ ×10`
- **AI 自适应测试**：选择题、填空题、简答题、听力题
- **Apple Watch 支持**：网页端可直接进行随身听和选择题测试
- **多 AI Provider**：支持 Gemini、OpenRouter、Cloudflare Workers AI、OpenAI-compatible API
- **自然 TTS**：支持 Azure Speech，浏览器 TTS 可作为回退

## 记忆挑战场（Memory Arcade 2.0）

首页或侧栏点击 **🎮 记忆游戏**。挑战直接读取知识库，不需要额外的 AI API。

| 挑战 | 实际练习方式 | 游戏机制 |
| --- | --- | --- |
| ⚡ 闪电生存战 | 选择题混合英文主动拼写 | 全局 60 秒、每题限时、3 颗心、连续正确积分倍率 |
| 🛡️ 错题 Boss 战 | 先写出自己的理解，再翻开正确答案自评 | 薄弱项优先、按掌握的卡片逐层击破护盾、错误项延后复练、无强制倒计时 |
| 🎧 音速追击 | 只听发音，从四个选项中辨认含义 | 播放后开始 18 秒/题的计时、3 颗心、数字键 1–4 作答 |
| ⌨️ 极限拼写 | 看释义，在 17 秒内输入英文单词或词组 | 3 颗心、首字母提示会降低积分、错题再练一次 |

挑战结束展示积分、最长连击、未掌握知识点清单；错误卡片下一局优先出场，近期正确的卡片会暂时降低出现频率。手动设置「⏳ 7 天不出现」仍然生效。

**为什么这样设计**：快速识别带来即时反馈，但主动拼写和 Boss 战的先写后核对更接近真正的主动提取（active recall）。积分和闯关只作反馈；即使积分很高，也不表示 FSRS 的长期记忆评估已经完成。

游戏练习历史存储在 `game_attempts`，**不修改原本的 FSRS 到期时间**。网页与手机浏览器可使用；原生 Apple Watch 暂不包含游戏。

## 随身听模式

随身听优先播放更容易遗忘的内容，例如：

1. 最近答错 / Again
2. 最近 Hard / 部分正确
3. 已到期卡片
4. 其他学习中的卡片

支持：

- 连续播放
- 倍速
- 歌词式滚动字幕
- 中英文混合朗读
- 当前知识点循环播放 10 遍
- Apple Watch Web Audio 播放

随身听本身不会直接修改 FSRS，正式复习和测试结果才会更新记忆状态。

## AI 测试

支持：

- 选择题
- 填空题
- 简答题
- 听力题
- 自适应变式题
- 置信度记录

测试结果会回写 FSRS。

Apple Watch 会自动使用 **四选一选择题模式**。

## 技术栈

**Frontend**

- HTML / CSS / Vanilla JavaScript
- Web Audio API
- Web Speech API
- MediaRecorder
- Service Worker

**Backend**

- Node.js
- Express
- PostgreSQL
- ts-fsrs
- Azure Speech
- OpenAI-compatible API

**Deployment**

- Docker
- Docker Compose
- Nginx
- HTTPS / Certbot

## 架构

```text
iPhone / Browser / Apple Watch
             │
             ▼
        Nginx Gateway
             │
             ▼
         Node.js API
       ┌─────┼─────┐
       ▼     ▼     ▼
 PostgreSQL  AI    TTS
```

## 快速部署

```bash
git clone https://github.com/goudanhh/memorycast.git
cd memorycast

cp .env.example .env
nano .env

docker compose up -d --build
```

至少配置数据库：

```env
POSTGRES_DB=memorycast
POSTGRES_USER=memorycast
POSTGRES_PASSWORD=CHANGE_ME
```

## AI 配置示例

### Gemini

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash-lite
```

### OpenRouter

```env
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=
OPENROUTER_MODEL=openrouter/free
```

### Azure TTS

```env
TTS_PROVIDER=azure
AZURE_SPEECH_KEY=
AZURE_SPEECH_REGION=
```

完整配置请参考：

```text
.env.example
```

## 更新

```bash
cd /home/goudan/memorycast/memorycast
git pull origin main
docker compose up -d --build
```

## 数据安全

普通停止不会删除数据：

```bash
docker compose down
```

不要随意执行：

```bash
docker compose down -v
```

`-v` 会删除 Volume，可能导致数据库数据丢失。

## 当前定位

MemoryCast 目前是一个 **个人自托管、单用户学习系统**。

重点不是做一个通用笔记软件，而是把：

> **输入 → 听 → 测 → 复习 → 再巩固**

做成一条完整学习链路。

## License

当前仓库尚未声明开源许可证。
