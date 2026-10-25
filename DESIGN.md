# webmux 设计文档

> 通过浏览器访问远程电脑终端，会话持久化（类似 tmux），附带文件管理与分享下载。
> 同时适配移动端与桌面端。

## 0. 已确定的约束

| 项 | 决定 |
|---|---|
| 后端技术栈 | Node 22 + TypeScript |
| 使用场景 | 单用户自用（无多租户、无 ACL） |
| 被控端平台 | Linux / macOS（可直接依赖 tmux） |
| 目标 | 自托管、部署简单、移动端真的可用 |

---

## 1. 核心难点

项目表面是"Web 终端 + 文件管理"，但 **90% 的复杂度集中在一件事上：会话的生命周期不属于浏览器**。

一旦承认"关掉网页命令还在跑"，架构上就出现一条硬边界：

- 终端会话必须由**服务端的长生命周期载体**持有，浏览器只是可随时插拔的"显示器 + 键盘"；
- 由此派生出四个必须正面解决的问题：
  1. **重连不丢输出**
  2. **多客户端尺寸协商**
  3. **断线期间的输出缓冲**
  4. **服务端自身重启后会话是否还在**

多数同类项目（ttyd / gotty / wetty）在这里偷懒 —— 刷新丢一屏历史、断网重连花屏。
这是 webmux 的重点投入方向，也是协议层设计，**不能后补**。

---

## 2. 持久化方案：复用 tmux

```
浏览器 attach ──► node-pty ──► tmux attach ──┐
                                             │
浏览器断开 ──► kill pty（仅杀掉 tmux 客户端）  │
                                             ▼
                                    tmux server（独立守护进程）
                                      ├── session A  ← 继续运行
                                      └── session B
```

**为什么能持久**：kill 掉 pty 只终止 tmux *客户端* 进程；tmux *server* 是独立 daemon，
它持有会话与子进程。因此：

- 浏览器关闭 / 刷新 / 断网 → 会话存活
- **webmux 服务端重启 → 会话同样存活**（这是相对自研 PTY 管理器的关键优势）

会话创建：

```bash
tmux -u -f /dev/null -L webmux new-session -A -s <sessionId> -c <cwd>
# 环境：TERM=xterm-256color
# 配置：set -g history-limit 50000
#       set -g window-size latest      # 多客户端尺寸策略
#       set -g status off              # 状态栏交给前端渲染
```

**抽象要求**：tmux 的所有细节必须封在 `SessionBackend` 接口之后。
未来若要支持 Windows（ConPTY）或需要更精细的回放控制，替换实现即可，上层不动。

```ts
interface SessionBackend {
  create(opts: { id: string; cwd: string; cols: number; rows: number }): Promise<void>
  attach(id: string): Promise<{ pty: IPty; cols: number; rows: number }>
  list(): Promise<SessionInfo[]>
  kill(id: string): Promise<void>
  captureHistory(id: string, lines: number): Promise<string>  // 带 ANSI 的滚动历史
}
```

---

## 3. 整体架构

```
┌─────────────────────────────────────────────────────────┐
│  浏览器 (PWA)                                            │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐           │
│  │ xterm.js   │ │ 文件管理器  │ │ 分享管理    │           │
│  └─────┬──────┘ └─────┬──────┘ └─────┬──────┘           │
└────────┼──────────────┼──────────────┼──────────────────┘
         │ WSS 二进制帧  │ HTTPS REST   │ HTTPS REST
┌────────▼──────────────▼──────────────▼──────────────────┐
│  Caddy  (TLS / WS 升级 / 限流)                           │
└────────┬────────────────────────────────────────────────┘
┌────────▼────────────────────────────────────────────────┐
│  webmux server (Node + TypeScript)                      │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ WsGateway    │  │ FileService  │  │ ShareService │  │
│  │ seq/环形缓冲  │  │ 路径牢笼      │  │ token/过期    │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│  ┌──────▼───────┐  ┌──────▼───────┐  ┌──────▼───────┐  │
│  │SessionManager│  │ streaming    │  │   SQLite     │  │
│  │  会话注册表   │  │ Range/zip    │  │ auth/shares  │  │
│  └──────┬───────┘  └──────────────┘  └──────────────┘  │
│         │ SessionBackend 接口（可替换）                   │
│  ┌──────▼───────┐                                        │
│  │ tmux 适配器   │                                        │
│  └──────┬───────┘                                        │
└─────────┼────────────────────────────────────────────────┘
          │ node-pty
   ┌──────▼───────┐
   │ tmux server  │
   └──────────────┘
```

