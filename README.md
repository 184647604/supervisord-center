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
cd C:\path\to\supervisord-center

.\install.ps1 -DryRun    # 先试运行：备用端口起临时实例，绝不碰现有服务
.\install.ps1            # 正式安装 / 从 dsh-supervisor 迁移
```

首次安装会从 `config/cfg.template.json` 生成配置。**模板里的路径是通用的**
（`%APPDATA%\...`、`C:\path\to\your\workspace`），安装时会自动展开环境变量，
但服务路径需要你自己填成实际的。

**已经装过的话，`install.ps1` 默认保留现有配置**，不会用模板覆盖它 ——
否则你辛苦配好的服务路径会被占位符替换掉，而且症状是「服务莫名起不来」，
很难联想到是安装脚本干的。要强制重建才用 `-RegenerateConfig`。

| 参数 | 作用 |
|---|---|
| `-DryRun` | 安全验证：备用端口 3098 起临时实例，假目标 8001，跑完即停。**不碰** 3099、不碰计划任务、不写运行时目录 |
| `-Force` | 覆盖运行时目录里被手改过的文件（默认会拒绝并提示） |
| `-NewToken` | 轮换 token（**会让手机缓存的 token 失效**，默认沿用旧的） |
| `-RuntimeDir` | 运行时目录，默认 `~\.supervisord-center` |
| `-DryRunPort` | 试运行端口，默认 3098 |

安装脚本做六件事：检查源 → 建运行时目录与配置 → 语法检查 → **迁移**（停旧进程、
注销旧计划任务、归档旧目录）→ 经 WMI 启动 → 健康探测 + 注册登录自启。

## 5. 接口速查

**鉴权**：请求头 `x-supervisord-center-token` 或 `Authorization: Bearer <token>`；
浏览器管理页走 Cookie（见 §12）。**刻意不支持 `?token=`** —— query string 会进访问日志、
Referer 和各种中间层，等于给 token 多开几条泄漏路径。

```powershell
$h = @{ 'x-supervisord-center-token' = '<token>' }
```

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/services` | 全部服务 + 在线状态（管理页数据源） |
| `POST` | `/services/<id>/start\|stop\|restart` | 按服务操作 |
| `GET` | `/health` `/super` `/status` | 默认服务的状态，**旧字段名保留** |
| `POST` | `/start` `/restart` | 旧接口，作用于 `defaultService` |
| `GET` | `/` `/ui` | 管理页（无 Cookie 时给登录页） |
| `POST` | `/` `/login` | 用 body 里的 token 换 Cookie |

完整的多服务说明见 §13，逐项验证结果见 §14。

`/health` 返回（字段名沿用旧的，原因见下）：

```jsonc
{
  "ok": true, "running": true,          // running = TCP 探测目标端口的结果
  "dshWebPort": 3080, "targetPort": 3080,   // 同一值的两个名字
  "supervisorPort": 3099, "centerPort": 3099,
  "launchedPid": null, "launchedAt": null,  // 只记「本实例拉起来的」；别人起的就是 null
  "supervisorPid": 10172, "centerPid": 10172,
  "uptimeSec": 949
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

## 8. 配置文件的摆放

`config/cfg.template.json` 是模板，install 脚本读它、注入真实 token、生成
`supervisord-center.config.json`。**服务清单的字段说明见 §13**，这里只讲文件放哪。

**配置查找顺序**（第一个存在的胜出，实际选中的会记进日志）：

1. `$env:SUPERVISORD_CENTER_CONFIG`
2. `<项目>/config/supervisord-center.config.json`
3. `<脚本同目录>/supervisord-center.config.json`
4. `~/.supervisord-center/supervisord-center.config.json`

之所以不写死单点：这个脚本有**两种合法摆放方式**（在项目里跑、被拷到别处单文件跑），
迁移期还可能留着旧路径。写死会让「配置该放哪」变成每次都要重新推理的问题。

> **模板里只能有一个 token 占位符。** 第一版模板在 `_comment` 说明文字里也提了一次
> 占位符，而那段注释在真正的 token 字段**上面**，于是单次 `.Replace()` 替换掉了注释、
> 把真字段留成了字面量 —— 配置能解析、看着也对，但**实际上是空令牌**。
> 实测复现过。现在 install 脚本会先断言占位符恰好出现 1 次，替换后再断言 0 次残留。

### 运行时目录

默认 `~/.supervisord-center/`（`$env:SUPERVISORD_CENTER_HOME` 可覆盖）：

```
~/.supervisord-center/
├── supervisord-center.js              # 部署副本
├── supervisord-center.config.json     # 含 token，按凭据对待
├── logs/center.log                    # 超 256 KB 自动清空
└── _archive-dsh-supervisor-<时间戳>/   # 迁移归档，可回滚
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

