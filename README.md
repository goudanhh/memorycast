# MemoryCast

MemoryCast 是一个面向个人学习场景的自托管学习系统，把 **原始笔记、AI 卡片、FSRS 间隔重复、AI 测试、TTS 朗读和学习统计** 放在同一个工作流里。

它的核心思路不是“只做闪卡”，而是保留完整学习上下文：

```text
原始笔记
   ↓
永久保存
   ↓
AI 拆分为知识卡片
   ↓
FSRS 安排复习
   ↓
TTS 连续播放 / 手动评分
   ↓
AI 测试与判分
   ↓
更新下一次复习时间
```

原始笔记和派生卡片同时存在。你既可以按照 FSRS 自动复习，也可以随时打开某篇原始笔记进行自主复习。

---

## 主要功能

### 原始笔记

- 粘贴中文、英文或专业学习笔记
- 原始内容单独保存在 PostgreSQL
- 保留换行、空行、缩进和段落顺序
- AI 只读取笔记生成卡片，不会改写原文
- 笔记支持搜索
- 笔记支持编辑和删除
- 可直接打开原始笔记自主复习
- 可朗读整篇笔记
- 可记录自主复习次数
- 删除笔记时，可级联删除由该笔记生成的相关卡片

### AI 整理

MemoryCast 可以把一篇长笔记自动整理成适合记忆的卡片。

每张卡片可以包含：

- 正面问题 / Recall Prompt
- 背面答案
- 例句或补充
- AI 自动语义标签
- 日期标签
- 来源笔记关联

AI 整理目前支持 Gemini，也保留 OpenAI provider 兼容逻辑。

### FSRS 间隔重复

卡片使用 FSRS 进行调度。

手动复习评分：

| 评分 | 含义 |
| --- | --- |
| Again | 忘了 |
| Hard | 模糊 |
| Good | 记住 |
| Easy | 很熟 |

今日复习只显示已经到期的卡片，并按照到期时间组织复习队列。

### AI 测试

系统可根据已有卡片自动生成：

- 选择题
- 填空题
- 简答题
- 听力题

AI 判分结果会映射到 FSRS：

| AI 判定 | FSRS |
| --- | --- |
| wrong | Again |
| partial | Hard |
| correct | Good |

因此测试不是独立模块，而是会真正影响后续复习调度。

### TTS 朗读

浏览器内置 Speech Synthesis 用于朗读。

当前默认：

- 中文：1.0×
- 英文：1.0×

今日复习支持连续播放：

```text
卡片正面
→ 卡片背面
→ 例句
→ 下一张卡
```

也支持循环播放。

### 知识库

知识库用于管理所有卡片：

- 搜索卡片
- 按标签筛选
- 查看 AI 标签
- 新建卡片
- 编辑卡片
- 删除卡片

### 笔记库

笔记库与知识库是两个不同层级：

```text
笔记库 = 完整上下文
知识库 = 可复习的原子知识卡片
```

点击一篇笔记的“复习”后，才会展开完整自主复习面板。

### 学习统计

当前统计包括：

- 卡片总数
- 累计复习次数
- 最近 7 天复习量
- AI 测试正确率
- 标签 / 分类分布
- 平均 FSRS difficulty

### Web Push

项目已经包含基于 Web Push 的每日复习提醒框架。

默认行为：

- 每天指定时间检查
- 只在存在 FSRS 到期卡片时提醒
- 默认时间为 09:00
- 可在设置中修改提醒时间

注意：浏览器后台推送需要 HTTPS。直接通过公网 IP 的普通 HTTP 页面访问时，浏览器通常不会允许完整的 Service Worker / Push 功能。

---

## 当前产品形态

MemoryCast 当前是 **单用户、自托管版本**。

没有登录流程。

打开网站后会直接使用同一个本地用户：

```text
Local User
```

这意味着：

> 任何可以访问你 MemoryCast 地址的人，都可能读取、修改或删除同一份学习数据。

因此当前版本适合：

- 自己的 VPS
- 家庭内网
- VPN / Zero Trust 网络
- 尚未公开的个人服务器

如果直接开放到公网，建议后续增加认证层。

---

## 技术栈

### Frontend

- HTML
- CSS
- Vanilla JavaScript
- Web Speech API
- Service Worker
- Push API

