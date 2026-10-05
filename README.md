# MemoryCast

MemoryCast 是一个 **听力优先（audio-first）的 AI 学习与记忆系统**。

它不是传统“翻卡片”应用。MemoryCast 更强调：

> 把学习内容整理好 → 反复听 → 用 FSRS 安排复习 → 用 AI 测试检验掌握情况 → 用费曼模式补薄弱点。

适合英语表达、双语笔记、专业课程、技术概念以及需要长期重复输入的学习内容。

---

## 核心工作流

```text
原始笔记
   ↓
AI 整理
   ↓
知识卡片
   ↓
听力复习 + 循环朗读
   ↓
FSRS 间隔重复
   ↓
AI 自适应测试
   ↓
薄弱点识别
   ↓
费曼模式强化理解
```

MemoryCast 同时保留：

- **完整原始笔记**
- **AI 派生卡片**
- **FSRS 学习状态**
- **测试历史**
- **费曼讲解记录**

---

# 主要功能

## 1. 听力优先复习

“今日复习”不是传统 Anki 式翻卡。

卡片内容可以直接作为视觉辅助，主要交互是朗读：

```text
正面
→ 背面
→ 例句
→ 下一条
```

支持：

- 单次连续朗读
- 循环朗读
- 多条队列自动循环
- 0.9× / 1.0× / 1.2× / 1.5× 速度
- 中文 / 英文混合内容
- 技术词、数字、缩写处理
- 单独字母 / 单词清晰发音

循环开启后：

```text
1 条内容：
正面 → 背面 → 例句 → 再从头播放

多条内容：
1 → 2 → 3 → ... → 最后一条 → 回到 1
```

---

## 2. Azure 中英双语 TTS

MemoryCast 支持 Azure Speech 神经网络语音。

当前设计不是整篇强制使用一种语言音色，而是根据自然段与主语言进行分块：

```text
英文主块
→ 英文多语种音色

中文主块
→ 中文多语种音色

块内少量另一种语言
→ 使用 SSML <lang> 保持正确发音
```

这样可以避免：

- 英文音色读中文导致普通话不标准
- 中文音色读英文导致英语口音明显
- 中途频繁切换 voice 导致卡顿
- 混合 SSML 过长导致播放截断

项目也包含：

- 数字和日期的 SSML `<say-as>`
- 独立英文字母清晰发音
- 独立英文单词轻微降速
- CO2 / NOx / PM2.5 等技术 token 的特殊处理
- 长笔记分块生成
- 下一块音频预加载
- TTS 本地缓存

如果 Azure TTS 未配置，可回退到浏览器 Speech Synthesis。

---

## 3. 原始笔记库

MemoryCast 不会只保留拆碎后的卡片。

完整笔记会单独保存到 PostgreSQL：

- 保留原始上下文
- 支持搜索
- 支持编辑
- 支持删除
- 支持整篇朗读
- 支持手动标记“本次已复习”
- 支持语音笔记
- 支持 OCR 导入

### 笔记与卡片同步

卡片通过：

```text
cards.source_note_id
```

关联来源笔记。

编辑笔记并保存时，MemoryCast 会自动同步关联卡片：

```text
编辑笔记
→ 保存
→ AI 重新整理关联卡片
→ 更新原卡片内容
→ 保留原 card ID
→ 保留 FSRS
→ 保留 due
→ 保留 review_count
→ 保留历史 Review
```

也就是说，修改学习内容不会直接清空学习进度。

如果同步失败：

- 笔记仍会保存
- 原卡片不会删除
- 原学习记录不会丢失

---

## 4. AI 整理笔记

可以把：

- 英语笔记
- 中文课程笔记
- 双语内容
- 专业知识
- 技术资料

整理成知识卡片。

两种模式：

### 智能分割

AI 把长笔记拆成多个适合复习的知识点。

### 不分割

整篇笔记保留成一张卡片，更适合主要依靠听力输入的内容。

每张卡片可包含：

- front
- back
- example
- category
- semantic tags
- source note
- FSRS 状态

---

## 5. FSRS 间隔重复

MemoryCast 使用 `ts-fsrs` 调度复习。

手动评分：

| 评分 | 含义 |
| --- | --- |
| Again | 忘了 |
| Hard | 模糊 |
| Good | 记住 |
| Easy | 很熟 |

系统根据卡片状态计算：

- difficulty
- stability
- due
- review state

今日复习只拉取已经到期的内容。

---

## 6. AI 自适应测试

AI 测试支持：

- 选择题
- 填空题
- 简答题
- 听力题

三种抽题模式：

- 综合测试
- 薄弱点优先
- 仅到期卡片

### 薄弱点算法

系统综合考虑：

- FSRS 已到期
- 最近一次 Again / wrong
- 最近一次 Hard / partial
- 历史错误次数
- 历史困难次数
- FSRS difficulty
- 距离上次复习时间

因此“薄弱点优先”不会只是简单按 difficulty 排序。

### 答题置信度

每题还需要选择：

- 很确定
- 不太确定
- 猜的 / 不会

例如：