- [x] **第一步：建项目 + 改名**
- [x] **第二步：多服务化** —— `services[]` 数组 + `/services/<id>/<动作>` 路由
- [x] **第三步：Web 管理页** —— 见 §12

三步都已完成并上线，现在托管 4 个服务。

## 12. Web 管理页

打开 `https://<你的节点>.ts.net/super`，用 token 登录。

### 界面设计：控制台，不是仪表盘

页面照「机柜控制台」的语汇做，**签名元素是实体指示灯**：内凹底座 + 高光 +
点亮时外溢的辉光。三个状态各有物理含义，且不只靠颜色区分（色觉障碍下也分得清）：

| 灯 | 含义 | 为什么这样定 |
|---|---|---|
| ● 亮绿 | 端口在听 | 正常 |
| ● 亮琥珀 | 在听，但 HTTP 探针不健康 | **这才是真异常**，值得占用一个颜色 |
| ○ 灭（暗红圈） | 端口没听 | **不是故障，只是没开** —— 所以不点亮、不报警、不喊红 |

这个区分是刻意的：把「没开」和「坏了」画成同一个红点，等于让每次「我故意
停掉的」都看起来像事故，久了就没人看状态了。

顶部还有一条**舰队灯带**（每个服务一个小灯）+ `4/4` 计数。它不重复列表信息，
它是「全部」的那个视角：扫一眼就知道有没有灯灭着，不用逐行读。

配色取自机柜：底板近黑 `#0b0f14`、面板 `#121820`、琥珀 `#e3a008` 是唯一的
「操作/注意」色。字体是 system-ui 正文 + 等宽数字（端口/PID/计数用
`tabular-nums`，跳数时不会左右抖）。

### 文字克制

界面上没有一句说明书。规则是：**能靠结构表达的，就不用文字**。

- 状态用灯，不用「在线/离线」四个字占一列
- `HTTP 200` 不显示（健康的 200 是废话），**只在异常时**出现琥珀色 `HTTP 500` 标签
- 主机名在标题里说一次。列表里只显示路径（`/traework/`），不逐行重复同一个域名
- 「自启」用小标签，不写「开机自启动」
- 页脚那行「控制面 3099 · 运行 N 秒 · 配置路径」整行删掉了 —— 那是给我调试看的，
  不是给你用的

### 手机适配

同一份 DOM，宽屏排成矩阵、窄屏叠成卡片，靠 `grid-template-areas` 切换
（`@media (max-width:640px)`）：

```
宽屏                                    窄屏
┌──┬────────┬─────┬──────┬────────┐    ┌──────────────────────┐
│● │DSH GUI │3080 │13512 │/       │    │● DSH Web GUI         │
└──┴────────┴─────┴──────┴────────┘    │端口 3080    PID 13512│
                                        │/                     │
                                        │[启动][重启][停止]     │
                                        └──────────────────────┘
```

窄屏下的具体处理：

- **表头藏起来后，用 `::before` 补回「端口」「PID」字样** —— 否则两个数字
  并排摆着，没人知道哪个是哪个
- **按钮拉满整行**（`flex:1`，高 40px）：手指点得中
- **加入 `env(safe-area-inset-*)`**：刘海屏/手势条不盖住内容
- 工具条的按钮也提到 40px（原来 33px，手机上点起来发飘）
- 登录页**去掉了自动聚焦**：手机上会在加载瞬间弹出键盘盖住半屏
- `viewport-fit=cover` + `<meta name="theme-color">` 跟页面底色一致

实测无横向溢出：320 / 360 / 390 / 414 / 641 / 768 / 1600 px 逐档量过
`scrollWidth`，全部等于视口宽度。

