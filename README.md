# supervisord-center

Windows 上的**服务托管中枢**：一个零依赖的常驻进程，用 HTTP 控制面枚举本机服务、
探测在线状态、把挂掉的服务拉起来。

- **零依赖** —— 只用 Node 内置模块，没有 `package.json`，不需要构建，离线可跑
- **单文件部署** —— 主程序就是一个 `.js`，拷到哪都能跑
- **独立生命周期** —— 刻意不属于任何被托管的服务，也不放在它们的目录下

<details>
<summary>为什么需要它（Tailscale 做不到这件事）</summary>

被托管的服务一旦死了，本机上就**没有任何东西在听**，远程再怎么发请求也没人接。

Tailscale 的两个功能名字很像，但都不管进程：

| 功能 | 实际作用 | 是我们要的吗 |
|---|---|---|
| **Serve** | 把本机端口映射成 `https://<节点>.ts.net/<路径>` | ❌ 只是反向代理，本项目**在用它**，但它不管进程 |
| **Services** | 把资源发布成 tailnet 内固定名字，多主机负载均衡 | ❌ 网络**路由**层，不是进程管理 |

[Tailscale Services 文档](https://tailscale.com/docs/features/tailscale-services)本身就假设
**资源已经被你启动了**（原文：*Make sure to **start the resource** on a device in a tailnet*）。
它的状态（`Pending approval` / `Connected` / `Offline`…）全是**端点发布状态**，与进程死活无关。
另外 Service host 必须用 tag 身份（*You cannot use a device authenticated with a user
account as a Service host*），普通用户账号用不了。

**根本原因**：Tailscale 在网络层工作，它**无法启动一个已经死掉的进程**。必须有一个
生命周期独立的进程外守护 —— 这就是本项目。

</details>

## 快速开始

需要 **Windows** + **Node.js 16+** + **PowerShell 5.1**（Windows 10/11 自带）。

主程序只用 `node:` 内置模块，语法上最低到 Node 14.18，但只在 16+ 上验证过。
`install.ps1` 用到 `Register-ScheduledTask` / `Invoke-CimMethod` / `Get-NetTCPConnection`，
都是 PS 5.1 自带模块，**不需要管理员权限**。

```powershell
.\install.ps1 -DryRun    # 先试运行：备用端口起临时实例，不碰任何现有服务
.\install.ps1            # 正式安装
```

`-DryRun` 会在备用端口 3098 起一个一次性实例、跑完自检就停，**不碰** 3099、
不碰计划任务、不写运行时目录。强烈建议先跑它。

安装脚本做六件事：检查源 → 建运行时目录与配置 → 语法检查 → 迁移（若有旧版）
→ 经 WMI 启动 → 健康探测 + 注册登录自启。

| 参数 | 作用 |
|---|---|
| `-DryRun` | 安全验证，跑完即停，零副作用 |
| `-Force` | 覆盖运行时目录里被手改过的文件（默认拒绝并提示） |
| `-NewToken` | 轮换 token（**会让已缓存的客户端凭据失效**） |
| `-RegenerateConfig` | 用模板重建配置（**默认不用模板覆盖已有配置**，原因见下） |
| `-RuntimeDir` | 运行时目录，默认 `~\.supervisord-center` |
| `-DryRunPort` | 试运行端口，默认 3098 |

> **已有配置默认不会被覆盖。** 模板里是通用路径，若用它覆盖你正在用的配置，
> 真实服务路径会被占位符替换，症状是「服务莫名起不来」，很难联想到是安装脚本干的。
> 所以要重建得显式加 `-RegenerateConfig`。

装完打开 `https://<你的节点>.ts.net/super`，用 token 登录。若还没映射：

```powershell
tailscale serve --bg --https=443 --set-path=/super http://127.0.0.1:3099
tailscale serve status
```

## 配置

`config/cfg.template.json` 是模板，install 脚本读它、注入 token、展开 `%VAR%` 环境变量，
生成 `supervisord-center.config.json`。

**服务清单是全部配置的核心**，加一个服务就是加一个数组项：

```jsonc
{
  "port": 3099,
  "host": "127.0.0.1",
  "token": "__TOKEN__",
  "defaultService": "my-app",
  "services": [
    {
      "id": "my-app",                    // 稳定标识，出现在 URL 里，别随便改
      "name": "My Web App",              // 显示名
      "port": 8080,                      // 存活探测端口 —— 在线/离线的唯一判据
      "via": "node",                     // node = 直接起可执行文件
      "node": "C:\\Program Files\\nodejs\\node.exe",
      "bin": "%APPDATA%\\npm\\node_modules\\my-app\\bin.js",
      "args": ["serve"],
      "cwd": "C:\\path\\to\\workspace",
      "path": "/",                       // tailnet 路径前缀，仅用于拼链接
      "autostart": false
    },
    {
      "id": "legacy",
      "name": "Legacy API",
      "port": 9000,
      "via": "cmd",                      // cmd = 起 .cmd 包装器
      "file": "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\legacy-api.cmd",
      "path": "/legacy/",
      "healthPath": "/health",           // 可选 HTTP 探针，仅作补充信息
      "note": "显示在管理页上的说明"
    }
  ]
}
```

| 字段 | 作用 |
|---|---|
| `id` | 稳定标识，出现在 URL 里。改它等于改接口 |
| `port` | **存活探测端口 —— 在线/离线的唯一判据** |
| `via` | `node` 直起可执行文件；`cmd` 起 `.cmd` 包装器 |
| `path` | tailnet 路径前缀，只用于在页面上拼链接 |
| `autostart` | 本进程启动后是否顺手拉起它 |
| `healthPath` | 可选 HTTP 探针，**只是补充信息**：端口通但 HTTP 500 也是有价值的信号 |

**配置查找顺序**（第一个存在的胜出，选中的会记进日志）：

1. `$env:SUPERVISORD_CENTER_CONFIG`
2. `<项目>/config/supervisord-center.config.json`
3. `<脚本同目录>/supervisord-center.config.json`
4. `~/.supervisord-center/supervisord-center.config.json`

不写死单点，是因为这脚本有两种合法摆放方式（在项目里跑、单文件拷到别处跑）。

### 复用各服务自己的启动脚本，不要抄环境变量

**没有**把环境变量抄进配置里。如果每个服务本来就有启动脚本（`.cmd` / `.ps1`），
里面通常有一堆关键配置。抄一份到配置里等于制造**第二份真相** —— 以后改了脚本，
服务端还按旧的起，而且没人会发现。所以配置只记「用哪个脚本」。

> **注意指向哪一份。** 同一个服务可能存在**两份内容不同**的启动脚本（例如启动文件夹里
> 的副本和项目内的副本）。配置要指向**实际在用的那份**，它们不等价。

### 配置里的坑：模板只能有一个 token 占位符

第一版模板在 `_comment` 说明文字里也提了一次占位符，而那段注释在真正的 token 字段
**上面**，于是单次 `.Replace()` 替换掉了注释、把真字段留成了字面量 —— 配置能解析、
看着也对，但**实际上是空令牌**。实测复现过。

现在 install 脚本会先断言占位符恰好出现 1 次，替换后再断言 0 次残留，最后还要
`ConvertFrom-Json` 验证产物能解析。

## HTTP 接口

**鉴权**：请求头 `x-supervisord-center-token` 或 `Authorization: Bearer <token>`。

**刻意不支持 `?token=`** —— query string 会进访问日志、Referer 和各种中间层，
等于给 token 多开几条泄漏路径。

```powershell
$h = @{ 'x-supervisord-center-token' = '<token>' }
Invoke-RestMethod http://127.0.0.1:3099/services -Headers $h
```

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/services` | 全部服务 + 在线状态（管理页数据源） |
| `POST` | `/services/<id>/start` | 启动（幂等） |
| `POST` | `/services/<id>/stop` | 尽力停（先杀包装器，见下） |
| `POST` | `/services/<id>/restart` | 停再起 |
| `GET` | `/health` `/status` | 默认服务的状态 |
| `POST` | `/start` `/restart` | 作用于 `defaultService` |
| `GET` | `/` `/ui` | 管理页（无 Cookie 时给登录页） |
| `POST` | `/` `/login` | 用 body 里的 token 换 Cookie |

**浏览器怎么过鉴权**：导航请求设不了请求头，所以管理页单独走一条路 ——
`POST` body 里的 token 换取 `HttpOnly` Cookie；无 Cookie 且 `Accept: text/html`
时返回登录页，API 调用仍返回 401 JSON（否则手机上打开只会看到一行
`{"error":"unauthorized"}`，没人知道该干嘛）。

Cookie 里存的是 `HMAC-SHA256(token, 固定串)` 而**不是 token 本身**：派生值同样能证明
「持有 token」，但泄漏出去不能直接当 API token 用，而且**换 token 就自动全部失效**。

## 为什么它能活下来

### ① 经 WMI 创建，不在父进程的 Job Object 里

Windows 上 `spawn` 出的子进程会进入父进程的 **Job Object**，父进程退出时会被连带杀掉 ——
`detached: true` **也逃不掉**（`DETACHED_PROCESS` 不解除 Job 成员身份）。

所以 install 脚本用 `Win32_Process.Create` 创建，父进程变成 `WmiPrvSE.exe` / `svchost.exe`，
天然在 Job 之外。**这是整套东西能成立的根本原因。** 验证方法：

```powershell
$p = Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"
(Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)").Name
# 应为 svchost.exe —— 若为 node.exe，说明起错了，父进程一退它就会跟着死
```

### ② 登录自启

计划任务 `supervisord-center`（AtLogOn 触发器）。非管理员可注册，`Register-ScheduledTask`
不需要提权。

三点值得留意：

- **是「登录时」不是「开机时」。** 触发器是 logon，没有 BootTrigger。重启后无人登录，
  控制面不会起来。要开机即起得改用开机触发器并以「不管用户是否登录都运行」的身份注册，
  那需要管理员权限和保存密码 —— 本项目刻意不要求管理员。
- **默认有 72 小时运行上限。** `New-ScheduledTaskSettingsSet` 不指定时取系统默认
  `ExecutionTimeLimit=PT72H`，连续跑满三天会被任务计划程序**强杀**，而 `RestartCount=0`
  不会自动回来。要取消就在注册时加 `-ExecutionTimeLimit ([TimeSpan]::Zero)`（零 = 不限）。
- **`Start-ScheduledTask` 起不来时不会报错。** 如果旧进程还占着端口，新进程会
  `EADDRINUSE` 退出，而任务状态仍然显示 Ready，`LastTaskResult` 才是线索。
  重启前先确认端口已释放。

各服务自己的自启走**启动文件夹**（`shell:startup`），与控制面互不知情。控制面的
`autostart` 只对**没有别的自启机制**的服务有意义 —— 已经在启动文件夹里的不需要它，
开了反而两边抢着启动。

> **什么时候必须用转发壳而不是复制。** 若脚本用 `%~dp0` 定位自己的项目目录
> （`set "PROJ=%~dp0"`），把它**复制**进启动文件夹会让 `%~dp0` 指向启动文件夹，
> 项目目录随之出错（找不到虚拟环境）。改为放一个转发壳：
>
> ```bat
> @echo off
> call "C:\path\to\real\launcher.cmd"
> exit /b %ERRORLEVEL%
> ```
>
> `call` 不改变被调脚本看到的 `%~dp0`，所以真实脚本仍能定位自己。顺带还避免了
> 把脚本里的密钥复制到第二处。实测确认 `%~dp0` 在 `call` 转发下不变。
>
> 反过来，脚本若不依赖自身位置（路径全写死），直接复制即可，少一层间接。

改了启动脚本后，记得同步配置里 `file` 指向的那一份 —— 指错了「停止」会失效。

### ③ 只用 TCP 探测判断死活

不用 PID 记账 —— PID 会因重启失效，而「端口有人监听」是唯一可靠的存活信号。
PID 只在展示时按端口反查（`netstat -ano`）。

## 已知的坑

### `.cmd` 包装器的 `:loop` 与 `timeout`：`detached: true` 是关键

很多 `.cmd` 包装器长这样：

```bat
:loop
"%PY%" -m admin.server
timeout /t 5 /nobreak >nul
goto loop
```

`timeout` 需要一个**真正的控制台**做 stdin。少了它，循环会退化成**紧循环**。
实测（`tools/probe-launch.js`）：

| spawn 配置 | 能否拉起 | 崩溃时 7 秒内循环次数 |
|---|---|---|
| `detached: true` + `windowsHide` | ✅ | **2 次**（正常节流） |
| `detached: false` | ✅ | **166 次**（≈每秒 24 次重启风暴） |
| `shell: true` | ✅ | 2 次 |

**决定因素是 `detached: true`**，不是「有没有控制台」。少了它，一个崩溃的服务会变成
每秒二十几次的重启风暴。

> 这个数字值得跑一次探针去量，而不是靠推理。我一开始用 `ProcessStartInfo` 手工搭管道
> 测出「紧循环」，差点据此绕开复用 `.cmd` —— 后来发现那是**管道句柄**导致的假象。
> **测试夹具本身出错，比不测更危险**：它会让你基于错的事实做出「正确」的决定。

### 「停止」为什么必须杀包装器

`killService` 的顺序是**先杀包装器，再杀端口占用者**：

1. `taskkill /PID <包装器> /T /F` —— `/T` 带上整棵子树（也就是真正监听的那个进程）
2. 再按端口反查、杀残留

顺序反了就会变成「你杀我起」的拉锯：包装器的 `:loop` 会在几秒后把服务拉回来，
你看到的现象是**「停止成功了但服务还在」**。

**「停止」在这套架构里是尽力而为，不是核心语义。** 如果某个包装器以我们认不出的姿势
启动，`/stop` 后服务会自己回来，接口会如实返回 `stillRunning: true`，不假装成功。

### 脚本一律纯 ASCII

`install.ps1` 内 **0 个非 ASCII 字节**，这是刻意的：

Windows PowerShell 5.1 解析**无 BOM** 的 `.ps1` 时用系统 ANSI 代码页。中文被打乱后，
**乱码字节可能吞掉收尾引号**，产生一串指向不相干行号的假语法错误：

```
At install.ps1:214 char:8
+ } else { Ok '娌℃湁鏃ц鍒掍换鍔￠渶瑕佹竻鐞? }
        ~
Missing closing '}' in statement block or type definition.
```

**BOM 不是可靠解法** —— BOM 会被很多编辑器和工具静默剥掉，等于把脚本的可用性押在
「下一个编辑者用对了工具」上。纯 ASCII 一次消除整类故障，PS 5.1 / PS 7 都能跑。

> 相关的坑：`Replace([char]0xFEFF, '')` **会抛异常** —— `Replace(char,char)` 要求第二个
> 参数是 char，传空字符串报 *"String must be exactly one character long"*。
> 剥 BOM 请用 `.TrimStart([char]0xFEFF)`。

所以：**中文只出现在 README（和配置模板的注释）里，脚本里没有。**

### 路径前缀

Tailscale serve 会把配置的路径前缀**剥掉**再转发，所以服务端只看到 `/`，
**不知道自己挂在哪个前缀下**。浏览器侧的相对路径解析又依赖末尾斜杠 ——
访问 `/super`（无斜杠）时 `fetch('services')` 会解析到 `https://host/services`，
打到别的服务上去。管理页因此用 JS 从 `location.pathname` 反推 base 并补斜杠。

## 管理页

页面照「机柜控制台」的语汇做，**签名元素是实体指示灯**：

| 灯 | 含义 |
|---|---|
| ● 亮绿 | 端口在听 |
| ● 亮琥珀 | 在听，但 HTTP 探针不健康 —— **这才是真异常** |
| ○ 灭 | 端口没听 —— **不是故障，只是没开** |

这个区分是刻意的：把「没开」和「坏了」画成同一个红点，等于让每次「我故意停掉的」
都看起来像事故，久了就没人看状态了。

界面上没有一句说明书，规则是**能靠结构表达的就不用文字**：状态用灯不用字、
`HTTP 200` 不显示（健康的 200 是废话）、主机名只说一次。

宽屏排成矩阵、窄屏（`max-width: 640px`）叠成卡片，同一份 DOM 靠 `grid-template-areas`
切换；表头藏起来后用 `::before` 补回「端口」「PID」字样，按钮拉到 40px 高方便手指点。
用 `<ul>/<li>` 而非 `<table>`（给 `tr/td` 套 grid 会让读屏软件丢掉表格语义），
灯是 `role="img"` + `aria-label`，计数带 `aria-live`，`prefers-reduced-motion` 下关掉动画。

### 登录限流

**为什么有**：token 是可配置的。一旦选成人能记住的短串，搜索空间就从随机串掉到
很小的量级，而登录接口原本没有节流，可以无限次猜。

```
前 8 次失败  → 401「令牌不正确」（快用完时会提示还剩几次）
第 9 次起    → 429 + Retry-After「尝试次数过多，请 N 分钟后再试」
成功登录     → 清空失败计数
```

用 `loginMaxFails` / `loginWindowMs` 可调（默认 8 次 / 10 分钟）。

**按来源 IP 分桶，但经反代进来时实际只有一个桶** —— 请求的 `remoteAddress` 全是
`127.0.0.1`（反代从本机回环转发），所以限流实际上是**全局单桶**。单用户场景下这是
**想要**的行为：攻击者无法靠换源 IP 绕过。代码仍按 IP 分桶而非写死全局，
这样直连时语义依然正确。

**代价要说清楚**：全局桶意味着攻击者可以把桶打满，让**你自己**也暂时登不进去。
这是有意的取舍 —— 短暂登不上，好过被无限次猜测。缓解：成功即清空计数；
计数是内存态，重启控制面即清零。

**真正该做的还是用长随机 token。** 限流是兜底，不是把短 token 变安全的办法 ——
`install.ps1 -NewToken` 会生成 43 位 URL-safe 随机串。

## 安全

| 暴露面 | 现状 | 风险 |
|---|---|---|
| 控制面端口 | 需 token（明文存在配置里），通常经反代暴露给 **tailnet** | 拿到 token 即可**启动/重启你的服务**。不是公网，但 tailnet 内任何拿到 token 的设备都能用 |
| **token 强度** | 可配置 | **最弱的一环**。限流挡住在线爆破，但挡不住离线猜测。要稳就用 `-NewToken` 换随机串 |
| 会话 Cookie | `HMAC(token)` 派生，`HttpOnly`，30 天 | 派生值泄漏不能直接当 API token 用，且换 token 即失效 |
| 登录限流 | 8 次 / 10 分钟，实际为全局单桶 | 攻击者打满可让你也暂时登不进去；重启即清零 |
| 监听地址 | **默认恒为 `127.0.0.1`** | 不对外网卡暴露。**不要改成 `0.0.0.0`**，外网可达性交给 Tailscale |
| 配置文件 | 含明文 token | **按凭据对待**，不要进版本库（`.gitignore` 已排除） |
| `Secure` Cookie 标志 | **刻意不开** | 直连 `http://127.0.0.1` 时开了会让本地登录失效。若你只经 HTTPS 反代访问，可以打开它 |
| 凭据复用 | 无强制约束 | 若把同一个 token 同时用于别的服务，**一处泄漏即多处失守**。想隔离就分开设 |

## 文件

```
supervisord-center/
├── src/supervisord-center.js       # 主程序（零依赖，只用 node: 内置模块）
├── config/cfg.template.json        # 配置模板（含逐字段说明）
├── install.ps1                     # 安装 / 迁移（纯 ASCII）
├── tools/                          # 测试夹具，见下
│   ├── dummy-target.js             #   极小 HTTP 假服务
│   ├── probe-launch.js             #   量 :loop 节流与 spawn 配置
│   ├── test-login-ratelimit.js     #   登录限流断言（隔离端口）
│   ├── ui-harness.js               #   界面试验台（隔离端口 + 假服务）
│   ├── splice-page.js              #   管理页拆/装（改页面用）
│   ├── verify-page.js              #   拼接后自检
│   └── scan-secrets.js             #   提交前扫真实凭据
├── _history/                       # 改造前的旧实现，仅存档，不要运行
└── README.md
```

运行时目录默认 `~/.supervisord-center/`（`$env:SUPERVISORD_CENTER_HOME` 可覆盖）：

```
~/.supervisord-center/
├── supervisord-center.js              # 部署副本
├── supervisord-center.config.json     # 含 token，按凭据对待
└── logs/center.log                    # 超 256 KB 自动清空
```

**刻意不放在任何被托管服务的目录下** —— 「独立」是设计目标：被托管服务被卸载/重装/
换 HOME 都不该影响这里，反过来也一样。

### 测试夹具为什么值得留在仓库里

它们记录的是**结论的来路**，不只是结果：

- `dummy-target.js` —— 真实的 `/restart` 会杀掉被托管服务，而开发时会话可能正跑在
  它上面。没有它，这条路径就只能靠推理，而推理在这件事上错过一次。
- `probe-launch.js` —— 它**推翻了上面那个错误结论**（见「已知的坑」）。
  夹具本身出错比不测更危险。
- `ui-harness.js` —— 界面**光看代码看不出好坏**。它起几个状态不同的假服务
  （健康 / HTTP 500 / 离线），才能在真实浏览器里把三种灯态、窄屏塌陷、点击链路看全。

```powershell
node tools/dummy-target.js 8099        # 起一个假服务
node tools/probe-launch.js             # 量 spawn 配置对 :loop 的影响
node tools/test-login-ratelimit.js     # 登录限流断言
node tools/ui-harness.js               # 界面试验台
node tools/ui-harness.js stop          # 停掉试验台
node tools/scan-secrets.js             # 提交前扫凭据
```

### 改管理页

页面是嵌在主程序里的模板字面量，不是外部 `.html` —— **单文件部署是设计约束**。
但直接在一个 JS 字符串里编辑上万字符的 HTML 很难受，所以有个拆/装工具：

```powershell
node tools/splice-page.js extract   # PAGE_HTML -> src/_newpage.html
#  用普通 HTML 工具改 src/_newpage.html
node tools/splice-page.js           # 拼回主程序
node tools/verify-page.js           # 自检
```

三条必须知道的：

1. **`src/supervisord-center.js` 里的 `PAGE_HTML` 才是唯一真相。** `src/_newpage.html`
   只是中转副本，**不入库**。两份都入库 = 第二份真相 = 「代码里是新的、跑起来是旧的」。
2. **拼接会拒绝含反引号 / `${` / 反斜杠的页面** —— 这三种字符会破坏 JS 模板字面量或
   造成意外插值。工具发现就中止且不改源文件。解法是用 `indexOf` 之类绕开，而不是转义
   （转义会层层叠加）。
3. **拼接是无损的**：`extract` → 立即拼回，源文件 SHA256 不变。

## License

MIT