---

## 4. 终端通道协议

### 4.1 帧类型

**同一个 WebSocket 上混用文本控制帧与二进制数据帧** —— 用 `typeof event.data === 'string'` 区分，语义清晰。

客户端 → 服务端（JSON 文本帧）：

```ts
| { t: 'attach'; sessionId: string; lastSeq?: number; cols: number; rows: number }
| { t: 'input';  data: string }              // 键盘输入
| { t: 'resize'; cols: number; rows: number }
| { t: 'ping' }
```

服务端 → 客户端：

```ts
| { t: 'attached'; sessionId: string; seq: number }
| { t: 'replay';   fromSeq: number; toSeq: number }   // 随后紧跟二进制补发帧
| { t: 'resync';   seq: number; cols: number; rows: number }  // 随后紧跟快照
| { t: 'synced';   seq: number }   // 同步完成标记，见下
| { t: 'exit';     code: number }
| { t: 'pong' }
| <二进制帧>                                  // PTY 原始输出
```

**`synced` 是必须的，不是可选优化。** 没有它，客户端无法区分"快照还在路上"和
"屏幕已经是最新的"，只能靠定时器猜。它同时解决三个问题：

- 前端知道何时可以撤掉"正在恢复…"提示
- 客户端能安全地推进自己记录的 `lastSeq` —— 只认 `synced.seq`，绝不提前认领
  尚未收到的字节（否则断线时会静默丢数据）
- 测试不必再和异步到达的数据赛跑

### 4.2 不丢输出：seq + 环形缓冲 + 无头终端镜像

> **实现时修订**：原设计用 `tmux capture-pane -e` 重建屏幕，已改为服务端运行
> `@xterm/headless` 维护一份终端状态镜像。这是借鉴 VS Code 终端持久化的做法：
> `capture-pane` 只能给你静态文本行，而镜像是一个活的终端 —— 颜色、属性、滚动历史、
> 光标位置全都是准的，还能用 `@xterm/addon-serialize` 一次性序列化成 ANSI 序列。
> 少了一层文本解析，恢复保真度反而更高。

```
服务端每会话持有三份状态，用 seq（累计产出字节数）串起来：

  pty ──> 环形缓冲（最近 1MB，用于补发缺口）
      ──> 无头镜像（完整屏幕 + 滚动历史，用于快照）
      ──> 各客户端

重连：{ t:'attach', sessionId, lastSeq }
      ├─ 缺口仍在缓冲内 → { t:'replay' } + 缺失字节        （无缝，无重绘）
      └─ 缺口已被淘汰   → { t:'resync' } + serialize() 快照 （整屏重建）
      └─ 两种情况最后都补一个 { t:'synced', seq } 作为完成标记
```

镜像必须与 tmux 窗口尺寸严格一致，否则客户端看到的是裁剪画面 —— 这也是
`window-size manual` + 显式 `resize-window` 的原因（见 §2）。

### 4.3 UTF-8 边界：不要转字符串

PTY 输出是 `Buffer`，多字节 UTF-8 字符**一定会在 chunk 边界被切断**。
转成 string 再发会出乱码。正确做法：

```ts
// 服务端：直接发二进制帧
ws.send(chunk)                              // chunk 为 Buffer

// 客户端：交给 xterm.js 内部的流式解码器
term.write(new Uint8Array(buf))
```

### 4.4 背压控制

跑 `yes` 或 `cat 大文件` 时，不做流控会撑爆 WS 发送缓冲。

```ts
if (ws.bufferedAmount > HIGH_WATER) pty.pause()
else if (ws.bufferedAmount < LOW_WATER) pty.resume()
```

### 4.5 心跳与连接回收

20s 一次 ping，60s 无 pong 即关闭。避免死连接在服务端堆积 tmux 客户端。

### 4.6 多客户端

同一会话可被多个标签页 / 多台设备同时 attach，tmux 原生支持。
尺寸策略 `window-size latest`（最后接入者决定）。可另提供 `tmux attach -r` 只读旁观模式。

---

## 5. 文件子系统

### 5.1 REST 接口

实现后的实际接口集合：