### 可访问性

- 用 `<ul>/<li>` 而不是 `<table>`：一旦给 `tr/td` 套 grid，读屏软件就丢掉表格语义
- 灯是 `role="img"` + `aria-label="在线"`，不是纯装饰
- 计数和提示条都带 `aria-live`，状态变化会被读出来
- 所有可交互元素 `:focus-visible` 有可见轮廓（实测逐个聚焦确认）
- `prefers-reduced-motion` 下关掉全部过渡与动画
- 长服务名单行截断 + `title` 兜底，不会撑破布局

### 首屏点亮动画

灯从上到下依次亮起（每行错开 45ms），像控制台通电。**只放一次** ——
之后每 5 秒的自动刷新不再重放，否则会一直闪。

### 浏览器怎么过鉴权

API 用请求头，但**浏览器导航设不了请求头**。所以管理页走另一条路：

```
GET  /super              → 无 Cookie 时返回登录页（不是干巴巴的 401 JSON）
POST /super  token=...   → 校验通过后 Set-Cookie: sdc_session=...; HttpOnly
GET  /super              → 带 Cookie，返回管理页
```

三个刻意的设计：

1. **token 放在 POST body 里，不进 URL** —— 和「不支持 `?token=`」是同一条理由：
   query string 会进访问日志、Referer、浏览器历史。
2. **Cookie 里存的不是 token**，而是 `HMAC-SHA256(token, 固定串)`。token 是长期凭据，
   浏览器会把它落到磁盘的 cookie 库；派生值同样能证明「持有 token」，
   但泄漏出去不能直接当 API token 用，而且**换 token 就自动失效**。
3. **`HttpOnly` 开，`Secure` 不开** —— loopback 直连是 HTTP，开 `Secure` 会让
   `http://127.0.0.1:3099` 登录失效（和 workbuddy 的 `ADMIN_INSECURE_COOKIE`、
   doubao 的 `SECURE_COOKIE` 是同一个权衡）。

### 登录限流（token 变短后必须有）

**为什么加**：token 是可配置的。一旦选成人能记住的短串（比如纯数字手机号），
搜索空间就从 32 位随机串（约 2^256）掉到 11 位数字（10^11，且按手机号规律
实际更小）。而登录接口原本**没有任何节流**，可以无限次猜。
workbuddy 和 doubao 的控制台都做了「10 分钟 8 次」限流，这里照同一个约定：

```
前 8 次失败  → 401，返回「令牌不正确」
             → 快用完时改口：「令牌不正确，还可尝试 3 次」
第 9 次起    → 429 + Retry-After，返回「尝试次数过多，请 10 分钟后再试」
成功登录     → 清空该来源的失败计数
```

用 `loginMaxFails` / `loginWindowMs` 可调（默认 8 次 / 10 分钟）。

**按来源 IP 分桶 —— 但实测只有一个桶。** 经 tailscale serve 进来的请求，
`remoteAddress` **全是 `127.0.0.1`**（serve 从本机回环转发）：

```
2026-09-27T18:48:07.238Z login ok from 127.0.0.1
2026-09-27T18:53:51.534Z 401 POST /login from 127.0.0.1
```

所以限流实际是**全局单桶**。这对本工具是**想要**的行为：单用户场景下，
攻击者无法靠换源 IP 绕过。代码仍按 IP 分桶而不是写死全局，这样直连
（不经 serve）时语义依然正确。

**代价要说清楚**：全局桶意味着攻击者可以把桶打满，让**你自己**也暂时登不进去
（实测第 4 步验证了「限流中正确 token 同样被 429」）。这是有意的取舍 ——
短暂登不上，好过被无限次猜测。两个缓解：

- **成功即清空**计数，所以正常使用不会累积到被锁（有测试覆盖）。
- 计数是**内存态**，重启控制面即清零（也就等于 `install.ps1` 重启一次）。

**真正该做的还是用长随机 token。** 限流是兜底，不是把短 token 变安全的办法 ——
`install.ps1 -NewToken` 会生成 43 位 URL-safe 随机串。

### 换 token 的连带影响

