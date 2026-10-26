# MemoryCast

MemoryCast 是一个 **AI + FSRS + 听力复习** 的个人学习系统。

AI 测试、Web 随身听和 watchOS 随身听都可以点击 **「⏳ 7天不出现」**：暂停自动抽取当前卡片，并跳过正在排队的同卡片自适应题；知识库可提前 **「恢复复习」**。暂停仅保存 `hidden_until`，不会清除 FSRS 复习记录或重写原计划，7 天后自动恢复。

它把笔记变成可复习的知识卡片，再通过 **随身听、AI 测试、间隔重复** 帮你持续巩固。

```text
笔记 / 图片 / PDF / 语音
          ↓
        AI 整理
          ↓
       知识卡片
          ↓
  听力复习 + FSRS
          ↓
 AI 测试 / FSRS 巩固
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

## ⚡ 听力闪击（Listening Blitz）

主导航「⚡ 听力闪击」是独立的碎片化听力训练，**不替代现有 AI 听力考试、FSRS、随身听及 Watch 端功能**。

- **单击开练**：20 秒（1 题）、45 秒（2 题，默认）、90 秒（3 题）；时长是大致目标，不强制截止交卷。
- **先声音后字幕**：必须先播放英语才能交卷。答题页完全不显示原文或正确答案，交卷后才给出逐题解析、原文依据与完整英文稿。
- **真实评分**：服务器保存每次答案、播放次数、是否第一次播放就交卷。首听理解率与重听辅助后的总体正确率分开显示；20/45/90 秒只是推荐学习窗口。
- **自动难度和错题强化**：根据近期题目得分推选 A2/B1/B2 内容，尽量优先安排表现最弱的能力，选用新的英语情景与提问方式。
- **AI 素材与应急回退**：优先即刻返回经过检查的原创短段落；练习进行时如已配置 AI，预生成后续原创语音脚本与客观选择/填空题。AI 不可用仍可使用内置素材。
- **语音**：复用已配置的 Azure Neural TTS；未配置或临时失败时可回退浏览器英文语音。没有虚构的真实人物录音，TTS 不完全等同于真实口音语料。
- **结果页复听**：优先播放本组已生成的音频，支持暂停/继续；音频服务不可用时提示再次点击，改用 iPhone/Safari 系统英文语音。状态及故障原因会显示在按钮下方，结果页复听不会增加答题阶段的播放次数或修改成绩。
- **学习统计**：独立数据表 \`blitz_sessions\`，含逐题得失分、弱项、7/30/90 天技能趋势；**不会改动** FSRS 排期或原听力考试成绩。不能据此直接估计 TOEFL/IELTS 官方成绩。

\`\`\`bash
node scripts/check-blitz.mjs
\`\`\`

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