### Backend

- Node.js 20+
- Express
- PostgreSQL driver
- ts-fsrs
- OpenAI SDK
- web-push

### Database

- PostgreSQL 16

### Infrastructure

- Docker
- Docker Compose
- Nginx
- Certbot / HTTPS scripts

---

## 系统架构

```text
Browser / Phone / Tablet
          │
          ▼
    Nginx Gateway
       :80 / :443
       ├──────────────► Static Web
       │
       └── /api/* ───► Node.js API
                           │
                           ├──► PostgreSQL
                           │
                           ├──► Gemini
                           │
                           └──► OpenAI (optional)
```

Docker Compose 服务：

| Service | 用途 |
| --- | --- |
| db | PostgreSQL |
| api | Node.js API |
| web | 静态前端 |
| gateway | Nginx 入口 |

---

## 数据关系

核心数据关系：

```text
User
 ├── Notes
 │     └── Cards
 │           └── Reviews
 │
 ├── Quiz Sessions
 ├── Settings
 └── Push Subscriptions
```

其中：

```text
notes.id
   ↓
cards.source_note_id
```

当前来源笔记外键使用：

```sql
ON DELETE CASCADE
```

所以删除一篇原始笔记时，它生成的关联卡片也会一起删除。

卡片对应的 reviews 同样使用级联删除。

---

## 数据库主要表

| 表 | 用途 |
| --- | --- |
| users | 单用户记录 |
| notes | 原始笔记 |
| cards | FSRS 知识卡片 |
| reviews | 卡片复习历史 |
| quiz_sessions | AI 测试会话 |
| user_settings | 学习和提醒设置 |
| push_subscriptions | Web Push 订阅 |
| app_config | 应用级配置 |

---

# 部署

以下示例以 Ubuntu / Debian 系服务器为例。

## 1. 开放端口

至少需要：

```text
22  SSH
80  HTTP
443 HTTPS
```

如果使用 UFW：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

如果服务器厂商还有安全组 / Firewall，也需要同步开放 80 和 443。

---

## 2. 安装 Docker 和 Git

```bash
sudo apt update
sudo apt install -y ca-certificates curl git openssl

curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

退出 SSH 后重新登录。

检查：

```bash
docker --version
docker compose version
```

---

## 3. 克隆项目

```bash
git clone https://github.com/goudanhh/memorycast.git
cd memorycast
```

如果已经部署：

```bash
cd memorycast
git pull
```

---

## 4. 创建环境变量

```bash
cp .env.example .env
nano .env
```

至少需要配置 PostgreSQL：

```env
POSTGRES_DB=memorycast
POSTGRES_USER=memorycast
POSTGRES_PASSWORD=CHANGE_ME_LONG_RANDOM_PASSWORD
```

生成随机数据库密码：

```bash
openssl rand -hex 24
```

不要把真实密码提交到 GitHub。

`.env` 已经应该被 Git 忽略。

---

## 5. 配置 Gemini

默认 AI provider：

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash-lite
```

填写自己的 Gemini API Key：

```env
GEMINI_API_KEY=YOUR_GEMINI_API_KEY
```

不要把 API Key 发到公开聊天、截图或 GitHub。

---

## 6. OpenAI 配置

项目保留 OpenAI provider 支持。

```env
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-mini
```

如果不使用，可以留空。

---

## 7. FSRS 默认保持率

```env
FSRS_RETENTION=0.90
```

用户也可以在前端设置页面修改目标保持率。

---

## 8. 启动

```bash
docker compose up -d --build
```

检查：

```bash
docker compose ps
```

正常应看到：

```text
memorycast-db-1        Up (healthy)
memorycast-api-1       Up
memorycast-web-1       Up
memorycast-gateway-1   Up
```

---

## 9. 检查 API

```bash
curl http://localhost/api/health
```

正常会返回类似：

```json
{
  "ok": true,
  "ai": {
    "enabled": true,
    "provider": "gemini",
    "model": "..."
  },
  "mode": "single-user"
}
```

---

## 10. 访问

浏览器：

```text
http://你的服务器公网IP
```

如果已经配置域名与 HTTPS：

```text
https://your-domain.example
```

---

# HTTPS

项目包含 HTTPS 脚本。

有域名后可使用：