`sessionValue()` 是 `HMAC(token)`，所以**换 token 会让所有已签发的 Cookie 立刻失效**，
需要重新登录。这是刻意的（见上面第 2 条），但换之前要知道：
手机上如果存过登录态，换完要重新输一次。

`install.ps1` 默认**沿用**旧 token（只在显式 `-NewToken` 时轮换），
正是为了避免这种「静默失效」。

无 Cookie 且 `Accept: text/html` 时给登录页，API 调用仍给 401 JSON ——
否则手机上打开 `/super` 只会看到一行 `{"error":"unauthorized"}`，没人知道该干嘛。

### 路径前缀的坑（已处理）

tailscale serve 会把 `/super` **剥掉**再转发（实测：`/super/nonexistent` 拿到的是
本进程的 404 JSON，不是 DSH 的页面）。所以服务端只看到 `/`，**不知道自己挂在哪个前缀下**。

浏览器侧的相对路径解析又依赖末尾斜杠：访问 `/super`（无斜杠）时 `fetch('services')`
会解析到 `https://host/services`，**打到 DSH 上去**。页面因此用 JS 从
`location.pathname` 反推 base 并补斜杠，`/super` 和 `/super/` 两种访问都测过。

### 改页面怎么改（别直接改中转文件）

页面是嵌在 `supervisord-center.js` 里的模板字面量，不是外部 `.html` ——
**单文件部署是这个项目的设计约束**（§6：不能有构建步骤，断网也要能跑）。
但直接在一个 JS 字符串里编辑 15000 字符的 HTML 很难受，编辑器补全、
缩进、语法高亮全都不认。于是有个拆/装工具：

```
node tools/splice-page.js extract   # PAGE_HTML -> src/_newpage.html
（用普通 HTML 工具改 src/_newpage.html）
node tools/splice-page.js           # 拼回 supervisord-center.js
node tools/verify-page.js           # 自检：确认装进去了、旧标记没残留
```

三条必须知道的：

1. **`src/supervisord-center.js` 里的 `PAGE_HTML` 才是唯一真相。**
   `src/_newpage.html` 只是中转副本，**不入库**（`.gitignore` 已排除）。
   两份都入库 = 第二份真相 = 「代码里是新的、跑起来是旧的」，
   这个项目在配置上已经吃过一次这个亏（§13）。
2. **拼接会拒绝含反引号 / `${` / 反斜杠的页面。** 这三种字符会破坏
   JS 模板字面量或造成意外插值。工具会先检查再写，发现就中止且不改源文件。
   踩过一次：页面里有个正则 `/^https?:\/\//`，反斜杠直接把字面量拆了。
   解法是用 `indexOf` 之类绕开正则，而不是去转义（转义会层层叠加）。
3. **拼接是无损的**：`extract` → 立即拼回，源文件 SHA256 不变（实测过）。

## 13. 多服务配置

```jsonc
{
  "port": 3099, "host": "127.0.0.1", "token": "…",
  "defaultService": "dsh",          // 旧接口 /start /restart 指向谁（App 兼容）
  "services": [
    { "id": "dsh", "name": "DSH Web GUI", "port": 3080, "via": "node",
      "node": "C:\\Program Files\\nodejs\\node.exe",
      "bin": "…\\@deepseek-ai\\dsh\\lib\\bin.js",
      "args": ["web", "--no-open"], "cwd": "…\\DeepSeek Harnss",
      "path": "/", "autostart": false },

    { "id": "traework", "name": "Traework API", "port": 39311, "via": "cmd",
      "file": "…\\Startup\\traework-api.cmd",
      "path": "/traework/", "healthPath": "/v1/models" }
  ]
}
```

| 字段 | 作用 |
|---|---|
| `id` | 稳定标识，出现在 URL 里。别随便改 |
| `port` | **存活探测端口 —— 在线/离线的唯一判据** |
| `via` | `node` 直起可执行文件；`cmd` 起 `.cmd` 包装器 |
| `path` | tailnet 路径前缀，只用于在页面上拼链接 |
| `autostart` | 本进程启动后是否顺手拉起它 |
| `healthPath` | 可选 HTTP 探针，**只是补充信息**；端口通但 HTTP 500 也是有用信号 |

### 关键决策：直接复用各项目自己的 `.cmd`

