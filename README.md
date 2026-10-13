# MemoryCast

MemoryCast 是一个 **AI + FSRS + 听力复习** 的个人学习系统。

它把笔记变成可复习的知识卡片，再通过 **随身听、AI 测试、费曼模式、间隔重复** 帮你持续巩固。

```text
笔记 / 图片 / PDF / 语音
          ↓
        AI 整理
          ↓
       知识卡片
          ↓
  听力复习 + FSRS
          ↓
 AI 测试 / 费曼强化
```

## 核心功能

- **AI 整理笔记**：文字、图片、PDF、语音都可转成知识卡片
- **原始笔记保留**：支持搜索、编辑、删除、朗读，并与卡片关联
- **FSRS 间隔重复**：根据记忆状态自动安排复习时间
- **随身听模式**：连续播放高优先级知识点，支持歌词式字幕和倍速
- **单知识点循环 10 遍**：随身听中可直接开启 `↻ ×10`
- **AI 自适应测试**：选择题、填空题、简答题、听力题
- **费曼模式**：用自己的话讲知识点，AI 找出理解漏洞并继续追问
- **Apple Watch 支持**：网页端可直接进行随身听和选择题测试
- **多 AI Provider**：支持 Gemini、OpenRouter、Cloudflare Workers AI、OpenAI-compatible API
- **自然 TTS**：支持 Azure Speech，浏览器 TTS 可作为回退

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

## 费曼模式

用户先讲，AI 再分析。

重点不是直接给答案，而是：

- 判断是否真的理解
- 找出关键缺口
- 生成下一步追问
- 对多轮解释持续跟进

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
