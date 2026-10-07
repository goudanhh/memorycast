# MemoryCast

MemoryCast 是一个 **听力优先、AI 辅助、FSRS 驱动的个人学习系统**。

它适合英语表达、双语笔记、专业课程、技术概念，以及任何需要长期重复输入和主动回忆的内容。

核心思路不是单纯“做卡片”，而是：

```text
原始笔记
  ↓
AI 整理为知识卡片
  ↓
听力输入 / 随身听
  ↓
FSRS 间隔重复
  ↓
AI 测试
  ↓
薄弱点与费曼强化
```

MemoryCast 会同时保留原始笔记、知识卡片、FSRS 状态、测试历史和费曼记录。

---

## 当前主要能力

### 1. AI 整理笔记

支持把学习内容整理成知识卡片。

可输入：

- 普通文字
- 英语 / 中文 / 双语笔记
- 专业课程内容
- 语音笔记
- 图片
- PDF

图片 / PDF 支持三种导入方式：

- 点击选择文件
- 直接拖拽到 AI 整理区域
- 复制图片或截图后直接 `Ctrl+V / Cmd+V`

原始文件会和笔记一起保存。

整理模式：

- **智能分割**：AI 自动拆成多张卡片
- **不分割**：整篇笔记保留为一张卡片

卡片保存成功后，输入区会自动清空，并结束当前笔记会话，下一次输入会创建新的原始笔记，不会覆盖上一条笔记。

---

### 2. 原始笔记库

原始笔记不会因为生成卡片而消失。

支持：

- 搜索
- 查看
- 编辑
- 删除
- 整篇朗读
- 手动标记“本次已复习”
- 查看图片 / PDF 附件
- 自动同步关联卡片

卡片通过：

```text
cards.source_note_id
```

关联来源笔记。

编辑原始笔记后，系统会尽量更新原有卡片内容，同时保留：

- card ID
- FSRS 状态
- due
- review count
- 历史复习记录

### 暂停学习

每篇笔记可以点击：

```text
🚫 不参与学习
```

暂停后：

- 原始笔记仍然保留
- 关联卡片仍然保留
- FSRS 数据不清零

但这些卡片不会再出现在：

- 知识库
- 今日复习
- AI 测试
- 随身听
- 费曼随机抽题
- 到期提醒

之后可以点击：

```text
↩ 恢复学习
```

原卡片和原 FSRS 进度会直接恢复。

---

### 3. 知识库与 FSRS

MemoryCast 使用 `ts-fsrs` 管理复习计划。

评分：

| 评分 | 含义 |
| --- | --- |
| Again | 忘了 |
| Hard | 模糊 |
| Good | 记住 |
| Easy | 很熟 |

系统维护：

- difficulty
- stability
- due
- review state
- review history

今日复习默认只显示已经到期、且当前参与学习的卡片。

默认目标保持率：

```env
FSRS_RETENTION=0.90
```

---

### 4. 听力优先复习

今日复习支持连续朗读：

```text
正面
→ 背面
→ 例句
→ 下一张卡片
```

支持：

- 连续播放
- 循环播放
- 多条自动循环
- 中文 / 英文混合内容
- 多档倍速
- 神经网络 TTS
- 浏览器 TTS 回退

数学符号在朗读时会进行语音友好转换，例如：

```text
3 + 2 = 5
```

页面仍显示原公式，但朗读为：

```text
3 加 2 等于 5
```

常见规则包括：

- `+` → 加
- `−` → 减
- `×` → 乘
- `÷` → 除以
- `=` → 等于

数字表达式中的 `*`、`/`、`-` 也会做对应处理。

---

## 随身听模式

随身听用于连续听高优先级学习内容。

队列优先考虑：

1. 最近 Again / 答错
2. 最近 Hard / 部分正确
3. 已到期卡片
4. 其他参与学习的卡片

同层级还会考虑：

- FSRS difficulty
- FSRS stability
- 逾期时间
- 最近复习结果

因此越容易遗忘的内容，通常越靠前。

随身听本身不会直接修改 FSRS。只有正式复习、AI 测试或其他明确学习反馈才会更新记忆曲线。

### 歌词式字幕

随身听会显示类似歌词播放器的字幕：

- 当前句高亮
- 当前句放大
- 上下句淡化
- 自动滚动
- 与音频时间同步

---

## Apple Watch 支持

MemoryCast 当前支持 **Apple Watch 网页端随身听**。

不需要 Mac，也不需要单独安装 watchOS App。

Apple Watch 的媒体播放兼容性比较特殊。实际可用方案不是普通的：

```text
<audio>
```

或：

```text
<video>
```

而是：

