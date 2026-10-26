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

## 记忆守卫者 — 混合战斗游戏（2026-10-26）

**主游戏已改为实时操作的三战区 Roguelite + 塔防混合玩法。** 打开侧边栏「⚔️ 游戏世界」，直接选择解锁的战区。旧版知识冒险和经典小游戏仍保存在下方折叠区，历史进度不删除。

- **实时战斗**：使用 WASD / 方向键或手机触屏方向键移动英雄。移动时自动瞄准最近敌人开火；`Space` 或页面「闪避」键冲刺，躲避 Boss 环状弹幕。
- **塔防建造**：保卫中央能量核心。战斗中击败敌人获得金币，靠近发光塔座按 `E` 或点击「建塔」，消耗 **35 战场金币** 造自动防御塔，帮助抵御敌人。
- **3 个战区 × 6 波敌人**：霓虹草原 → 晶核沙漠 → 星际废墟。每战区第六波出现 Boss，战胜后开放下一战区。
- **角色成长**：击败敌人收集经验晶体；等级提升时从多个主动/被动技能中选择，例如速射、散射、雷暴、重炮、护盾修复。一次出战内技能叠加。
- **基地永久养成**：每局结算金币及经验，金币可用于升级永久火力、护盾和拾取磁场；保存在新表 `arcade_profiles`（按用户隔离）。
- **知识符文（可选）**：只在特定波次出现，**靠玩家自行走过去拾取**。右侧短暂出现已有知识卡对应的拼写或四选一增益任务。答对释放群体冲击波并恢复血量；不拾取、答错或超时不阻断战斗。游戏在没有任何知识卡时也能正常进行。
- **与学习系统隔离**：只有实际作答的符文记录进入旧 `game_attempts`，用于识别弱项；不会因打怪或升级而修改 FSRS 复习时间，也遵守知识卡「7 天不出现」设置。

无需外部游戏下载或图像素材，游戏直接使用浏览器 Canvas 2D。原生 Apple Watch 暂不支持实时游戏；保持其原有学习功能不变。

### 运行和检查

```bash
node scripts/check-rogue.mjs
node scripts/check-games.mjs
node scripts/check-adventure.mjs
```

更新服务器：`git pull origin main && docker compose up -d --build`。数据库表由 API 启动时的幂等迁移自动创建。

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
