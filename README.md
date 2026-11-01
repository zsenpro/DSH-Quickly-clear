# DSH-Quickly-clear

DeepSeek Harness 的侧边栏插件：在已归档对话的 `⋯` 菜单里加一项「删除对话」，连会话日志、投影缓存和工作区记账一起清掉。未归档的对话不会出现这一项。

English: a DSH (DeepSeek Harness) plugin that adds *Delete conversation* to an archived Session's `⋯` menu and removes the session log, its projection cache and its workspace booking along with it. Sessions that are not archived never see the row.

## 为什么需要它

DSH 有归档，没有删除。归档只是把对话从列表里挪走，磁盘上一份没少：

```
~/.dsh/sessions/<project>/<sessionId>/session.v4.jsonl.zstd
~/.dsh/storages/session_projcache/sessions/<sessionId>.json
~/.dsh/storages/workspace.json           # archivedSessionIds / sessionIds
```

Host 服务里也确实没有删除口子：`workspaceRegistry` 能归档、置顶、改名、把会话从工作区摘出来；`sessionPersistence` 只能 create / open / flush / stat / list；内存里的 `sessions` 连删都不谈。这个插件补的就是这一块。

## 装上

要求：DSH 桌面版或 `dsh web`（走 profile 机制），Node >= 20。

把仓库放到任意目录，然后二选一。

### 首选：插件管理器

```
plugin_manager install_bundle target=<克隆目录>
```

`install_bundle` 会给 profile 加依赖并挂上 bundle。如果你的 profile 里已经有需要本地编译的依赖（比如带 `cpu-features` 的包），pnpm 那步会卡在 install script 批准上，那就走下面的手工登记。

### 手工登记（本地 link）

跟 `@yg/dsh-session-mover` 之类的本地插件一个形态：

```powershell
$src = '<克隆目录>'
$profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
New-Item -ItemType Junction -Path (Join-Path $profile 'node_modules\DSH-Quickly-clear') -Target $src
```

然后编辑 `$profile\package.json` 两处（路径用正斜杠）：

```jsonc
{
  "dependencies": {
    "DSH-Quickly-clear": "link:<克隆目录>"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ... 其它 bundle
        "DSH-Quickly-clear"
      ]
    }
  }
}
```

改动 `index.js` 需要重启 DSH Host；只改 `client.js` 走 HMR。

### 卸载

从 `bundles` 里删掉那一行、删掉依赖项、删掉 Junction，再删掉 `~/.dsh/DSH-Quickly-clear.log`。

## 用法

1. 归档一个对话（`⋯` → 归档对话）。
2. 再打开它的 `⋯` 菜单，最后多出一行「删除对话」。
3. 点它，确认卡片里会写出会话标题和后果，再点「永久删除」。

删除成功后页面会自己刷新一次。侧边栏的会话目录是客户端快照，Host 删文件碰不到它，不重挂那一行会赖着不走。

## 它删什么

`POST /DSH-Quickly-clear/api/delete`，按顺序：

1. 所有 workspace 记录的 `sessionIds` 摘掉这个 sessionId（`workspace.mutate`，写盘）
2. `unarchiveSession` + `unpinSession`
3. registry 的 `headers` / `sessionPaths` / `missingSessionPaths` / `invalidSessionPaths` 四个缓存清掉——不清的话下一次快照会从 cwd 索引把它重新推导回工作区
4. `sessions/<project>/<encodeSegment(sessionId)>/` 整目录删除，project 目录空了顺手收掉
5. `storages/session_projcache/sessions/<sessionId>.json`
6. 再清一次 registry 缓存（清扫期间重建的投影可能又读过 header）

先清记账再删文件是有意的：文件删不掉（Windows 上句柄没放）时会话仍然能解析、仍然显示在侧边栏里，不会留下一个指向空处的行。

正在运行的会话会被拒（`session-live`）。归档本身会停掉会话，正常路径撞不上。

## 它不删什么

- `attachments/v1/objects/`：内容寻址，多个会话共用同一份字节，没法按会话归属。
- `storages/cost-meter/ledger.json`：按会话记账的共享文件，动它的风险大于收益；删掉会话后那笔花费仍留在历史账单里。
- `sessionQuery` 的 SQLite 全文索引：服务没有删除方法，搜索里可能还留着陈旧命中。

## 端点

给二次开发用的两个口子，都要过 `ctx.connection.requestRejection`（同源 / 可信连接校验）：

| 方法 | 路径 | body | 作用 |
| --- | --- | --- | --- |
| POST | `/DSH-Quickly-clear/api/delete` | `{"sessionId":"..."}` | 执行清扫，返回删掉的路径与记账 |
| POST | `/DSH-Quickly-clear/api/inspect` | `{"sessionId":"..."}` | 只读：列出命中的日志目录、缓存文件、是否在运行 |

调用记录写在 `~/.dsh/DSH-Quickly-clear.log`。

## 验证

```powershell
node verify.js
```

19 项自检，分两层，全在临时目录里跑，不连 Host、不碰真实数据：

- 纯函数：`encodeSegment` 对普通 uuid / IM 形态 id（`:` → `~003A`）/ `~` / `.` / `..`；`findSessionFolders` 命中与未命中；`projectionCacheFiles` 只认本会话的文件。
- 清扫流程（桩服务替 `sessions` / `workspaceRegistry` / `sessionPersistence`）：记账摘 id、归档与置顶标记清除、日志目录与投影缓存被删、空 project 收掉、registry 四个缓存清空、运行中的会话被拒且文件不动、只有记账没有日志也能收尾。

## 实现备忘

- 菜单行注册进 `sidebar.workspaces.session.menu.item`，cell id `quickly-clear`，`order: 500`（出厂行是 pin 100 / rename 200 / fork 300 / archive 400 / session-id 450）。可见性读 `useWorkspaces(...).archivedSessionIds`，未归档的会话直接不渲染。
- 确认框注册进 `shell.overlay`，cell id `quickly-clear-dialog`，`order: 940`。Esc、点背景、取消都能退；删除中两个按钮都禁用。
- 不 `require` 任何 Harness Client 包（`@deepseek-ai/dsh-client-ui-primitives` 之类），控件、图标、hover 样式自己写，颜色只吃 `--dsw-alias-*` token 并带硬编码回退值。
- 会话目录名的编码跟 JSONL store 保持一致，见 `encodeSegment`：`~` 与非 `[A-Za-z0-9._-]` 转 `~XXXX`，`.` 与 `..` 特判。

## License

MIT