```text
答对 + 很确定
→ Good

答对 + 不确定
→ Hard

部分正确
→ Hard

答错
→ Again

答错 + 很确定
→ 标记为高置信错题
```

### 自适应变式重测

系统会根据表现自动调整：

```text
答错
→ 后续生成更基础的同概念变式

部分正确
→ 生成标准难度变式

答对 + 很确定
→ 可生成挑战题
```

变式题不会立即原题重复，而会尽量隔 2～4 道题再出现。

每场测试最多加入 3 道自适应题，避免无限增长。

### 测试结束诊断

结果不仅显示分数，还会按知识点分成：

- 稳定掌握
- 模糊
- 未掌握
- 高置信错题
- 已变式纠正

并提供：

- 只复习错题
- 再测薄弱点
- 进入费曼模式补薄弱点

---

## 7. 费曼模式

费曼模式用于检查“是否真的理解”。

系统会根据 FSRS 和记忆历史优先选择：

- 已到期知识点
- 最近答错知识点
- 最近 Hard 的知识点
- difficulty 较高知识点
- 历史错误较多知识点
- 尚未充分复习的知识点

你可以：

1. 看到随机知识点
2. 用自己的话完整讲一遍
3. 提交给 AI
4. 获得：
   - AI 听懂了什么
   - 哪些地方讲清楚了
   - 哪些逻辑没讲通
   - 一个关键追问
   - clarity score
5. 结果回写 FSRS

费曼模式也支持麦克风录入，转写完成后再由 AI 分析。

---

## 8. 语音笔记

支持浏览器录音：

```text
麦克风录音
→ STT
→ 转成文字
→ 保存到笔记库
→ 可继续编辑
→ 可再整理为卡片
```

当前 STT provider 可配置：

- Cloudflare Workers AI
- Gemini
- OpenRouter

自动路由默认优先避免不必要的付费路径。

---

## 9. 图片 OCR

支持：

```text
拍照 / 上传图片
→ 浏览器压缩
→ AI OCR
→ 保存为笔记
→ 后续整理为卡片
```

适合：

- 讲义
- PPT
- 课本
- 手写或打印资料
- 白板照片

---

## 10. 多 AI Provider

AI 功能可按模块分别选择 provider。

当前支持：

- Gemini
- Cloudflare Workers AI
- OpenRouter
- OpenAI-compatible API

可分别配置：

- AI 整理
- AI 出题
- AI 判分
- 费曼模式
- STT
- OCR

设置页支持 `gemini / cloudflare / openrouter / auto`。

---

# 技术架构

## Frontend

- HTML
- CSS
- Vanilla JavaScript
- MediaRecorder
- Web Speech API
- Service Worker
- Push API

## Backend

- Node.js 20+
- Express
- PostgreSQL
- `ts-fsrs`
- OpenAI-compatible SDK
- `web-push`

## Infrastructure

- Docker
- Docker Compose
- PostgreSQL 16
- Nginx
- Certbot
- HTTPS
- Persistent Docker volumes

---

# 系统结构

```text
Browser / Phone / Tablet
          │
          ▼
     Nginx Gateway
       80 / 443
          │
     ┌────┴─────┐
     ▼          ▼
 Static Web    /api/*
                │
                ▼
            Node.js API
        ┌───────┼───────────┐
        ▼       ▼           ▼
   PostgreSQL   AI          TTS
               │            │
      Gemini / CF / OR   Azure Speech
```

Docker Compose：

| Service | 作用 |
| --- | --- |
| `db` | PostgreSQL |
| `api` | Node.js API |
| `web` | 静态前端 |
| `gateway` | Nginx 入口 |

持久化 Volume：

| Volume | 内容 |
| --- | --- |
| `postgres_data` | 数据库 |
| `tts_cache` | Azure TTS 缓存 |

---

# 核心数据关系

```text
User
 ├── Notes
 │     └── Cards
 │           └── Reviews
 │
 ├── Quiz Sessions
 ├── Feynman Sessions
 │     └── Feynman Turns
 │
 ├── Settings
 └── Push Subscriptions
```

核心关联：

```text
notes.id
   │
   ▼
cards.source_note_id
```

来源笔记删除后，关联卡片使用数据库外键级联删除。

---

# 单用户模式

当前 MemoryCast 是 **单用户、自托管应用**。

没有账号登录流程。

服务器中维护一个 Local User。

这意味着：

> 能访问网站的人，也能够访问同一份学习数据。

因此推荐：

- 个人 VPS
- 内网
- VPN
- Tailscale
- Cloudflare Access
- Nginx Basic Auth

如果直接暴露到公网，请自行增加访问保护。

---

# 部署

## 1. 安装 Docker 和 Git

Ubuntu / Debian：

```bash
sudo apt update
sudo apt install -y ca-certificates curl git openssl

curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

重新登录 SSH 后检查：

```bash
docker --version
docker compose version
```

---

## 2. 克隆仓库

```bash
git clone https://github.com/goudanhh/memorycast.git
cd memorycast
```

---

## 3. 创建环境变量

```bash
cp .env.example .env
nano .env
```

至少配置：

```env
POSTGRES_DB=memorycast
POSTGRES_USER=memorycast
POSTGRES_PASSWORD=CHANGE_ME_LONG_RANDOM_PASSWORD
```

生成随机密码：

```bash
openssl rand -hex 24
```

不要把真实密码或 API Key 提交到 Git。

---

# AI 配置

## Gemini

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash-lite
```