```
GET    /api/fs/roots                        可用根目录列表（含不可用的根与原因）
GET    /api/fs/list?path=&sort=&cursor=     目录列表（游标分页，目录恒排在文件前）
GET    /api/fs/stat?path=                   单文件元信息（不解引用，符号链接如实报告）
POST   /api/fs/mkdir                        建目录；recursive 走 mkdir -p 语义
POST   /api/fs/touch                        建空文件。只建不改 —— 已存在即 409，
                                            不去碰已有文件的 mtime
POST   /api/fs/rename                       改名 / 跨目录移动
DELETE /api/fs?path=&recursive=             删除；递归必须显式，根永远删不掉
GET    /api/fs/download/<name>?path=        流式下载，支持 Range，恒定 attachment。
                                            <name> 只给客户端取名（见 5.3），服务端不读
GET    /api/fs/preview?path=                内联预览；白名单之外回落到 attachment
POST   /api/fs/upload/init                  ┐
PUT    /api/fs/upload/:id/chunk?offset=     │ 分片断点续传。init 在任何字节流动之前
GET    /api/fs/upload/:id                   │ 校验目标与磁盘余量；received 以合并后的
POST   /api/fs/upload/:id/complete          │ 半开区间返回，客户端据此续传
DELETE /api/fs/upload/:id                   ┘
GET    /api/fs/archive/<name>.zip?path=&format=zip
                                            目录流式打包，全程不落盘；<name> 同上
POST   /api/fs/extract                      解压，来源为 path 或 uploadId
PUT    /api/fs/content                      保存编辑后的文本（预览页的编辑按钮）。
                                            只改既有文件，不创建；带 mtime 前置条件，
                                            磁盘上变过就 409
```

两处相对原设计的有意收敛：

- **没有 `move`。** `rename` 已经接受牢笼内任意的 from→to，跨目录移动本来就是同一个请求。
  再加一个和 rename 做同样事的端点是多一处要保持同步的地方，不是功能。
- **`extract` 的来源是 `{ path }` 或 `{ uploadId }`**，不接流式 body。用 `uploadId`
  就直接复用了分片暂存区：大归档于是自带断点续传与 GC，而暂存的 `data` 本来就是可随机读的
  普通文件 —— 正是 zip 解析器想要的。比再引一个流式 body 解析器更贴合场景，不是抄近路。

### 5.2 路径牢笼（安全第一优先）

这是整个项目最容易被攻破的地方，必须独立成模块 + 独立测试套件。

```ts
function safeResolve(root: string, userPath: string): string {
  if (userPath.includes('\0')) throw new BadPath()

  const abs = path.resolve(root, userPath)
  // 已存在：realpath 解开符号链接
  // 新建：realpath 其父目录
  const real = existsSync(abs)
    ? realpathSync(abs)
    : path.join(realpathSync(dirname(abs)), basename(abs))

  if (real !== root && !real.startsWith(root + path.sep)) throw new Escape()
  return abs
}
```

测试需覆盖：`..` 穿越、URL 编码变体、符号链接逃逸、绝对路径注入、超长路径、null 字节、
Windows 风格分隔符、大小写不敏感文件系统。

### 5.3 其他要点

- `Content-Disposition` 用 RFC 5987 (`filename*=UTF-8''...`) 编码中文文件名
- 音视频依赖 `Range` 支持拖动进度条
- 大文件上传必须分片（移动端网络不稳）
- `O_NOFOLLOW` 打开、上传文件名消毒

**实现时补充的七条**（原设计没写到，但都是必须的）：

- **文件名同时出现在下载 URL 的末段（`/api/fs/download/<name>?path=`）。** 有一类客户端
  （安卓下载管理器、App 内置浏览器的下载桥、部分下载工具）**完全不读 `Content-Disposition`**，
  只按 URL 末段取名字，再按 `Content-Type` 补后缀 —— URL 里只有 `?path=` 时末段就是字面的
  `download`，文件于是存成 `download.bin`；分享页的 `/raw` 同理变成 `raw.bin`。
  服务端**从不读取**这一段：发哪个文件仍然只由 `path` 决定（照样走牢笼），所以 URL 不可能
  靠名字说谎。不带名字的老 URL 继续注册，老书签与老链接不受影响。
- **下载一律 `attachment` + `nosniff`；只有 `/preview` 会内联，且只对内联白名单。**
  SPA 与本接口同源，内联渲染一个上传上来的 `.html` 就是带 cookie 的同源 XSS。
  预览白名单里 **`.svg` / `.html` 不按真实类型发出**，而是当 `text/plain` ——
  于是"看源码"既安全又有用。白名单是白名单而非黑名单：黑名单的失败形态是
  "某个没人想到的类型被渲染了"。
