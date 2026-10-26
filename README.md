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

## 知识冒险（Knowledge Adventure）

**主入口**：网页 / 手机浏览器进入「🗺️ 记忆冒险」，地图共有 8 关。用户控制小探险家使用 **方向键 / WASD** 或触屏方向按钮在 13×9 方格地图中移动。旧版「闪电生存战」等练习收纳于「经典限时练习」折叠区域。

每关都是一个可以走动的世界：

- 依次探索：记忆草原 → 萤火森林 → 迷雾溪谷 → 森林守卫 → 星际书库 → 浮空遗迹 → 时间裂缝 → 记忆之心。
- 地图有障碍物、巡逻敌人、三枚水晶和关底传送门。碰到敌人或知识答错会损失生命。
- 走到水晶处触发真实知识卡问题：选择、英文拼写及可用时的听音辨义混合。
- 集齐三枚水晶才可以挑战出口守卫；某些关底需连续正确回答多道题。失败需要重试该关。
- 通关会根据失误和剩余生命评 1–3 星，保存每关最佳星级和最快时间，并且逐关解锁。通过 PostgreSQL 的 `adventure_progress` 表同步。
- 关卡题目优先来自你已有的待复习、容易遗忘的卡片，不新增一套题库；原先「7 天不出现」的知识点不会出现，游戏答题记录仍存入 `game_attempts`，**不修改 FSRS 原有到期安排**。

### 注意

这是可移动、探索、遇敌、搜集道具和关底通关的**小游戏**，不再只是答题选单。通关奖励用于提供练习动力，长期掌握程度仍应参考间隔重复与之后的测验。Safari/Chrome 的语音朗读取决于浏览器是否支持；不支持则使用文字关卡。关卡中途退出不会保存未完成的半关进度。

### 经典限时练习

原有四种玩法仍可以通过下方折叠菜单打开：闪电生存战、错题 Boss 战、音速追击和极限拼写。

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