**没有**把环境变量抄进配置里。每个项目本来就有启动脚本（`doubao-api.cmd`、
`traework-api.cmd`、`workbuddy-api.cmd`），里面有一堆关键配置
（`DOUBAO2API_ADMIN_KEY`、`TRAE_PROXY_DISABLE_API_KEY`、`MANAGEMENT_DATA_DIR`…）。
抄一份到配置里等于制造第二份真相 —— 以后改脚本，服务端还按旧的起，**而且没人会发现**。
所以配置只记「用哪个脚本」。

**但要注意指向哪一份**：`traework` 和 `workbuddy` 有**两份不同的**启动脚本 ——
启动文件夹里那份和项目内那份内容不同（启动文件夹版多了 `TRAE_PROXY_HOST` /
`TRAE_PROXY_DISABLE_API_KEY` 等设置，项目版没有），而**当前实际在跑的是启动文件夹那份**。
配置指向的是启动文件夹，因为它们不等价。

### `.cmd` 包装器的 `:loop` 与 `timeout`（实测数据，别想当然）

包装器末尾都有：

```bat
:loop
"%PY%" -m admin.server
timeout /t 5 /nobreak >nul
goto loop
```

`timeout` 需要一个**真正的控制台**做 stdin。少了它，循环会退化成**紧循环**。
`tools/probe-launch.js` 量出来的结果：

| spawn 配置 | 服务能否拉起 | 崩溃时 7 秒内循环次数 |
|---|---|---|
| `detached: true` + `windowsHide` | ✅ | **2 次**（正常节流） |
| `detached: false` | ✅ | **166 次**（紧循环，≈每秒 24 次重启风暴） |
| `shell: true` | ✅ | 2 次 |

**决定因素是 `detached: true`**，不是「有没有控制台」。少了它，一个崩溃的服务会变成
每秒二十几次的重启风暴 —— 这个数字值得跑一次探针去量，而不是靠推理。

> 我一开始用 `ProcessStartInfo` 手工搭管道去测，得到「紧循环」的结论并差点据此
> 绕开 `.cmd`。后来发现那是**管道句柄**导致的假象，与 `detached` 无关。
> 换成真正的 spawn 才量到上表。**测试夹具本身出错，比不测更危险** ——
> 它会让你基于错的事实做出「正确」的决定。

### 「停止」为什么必须杀包装器

`killService` 的顺序是**先杀包装器，再杀端口占用者**：

1. `taskkill /PID <包装器> /T /F` —— `/T` 带上它的整棵子树（也就是真正监听的那个进程）
2. 再按端口反查、杀残留

顺序反了就会变成「你杀我起」的拉锯：包装器的 `:loop` 会在 5 秒后把服务拉回来，
你看到的现象是**「停止成功了但服务还在」**。

这也说明「停止」在这套架构里是**尽力而为**，不是核心语义 —— 用户明确说过
自愈循环「没有影响」，要的是**看到在线/离线 + 能拉起来**。诚实地讲：
如果某个包装器以我们认不出的姿势启动（命令行里没有配置的脚本路径），
`/stop` 后服务会自己回来，接口会如实返回 `stillRunning: true`，不假装成功。

### HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/services` | 全部服务 + 状态（管理页数据源） |
| `POST` | `/services/<id>/start` | 启动（幂等） |
| `POST` | `/services/<id>/stop` | 尽力停（先杀包装器） |
| `POST` | `/services/<id>/restart` | 停再起 |
| `GET` | `/health` `/super` `/status` | 单服务状态，**旧字段名保留** |
| `POST` | `/start` `/restart` | 旧接口，作用于 `defaultService` |
| `GET` | `/` `/ui` | 管理页（无 Cookie 给登录页） |
| `POST` | `/` `/login` | 用 body 里的 token 换 Cookie |

**旧接口和旧字段名全部保留**：`/health` 仍返回 `dshWebPort` / `supervisorPort`，
`/start` `/restart` 仍在 —— 手机 App 侧可能已经在解析它们，改名属于破坏性变更。

## 14. 验证记录

全部逐项实测。**真实 `/restart` 刻意绕开 DSH 测** —— 它会杀掉 DSH，而 DSH 正是
执行测试的这个会话的宿主。

### 第一步：建项目 + 改名