- **打包下载不发 `Content-Length` / `Range` / `ETag`。** 长度要把整棵树先压一遍
  （正是要避免的临时文件）；而验证器比没有更糟 —— 强 ETag 要哈希整个归档，流式做不到，
  弱验证器会在目录变化后让客户端拿到**静默拼接坏掉的 zip**。目录没有稳定的版本标识。
- **递归删除不穿符号链接，打包跳过符号链接，解压拒绝符号链接条目** —— 三处一致。
  种下一个 `a -> /etc` 就是一个持久化的逃逸原语。
- **解压的落盘防线是 `jail.resolveForCreate`，不是名字校验。** 目标目录里已经存在
  `a -> /etc` 时，一个完全干净的条目 `a/passwd` 会被写到 `/etc/passwd`，而 `..` 过滤与
  字符串包含检查都看不出来。名字校验只是一半，另一半必须走牢笼。
- **保存走同目录临时文件 + `rename`，并显式复制原文件的 mode 与 uid/gid。** 原地截断
  省一个 inode 的代价是崩在中间就留下半截文件；同目录则让 rename 天然原子，不需要跨
  设备回退。mode 必须显式复制：临时文件是新建的，不复制的话一个 0664 的文件回来会变成
  0600，uid/gid 同理（chown 失败降级为警告——拒绝对着不属于自己的文件保存，比换一个
  属主更糟）。另外**拒绝保存到大于预览上限的文件**：截断预览的大小恰好就是上限，只校验
  请求体大小会让一个 600 KiB 的文件被它自己的前 512 KiB 覆盖。
- **文件夹上传没有服务端接口，是客户端展开的：** 每个目录先 `mkdir -p`（`/api/fs/mkdir`
  对已存在的目录返回 200，所以可以无脑调），再逐个文件走既有的分片上传。语义上是一条
  「新建目录 + 上传文件」的编排，不需要第四种写路径；代价是每加一个文件就要多一次
  `mkdir` 的往返，收益是断点续传、逐文件取消和重试全部照旧可用。浏览器侧两条入口
  （`webkitdirectory` 与拖拽的 `webkitGetAsEntry`）产出同一份清单，**选目录拿不到空目录**
  （FileList 里没有它），拖拽能拿到并会创建。拖拽还必须在事件处理返回前**同步**取好
  entry，之后 `DataTransferItem` 就不再回答 `webkitGetAsEntry()` 了。

### 5.4 根目录配置

单用户模式下，用**白名单根目录**替代复杂的权限系统（P2 实现）：

```json
{
  "files": {
    "roots": [
      { "name": "home", "path": "/home/mi" },
      { "name": "logs", "path": "/var/log", "readonly": true }
    ]
  }
}
```

只读根在 UI 上禁用写操作，路径牢笼按根逐个校验。

---

## 6. 分享链接

独立于登录体系的一条公开通道。

```
POST   /api/shares              创建 → { token, path, expiresAt, maxDownloads, password? }
GET    /api/shares              我的分享列表
DELETE /api/shares/:id          撤销
GET    /s/:token                公开下载页（无需登录，可带密码）
GET    /s/:token/raw            实际流式下载（限速 + 计数 + 过期校验）
GET    /s/:token/raw/<name>     同上；<name> 只给不读 header 的客户端取名，服务端不读
```

- token = `crypto.randomBytes(32).toString('base64url')`
- DB 只存哈希（库泄露 ≠ 文件泄露），代价是链接仅展示一次
- 目录分享 → 动态 zip 流，不落盘
- 图片 / 文本 / PDF 提供内联预览页，其余强制下载
- 必须支持：过期时间、下载次数上限、限速、一键撤销

**实现时补充的六条**（原设计没写到，但都是必须的）：

- **share 行要快照 `root_name` / `root_path` / `kind`。** 原设计只说了存 `path`。
  只存一个绝对路径然后 `open()`，会在某个根被重新指向的那天**静默地把分享变成一次
  牢笼绕过**。每次访问都要用这几个字段重做一次"它是否还指向当初那个东西"的判定。
- **「内联预览页」与「恰好两条公开路由」冲突。** 一个 per-type 的预览页就是第三条路由
  加一个路径参数。落法是：把内联做成 `/raw` 上的 **disposition 决策**（复用
  `previewPolicy`），于是不需要新路由，公开面保持两条。唯一的例外是 `/raw/<name>`
  这个**只做命名的尾段**（理由见 5.3）：它挂同一个 handler，不放宽任何判断 —— token、
  密码门、下载计数、限速都还在 handler 里。