```text
服务器自然 TTS
→ MP3 二进制
→ Web Audio API
→ decodeAudioData()
→ AudioBufferSourceNode
→ AirPods / Watch 音频输出
```

当前 Watch 随身听还包含：

- 第一段后台预取与解码
- 下一段提前预取
- 小型解码缓存
- 字幕同步
- 自动连续播放
- 1.25× Web Audio 增益，改善 AirPods 上偏小的 TTS 音量

### Watch AI 测试

检测到 Apple Watch 时，AI 测试会自动只生成：

```text
四选一选择题
```

包括自适应追加题也保持 MCQ。

其他设备仍然使用完整题型。

> 仓库中的 `watchos/` 是实验性原生客户端目录。当前正常使用 Apple Watch 不依赖它。

---

## Azure TTS

推荐使用 Azure Speech 神经网络语音：

```env
TTS_PROVIDER=azure
AZURE_SPEECH_KEY=
AZURE_SPEECH_REGION=

AZURE_EN_MULTILINGUAL_VOICE=en-US-AvaMultilingualNeural
AZURE_ZH_MULTILINGUAL_VOICE=zh-CN-YunxiaoMultilingualNeural
```

未配置 Azure 时可以回退到浏览器 Speech Synthesis。

MemoryCast 会根据语言对中英文内容分段，避免整段由错误语言音色朗读。

同时支持：

- 长文本切块
- TTS 缓存
- 下一段预取
- 技术 token 处理
- 数字 / 数学符号朗读优化

---

## AI 自适应测试

支持：

- 选择题
- 填空题
- 简答题
- 听力题

抽题模式：

- 综合测试
- 薄弱点优先
- 仅到期卡片

薄弱度综合考虑：

- 是否已到期
- 最近 Again / wrong
- 最近 Hard / partial
- 历史错误次数
- 历史困难次数
- FSRS difficulty
- 距离上次复习时间

答题时还可以记录置信度：

- 很确定
- 不太确定
- 猜的 / 不会

测试结果会真实影响 FSRS，而不是只显示一个分数。

### 自适应变式

系统可以根据表现追加变式题：

```text
答错
→ 更基础的同概念题

部分正确
→ 标准难度变式

答对且很确定
→ 更高难度挑战
```

---

## 费曼模式

费曼模式用于检查是否真正理解知识点。

系统会优先抽取：

- 已到期内容
- 最近答错内容
- 最近 Hard 内容
- difficulty 高的内容
- 历史错误较多的内容

可以用文字或语音回答。

AI 会返回：

- 它理解到的内容
- 讲清楚的部分
- 缺失或错误的部分
- 关键追问
- clarity score

---

## 语音笔记

浏览器可以直接录音：

```text
录音
→ STT
→ 文字
→ 原始笔记
→ AI 整理
→ 知识卡片
```

当前 STT 可使用：

- Cloudflare Workers AI
- Gemini
- OpenRouter

---

## AI Provider

AI 功能可以使用多个 provider。

当前配置支持：

- Gemini
- Cloudflare Workers AI
- OpenRouter
- OpenAI-compatible API

可用于：

- AI 整理
- AI 出题
- AI 判分
- 费曼模式
- OCR
- STT