```bash
bash scripts/enable-https.sh your-domain.com your@email.com
```

HTTPS 不只是为了加密。

如果需要 Web Push / Service Worker 的完整浏览器能力，也建议使用 HTTPS。

---

# 更新部署

服务器中进入项目目录：

```bash
git pull
docker compose up -d --build
```

检查：

```bash
docker compose ps
```

查看 API 日志：

```bash
docker compose logs api --tail=100
```

实时查看：

```bash
docker compose logs -f api
```

---

# PostgreSQL 数据

数据存放在 Docker named volume：

```text
postgres_data
```

普通：

```bash
docker compose down
```

不会删除数据库。

## 不要随便执行

```bash
docker compose down -v
```

`-v` 会删除 Compose 管理的 volume，可能导致 PostgreSQL 数据丢失。

---

# 数据库备份

项目包含备份脚本：

```bash
bash scripts/backup.sh
```

备份文件默认放在：

```text
backups/
```

在升级、迁移数据库结构或批量删除数据前，建议先备份。

---

# 清理旧的孤立卡片

早期版本还没有“笔记 → 卡片”关联，所以部分旧卡片可能：

```text
source_note_id = NULL
```

先查看数量：

```bash
docker compose exec db psql -U memorycast -d memorycast -c "SELECT COUNT(*) FROM cards WHERE source_note_id IS NULL;"
```

确认后删除：

```bash
docker compose exec db psql -U memorycast -d memorycast -c "DELETE FROM cards WHERE source_note_id IS NULL;"
```

卡片对应的 review 会因为数据库外键级联一起删除。

---

# 新服务器部署

不迁移旧数据时：

```bash
git clone https://github.com/goudanhh/memorycast.git
cd memorycast
cp .env.example .env
nano .env
docker compose up -d --build
```

如果需要迁移旧服务器的学习数据，不能只复制 GitHub 项目。

GitHub 中只有程序代码。

真正的：

- 原始笔记
- 卡片
- FSRS 状态
- Review
- Quiz
- Settings

都在 PostgreSQL 中，需要通过 PostgreSQL 备份和恢复迁移。

---

# 常见问题

## 页面一直显示“正在连接服务器”

先检查：

```bash
docker compose ps
```

然后：

```bash
curl http://localhost/api/health
```

如果 API 容器重启：

```bash
docker compose logs api --tail=100
```

## 出现 POSTGRES_PASSWORD variable is not set

说明当前目录没有正确读取 `.env`。

检查：

```bash
pwd
ls -la
```

确保：

```text
docker-compose.yml
.env
```

位于同一个项目目录。

## AI 不可用

检查：

```bash
curl http://localhost/api/health
```

再检查 `.env` 中：

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=...
```

重新构建：

```bash
docker compose up -d --build --force-recreate api
```

## 网站能打开，但部分模块加载失败

查看 API：

```bash
docker compose logs api --tail=100
```

前端初始化已经使用分模块加载逻辑，因此单个次要模块失败时，不应该再导致整个网站退回连接页面。

---

# 安全说明

当前版本没有身份认证。

如果直接暴露到公网：

- 别人可能看到原始笔记
- 别人可能编辑卡片
- 别人可能删除学习数据
- 别人可能触发 AI API 消耗

正式长期使用时，至少建议加入一种访问保护：

- 应用登录
- Nginx Basic Auth
- Cloudflare Access
- VPN
- Tailscale

---

# 当前限制

MemoryCast 目前仍然是个人项目 / MVP，主要限制包括：

- 单用户
- 无账号权限系统
- 前端仍以 Vanilla JS 单文件逻辑为主
- 数据库迁移暂时混合使用 init.sql 和 API 启动时补表
- 缺少完整自动测试
- Web Push 依赖 HTTPS
- 早期旧卡片可能没有 source_note_id

---

# 推荐的下一步

项目后续优先级建议：

1. 域名 + HTTPS
2. 访问认证
3. 自动数据库备份
4. 前端 JS 模块化
5. 正式数据库 migration
6. API 自动测试
7. 学习日历 / streak
8. PWA 安装体验
9. 学习周报
10. 笔记与卡片关系可视化

---

# License

当前仓库未声明开源许可证。

如果计划公开发布或允许他人二次使用，建议后续明确添加 License。