- **「目录分享 → 列出条目」需要封顶与限深。** 一层、500 条，而且要一个**有界读取器**：
  直接复用 `listDirectory` 会为了 cursor 和 total 把整个目录读完并排序，
  在一个免认证页面上就是可任意重复的 O(n) readdir。
- **下载计数的读-改-写会完全失效。** SELECT 与 UPDATE 之间全是 `await`，事件循环自由交错；
  对 `maxDownloads: 1`（敏感链接最常用的设置）N 个并发请求**全部通过**。
  必须写成一条 `UPDATE … WHERE downloads < max_downloads RETURNING`。
  另外要写明：**这个上限是防扩散的礼貌，不是强制边界** —— 一个把每个 Range 都从字节 1
  开始的客户端只计一次却拿到 99.99% 的文件。
- **解锁 cookie 的 `Path` 必须是 `/s/<token>` 这个确切串。** 写成 `/s` 就是整个特性的
  完全绕过，而且**在任何一个单 share 的测试里都看不出来**。配套的不变式：
  **签名只证明是我们签发的，行才是权威** —— 撤销、过期、下载数每次请求都从行里重读。
- **「空闲超时回收」对 share 应该是「过期」而不是「空闲」。** 一条在别人书签里躺了三周的
  链接是常态；因为没人点就悄悄失效是 bug 不是 feature。

---

## 7. 通知

**要解决的问题**：这个项目最值钱的一句话是"关掉网页，命令继续跑"。
可正因为你放心地关掉了页面，你就不知道它跑完没有 —— 唯一的办法是回来刷新看一眼。

形态：本机脚本回调一个 HTTP 入口 → 落库 → 两条出口。

```
  构建脚本 / CI / 任何本机程序
        │  POST /api/notify
        ▼
   NotificationHub ──┬── /ws/events ──→ 页面内 toast / 角标 / 系统通知
                     └── Web Push ────→ 手机、页面关闭时
```

### 7.1 为什么入口是本机的，以及为什么光判本机不够

判定"是不是本机"读的是 **`req.socket.remoteAddress`，不是 `req.ip`**：开了 `trustProxy`
时后者取自 `X-Forwarded-For`，由调用方自己填 —— 也就是 `forwardedHeaderWarning` 警告的同一件事。

但地址判断有两个洞，都得补：

1. **浏览器就在本机上。** 你浏览的任何网页都能向 `127.0.0.1:8866` 发 POST；同源策略只拦
   读响应，不拦发请求。所以还要求令牌（存在数据目录，0600），并且**拒绝任何带 `Origin`
   头的请求** —— 浏览器给每个 POST 都带 `Origin`，本机脚本不带。注意 `Origin: null`
   （`file://` 页面、sandbox iframe）是"存在且值为 null"，按"存在即拒"处理；
   写成 `origin && origin !== 'null'` 就正好漏掉这一类。
2. **同机反代让 peer 恒为回环。** nginx 从 `127.0.0.1` 转发过来时，任何来源的请求都满足
   地址判断。所以还要查整条 `X-Forwarded-For`：**每一跳**都必须是本机。只看最后一跳会被
   `127.0.0.1, 203.0.113.9` 绕过（真实的公网地址被 nginx 追加在最右，伪造的回环在最左）。
   反代不发 `XFF` 时这一层就没了，只剩令牌 —— 启动时开 `trustProxy` 会打警告说明这点。

两种"确实是本机但源地址不是回环"的情况用 `notify.allowFrom` 放行：绑到具体非回环地址、
以及容器里跑服务而脚本在宿主机上（源地址是桥网关）。

### 7.2 事件通道为什么另开一条

`/ws/events` 不复用 `/ws/terminal`。终端那条 socket 的语义是"attach 到某个会话"，
带着二进制帧、seq 重放、快照重同步、背压丢弃一整套；通知是全应用级的 —— 在文件页、
一个终端都不开、手机上开了三个标签，都要收得到。塞进终端通道会让两边都变脏。

协议很小：客户端 `hello {since}`，服务端回 `ready {latestId, unread, truncated}` 和一帧
`notify {items, unread, catchUp}`。三个不显然的点：

