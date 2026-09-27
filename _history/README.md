# _history —— 改造前的旧版本，仅存档

**这些文件不要运行。** 它们保留在这里只有一个目的：改造前后的对比取证。

本目录的三个文件全部来自旧的 `dsh-supervisor`（`~/.dsh/supervisor/`），
该实现**没有版本控制、没有源码仓库** —— 唯一真相就是运行时目录里那份文件。
建成正式项目（`supervisord-center`）之前先把它们抄一份存档，否则改名后
旧实现就再也回不去了。

| 文件 | 是什么 | 备注 |
|---|---|---|
| `dsh-supervisor.released-v1.js` | 发布版（GitHub Release `supervisor-v1` 的资产，11940 bytes） | 与 release 资产 SHA256 逐字节一致 |
| `review-dsh-supervisor.js` | **更早的版本**（221 行，端口 3081） | 见下 |
| `install-supervisor.ps1` | 旧安装脚本（从 GitHub Release 下载产物） | 带 UTF-8 BOM，中文可读；新版改为纯 ASCII，理由见主 README 的「脚本一律纯 ASCII」 |

## `review-dsh-supervisor.js` 的考古价值

它比发布版**早半小时**（17:48 vs 18:21），是改造前的快照。它保留了后来被逐个修掉的
缺陷，正好是发布版那些注释（「实测踩出来的」）所对应的「before」：

| 缺陷 | 发布版怎么修的 |
|---|---|
| 不剥 BOM（`JSON.parse(fs.readFileSync(...))` 裸读） | 读取侧 `.replace(/^\uFEFF/, '')` 容错 |
| `process.kill(launchedPid \|\| 0)` | **自杀路径**：`kill(0)` 杀整个进程组含自己。发布版改成按端口反查 PID，并显式拦截 `kill(0)` |
| 允许 `?token=` | 发布版只认请求头（query string 会进日志、Referer、中间层） |
| 端口 3081 | 发布版改为 3099（`/super` 映射的既有约定） |

**注意 `/restart` 那个 `kill(0)` bug 实测触发过** —— 发布版注释里记着：
「`/restart` 48ms 返回 502，supervisor 自杀而被托管服务反而活着，因为两者不在同一进程组」。
这是为什么新版宁可「查不到 PID 就跳过 kill」，也绝不 fallback 到 0。