| 项目 | 方法 | 结果 |
|---|---|---|
| 语法 | `node --check` | ✅ 通过 |
| 安装脚本编码 | 统计非 ASCII 字节 | ✅ 0 个（纯 ASCII） |
| 安装脚本语法 | `Parser::ParseFile` | ✅ 无解析错误 |
| **WMI 脱离 Job** | 查新建进程的父进程 | ✅ 父 = `WmiPrvSE.exe`，非 dsh |
| 存活探测 | 假目标（8001，无人监听） | ✅ `running:false` 正确 |
| 鉴权（无 token） | 不带请求头 | ✅ 401 |
| 鉴权（`?token=`） | 拒绝 query 传参 | ✅ 401 |
| 鉴权（新请求头） | `x-supervisord-center-token` | ✅ 200 |
| 鉴权（Bearer） | `Authorization: Bearer` | ✅ 200 |
| 鉴权（旧请求头） | `x-dsh-supervisor-token` | ✅ 401（证明改名生效） |
| `/start` 幂等 | DSH 已在跑时调用 | ✅ `alreadyRunning:true`，DSH pid 未变 |
| **`/restart`** | 用假目标测完整链路 | ✅ 靶子换新进程（24524→23844） |
| **无自杀 bug** | `/restart` 后查控制面自身 | ✅ 存活，`uptime` 连续，未触发 `kill(0)` |
| DryRun 零副作用 | 查运行时目录 / 端口 / TEMP | ✅ 皆无残留 |
| 迁移 | 真实从 dsh-supervisor 迁 | ✅ 旧进程停、旧任务注销、旧目录归档、token 沿用 |
| token 沿用 | 首次迁移（新配置不存在） | ✅ 从**旧路径**取到（32 位） |

### 第二步 + 第三步：多服务 + 管理页

| 项目 | 方法 | 结果 |
|---|---|---|
| 启动方式探针 | `tools/probe-launch.js`，4 种 spawn 配置 | ✅ 量出 `detached` 是 `timeout` 节流的关键（见 §13） |
| 服务识别 | `GET /services` | ✅ 4 个服务全识别，端口/PID/HTTP 探针都对 |
| 旧字段兼容 | `GET /health` | ✅ 仍返回 `dshWebPort` / `supervisorPort` |
| 浏览器过鉴权 | 无 Cookie + `Accept: text/html` | ✅ 返回登录页而非 401 JSON |
| 错误 token 登录 | `POST /` body `token=wrong` | ✅ 401 |
| 正确 token 登录 | `POST /` | ✅ 204 + `Set-Cookie`（`HttpOnly` 确认） |
| Cookie 访问 API | 带会话 Cookie | ✅ 200 |
| `?token=` 仍拒 | 登录页之后依旧不认 query | ✅ 401 |
| **`/stop` 杀包装器** | 停 traework（带 `:loop`） | ✅ 端口释放、包装器消失、**等 8 秒 > 5 秒循环周期未被拉回** |
| **`/start` 拉起来** | 再启动 traework | ✅ 1.5 秒起好，`/v1/models` 返回 **19 个模型** |
| `/start` 幂等 | 已在跑时再调 | ✅ `alreadyRunning:true` |
| 包装器重建 | 起后查 `cmd.exe` | ✅ 新包装器 pid=9984，父子关系正常 |
| tailnet 不受影响 | `/traework/v1/models` | ✅ 200，19 个模型 |
| 管理页渲染 | Playwright 截图 | ✅ 4 行服务、状态/端口/PID/链接/按钮齐全 |
| **`/super` 无尾斜杠** | 直接访问无斜杠 URL | ✅ base 归一化为 `/super/`，4 行数据正常加载 |
| **UI 点「重启」** | 点 Doubao 的重启按钮 | ✅ PID 变化（20000→3464），重启后 `/health` 返回 `logged_in:true` |
| 生产部署 | WMI 重启到多服务版 | ✅ 父进程 `WmiPrvSE.exe`，4 服务全部在线 |

### 登录限流（`tools/test-login-ratelimit.js`，13 项全过）

在备用端口起隔离实例测的，不碰生产：

