# MemoryCast — Oracle + Docker 一键部署版

这是一个完整的中英双语 AI 复习网站，面向手机、电脑和小屏/手表浏览器。

## 已实现

- GitHub OAuth 登录
- PostgreSQL 云端数据与跨设备同步
- FSRS 间隔重复（ts-fsrs 5.4.2）
- 中英文浏览器 TTS
- 循环朗读
- AI 自动整理长笔记为复习卡
- AI 自动生成选择题 / 填空题 / 简答题 / 听力题
- AI 语义判分
- 错题回炉：wrong → Again，partial → Hard，correct → Good
- 知识库新增 / 编辑 / 删除
- 学习统计
- 手表极简模式
- Nginx + Node.js + PostgreSQL + Docker Compose
- Let's Encrypt HTTPS 脚本
- PostgreSQL 备份脚本
- GitHub Actions → Oracle 自动部署模板

## 架构

Browser / Watch → Oracle VM → Nginx → Web + Node API → PostgreSQL  
AI 功能由 Node API 服务端调用 OpenAI API。

## 1. Oracle 网络

在 Oracle Cloud VCN / Security List 或 NSG 开放：

- TCP 22
- TCP 80
- TCP 443

Ubuntu 如果启用了 UFW：

    sudo ufw allow OpenSSH
    sudo ufw allow 80/tcp
    sudo ufw allow 443/tcp

## 2. 安装 Docker

Ubuntu 22.04 / 24.04：

    sudo apt update
    sudo apt install -y ca-certificates curl git openssl
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker $USER

退出 SSH 后重新登录，然后确认：

    docker --version
    docker compose version

仓库也提供：

    bash scripts/install-oracle.sh

## 3. Clone 项目

因为当前仓库是 Private，Oracle 服务器需要有访问该 GitHub 私有仓库的权限。

    git clone https://github.com/goudanhh/memorycast.git
    cd memorycast

## 4. 配置环境变量

    cp .env.example .env
    nano .env

至少填写：

    POSTGRES_PASSWORD=一个随机长密码
    SESSION_SECRET=至少32字符随机字符串

    PUBLIC_URL=http://你的Oracle公网IP

    GITHUB_CLIENT_ID=...
    GITHUB_CLIENT_SECRET=...

    OPENAI_API_KEY=...
    OPENAI_MODEL=gpt-5.4-mini

随机字符串可用：

    openssl rand -hex 32

不要把 .env 提交到 GitHub；仓库的 .gitignore 已排除它。

如果暂时不配置 OPENAI_API_KEY，登录、卡片、数据库、FSRS 和 TTS 仍然能使用，只是 AI 整理 / AI 测试会关闭。

## 5. 创建 GitHub OAuth App

GitHub：

Settings → Developer settings → OAuth Apps → New OAuth App

如果先用 Oracle 公网 IP：

Homepage URL

    http://YOUR_ORACLE_PUBLIC_IP

Authorization callback URL

    http://YOUR_ORACLE_PUBLIC_IP/api/auth/github/callback

将 Client ID 和 Client Secret 填进服务器 .env。

## 6. 启动

由于通过 GitHub Contents API 上传时 shell 文件通常是普通 0644 权限，直接用 bash 最稳：

    bash scripts/deploy.sh

或者：

    docker compose up -d --build

查看状态：

    docker compose ps

日志：

    docker compose logs -f --tail=100

访问：

    http://你的Oracle公网IP

如果希望脚本以后可直接 ./scripts/deploy.sh：

    chmod +x scripts/*.sh

## 7. 数据存储

真实数据保存在 Docker PostgreSQL volume：

    postgres_data

主要表：

- users
- session
- cards
- reviews
- quiz_sessions
- user_settings

数据不依赖浏览器 localStorage。

同一个 GitHub 用户在电脑、手机、手表登录后读取相同的 PostgreSQL 数据。

## 8. FSRS

默认目标保持率为 90%。

手动复习评分：

- Again = 忘了
- Hard = 模糊
- Good = 记住
- Easy = 很熟

AI 测试：

- wrong → Again
- partial → Hard
- correct → Good

评分会更新原卡片的 FSRS 状态和 due 时间。

## 9. AI 测试的答案保护

生成测试后，完整题目和答案保存在 PostgreSQL quiz_sessions。

浏览器收到的题目不会包含：

- answer
- acceptableAnswers
- explanation

用户提交后，由后端判分，再返回正确答案和解释。

## 10. 域名和 HTTPS

先将域名 A 记录指向 Oracle 公网 IP。

然后运行：

    bash scripts/enable-https.sh memory.example.com your@email.com

成功后把 GitHub OAuth App 改成：

Homepage URL

    https://memory.example.com

Authorization callback URL

    https://memory.example.com/api/auth/github/callback

## 11. HTTPS 续期

    bash scripts/renew-https.sh

可使用 cron 定期执行。

## 12. 数据库备份

    bash scripts/backup.sh

备份文件生成到：

    backups/memorycast_YYYYMMDD_HHMMSS.sql.gz

backups/*.sql.gz 已被 .gitignore 排除。

## 13. GitHub Actions 自动部署

工作流：

    .github/workflows/deploy-oracle.yml

需要配置 Repository Secrets：

- ORACLE_HOST
- ORACLE_USER
- ORACLE_SSH_KEY
- ORACLE_APP_DIR

例如：

    ORACLE_APP_DIR=/opt/memorycast

配置完成后，push main 可自动 SSH 到 Oracle：

    git pull
    docker compose build api
    docker compose up -d

## 首次部署推荐顺序

1. Oracle 开放 22 / 80 / 443
2. 安装 Docker + Git
3. clone memorycast
4. cp .env.example .env
5. 创建 GitHub OAuth App
6. 填写 .env
7. bash scripts/deploy.sh
8. 使用 IP 验证
9. 配置域名
10. bash scripts/enable-https.sh ...
11. 修改 GitHub OAuth callback 为 HTTPS
12. 设置定期备份