示例：

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash-lite
```

Provider 的模型名称、免费额度和可用性会变化，请以各平台当前控制台为准。

---

# 技术栈

### Frontend

- HTML
- CSS
- Vanilla JavaScript
- Web Audio API
- Web Speech API
- MediaRecorder
- Service Worker
- Push API

### Backend

- Node.js 20+
- Express
- PostgreSQL
- ts-fsrs
- Azure Speech SDK
- OpenAI-compatible SDK
- web-push
- pdf-parse

### Infrastructure

- Docker
- Docker Compose
- PostgreSQL 16
- Nginx
- HTTPS / Certbot

---

# 架构

```text
Browser / iPhone / Apple Watch
              │
              ▼
         Nginx Gateway
           80 / 443
              │
       ┌──────┴──────┐
       ▼             ▼
   Static Web      /api/*
                     │
                     ▼
                 Node.js API
        ┌────────────┼────────────┐
        ▼            ▼            ▼
    PostgreSQL       AI           TTS
                 Providers    Azure Speech
```

Docker Compose 服务：

| Service | 作用 |
| --- | --- |
| `db` | PostgreSQL |
| `api` | Node.js API |
| `web` | Nginx 静态前端 |
| `gateway` | HTTPS / API 反向代理 |

持久化 Volume：

| Volume | 内容 |
| --- | --- |
| `postgres_data` | 学习数据 |
| `tts_cache` | TTS 缓存 |

---

# 部署

## 1. 克隆

```bash
git clone https://github.com/goudanhh/memorycast.git
cd memorycast
```

## 2. 创建环境变量

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

不要把真实密码、API Key 或 Azure Key 提交到 GitHub。

## 3. 启动

```bash
docker compose up -d --build
```

查看容器：

```bash
docker compose ps
```

查看 API 日志：

```bash
docker compose logs --tail=120 api
```

健康检查：

```bash
curl -i http://127.0.0.1/api/health
```

如果 Gateway 没有绑定本地 80 端口，可以根据实际部署端口检查 API。

---

# 常用环境变量

### PostgreSQL

```env
POSTGRES_DB=memorycast
POSTGRES_USER=memorycast
POSTGRES_PASSWORD=
```

### Gemini

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash-lite
```

### OpenAI-compatible

```env
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-mini
```

### Cloudflare Workers AI

```env
CLOUDFLARE_API_KEY=
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_AI_MODEL=@cf/google/gemma-4-26b-a4b-it
CLOUDFLARE_STT_MODEL=@cf/openai/whisper-large-v3-turbo
CLOUDFLARE_OCR_MODEL=@cf/moondream/moondream3.1-9B-A2B
```

### OpenRouter

```env
OPENROUTER_API_KEY=
OPENROUTER_MODEL=openrouter/free
OPENROUTER_VISION_MODEL=openrouter/free
OPENROUTER_STT_MODEL=openai/whisper-large-v3
```

### FSRS

```env
FSRS_RETENTION=0.90
```

完整变量请参考：

```text
.env.example
```

---

# 更新

服务器常用更新方式：

```bash
cd /home/goudan/memorycast/memorycast
git pull origin main
docker compose up -d --build
```

更新后建议检查：

```bash
docker compose ps
docker compose logs --tail=80 api
```

---

# 数据持久化

普通停止：

```bash
docker compose down
```

不会删除 PostgreSQL 数据。

不要随意执行：

```bash
docker compose down -v
```

`-v` 会删除 Compose Volume，可能导致数据库和学习数据丢失。

升级、修改数据库结构或大规模操作前建议先备份。

如果备份脚本可用：

```bash
bash scripts/backup.sh
```

---

# 常见故障排查

## 页面显示“正在连接服务器”

先看：

```bash
docker compose ps
```

然后：

```bash
docker compose logs --tail=120 api
```

如果 API 没有处于 Running / Up 状态，优先看日志中的 JavaScript 或 SQL 错误。

---

## 更新后前端看起来还是旧版本

MemoryCast 的前端资源可能被浏览器缓存。

先：

- 完全关闭网页
- 重新打开
- 必要时清除该站点缓存

代码中也会通过静态资源版本号主动进行 cache bust。

Apple Watch 的网页缓存通常比桌面浏览器更顽固，改动后建议彻底关闭页面再重新进入。

---

## Apple Watch 有字幕但声音不自然

Watch 当前应优先使用 Web Audio 自然 TTS。

如果退回浏览器 Speech Synthesis，声音会明显更机械。

检查 API/TTS 是否正常：

```bash
docker compose logs --tail=120 api
```

以及 Azure TTS 配置是否可用。

---

# 单用户模式

MemoryCast 当前是个人自托管、单用户模式。

它没有传统账号系统，访问该站点的人会使用同一份学习数据。

如果公开部署，建议增加额外保护，例如：

- Cloudflare Access
- VPN / Tailscale
- Nginx Basic Auth
- 仅内网访问

---

# 当前限制

目前项目仍然以个人使用为主：

- 单用户
- Vanilla JS 前端较集中
- 数据库 migration 仍以内联 `ALTER TABLE ... IF NOT EXISTS` 为主
- 自动化测试覆盖有限
- Apple Watch 依赖 watchOS WebView / WebKit 行为
- 不同 AI Provider 的模型和额度会变化
- AI 生成质量取决于模型
- Web Push、麦克风等功能最好通过 HTTPS 使用

---

# 设计原则

1. **听优先于看**  
   视觉是辅助，连续听和重复输入是核心。

2. **原始笔记不能丢**  
   卡片是派生学习对象，原始内容必须保留。

3. **编辑内容不应该清空学习进度**  
   尽量保留原 card ID 与 FSRS 历史。

4. **暂停学习不等于删除**  
   内容可以暂时退出学习系统，但数据和 FSRS 应保留。

5. **AI 测试必须影响真实复习计划**  
   测试结果会回写 FSRS。

6. **错误需要变式重测**  
   避免刚看过答案后立刻重复原题造成虚假掌握。

7. **AI 是辅助层，不是事实来源**  
   整理、出题和费曼分析应围绕用户已有学习材料。

---

# License

当前仓库尚未声明开源许可证。

如果准备公开分发、接受外部贡献或允许二次开发，建议补充明确的 License。
