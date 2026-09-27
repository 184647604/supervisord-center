# supervisord-center

常驻的**服务托管中枢**，带 token 保护的 HTTP 控制面，经 Tailscale Serve 暴露给 tailnet 内的设备远程管理。

> **本文件是唯一允许出现中文的地方。** 项目里的 `.ps1` 一律纯 ASCII —— 理由见
> [「为什么脚本是纯 ASCII」](#为什么脚本是纯-ascii)，那是踩出来的，不是洁癖。

---

## 1. 它解决什么问题

被托管的服务（当前是 DSH web）一旦死了，本机上就**没有任何东西在听**，手机再怎么
发请求也没人接。重启之所以不需要它，是因为那时插件还跑在活着的进程里；**启动不行** ——
必须有一个生命周期独立于被托管服务的常驻进程。

```
                    ┌──────────────────────────────────────┐
   手机 / 其他设备 ──▶│  Tailscale（tailnet 内 HTTPS）        │
   （需同一 tailnet） │  https://<node>.<tailnet>.ts.net/super│
                    └──────────────────┬───────────────────┘
                                       ▼
                          ┌────────────────────────┐
                          │ 127.0.0.1:3099          │
                          │ supervisord-center      │  ← 本进程，生命周期独立
                          │  /health /start /restart│
                          └───────────┬────────────┘
                                      │ 启动 / 杀掉 / 探测
                                      ▼
                          ┌────────────────────────┐
                          │ 127.0.0.1:3080          │
                          │ DSH Web GUI（被托管）    │
                          └────────────────────────┘
```

## 2. 为什么不用 Tailscale 自带的能力

**问过，官方没有这个功能。** 两个名字很像的东西都不是：

| 功能 | 实际作用 | 是我们要的吗 |
|---|---|---|
| **Tailscale Serve** | 把本机端口映射成 `https://<节点>.ts.net/<路径>` | ❌ 只是反向代理，本项目**在用它**，但它不管进程 |
| **Tailscale Services** | 把资源发布成 tailnet 内固定名字，多主机负载均衡、高可用 | ❌ 网络**路由**层，不是进程管理 |

[Tailscale Services 文档](https://tailscale.com/docs/features/tailscale-services)本身就假设
**资源已经被你启动了**（原文：*Make sure to **start the resource** on a device in a tailnet*）。
管理台 Services 页的状态（`Pending approval` / `Connected` / `Offline` / `Draining`…）
全是**端点发布状态**，与进程死活无关。

**硬门槛**：Service host 必须用 tag 身份，文档原文 *You cannot use a device
authenticated with a user account as a Service host* —— 本机是用户账号，用不了。

**最关键的一点**：Tailscale 在网络层工作，它**无法启动一个已经死掉的进程**。GUI 挂了之后
自己把自己拉起来，在网络层无解，必须有进程外的守护 —— 这就是本项目存在的理由。

## 3. 命名

`supervisord` 取自 Unix 守护进程命名传统（`sshd` / `crond` / `httpd`）；
`center` 指它同时是一个**中心** —— 不只守一个进程，而是统一托管本机若干服务，
并提供 Web 控制台。

> **为什么必须加 `center` 后缀**：`supervisord` 是 **Python Supervisor**
> （`Supervisor/supervisor`，9122★）的守护进程**二进制名**，配套 `supervisorctl`。
> GitHub 上 `supervisord` 精确同名 **527 个仓库**（头部 `ochinchina/supervisord` 4272★），
> npm 上也被占（v0.1.0, 2011-09-17, `crcn/node-supervisord`）。
> Python 版是 Unix-only（依赖 fork/exec/信号），在 Windows 上功能不冲突，
> 但**搜索和沟通会被淹没** —— 搜 `supervisord` 排错翻十页都是别人的东西。
> 加后缀后 npm 与 GitHub 双 free（已逐个直连复核）。

## 4. 快速开始

```powershell
cd "C:\Users\sun\Documents\DeepSeek Harnss\supervisord-center"

.\install.ps1 -DryRun    # 先试运行：备用端口起临时实例，绝不碰现有服务
.\install.ps1            # 正式安装 / 从 dsh-supervisor 迁移
```

| 参数 | 作用 |
|---|---|
| `-DryRun` | 安全验证：备用端口 3098 起临时实例，假目标 8001，跑完即停。**不碰** 3099、不碰计划任务、不写运行时目录 |
| `-Force` | 覆盖运行时目录里被手改过的文件（默认会拒绝并提示） |
| `-NewToken` | 轮换 token（**会让手机缓存的 token 失效**，默认沿用旧的） |
| `-RuntimeDir` | 运行时目录，默认 `~\.supervisord-center` |
| `-DryRunPort` | 试运行端口，默认 3098 |

安装脚本做六件事：检查源 → 建运行时目录与配置 → 语法检查 → **迁移**（停旧进程、
注销旧计划任务、归档旧目录）→ 经 WMI 启动 → 健康探测 + 注册登录自启。

## 5. HTTP 接口

**鉴权**：只认请求头，**刻意不支持 `?token=`**（query string 会进访问日志、Referer
和各种中间层，等于给 token 多开几条泄漏路径）。

```powershell
$h = @{ 'x-supervisord-center-token' = '<token>' }   # 或 Authorization: Bearer <token>
```

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health`（也接受 `/` 和 `/super`） | 查状态 |
| `POST` | `/start` | 启动。**幂等**：已在跑则回 `alreadyRunning:true`，无副作用 |
| `POST` | `/restart` | 先停再起 |

`/health` 返回：

```jsonc
{
  "ok": true, "running": true,          // running = TCP 探测目标端口的结果
  "dshWebPort": 3080, "targetPort": 3080,   // 同一值的两个名字，见下
  "supervisorPort": 3099, "centerPort": 3099,
  "launchedPid": null, "launchedAt": null,  // 只记「本实例拉起来的」；别人起的就是 null
  "supervisorPid": 6972, "centerPid": 6972,
  "uptimeSec": 183100
}
```

> `dshWebPort` / `supervisorPort` 是**旧名字，刻意保留** —— 手机 App 侧可能已经在解析它们，
> 改名属于破坏性变更。`targetPort` / `centerPort` 是语义更准的别名，两者永远同值。

## 6. 为什么它能活下来（三个硬机制）

**① 经 WMI 创建，不在 dsh 的 Job Object 里。**
dsh 用 Windows Job Object 管理子进程并在关闭时连带杀掉，`detached:true` 也逃不掉
（`DETACHED_PROCESS` 不解除 Job 成员身份）。install 脚本用
`Win32_Process.Create` 创建，父进程变成 `WmiPrvSE.exe` / `svchost.exe`，天然在 Job 之外。
**这是整套东西能成立的根本原因**，验证方法：

```powershell
$p = Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"
(Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)").Name
# 应为 svchost.exe —— 若是 node.exe/dsh，说明起错了
```

**② 登录自启**：计划任务 `supervisord-center`（AtLogOn），非管理员可注册。

**③ 只有 TCP 探测判断死活**，不用 PID 记账 —— PID 会因重启失效，而端口有人监听是
唯一可靠的存活信号。

## 7. 为什么脚本是纯 ASCII

`install.ps1` 内 **0 个非 ASCII 字节**，这是刻意的，理由同本生态里的
`workbuddy-api.cmd` / `traework-api.cmd`：

Windows PowerShell 5.1 解析**无 BOM** 的 `.ps1` 时用系统 ANSI 代码页（本机 gb2312）。
中文被打乱后，**乱码字节可能吞掉收尾引号**，产生一串指向不相干行号的假语法错误：

```
At install.ps1:214 char:8
+ } else { Ok '娌℃湁鏃ц鍒掍换鍔￠渶瑕佹竻鐞? }
        ~
Missing closing '}' in statement block or type definition.
```

**BOM 不是可靠解法。** 旧 `install-supervisor.ps1` 靠 UTF-8 BOM 承载中文，而 BOM
**会被很多编辑器和工具静默剥掉** —— 本文这个文件在编写过程中就被剥了两次。
依赖它等于把脚本的可用性押在「下一个编辑者用对了工具」上。

纯 ASCII 一次消除整类故障：PS 5.1 / PS 7 都能跑，未来的编辑者不需要任何编码纪律。

> 相关的一个坑：`Replace([char]0xFEFF, '')` **会抛异常** —— `Replace(char,char)`
> 要求第二个参数是 char，传空字符串报 *"String must be exactly one character long"*。
> 剥 BOM 请用 `.TrimStart([char]0xFEFF)`。

## 8. 配置

`config/cfg.template.json` 是模板，install 脚本读它、注入真实 token、生成
`supervisord-center.config.json`。模板里的字段说明写在 JSON 的 `_comment` 数组里。

**配置查找顺序**（第一个存在的胜出，实际选中的会记进日志）：

1. `$env:SUPERVISORD_CENTER_CONFIG`
2. `<项目>/config/supervisord-center.config.json`
3. `<脚本同目录>/supervisord-center.config.json`
4. `~/.supervisord-center/supervisord-center.config.json`

之所以不写死单点：这个脚本有**两种合法摆放方式**（在项目里跑、被拷到别处单文件跑），
迁移期还可能留着旧路径。写死会让「配置该放哪」变成每次都要重新推理的问题。

### 运行时目录

默认 `~/.supervisord-center/`（`$env:SUPERVISORD_CENTER_HOME` 可覆盖）：

```
~/.supervisord-center/
├── supervisord-center.js              # 部署副本
├── supervisord-center.config.json     # 含 token，按凭据对待
└── logs/center.log                    # 超 256 KB 自动清空
```

**刻意不放在 `~/.dsh/` 下** —— 这是「完全独立」的一部分：本进程托管 dsh web，
但它的生命周期、配置、日志都不该跟 dsh 的目录纠缠。dsh 被卸载/重装/换 HOME
都不该影响这里，反过来也一样。

## 9. 从 dsh-supervisor 迁移

### 改名映射表

| 旧 | 新 |
|---|---|
| `~/.dsh/supervisor/dsh-supervisor.js` | `src/supervisord-center.js`（源）+ `~/.supervisord-center/supervisord-center.js`（部署） |
| `dsh-supervisor.config.json` / `cfg.template.json` | `supervisord-center.config.json` / `config/cfg.template.json` |
| `~/.dsh/supervisor.log` | `~/.supervisord-center/logs/center.log` |
| `DSH_SUPERVISOR_CONFIG` | `SUPERVISORD_CENTER_CONFIG` |
| `x-dsh-supervisor-token` | `x-supervisord-center-token`（同时接受 `Authorization: Bearer`） |
| 计划任务 `dsh-supervisor` | `supervisord-center` |
| `install-supervisor.ps1` | `install.ps1` |

**端口 3099 与路径 `/super` 刻意不变** —— 它们是 Tailscale serve 映射和手机 App
的既有约定，改了要动多处配置，收益为零。

**token 默认沿用**（不是重新生成）。理由：手机 App 会把 supervisor 的地址和 token
**缓存下来备用**（DSH 挂掉时它没别的地方可问）。每次重装都换 token 会让那份缓存
静默失效 —— 而这恰恰是最需要它工作的时刻。要轮换得显式 `-NewToken`。

install 脚本会自动完成迁移：停旧进程、注销旧计划任务、**归档**（不删）旧目录到
`~/.supervisord-center/_archive-dsh-supervisor-<时间戳>/`。

### 回滚

旧目录**未被删除**。回滚 = 停掉新进程 + 重放旧任务：

```powershell
Stop-Process -Id (Get-NetTCPConnection -State Listen -LocalPort 3099).OwningProcess -Force
Unregister-ScheduledTask -TaskName 'supervisord-center' -Confirm:$false
# 旧文件仍在 ~/.dsh/supervisor/，按旧方式重新注册即可
```

## 10. 已知耦合（迁移后需要处理的）

### ⚠️ dsh-plugin-center 硬编码了旧路径

```
dsh-plugin-center v0.1.7  lib/index.js:1283
  const configPath = join(DSH_HOME, 'supervisor', 'dsh-supervisor.config.json');
```

插件的 `center.supervisor` 端点**硬编码了旧配置路径**，改名后会失效
（返回 `installed:false`）。

**影响面有限**：该端点是只读的，作用是让手机 App 在 dsh **还活着**时把
supervisor 的地址和 token 拿到并缓存备用。失效后 App 拿不到这一份，
但 supervisor 本身照常工作，`/super/health` 等端点不受影响。

**修法**（二选一，都要动 `dsh-plugins` 仓库并重新发 release）：

1. 改插件里的 `configPath` 指向新路径 `~/.supervisord-center/supervisord-center.config.json`
2. 或在插件里做**路径回退**：先找新路径，不存在再找旧路径

推荐**方案 2** —— 迁移期会有旧实例仍在新版本插件下运行的情况，单向改名会让那部分用户
静默失去这个端点。

## 11. 路线图

- [x] **第一步：建项目 + 改名**（本次完成，已端到端验证，见 §14）
- [ ] **第二步：多服务化** —— 现在配置里的 `dsh` 段是**单服务**的，只支持托管一个。
      改造方向：`services: [{id, name, cmd, args, cwd, port, autostart}]`，
      路由改成 `/services/:id/{start,stop,restart}`，并加 Web 管理页。
- [ ] **第三步：Web 前端管理页** —— 看到连接了哪些服务、启动了哪些。

### 第二步的真正难点：「怎么停」要逐服务设计

不是把配置改成数组就完事。本机三个现有服务的启动方式**根本不同**：

| 服务 | 启动方式 | 停止的坑 |
|---|---|---|
| DSH web | `spawn(node, [bin, 'web', '--no-open'])` | 直连可执行文件，简单 |
| workbuddy / traework | **`.cmd` 启动脚本** | 脚本里有 `:loop` 自愈循环（死了自己 5 秒后重启）。**若只 kill 端口占用者，那个 cmd 会立刻把它拉回来** → 「你杀我起」拉锯 |
| workbuddy | `python -m admin.server` | 是**两个进程**（venv 启动器 + 真身），只按端口 kill 会留下启动器（`DEPLOY.md` 明确记过这条） |

所以多服务化必须先设计**每个服务的 stop 策略**：走 `.cmd` 还是绕过它直连真实进程、
要不要先停掉自愈循环、要不要按进程树 kill。

## 12. 验证记录

改造完成后逐项实测过。**真实 `/restart` 是刻意绕开 DSH 测的** —— 它会杀掉 DSH，
而 DSH 正是执行测试的这个会话的宿主，所以用 `tools/dummy-target.js` 当靶子。

| 项目 | 方法 | 结果 |
|---|---|---|
| 语法 | `node --check` | ✅ 通过 |
| 安装脚本编码 | 统计非 ASCII 字节 | ✅ 0 个（纯 ASCII） |
| 安装脚本语法 | `Parser::ParseFile` | ✅ 无解析错误 |
| **WMI 脱离 Job** | 查新建进程的父进程 | ✅ 父 = `WmiPrvSE.exe`，非 dsh |
| 存活探测 | 假目标（8001，无人监听） | ✅ `running:false` 正确 |
| 鉴权（无 token） | 不带请求头请求 | ✅ 401 |
| 鉴权（`?token=`） | 明确拒绝 query 传参 | ✅ 401 |
| 鉴权（新请求头） | `x-supervisord-center-token` | ✅ 200 |
| 鉴权（Bearer） | `Authorization: Bearer` | ✅ 200 |
| 鉴权（旧请求头） | `x-dsh-supervisor-token` | ✅ 401（证明改名生效） |
| tailnet 端到端 | `https://…ts.net/super/health` | ✅ 200 |
| `/start` 幂等 | DSH 已在跑时调用 | ✅ `alreadyRunning:true`，DSH pid 未变（13512） |
| **`/restart`** | 用假目标测完整链路 | ✅ 靶子换新进程（24524→23844） |
| **无自杀 bug** | `/restart` 后查控制面自身 | ✅ 存活，`uptime` 连续，未触发 `kill(0)` |
| DryRun 零副作用 | 查运行时目录 / 端口 / TEMP | ✅ 三者皆无残留 |
| 迁移 | 真实从 dsh-supervisor 迁 | ✅ 旧进程停、旧任务注销、旧目录归档、新实例 WMI 起、token 沿用 |
| token 沿用 | 首次迁移（新配置不存在） | ✅ 从**旧路径**取到（32 位） |

**全程未触碰正在跑的 DSH web（pid 13512）**，除 `/start` 幂等测试确认它未被重启。

### 测试夹具

```powershell
# tools/dummy-target.js 是个只回一行字的极小 HTTP 服务，
# 用来在**不碰真实 DSH** 的前提下验证 start/restart 全链路。
node tools/dummy-target.js 8099
```

## 13. 安全

| 暴露面 | 现状 | 风险 |
| `3099` 控制面 | 需 token（明文存在配置里），经 `/super` 暴露给 **tailnet** | 拿到 token 的设备可**启动/重启**你的 DSH。不是公网，但 tailnet 内任何拿到 token 的设备都能用 |
| 监听地址 | **恒为 `127.0.0.1`** | 不对外网卡暴露。不要改成 `0.0.0.0`：本机用户不是管理员，Windows 防火墙会拦截，而且外网可达性已交给 Tailscale |
| 配置文件 | 含明文 token | **按凭据对待**，不要进版本库（`.gitignore` 已排除） |

## 14. 文件

```
supervisord-center/
├── src/supervisord-center.js       # 主程序（零依赖，只用 node: 内置模块）
├── config/cfg.template.json        # 配置模板（含字段说明）
├── config/supervisord-center.config.json  # 真实配置，含 token，不入库
├── install.ps1                     # 安装 / 迁移（纯 ASCII）
├── tools/dummy-target.js           # 测试用假服务（验证 start/restart 用）
├── _history/                       # 改造前的旧版本，仅存档
│   ├── dsh-supervisor.released-v1.js
│   ├── review-dsh-supervisor.js
│   └── install-supervisor.ps1
├── docs/
├── logs/
├── .gitignore
└── README.md
```

`_history/review-dsh-supervisor.js` 是 `dsh-supervisor.js` 那个发布版的**改造前快照**
（221 行，端口 3081）。它保留了后来被修掉的几个 bug，有考古价值：
不剥 BOM、`process.kill(launchedPid || 0)` 的自杀路径、允许 `?token=`。
**不要运行它**，只作参考。

`tools/dummy-target.js` 是测试夹具：一个只回一行字的极小 HTTP 服务。
用途是在**不碰真实 DSH** 的前提下验证 `/start` 与 `/restart` 的完整链路
（起进程 → 探活 → kill → 再起）。真实 restart 会杀掉 DSH，而 DSH 正是本会话
的宿主 —— 所以这条路径必须用假目标测：

```powershell
# 起一个指向假服务的独立实例（端口 3096），然后打它的 /start 和 /restart
node tools/dummy-target.js 8099   # 手动起假服务看看
```

## License

MIT