- **先入广播集合，再读快照。** 反过来的话，注册与快照之间产生的通知会两边都不在，永久丢失。
  重复是可以容忍的（客户端按 id 去重），丢失不行。
- **补发批次显式标记 `catchUp`**，而不是让客户端推断"`ready` 之后的第一帧就是历史"。
  后者在补发为空时（服务端没什么可补的）标志位会一直悬着，把随后的第一条实时通知当成历史，
  静默吞掉。
- **心跳无条件发。** 终端通道只在 attach 之后才 ping；照抄会让事件通道的连接在 60 秒后
  被统一回收 —— 这条通道没有 attach。

### 7.3 Web Push

VAPID（`jose` 签 ES256）+ RFC 8291 的 aes128gcm 加密，只用 `node:crypto`，不引 `web-push`。
理由和 ZIP 自己写一样：核心逻辑不长，而可验证性来自**规范里公布的测试向量** ——
密钥调度（ECDH → HKDF → CEK/NONCE）逐字节对着 RFC 8291 附录 A 断言。
加密函数因此必须允许注入 salt 和临时私钥，否则那段向量根本没法测。

订阅是**绑定发送方密钥**的：换一次 VAPID 密钥，之前所有订阅全部作废，而且推送服务回的是
403 —— 看起来像 bug。所以订阅行里存了当时的公钥，发送前比对、不一致就删掉让前端重订阅。

**HTTPS 是硬约束**：Web Push 只在安全上下文里存在，手机用 `http://192.168.x.x:8866`
访问时浏览器里根本没有 `pushManager`。这不是实现细节，是产品边界，文档里必须说清楚。

### 7.4 取舍

- **未读是全局一个 `read_at`**：手机上读过，桌面角标也会清。单人自用够用；
  要按设备未读得再加一张订阅维度的读表。
- **审计不逐条写，而且入口的拒绝要节流**：审计是安全事件轨迹，通知本身一条都不记。
  四道闸的拒绝记一条是应该的（有人敲门值得知道），但 `audit` 表没有任何清理机制，
  而端口扫描器会成片地撞 peer 检查 —— 所以拒绝最多每分钟记一条，其余只进日志。
- **推送失败的记法是窄的**：只有"根本连不上"才计入订阅的失败计数（5 次禁用该订阅）。
  429、5xx、403 要么是暂时的，要么是我们自己的问题（VAPID 配错、密钥轮换），
  把它们记在设备头上，会让一次限流或一个下午的配置调试**永久**废掉一台手机 ——
  而浏览器那边毫不知情，也不会重新订阅。
- **不做去重 / 合并 / 优先级队列**：需要合并的调用方用 `tag` 自己解决。
- **未读通知不受保留期约束**（只受条数上限约束）：出门一个月回来，"构建失败"不该已经消失。

---

## 8. 移动端适配

这是决定项目"能不能用"的部分，不是锦上添花。

| 问题 | 解法 |
|---|---|
| 虚拟键盘没有 Ctrl/Esc/Tab/方向键 | 自制**快捷键条**（回车 / Esc / Ctrl / Alt / Tab / ↑↓←→ / `\|` / `~` / `-` / `/`），Ctrl 做粘滞态 |
| iOS 键盘弹出把终端顶飞 | 监听 `visualViewport.resize` 调整容器高度，**不要用 `window.innerHeight`** |
| xterm.js 触摸滚动很糟 | 覆盖一层透明 `overflow-y:auto` 的 div，同步 `scrollTop` ↔ `term.scrollToLine()` |
| 长任务时手机息屏 | `navigator.wakeLock.request('screen')`，配合页面可见性自动重申请 |
| 地址栏遮挡 | 用 `dvh` 而非 `vh`，配合 `env(safe-area-inset-bottom)` |
| 反复打开 | PWA：manifest + service worker，`display: standalone` |

**实现时修正的三条**：

- **「xterm.js 触摸滚动很糟」说轻了 —— xterm 6 根本没有触摸滚动。** `.xterm-viewport` 不是
  滚动容器（一个空的透明 div），6.0 的滚动模型是 VS Code 的 `SmoothScrollableElement`，
  滚动位置存在 JS 里，DOM 的 `scrollTop` 永远不被写入。所以覆盖层**是唯一的机制，
  不是打磨层** —— 风险等级从「调好看点」变成「从零实现」。
  连带一条：你看到的滚动条是 xterm 自己的滑块，颜色来自 **xterm theme 对象的
  `scrollbarSlider*` 键**，而不是 CSS 的 `::-webkit-scrollbar`（那些规则 style 的是一条
  永远不动的滚动条）。浅色主题必须设这三个键，否则得到白底上看不见的半透明白滑块。