模型名称只是默认配置，可在 `.env` 中替换为当前账号可用模型。

---

## Cloudflare Workers AI

```env
CLOUDFLARE_API_KEY=
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_AI_MODEL=@cf/google/gemma-4-26b-a4b-it
CLOUDFLARE_STT_MODEL=@cf/openai/whisper-large-v3-turbo
CLOUDFLARE_OCR_MODEL=@cf/moondream/moondream3.1-9B-A2B
```

---

## OpenRouter

```env
OPENROUTER_API_KEY=
OPENROUTER_MODEL=openrouter/free
OPENROUTER_VISION_MODEL=openrouter/free
OPENROUTER_STT_MODEL=openai/whisper-large-v3
```

是否免费、可用模型和限额取决于 provider 当前政策，请以 provider 控制台为准。

---

## OpenAI-compatible

```env
OPENAI_API_KEY=
OPENAI_MODEL=
```

不使用可以留空。

---

# Azure TTS

推荐配置：

```env
TTS_PROVIDER=azure
AZURE_SPEECH_KEY=
AZURE_SPEECH_REGION=westus2

AZURE_EN_MULTILINGUAL_VOICE=en-US-AvaMultilingualNeural
AZURE_ZH_MULTILINGUAL_VOICE=zh-CN-YunxiaoMultilingualNeural
```

也保留兼容变量：

```env
AZURE_MULTILINGUAL_VOICE=en-US-AvaMultilingualNeural
```

未配置 Azure 时可使用浏览器 TTS。

---

# FSRS

默认目标保持率：

```env
FSRS_RETENTION=0.90
```

前端设置页也可以调整。

---

# 启动

```bash
docker compose up -d --build
```

检查：

```bash
docker compose ps
```

查看 API：

```bash
curl http://localhost/api/health
```

查看日志：

```bash
docker compose logs api --tail=100
```

---

# HTTPS

项目 Gateway 支持 80 / 443。

推荐使用：

- 域名
- Let's Encrypt
- Certbot

Web Push、麦克风权限以及部分浏览器能力在 HTTPS 下工作更可靠。

---

# 更新

普通更新：

```bash
git pull
docker compose up -d --build
```

如果服务器本地单独维护了 Gateway HTTPS 配置，请在更新前自行备份该文件，避免 `git pull` 覆盖或冲突。

---

# 数据持久化

PostgreSQL 数据保存于：

```text
postgres_data
```

TTS 缓存保存于：

```text
tts_cache
```

普通：

```bash
docker compose down
```

不会删除数据。

## 注意

不要随便执行：

```bash
docker compose down -v
```

`-v` 会删除 Compose volumes，可能导致 PostgreSQL 学习数据丢失。

---

# 数据备份

如果仓库中的备份脚本可用：

```bash
bash scripts/backup.sh
```

升级、数据库迁移和大规模数据操作前建议先备份 PostgreSQL。

---

# 常用诊断

## 查看容器

```bash
docker compose ps
```

## API 健康检查

```bash
curl -i http://localhost/api/health
```

## API 日志

```bash
docker compose logs api --tail=120
```

## TTS 信息

```bash
curl -i http://localhost/api/tts/info
```

---

# 安全说明

MemoryCast 会使用：

- 数据库密码
- AI provider API Key
- Azure Speech Key
- Web Push 配置

请：

- 只放在服务器 `.env`
- 不要提交到 GitHub
- 不要截图公开
- 不要把真实 Key 写入 README
- 泄露后立即到 provider 控制台撤销并重新生成

---

# 当前限制

当前仍是个人使用导向项目，主要限制：

- 单用户
- 没有内置登录 / 权限系统
- 前端主要是 Vanilla JS 单文件
- 数据库 migration 尚未完全独立
- 自动化测试覆盖不足
- Web Push 依赖 HTTPS
- 不同 AI provider 的可用模型与额度会变化
- AI 自动同步卡片依赖模型输出质量

---

# 设计原则

MemoryCast 当前最重要的产品原则：

### 1. 听优先于看

文字用于辅助确认，核心输入来自连续朗读与循环听。

### 2. 原始笔记不能丢

卡片只是派生学习对象，原文必须保留。

### 3. 学习进度不能因为编辑内容被清零

更新笔记时尽量保留原 card ID 与 FSRS 历史。

### 4. AI 测试必须影响真实复习计划

测试结果直接写入 FSRS，而不是只显示一个分数。

### 5. 错题应该变式重测

避免“刚看到答案就原题再问”造成虚假掌握。

### 6. AI 是辅助层，不是数据源

AI 整理和出题应以用户已有学习内容为依据。

---

# License

当前仓库未声明开源许可证。

如果计划公开发布、接受贡献或允许第三方二次分发，建议补充明确的 License。