| 项目 | 结果 |
|---|---|
| 新 token 走请求头 / Bearer | ✅ 200 / 200 |
| 错一位的 token | ✅ 401 |
| 前 8 次失败 | ✅ 全 401 |
| 第 9 次失败 | ✅ 429 |
| 429 带 `message` 与 `retryAfterSec` | ✅ `"尝试次数过多，请 10 分钟后再试"`, 600 |
| 限流中正确 token 也被挡 | ✅ 429（全局桶的有意代价） |
| 重启后计数清零 | ✅ 204 |
| 成功登录清空计数 | ✅ 成功后连失 7 次仍未限流 |
| Cookie 会话不受登录限流影响 | ✅ 200 |

真机（tailnet）上也点了一遍：第 5 次失败时页面显示「令牌不正确，还可尝试 3 次」，
第 9 次显示「尝试次数过多，请 10 分钟后再试」—— **不是静默无反应**。

### token 轮换

| 项目 | 结果 |
|---|---|
| 改 token 后本机 API | ✅ 200 |
| **旧 token 失效** | ✅ 401 |
| tailnet `/super/services` | ✅ 4 个服务全在线 |
| 表单登录换 Cookie | ✅ 204 + Cookie |
| **旧 Cookie 自动失效** | ✅ `HMAC(token)` 派生，换 token 即失效（登录页重新出现） |

**全程未触碰正在跑的 DSH web（pid 13512）**。

### 界面改版（§12）

改版是在**隔离试验台**上做的（`tools/ui-harness.js`，3091 端口），
理由：生产控制面管着正在跑的 DSH，也就是宿主进程本身，拿它当渲染试验台，
手滑点到「重启」就可能把自己的会话弄没。

| 项目 | 结果 |
|---|---|
| 三种灯态渲染 | ✅ 绿(健康) / 琥珀(HTTP 500) / 灭(离线) 各自正确 |
| 舰队灯带与计数 | ✅ 与列表同源，`2/3` → `3/3` 同步变化 |
| 启动链路 | ✅ 点「启动」后灯变绿、PID 出现、计数 +1、绿色提示条 |
| 停止链路 | ✅ 灯熄灭、PID 变 `—`、计数 −1 |
| 失败提示 | ✅ 琥珀/红色提示条带 tone 配色，文案说清是哪个服务 |
| 横向溢出 | ✅ 320/360/390/414/641/768/1600px 全部无溢出 |
| 触摸目标 | ✅ 手机上所有按钮 ≥40px 高 |
| 焦点可见 | ✅ 逐个聚焦确认，禁用按钮正确跳过 |
| `prefers-reduced-motion` | ✅ 规则解析成功，过渡与动画全关 |
| 长名字截断 | ✅ 超长名字省略号收尾，不撑破布局 |
| 控制台报错 | ✅ 0 errors / 0 warnings |
| 路径前缀 `/super` 无斜杠 | ✅ 仍渲染 4 行（老坑未回归） |
| 登录限流回归 | ✅ 13 项仍全过 |
| 生产端到端 | ✅ tailnet 上 4/4 全绿，桌面与手机各截图确认 |

### 测试夹具

```powershell
node tools/dummy-target.js 8099        # 极小 HTTP 假服务，测 start/restart 全链路
node tools/probe-launch.js             # 量各种 spawn 配置下 :loop 是否被节流
node tools/test-login-ratelimit.js     # 登录限流 13 项断言（隔离端口，不碰生产）
node tools/ui-harness.js               # 界面试验台（3091，三个假服务覆盖三种灯态）
node tools/ui-harness.js stop          # 停掉试验台
node tools/verify-page.js              # 拼接后自检：确认页面是新版且无旧标记
node tools/splice-page.js extract      # 把 PAGE_HTML 导出成 src/_newpage.html（改页面用）
node tools/splice-page.js              # 把 src/_newpage.html 拼回 PAGE_HTML 字面量
```

`probe-launch.js` 的价值在于它**推翻了我自己的一个错误结论**（见 §13 末尾）。

`ui-harness.js` 的价值类似：界面这种东西**光看代码看不出好坏**。
它起了三个状态不同的假服务（健康 / HTTP 500 / 离线），
才能在真实浏览器里把三种灯态、窄屏塌陷、点击链路一次性看全。