- **「同步 `scrollTop` ↔ `term.scrollToLine()`」不完整。** 真相在 `buffer.active.viewportY`；
  守卫必须是**值相等**而不是布尔标志（给 `scrollTop` 赋值会异步再排一个 scroll 事件，
  那时标志早被清掉了）；两边都要 clamp；`smoothScrollDuration: 0` 是前提不是巧合。
  还有一条陷阱：**覆盖层绝不能用 `display:none` 藏** —— 那会丢掉布局盒、把 `scrollTop`
  重置为 0，触发 scroll 事件把终端拽到第 0 行。而应用切到「文件」时正是用 `hidden` 藏终端的。
- **「设置」不该做第四个标签页**，理由 `TabBar.tsx` 里已经写过：点进去是空的标签页是用户
  一分钟内就会撞上的 bug。主题开关放在侧栏底部，等「设置」有第二样东西时再搬过去。

### 响应式布局：一套代码两种形态

- **桌面（≥1024px）**：左侧栏（会话列表 + 文件树）+ 主区终端，可拖拽分栏
- **平板（640–1024px）**：可折叠抽屉式侧栏
- **手机（<640px）**：底部 Tab Bar（终端 / 文件 / 分享 / 设置），
  终端全屏 + 顶部可收起快捷键条；文件列表用卡片而非表格 + 长按呼出操作菜单

---

## 9. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node 22 + TypeScript | |
| HTTP | Fastify | 插件生态好，WS 支持清晰 |
| PTY | node-pty | 事实标准（VS Code 在用） |
| WebSocket | ws | 比 socket.io 轻，二进制帧语义干净 |
| DB | better-sqlite3 | 单文件、同步 API、免运维 |
| 密码 | **`node:crypto` scrypt** | 见下 |
| 会话令牌 | jose (JWT, HS256) | httpOnly + Secure + SameSite=Lax Cookie |
| 校验 | zod | 前后端共享 schema |
| 前端 | React 19 + Vite + TS | |
| 终端 | `@xterm/xterm` + `addon-fit` / `addon-webgl` / `addon-search` / `addon-web-links` / `addon-unicode11` / `addon-image` | 注意已迁移到 `@xterm/*` scope |
| 样式 | Tailwind v4 | 响应式断点写得快 |
| 状态 | TanStack Query（服务端状态）+ Zustand（终端/UI 本地状态） | 终端实例不要塞进全局 store |
| 部署 | Docker + Caddy | Caddy 自动 HTTPS 且自动处理 WS 升级 |

**两处实现时的选型调整**

- **argon2id → scrypt**。argon2 需要一个在每种目标平台上都要编译的原生依赖，
  而 scrypt 就在 Node 标准库里，同样是内存困难型算法。对单凭据的自托管服务，
  这笔依赖换来的安全余量不值得。参数按 RFC 7914 取（N=2¹⁵, r=8, p=1，约 32 MB
  工作集 / 100 ms），注意必须显式提高 `maxmem`，否则默认的 32 MB 会直接抛错。
- **配置文件用 JSON 而非 TOML**。TOML 要引一个解析器，而这里需要配置的字段很少。
  代价是手写配置不能加注释，用 README 里的字段表补偿。

**Go 替代方案**（若日后追求单二进制部署）：`creack/pty` + `gorilla/websocket` +
`modernc.org/sqlite` + `embed` 前端 → `scp` 一个文件就能跑。代价是前后端类型无法共享。

**部署坑：node-pty 的 `spawn-helper` 缺少可执行位**。npm 上发布的预构建包丢失了
权限位，导致 `posix_spawnp failed` —— 而且只在第一次打开终端时才暴露，安装阶段
完全看不出来。仓库里 `scripts/fix-pty-permissions.mjs` 作为 postinstall 修复它。

---

## 10. 数据模型

单用户模式，无需 users 表（凭据存 config 或单行 settings 表）。

```sql
-- 单一用户凭据
settings(key TEXT PRIMARY KEY, value TEXT)
--   auth.password_hash / auth.totp_secret / auth.jwt_secret

-- 会话元数据（tmux 是运行时的真相来源，这里只存 UI 需要的附加信息）
sessions(
  id TEXT PRIMARY KEY,          -- tmux session name
  title TEXT,                   -- 用户可见名称
  cwd TEXT,
  created_at INTEGER,
  last_attached_at INTEGER
)

shares(
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE,       -- 只存哈希
  path TEXT, kind TEXT,         -- file | dir
  password_hash TEXT,
  expires_at INTEGER,
  max_downloads INTEGER,
  downloads INTEGER DEFAULT 0,
  revoked INTEGER DEFAULT 0,
  created_at INTEGER
)

audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER, action TEXT, detail TEXT, ip TEXT
)
```

迁移用 `PRAGMA user_version` + 代码内 migrations 数组。

---

## 11. 目录结构

```
webmux/
├─ pnpm-workspace.yaml
├─ packages/
│  ├─ shared/                  # 协议类型 + zod schema（前后端共享，关键）
│  │  └─ src/{protocol.ts,api.ts}
│  ├─ server/
│  │  └─ src/
│  │     ├─ index.ts           # bootstrap
│  │     ├─ config.ts          # zod 校验配置
│  │     ├─ http/{auth,files,sessions,shares}.ts
│  │     ├─ ws/{gateway,ringbuffer,protocol}.ts
│  │     ├─ terminal/{backend.ts,tmux.ts,registry.ts}
│  │     ├─ fs/{jail.ts,ops.ts,stream.ts,upload.ts}
│     ├─ fs/zip/{crc32,dos-time,name,write,read,extract}.ts
│  │     ├─ shares/     存储、token、公开页渲染、访问判定、校验闸门
│  │     └─ db/{index.ts,migrations.ts}
│  └─ web/
│     └─ src/
│        ├─ features/{terminal,files,shares,auth}/
│        ├─ components/        # 响应式外壳、TabBar、Sidebar
│        ├─ lib/{api.ts,ws.ts}
│        └─ styles/
└─ docker/
```

---

## 12. 安全清单

这是远程 shell，必须严肃对待。

1. **WS 升级不受 CORS 保护** —— 必须校验 `Origin` 头，否则存在跨站 WebSocket 劫持（CSWSH），
   攻击者能从受害者浏览器里拿到 shell。**这是同类项目最常漏的洞。**
2. TLS 强制；建议再叠一层 WireGuard / Tailscale / Cloudflare Access，尽量不裸奔公网。
3. 首次运行走 `/setup` 设置密码，**杜绝默认口令**。
4. 登录失败限流 + 锁定（5 次 / 15 分钟 / IP）。
5. 全量审计日志（时间、动作、IP）。
6. 会话与分享的数量上限、空闲超时回收。
7. 路径牢笼独立测试套件（见 5.2）。
8. **通知入口只收本机请求**：socket 对端地址（不是 `req.ip`）+ 整条 `X-Forwarded-For`
   + 令牌 + 拒绝带 `Origin` 的请求。四条缺一不可，理由见 7.1 ——
   尤其"浏览器就在本机上"这一条，是本类接口最常见的漏法。

---

## 13. 路线图

| 阶段 | 内容 | 可验证成果 |
|---|---|---|
| **P0** | PTY + WS + xterm.js + 密码登录 | 能在浏览器里跑命令 |
| **P1** | tmux 持久化 + 会话列表 + seq/环形缓冲重连 + resize | **关网页重开，命令还在，输出不丢** |
| **P2** | 文件 API + 路径牢笼 + 测试 + 文件管理 UI | 能浏览 / 上传 / 下载 / 删除 |
| **P3** | 分享链接（token / 过期 / 限速 / 撤销） | 能发给别人下载 |
| **P4** | 移动端打磨（快捷键条、visualViewport、触摸滚动）+ PWA + 主题 | 手机上真的能用 |
| **P5** | 审计、2FA、Docker、健康检查、文档 | 可交付 |
| **P6** | 通知：本机回调 API + `/ws/events` + Web Push | **命令跑完，手机会响** |

> **P1 的完成度是项目成败的分水岭。**
> 不要为了早点看到界面而把 seq / 环形缓冲留到后面补 —— 它是协议层设计，后补等于重写。

---

## 14. 待定问题

- [ ] 终端会话是否需要"开机自启"的固定会话（如 `webmux` 常驻会话）？
- [ ] 是否需要文件内联编辑器（CodeMirror）？还是只做浏览 + 下载？
- [ ] 分享链接是否需要"上传"方向（让对方传文件给我）？
- [ ] 是否需要终端会话的分享（多人围观同一个 shell）？