## 15. 安全

| 暴露面 | 现状 | 风险 |
|---|---|---|
| `3099` 控制面 | 需 token（明文存在配置里），经 `/super` 暴露给 **tailnet** | 拿到 token 的设备可**启动/重启你的服务**（含 DSH）。不是公网，但 tailnet 内任何拿到 token 的设备都能用 |
| **token 强度** | 当前是可配置的短串 | **这是最弱的一环**。限流（10 分钟 8 次）兜住了在线爆破，但挡不住离线猜测 —— token 明文存在配置文件和 tailnet 客户端的缓存里。要更稳就用 `install.ps1 -NewToken` 换成 43 位随机串 |
| 浏览器会话 Cookie | `HMAC(token)` 派生值，`HttpOnly`，30 天 | 派生值泄漏不能直接当 API token 用，且换 token 即失效 |
| 登录限流 | 10 分钟 8 次，全局单桶（来源都是 127.0.0.1） | 攻击者打满桶会让你也暂时登不进去；重启即清零 |
| 监听地址 | **恒为 `127.0.0.1`** | 不对外网卡暴露。不要改成 `0.0.0.0`：本机用户不是管理员，Windows 防火墙会拦截，而且外网可达性已交给 Tailscale |
| 配置文件 | 含明文 token | **按凭据对待**，不要进版本库（`.gitignore` 已排除） |
| 管理页的「停止」 | 能杀掉带 `:loop` 的包装器 | 这是有意的：能停才能重启。但也意味着误操作能停掉服务——tailnet 内拿到 token 即可 |
| **凭据复用** | 本 token 与 workbuddy 的 `ADMIN_KEY`、doubao 的 `DOUBAO2API_ADMIN_KEY` 同值 | **一处泄漏即三处失守**。想隔离就分开设，代价是要多记几个串 |

## 16. 文件

```
supervisord-center/
├── src/supervisord-center.js       # 主程序（零依赖，只用 node: 内置模块）
├── config/cfg.template.json        # 配置模板（含字段说明）
├── config/supervisord-center.config.json  # 真实配置，含 token，不入库
├── install.ps1                     # 安装 / 迁移（纯 ASCII）
├── tools/dummy-target.js           # 测试夹具：极小 HTTP 假服务
├── tools/probe-launch.js           # 测试夹具：量 :loop 节流与 spawn 配置
├── tools/test-login-ratelimit.js   # 测试夹具：登录限流 13 项断言
├── tools/ui-harness.js             # 界面试验台（隔离端口 + 三种灯态的假服务）
├── tools/ui-fakes.js               # 试验台用：常驻假服务
├── tools/ui-target.js              # 试验台用：可被真正启动的目标
├── tools/splice-page.js            # 页面拆/装（extract / 拼回 PAGE_HTML）
├── tools/verify-page.js            # 拼接后自检（防旧标记残留）
├── _history/                       # 改造前的旧版本，仅存档
│   ├── dsh-supervisor.released-v1.js
│   ├── review-dsh-supervisor.js
│   └── install-supervisor.ps1
└── README.md
```

`_history/review-dsh-supervisor.js` 是 `dsh-supervisor.js` 那个发布版的**改造前快照**
（221 行，端口 3081）。它保留了后来被修掉的几个 bug，有考古价值：
不剥 BOM、`process.kill(launchedPid || 0)` 的自杀路径、允许 `?token=`。
**不要运行它**，只作参考。

### 测试夹具为什么值得留在仓库里

两个 `tools/*.js` 都是夹具，但它们记录的是**结论的来路**：

- `dummy-target.js` —— 真实 `/restart` 会杀掉 DSH，而 DSH 正是开发时会话的宿主。
  没有它，这条路径就只能靠推理，而推理在这件事上错过一次（见下）。
- `probe-launch.js` —— 它**推翻了我自己的一个错误结论**。我先前手工用
  `ProcessStartInfo` 搭管道测出「`:loop` 会变成紧循环」，差点据此绕开复用 `.cmd`。
  换成真正的 `spawn` 才量到：决定因素是 `detached: true`，而管道才是元凶。
  **夹具本身出错比不测更危险** —— 它会让你基于错的事实做出「正确」的决定。

## License

MIT
