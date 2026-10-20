# dsh-memory-mcp

> **让 DSH 的长期记忆跨 IDE 共享 —— Trae / WorkBuddy / 任何支持 MCP 的 agent 都能读能写同一份记忆。**

> 🤖 **给 AI agent 的入口**:如果你是 agent 而不是人,先读 [`AGENTS.md`](./AGENTS.md)(动手前必须知道的事实与不变量);
> 需要让别的 agent/工具发现本仓库,用 [`llms.txt`](./llms.txt)。
> 本文是写给人的完整说明,可以按需跳读。

[`@restregular/dsh-memory`](https://github.com/RestRegular/dsh-memory) 是一个**只服务于 DeepSeek Harness 的插件**:
它的记忆库、召回注入、管理面板都长在宿主里,**离开 DSH 就完全用不上**。

本项目把同一套记忆能力抽出来做成一个**独立的 MCP (Model Context Protocol) 服务**:

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  DSH 插件     │   │     Trae     │   │  WorkBuddy   │
│ (原生面板)    │   │ (MCP 客户端)  │   │ (MCP 客户端)  │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                  │
       └──────────────────┼──────────────────┘
                          ▼
              <store-dir>（两边必须配成同一个）
              global.jsonl + projects/<sha1>.jsonl
                    + .vec 向量边车
```

**一处写入，三处可见。** 在 Trae 里记下的偏好，回到 DSH 继续对话时 agent 也能检索到。

### 与上游的区别

|  | `@restregular/dsh-memory` | 本项目 |
| --- | --- | --- |
| 形态 | DSH 插件(cordis loader entry) | 独立 MCP 服务(stdio) |
| 可用宿主 | **仅 DSH** | Trae / WorkBuddy / 任何 MCP 客户端,**DSH 不需要开** |
| 工具数 | 4 个(`memory_get` 定义了但漏注册,见 [上游 #2](https://github.com/RestRegular/dsh-memory/pull/2)) | 5 个(补上 `memory_get`) |
| 管理面板 | ✅ 设置页「记忆」 | ❌ 面板仍建议在 DSH 里用 |
| 自动召回注入 | ✅ 每轮自动注入 | ❌ 由调用方 agent 主动调 `memory_search` |
| 存储 | JSONL + `.vec` 边车 | **完全相同的格式**,共用同一个 `storeDir` |
| 检索算法 | 词法 IDF + CJK bigram + 本地向量 | **逐条对齐**(复用上游 `scoring.js` / `scope.js`) |
| 多进程安全 | ❌ 见 [上游 #3](https://github.com/RestRegular/dsh-memory/issues/3) | ✅ 独占锁 + 每次事务重新读盘 |

### 特点

- **五个模型工具**:`memory_save` / `memory_search` / `memory_list` / `memory_get` / `memory_forget`
- **与 DSH 插件共用同一份数据**(`storeDir`),无需导入导出,两个方向都实时互通
- **不需要开 DSH** —— IDE 自己拉起进程、自己拉起向量后端
- **检索算法与上游逐条对齐**,不是"近似实现"
- **跨进程安全**:独占锁文件 + 读-改-写在锁内重新读盘,不会覆盖别的进程刚写的记录

## ⚡ 不需要开 DSH

**本 MCP 服务完全独立,不依赖 DeepSeek Harness 是否运行。**

### 它是怎么启动的

**由 IDE 的 MCP 配置启动** —— 不是某个脚本,也不是随 DSH 插件启动。IDE 读自己的
`mcp.json`,看到 `dsh-memory` 条目后 `spawn` 出这个进程:

```json
{
  "mcpServers": {
    "dsh-memory": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\path\\to\\dsh-memory-mcp\\src\\index.js", "--store-dir", "C:\\Users\\me\\.dsh-memory-store"]
    }
  }
}
```

启动后的链路:

```
你打开 Trae / WorkBuddy
  └─ IDE 读 mcp.json → spawn: node src/index.js --store-dir ...
       ├─ 读磁盘上的 JSONL 记忆(不等 DSH)
       └─ 探活 8199 → 没活 → 自己 spawn llama-server(向量后端)
```

**想在任务管理器里确认它**:Trae 开着时,能看到一个 `node.exe` 跑着
`D:\dev\dsh-memory-mcp\src\index.js`,命令行参数与上面 `mcp.json` 里写的完全一致。

### 三者关系

| 组件 | 谁启动它 | 依赖谁 |
| --- | --- | --- |
| DSH 记忆插件 | DSH 自身的 cordis 插件系统 | — |
| **本 MCP 服务** | **IDE 的 MCP 配置** | **不依赖 DSH** |
| `llama-server` 向量服务 | 各自 spawn(插件用 8078,MCP 用 8199) | 互不干扰 |

三者**只共用同一个数据目录**(`<store-dir>`,DSH 插件与 MCP 必须配成同一个),记忆因此互通 —— 仅此而已,
没有父子关系、没有共享进程。

### 生命周期

stdio 型 MCP 不是 Windows 服务,而是 IDE 按需拉起的子进程:

| 场景 | MCP 服务 |
| --- | --- |
| Trae / WorkBuddy 需要调记忆工具时 | ✅ 由 IDE 拉起 |
| 只有 DSH 开着 | ❌ 不存在(DSH 走自己的插件,不经过 MCP) |
| IDE 关闭 | ❌ 随之退出,不留孤儿进程 |

**记忆不会因为进程重启而丢失** —— 下次 IDE 拉起时读的是磁盘上同一份 JSONL。

> 想开机就常驻可以自己注册计划任务,但通常没必要:IDE 关掉自动回收更干净。

### 实测

`scripts/acceptance-standalone.mjs`(在 8078/8199 全空闲、无任何 llama-server 的状态下,
`DSH_MEMORY_EMBED_EXE` / `DSH_MEMORY_EMBED_MODEL` 已配好):

```
✓ MCP 服务在无 DSH 情况下冷启动成功
✓ MCP 自己拉起了 llama-server（8199）
✓ DSH 的 8078 始终未被占用（两者互不干扰）
✓ 读到了 DSH 之前写入的记忆（命中 5 条）
✓ memory_save 在无 DSH 时成功
✓ 语义相近但措辞不同也能召回
✓ MCP 退出后向量后端随之关闭（无孤儿进程）
```

服务端日志:`vector: 已启动 llama-server pid=35584 http://127.0.0.1:8199`

> ⚠️ **别用端口状态反推宿主状态**。「8199 没监听」只说明向量服务此刻不在跑,
> 不代表 DSH 没运行 —— 这个推理错误本项目犯过一次,特此记下。

---

## 目录

- [安装](#安装)
- [启动](#启动)
- [命令行与退出码](#命令行与退出码)
- [验证你的部署](#验证你的部署)
- [环境变量](#环境变量)
- [五个工具](#五个工具)
- [Trae / WorkBuddy 配置](#trae--workbuddy-配置)
- [与 DSH 共存的设计](#与-dsh-共存的设计)
- [scope 语义(与 DSH 的差异)](#scope-语义与-dsh-的差异)
- [向量开关](#向量开关)
- [已知限制](#已知限制)
- [自测](#自测)
- [面向 AI agent](#面向-ai-agent)
---

## 安装

**要求 Node.js `>= 20.3.0`**(见 `package.json` 的 `engines`)。

这个下限不是随手写的,也不是"Node 越新越好"的意思 —— 它由两个硬约束取较严者决定:

| 约束 | 要求 | 出处 |
| --- | --- | --- |
| 源码里用到的 `AbortSignal.any()` | **>= 20.3.0** | `src/vector.js`(`AbortSignal.any` 在 Node 20.3.0 才出现;20.2 及以前是 `undefined`) |
| 依赖树里的 `@hono/node-server` | >= 20 | MCP SDK 的传递依赖 |

所以 **20.3.0** 是真实下限。低于它会在运行到向量检索时抛 `AbortSignal.any is not a function`,
而且那个报错不会告诉你"是 Node 太旧"—— 这是部署时第一道容易撞上的门槛。

> Node 18.20 上实测整套自测也能过,但那是走运:`AbortSignal.any` 只在「带 signal 调 `embed()`」这条
> 运行期路径上才会执行到。靠"恰好没踩到"的兼容不算兼容,所以下限没有定在 18。

两种装法,任选一种:

```bash
# ① 从源码(推荐:能跑完整自测)
git clone https://github.com/tearslee/dsh-memory-mcp.git
cd dsh-memory-mcp
npm install

# ② 作为依赖装进别的项目 / 全局(装完就能自证)
npm install dsh-memory-mcp
npx dsh-memory-mcp --version
```

**依赖清单**:

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | `1.32.1`(精确版本) | MCP 协议实现(`Server` / `StdioServerTransport` / `Client`) |

存储层(`src/store.js` / `src/scoring.js` / `src/scope.js` / `src/scope-names.js` / `src/lock.js`)**零外部依赖**,只用 Node.js 内置模块。
SDK 只在 `src/server.js` 里用到三行 import;其余 8 个文件对 SDK 一无所知。

> `npm install` 后依赖树会变大(96 个包)是正常的 —— SDK 自带 `express` / `ajv` / `zod` 等传递依赖。

## 启动

```bash
# 最简:store 用默认目录(~/.dsh-memory-store),工作区 = 当前目录
node src/index.js

# 指定工作区(决定 project 作用域)
node src/index.js --project D:\dev\my-app

# 指定存储目录(**与 DSH 插件共用时必须显式给**,见下方警告)
node src/index.js --store-dir D:\dev\.dsh-memory-store

# 两者一起
node src/index.js --project D:\dev\my-app --store-dir D:\dev\.dsh-memory-store
```

> ⚠️ **默认 storeDir 是 `~/.dsh-memory-store`,它是平台中立的,但不一定是你 DSH 在用的那个**。
> `DEFAULT_STORE_DIR` 只保证"任何机器上都能跑起来",不保证"跑对了库"。真正要共用的是
> **DSH 记忆插件的 `storeDir`**。两者不一致时服务一切正常,只是你看到的是另一份(空的)记忆库 ——
> **这是本仓库最容易让人误判「没生效」的地方**。
>
> 用默认值启动时,stderr 会打一条显式提示:
> ```
> [dsh-memory-mcp] ℹ️  未指定 --store-dir / DSH_MEMORY_STORE_DIR,使用默认目录:C:\Users\me\.dsh-memory-store
> [dsh-memory-mcp]    ⇒ 请确认它与 DSH 记忆插件的 storeDir **是同一个目录**,否则两边看到的是两份互不相通的记忆。
> ```
> 看到这条就说明你在用默认库。想确认对不对,最直接的办法是看那个目录里有没有 `global.jsonl`。

启动参数(都支持 `--key value` 与 `--key=value` 两种写法):

| 参数 | 说明 | 缺省 |
| --- | --- | --- |
| `--project <dir>` / `--project-dir <dir>` | 当前工作区目录(绝对或相对)。决定 `project` / `project:<路径>` 作用域。 | `DSH_MEMORY_PROJECT` → `process.cwd()` |
| `--store-dir <dir>` / `--store <dir>` | 记忆存储目录。 | `DSH_MEMORY_STORE_DIR` → `~/.dsh-memory-store` |
| `-h` / `--help` | 打印用法后退出(0)。 | — |
| `-v` / `--version` | 打印版本后退出(0)。 | — |

进程是 **stdio 传输**:stdout 只输出 MCP 协议消息,**所有日志走 stderr**。
`SIGINT` / `SIGTERM` 会优雅退出,并且**只终止自己拉起的** llama-server(复用的外部服务原样保留)。

## 命令行与退出码

CLI 是**自描述**的,不需要读源码就能查用法:

```bash
$ node src/index.js --help      # 打到 stdout,exit 0
$ node src/index.js --version
dsh-memory-mcp 0.1.0
```

`--help` / `--version` 有两个刻意的性质:

- **不加载 MCP SDK** —— 所以 `node_modules` 没装、依赖缺失时,帮助照样能打出来。
  这是部署排障的第一步("先确认我参数写对没")。
- **不碰磁盘** —— 不建 store 目录、不探活向量后端。用一个不存在的 `--store-dir` 跑 `--help`,
  跑完那个路径仍然不存在。

| 退出码 | 含义 |
| --- | --- |
| `0` | 正常退出(`--help` / `--version`;服务在 stdin 关闭后也以 0 退出) |
| `1` | 启动失败(store 目录不可用、依赖缺失等),会打印可操作的中文提示 |
| `2` | 参数错误(未知参数、参数缺值),**不会启动服务、不碰 store** |

两条容易踩的规则:

- **未知参数不再被静默忽略**。`--store_dir`、`--storedir`、`--storeD` 这类笔误以前会让服务
  悄悄回退到默认 store(在别人机器上等于写到一个莫名其妙的目录),现在一律 exit 2 并指出是哪个参数写错了。
- **flag 缺值同样报错**。`--store-dir` 后面什么都没有、或紧跟另一个 `--xxx`,都算缺值 ——
  不会把 `--help` 当成目录名吃掉。

启动失败时给的是可操作的中文诊断,不是 Node 裸栈:

```
[dsh-memory-mcp] ❌ 启动失败:记忆存储目录不可用:Q:\nope\store
[dsh-memory-mcp]    ⇒ 原因:盘符 Q: 不存在(这台机器上没有这个盘)
[dsh-memory-mcp]    ⇒ 改 --store-dir(或环境变量 DSH_MEMORY_STORE_DIR)指向一个已存在且可写的目录;默认是 C:\Users\me\.dsh-memory-store
[dsh-memory-mcp]    原始错误:ENOENT ENOENT: no such file or directory, mkdir 'Q:\nope\store\projects'
```

需要完整调用栈时设 `DSH_MEMORY_DEBUG=1`。已覆盖的诊断:盘符不存在、父目录不存在、路径已存在且是个文件、
无写入权限、缺依赖(`npm install` 提示)。

## 验证你的部署

刚 `npm install` 完,别急着配 IDE —— 先用下面 5 步确认**你自己这台机器**是好的。
全部用临时目录,不会碰你真实的记忆库。

> 下面命令块是 **bash / zsh** 写法;PowerShell 的差异标在每行后面的注释里。
> ④⑤ 里的 `--store-dir` 指向一个临时目录,**跑完可以直接删**。

```bash
# ① Node 版本够不够(要 >= 20.3.0;低于它会在向量检索时才炸,很难查)
node -v
node -p "require('./package.json').engines.node"

# ② 依赖 + 版本 + storeDir 一次查完(只读,不建目录、不碰记忆库)
node scripts/check-install.mjs
#   想连"我会落到哪个 storeDir"一起确认,就把要用的参数带上:
#   node scripts/check-install.mjs --store-dir <你的 DSH storeDir>

# ③ CLI 能自描述(--version / --help 都不加载 SDK、不建目录,依赖没装也能用)
node src/index.js --version
node src/index.js --help | head -3
#   PowerShell: node src/index.js --help | Select-Object -First 3

# ④ 实际生效的 storeDir 对不对 —— 看 stderr 首三行
#    注意 stdin 必须关掉/喂空,否则 stdio 服务会一直等输入不退出
echo '' | node src/index.js --store-dir /tmp/dsh-probe
#   PowerShell: echo '' | node src/index.js --store-dir "$env:TEMP\dsh-probe"

# ⑤ MCP 握手通不通(喂一个 initialize 给 stdin,stdout 应回一行 JSON-RPC)
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"selfcheck","version":"1.0.0"}}}' \
  | node src/index.js --store-dir /tmp/dsh-probe
#   PowerShell 用上面这条原样即可(echo 是 Write-Output 的别名,单行 JSON 没问题)
```

**每一步该看到什么**(以下输出在 Windows(Node 26)与 Linux(Node 20/22/24)上逐条实际跑过;
除路径写法以外一致)。

① 版本检查 —— `engines` 会原样打出来,自己比一下:
```
v26.3.0
>=20.3.0
```

② 部署自检 —— 三行绿色 `✅` 就是好的:
```
  ✅ Node 版本 26.3.0(要求 >= 20.3.0)
  ✅ 依赖 @modelcontextprotocol/sdk 1.32.1
     file:///C:/path/to/dsh-memory-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/index.js
  ✅ 入口 src/index.js 存在
```
然后它会告诉你**会落到哪个 storeDir**。如果用的是默认值,你会看到一条 `⚠️`:
```
  ⚠️  storeDir = C:\Users\me\.dsh-memory-store
     ⇒ 这是**默认值**。它只保证能跑,不保证就是你 DSH 在用的那个库。
```
看到这条 `⚠️` 就要警惕了 —— 接着带上真实参数再跑一次,确认它认得出你的库:
```bash
node scripts/check-install.mjs --store-dir <你的 DSH storeDir>
# 期望多出一行:✓ 该目录里有 global.jsonl,看起来是一份已有的记忆库
```

> **为什么不用 `npm ls @modelcontextprotocol/sdk --depth=0`**:从 npm 装进别的项目时
> `node_modules` 是**平铺(hoisted)**的,本包目录下没有自己的 `node_modules`,
> `npm ls` 会打出 `-- (empty)` —— 那表示"依赖被提升到上一层",**不是**"没装",
> 很容易让人误判成安装失败。`check-install.mjs` 用 Node 自己的解析算法,两种布局下都准。

③ 自描述 —— 退出码 `0`,且 `--help` 第一行带版本号:
```
dsh-memory-mcp 0.1.0
dsh-memory-mcp 0.1.0 —— 把 DSH 的长期记忆库暴露成独立 MCP 服务(stdio)
```

④ **这一步最容易查出问题**。前几行 stderr 就是**实际生效**的配置(不是你以为的那个)。
第 4 行起是向量后端的日志,因机器而异(关闭 / 复用已有服务 / 自行拉起 / 启动失败退化),
**不影响判断 —— 只看前 3 行**。看到 `已启动 dsh-memory-mcp v0.1.0(stdio)` 即启动成功:
```
[dsh-memory-mcp] store-dir  = C:\Users\me\AppData\Local\Temp\dsh-probe
[dsh-memory-mcp] project   = D:\dev\my-app(project 作用域 = project:D:\dev\my-app)
[dsh-memory-mcp] 默认保存作用域 = global
[dsh-memory-mcp] 已启动 dsh-memory-mcp v0.1.0(stdio)        ← 这行 = 启动成功
```
- `store-dir` 必须等于**你 DSH 插件正在用的那个目录**。不相等 = 两边看到两份互不相通的库。
- 没传 `--store-dir` 时会额外多打一行 `ℹ️ 未指定 --store-dir … 使用默认目录`,说明你正在用默认库
  (`~/.dsh-memory-store`),**多半不是你 DSH 那个**。
- 对照办法:去那个目录 `ls`,有没有 `global.jsonl`。
- 若看到 `vector: llama-server 启动失败(…),向量后端不可用,退化为纯词法检索`:**不是错误**,
  服务照常工作,只是没有语义召回。换机器后想恢复向量,按 [环境变量](#环境变量) 那张表配
  `DSH_MEMORY_EMBED_EXE` + `DSH_MEMORY_EMBED_MODEL`,或直接设 `DSH_MEMORY_VECTOR=off` 关掉它。

⑤ 握手 —— stdout **只有一行** JSON-RPC(日志全在 stderr,这是 stdio 传输的硬要求):
```json
{"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"dsh-memory-mcp","version":"0.1.0"}},"jsonrpc":"2.0","id":1}
```
看到这行 = 进程能拉起来、协议层是通的。想让 IDE 之外更完整地验一遍工具清单,直接跑
`npm test`(见 [自测](#自测))。

> ④⑤ 里 `--store-dir` 指向的临时目录**跑完可以删**;它只证明"能启动",不代表配好了。
> 真正要共用记忆时,必须显式 `--store-dir` 指向 DSH 插件的 `storeDir`。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_MEMORY_PROJECT` | `process.cwd()` | 当前工作区目录,等价于 `--project`。 |
| `DSH_MEMORY_STORE_DIR` | `~/.dsh-memory-store` | 存储目录,等价于 `--store-dir`。 |
| `DSH_MEMORY_SCOPE_ALL` | `false` | `1`/`true`/`yes`/`on` ⇒ `memory_save` 省略 scope 时默认写 **project** 而不是 **global**。 |
| `DSH_MEMORY_VECTOR` | 开启 | `off`(或 `0`/`false`/`no`/`disabled`)⇒ 完全关闭向量,退化为纯词法检索。 |
| `DSH_MEMORY_EMBED_ENDPOINT` | — | 直接指定已有的 embedding 服务(如 `http://127.0.0.1:8078`)。**设了它就永不 spawn 进程,也永不杀进程。** |
| `DSH_MEMORY_EMBED_EXE` | `D:\dev\llamacpp\llama-server.exe` ⚠️ | llama-server 可执行文件。**默认值是作者本机路径,换机器必须设。** |
| `DSH_MEMORY_EMBED_MODEL` | `D:\dev\models\Qwen3-Embedding-0.6B-Q8_0.gguf` ⚠️ | gguf 模型文件。**同上。** |
| `DSH_MEMORY_EMBED_PORT` | `8199` | 端口(避开 DSH 的 8078,两者可共存)。 |
| `DSH_MEMORY_EMBED_THREADS` | `6` | llama-server 线程数。 |
| `DSH_MEMORY_EMBED_POOLING` | 按模型推断 | 池化方式。**换模型时务必确认这一项**(见下)。 |
| `DSH_MEMORY_DEBUG` | 关闭 | `1` ⇒ 启动失败时额外打印完整调用栈(默认只打一行原始错误)。 |

> ⚠️ 向量相关的三个默认值(`EXE` / `MODEL`)是**作者本机的绝对 Windows 路径**。
> 别人 clone 后直接跑,向量后端会 spawn 失败 —— 但服务**不会崩**,只是静默退化为纯词法检索。
> 换机器时三选一:设 `DSH_MEMORY_EMBED_EXE` + `DSH_MEMORY_EMBED_MODEL`;或用
> `DSH_MEMORY_EMBED_ENDPOINT` 指向已有的 embedding 服务;或直接 `DSH_MEMORY_VECTOR=off` 关掉向量。

## 五个工具

所有工具都返回 `{ content: [{ type: 'text', text }], structuredContent: {...} }`,
文本是给人(和模型)看的友好渲染,`structuredContent` 是给程序用的结构化数据。

### `memory_save`

保存一条长期记忆。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `content` | string | ✅ | — | 一句自包含的陈述句,不依赖上下文也能读懂。 |
| `scope` | string | | **global** | 作用域。省略时写入 `global`(见下方说明)。 |
| `path` | string | | — | 工作区目录。给出后写入 `project:<解析后的绝对路径>`。 |
| `kind` | enum | | `note` | `fact` / `decision` / `preference` / `procedure` / `note` / `rule`。 |
| `tags` | string[] | | `[]` | 自由标签。 |
| `importance` | number | | — | `0~1`,越界报错。 |
| `supersedes` | string | | — | 被本条取代的记忆 id。 |

> **默认 scope = `global`**,这是与 DSH 最重要的差异。
> DSH 里 `tools.defaultScope` 是 `session`,但 Trae / WorkBuddy / DSH 各自的 session id 完全不同,
> session 作用域**无法跨 IDE 共享**。真正能共享的只有 `global` 与 `project:<绝对路径>`,
> 所以 MCP 默认写 `global`,让三个 IDE 看到同一份记忆。
>
> 想要「只对当前工作区生效」,显式传 `scope: "project"` 或 `path: "<工作区目录>"`。
>
> 也可以用 `DSH_MEMORY_SCOPE_ALL=true` 把默认改成 `project`。**默认不开启** ——
> 默认写 `global` 的收益是「Trae 里学到的偏好,WorkBuddy 里立刻能用」,
> 而代价是 global 作用域会混入各个项目的记录。对多数个人使用者来说,
> 跨 IDE 共享的价值大于作用域混在一起的代价,所以默认选 `global`。

输出示例:

```
已保存记忆 ae2061aa @ global
```

### `memory_search`

按关键词或语义检索。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `query` | string | ✅ | — | 关键词或一句话描述。 |
| `scope` | string | | **当前项目 + global** | `all` / `*` = 所有已发现作用域(只读)。 |
| `topK` | number | | `5` | `1~20`。 |

输出示例:

```
找到 2 条记忆(检索范围:D:/dev/my-app, global)

[0.4213] (global/procedure) 本机 DSH 的 desktop profile 由 Electron 应用独占管理
    id=ae2061aa  tags=DSH,desktop profile  importance=0.90  updated=2026-10-19 12:03:11

[0.1875] (project:D:/dev/my-app/decision) 前端统一用 TypeScript 严格模式
    id=be1c02d7  importance=0.70  updated=2026-10-20 09:15:22

提示:需要完整内容时用 memory_get 传入上面的 8 位 id 前缀。
```

### `memory_list`

列出记忆,按最近更新优先。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `scope` | string | | **当前项目 + global** | `all` = 所有作用域。 |
| `kind` | string | | — | 按种类过滤。 |
| `limit` | number | | `50` | `1~200`。 |

### `memory_get`

按 id 取回具体内容(可写 8 位前缀)。**已知 id 时用它,不要为此再跑一次 search。**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `ids` | string[] | ✅ | id 或 8 位前缀。自动去重,最多取前 50 个。 |

### `memory_forget`

删除记忆。`id` 与 `query` **恰好二选一**。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 二选一 | 精确 id(或 8 位前缀)。跨作用域唯一,`scope` 参数不适用。 |
| `query` | string | 二选一 | 按内容子串批量删。 |
| `scope` | string | | query 路径省略时**只作用于当前工作区**(不会误删 global)。 |

- 都不给 → `TARGET_REQUIRED`
- 都给 → `TARGET_AMBIGUOUS`
- `scope: "all"` 与 `query` 同用 → `SCOPE_NOT_WRITABLE`(防批量误删)

输出示例:

```
已删除 1 条记忆 ae2061aa @ global
```

### 结构化输出

每个工具除了给模型的文本,还返回 `structuredContent`,字段名**与上游 DSH 插件保持一致**
(同一个 agent 在两边可以用同一套读取习惯):

| 工具 | `structuredContent` 关键字段 |
| --- | --- |
| `memory_save` | `{ ok, id, deduped, scope, kind }` |
| `memory_search` | `{ ok, count, scopes, records: [{ id, shortId, score, scope, kind, content, tags, importance, updatedAt }] }` |
| `memory_list` | `{ ok, count, scopes, records: [...] }` |
| `memory_get` | `{ ok, count, records: [...], missing: [...] }` |
| `memory_forget` | `{ ok, deleted, ids: [...] }` |

出错时返回 `isError: true` + `{ ok: false, code, message }`。**不抛栈**,文本里写明怎么改。

参数校验类错误码:

| 错误码 | 触发点 |
| --- | --- |
| `CONTENT_EMPTY` | `memory_save` 的 `content` 为空或非字符串 |
| `QUERY_EMPTY` | `memory_search` 的 `query` 为空或非字符串 |
| `KIND_INVALID` | `kind` 不在六种之内(`memory_save` 与 `memory_list` 共用) |
| `IMPORTANCE_RANGE` / `TOPK_RANGE` / `LIMIT_RANGE` / `IDS_EMPTY` | 对应数值越界,或 `ids` 是空数组 |
| `TARGET_REQUIRED` / `TARGET_AMBIGUOUS` | `memory_forget` 的 `id` 与 `query` 都不给 / 都给 |
| `PATH_INVALID` | `path` 是空串 |
| `PATH_SCOPE_CONFLICT` | 同时给 `path` 和 `scope: global/session/all` |

作用域类错误码:

| 错误码 | 触发点 |
| --- | --- |
| `SCOPE_INVALID` | 作用域名不合法(含 `:` `/` `\` `..`、控制字符、超长、保留名) |
| `SCOPE_NOT_WRITABLE` | 用 `all` 写;或 `memory_forget` 把 `all` 与 `query` 同用 |
| `SCOPE_NAME_INVALID` / `SCOPE_NAME_TAKEN` | 别名本身非法 / 该别名已被**另一个路径**占用(来自 `scope-names.js`) |

存储与兜底类错误码:

| 错误码 | 触发点 |
| --- | --- |
| `LOCK_TIMEOUT` / `LOCK_RECURSION` | 取锁 10 秒超时 / 同进程对同一把锁递归加锁 |
| `STORE_ERROR` | 存储层返回了无法识别的结果(适配层兜底) |
| `UNKNOWN_TOOL` / `TOOL_ERROR` | 工具名不存在 / 任何未归类的异常 |

> 注意 `memory_search` 的记录数组字段是 **`records`**(不是 `results`),与上游
> `lib/tools/index.js` 的 `{ records: [...] }` 对齐。

## 记忆在磁盘上长什么样

```
<store-dir>/
├── global.jsonl                    ← scope 键 "global"
├── global.vec                      ← 向量边车,首行 #qwen3-embedding-0.6b\t1024
├── projects/<sha1(scope)>.jsonl    ← 其他任何 scope 键
├── projects/<sha1(scope)>.vec
├── scopes.json                     ← 作用域别名(只有登记过别名才存在)
├── .locks/                         ← 每 scope 一个锁文件(sha1(scope).lock)
├── llama-server-mcp.log            ← 自己 spawn 的向量后端日志(仅 spawn 过才存在)
└── settings.json                   ← DSH 的注入设置(本 MCP **不读不写**)
```

**排查"记忆去哪了"时,就看这个目录里有没有 `global.jsonl`、以及 mtime 是不是刚刚。**
`llama-server-mcp.log` 是排查"语义检索为什么不生效"的第一现场。

## Trae / WorkBuddy 配置

两个 IDE 的 MCP 配置格式一样(`mcpServers` 对象)。下面两段直接贴进对应配置文件即可。

### Trae

配置文件:`%APPDATA%\Trae CN\User\mcp.json`(本机实测路径)。
也可以在 Trae 里 **设置 → MCP 服务器 → 添加** 手动填。

### WorkBuddy

配置文件:`%USERPROFILE%\.workbuddy\mcp.json`。

### 一份可直接改的模板

下面把本机的绝对路径换成了占位符。**三个 ⚠️ 处必须换成你自己的**:

```json
{
  "mcpServers": {
    "dsh-memory": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\path\\to\\dsh-memory-mcp\\src\\index.js",
        "--store-dir",
        "C:\\Users\\me\\.dsh-memory-store"
      ],
      "env": {
        "DSH_MEMORY_EMBED_EXE": "C:\\path\\to\\llama-server.exe",
        "DSH_MEMORY_EMBED_MODEL": "C:\\path\\to\\Qwen3-Embedding-0.6B-Q8_0.gguf",
        "DSH_MEMORY_EMBED_POOLING": "last"
      }
    }
  }
}
```

> `command` 写**node 的绝对路径**而不是 `node` —— IDE 拉起 MCP 时继承的 PATH 常常不含 node,
> 写 `node` 会报「不是内部或外部命令」。
>
> `--store-dir` 必须**指向 DSH 插件在用的那个目录**,否则两边看不到同一份记忆。
>
> 不想配向量后端的话,把 `env` 整段删掉、改成 `"DSH_MEMORY_VECTOR": "off"`,只保留词法检索 ——
> 记忆照样能读写,只是没有语义召回。

### 关于 `--project`:全局配置里**故意不写**

> ⚠️ 上面这份配置里**没有** `--project`,这是刻意的。
>
> MCP 配置是**全局**的(一个配置文件服务所有项目),而 `--project` 是单一值。
> 一旦写死成某个具体项目,那么你在 Trae 里打开**任何其它项目**时,
> 它的 `project` 作用域都会错误地落到那个目录 —— 所有项目的记忆混进同一个桶。
>
> 不写 `--project` 时,服务退回 `process.cwd()`。**正确用法是按项目单独配一份**:
>
> - **项目级配置**(推荐):在项目根放 `.trae/mcp.json`(Trae 需在设置里开启「项目级 MCP」),
>   或 `.workbuddy/mcp.json`(WorkBuddy),此时加 `--project <项目绝对路径>`。
> - **或者干脆不用 project 作用域**:`memory_save` 默认写 `global`,
>   `memory_search` 默认检索「当前项目 + global」。全局配置下项目识别可能不准,
>   但 `global` 那部分始终正确 —— 而跨 IDE 共享的本来就是 `global`。
> - 想让保存默认落到项目而不是 global,加 `"DSH_MEMORY_SCOPE_ALL": "true"`。

**如果 IDE 不支持 `env` 字段**,把环境变量写进 `command` 的调用脚本里。
别指望"省略 `--store-dir` 就行" —— 默认目录是 `~/.dsh-memory-store`,与你的 DSH storeDir 多半不是同一个。

### 接好之后先自测一遍

不用真的让 agent 去调工具,先确认进程能被拉起来:

```bash
# CLI 层(不建连接):确认参数/版本/路径都对
node <repo>/src/index.js --version
node <repo>/src/index.js --help

# 真正起一次服务,看 stderr 首几行(stdio 型服务在 IDE 外跑需要喂一个 initialize)
echo {} | node <repo>/src/index.js --store-dir <你的目录>
```

首三行 stderr 会打印**实际生效**的 `store-dir` / `project` / 默认保存作用域 ——
「记忆写错地方」90% 在这一屏就能看出来。

## 与 DSH 共存的设计

**存储目录相同,进程独立,互不干扰。**

```
<store-dir>/
├── global.jsonl                    ← scope 键 "global"
├── global.vec                      ← 向量边车,首行 #qwen3-embedding-0.6b\t1024
├── projects/<sha1(scope)>.jsonl    ← 其他任何 scope 键
├── projects/<sha1(scope)>.vec
├── .locks/<sha1(scope)>.lock       ← 每个 scope 一把独占锁
├── scopes.json                     ← 作用域别名(登记过别名才存在)
├── llama-server-mcp.log            ← 自己 spawn 的向量后端日志(仅 spawn 过才存在)
└── settings.json                   ← DSH 的注入设置(MCP 不读不写)
```

- **作用域键 → 文件名**:`global` → `global.jsonl`;其余 → `projects/sha1(scope).jsonl`
  (哈希文件名结构上不可能路径穿越,也没有 Windows 保留名问题)。
- **记录格式**与上游逐字节兼容:
  ```json
  {"id":"<uuid>","scope":"global","kind":"procedure","content":"...","tags":[],
   "source":{"origin":"explicit"},"createdAt":1792403053326,"updatedAt":1792403053326,
   "lastAccessedAt":1792403053326,"accessCount":0,"importance":0.9}
  ```
- **向量边车**:首行 `#<model>\t<dims>`,之后每行 `<id>\t<base64(Float32Array 原始字节)>`。
  头不匹配(换过模型)时整个边车作废、重新嵌入。

### 为什么不会互相覆盖

上游 DSH 插件的 `MemoryStore` 是**进程内快照 + 全量重写**:
`loadScope()` 每个 scope 只读盘一次,`flush()` 拿内存快照重写整个文件。
两个进程共用时,后者的快照里没有前者刚写的记录,一次 flush 就**确定性抹掉**。

本项目的 `SharedStore` 换掉了这一层:

- 粒度为单个 scope 文件的**独占锁文件**(`openSync(path, 'wx')` / O_EXCL);
- 每个「读-改-写」事务都在锁内**重新从磁盘读取**该 scope 的全部记录;
- 写盘走 tmp + `renameSync` 原子替换;
- `.vec` 向量边车走**单行 append**(append 语义天然跨进程安全),删除向量时才在锁内全量重写。

> ⚠️ **注意**:DSH 插件本身仍然是「快照 + 全量重写」。当 DSH 进程和 MCP 进程**同时**写同一个 scope 时,
> **数据是双向互毁的,不是单方面碾压**。`scripts/acceptance-coexist.mjs` 实测:
>
> ```
> 加锁写者 A 写入 24 条 → 磁盘剩 12 条
> 上游式写者   写入 12 条 → 磁盘剩  0 条
> 合计磁盘 12 条（写入前双方共 36 条）
> ```
>
> 本项目的锁能保证**自己这一侧**的事务不丢(串行写 5/5、外部追加不被 flush 抹除均已验证),
> 但**挡不住另一个进程的无锁全量重写** —— 这是上游 `MemoryStore` 的病,本项目修不了它。
>
> **实务纪律(唯一可靠的办法)**:
> - **读随便读**,两边同时读完全没问题(读路径不产生覆盖)。
> - **写同一时刻只让一个进程写**。日常用法是 DSH 与 MCP 交替着来,
>   不要在两边同一瞬间各写一条。
> - MCP 侧的 3 个实例之间(多个 IDE 同时开)**不会**出问题 —— 它们共用同一把锁。

### 与上游的版本关系

本项目基于 **0.8.0** 的源码(本机已升级到 0.8.0,2026-10-20)。

**已核对 0.7.2 → 0.8.0 的差异**:只改动了 6 个文件(`client.js` / `panel.js` /
`provider/apply.js` / `provider/index.js` / `package.json` / `README.md`),
**`store.js` / `scoring.js` / `scope.js` / `scope-names.js` / `tools/*` 逐字节未变** ——
所以本项目复用这些模块的部分**不受版本升级影响**,升级后实测验收 13/13 全绿。

升级上游后仍建议比对这几个文件(它们才是与本项目耦合的部分)。

> 上游包**无法被直接 import**:`exports` 只声明了 `.` / `./client` / `./package.json`(没有 `lib/*` 子路径),
> 裸包根入口又会因 `@deepseek-ai/cordis` peer 依赖而 `ERR_MODULE_NOT_FOUND`。
> 所以本项目**复制**了那几个零依赖纯模块的源码(`scoring.js` / `scope.js` 逐字复制,
> `store.js` 重写但保持字节级格式兼容),版权声明见 `third-party-notices.md`。

## scope 语义(与 DSH 的差异)

**键空间**(与上游完全一致):

| 形式 | 含义 |
| --- | --- |
| `global` | 所有项目共享 |
| `project:<绝对路径>` | 一个工作区 |
| `session:<id>` | 一个会话(同一套 `projects/<sha1>` 文件体系) |
| 自定义名 | 自由命名 |

**自定义名规则**:内部空白(含制表/换行)折叠为单个空格 → 转小写 → 长度 1~64 码点 →
禁 `:` `/` `\` `..` 控制字符、禁纯点/空格组成的名字、禁保留名 `global`/`project`/`session`/`all`。
**任何不合法的作用域名一律报错,绝不静默回退。**

**MCP 里的默认行为**(与 DSH 不同,原因见下):

| 工具 | 省略 scope 时 | 原因 |
| --- | --- | --- |
| `memory_save` | `global` | 跨 IDE 共享的只有 global 与 project。 |
| `memory_search` | 当前项目 + global | session 在 MCP 里没有共享意义。 |
| `memory_list` | 当前项目 + global | 同上。 |
| `memory_forget`(query) | 当前项目 | 比 session 安全,不会误删别人的。 |

**为什么不用 session**:DSH 的 session id 来自 DSH 自己的会话头,Trae / WorkBuddy 各有各的 id。
用 session 作用域等于**每个 IDE 一份互不相通的记忆**,跨 agent 共享就无从谈起。
所以本 MCP 把裸 `session` 落到**当前工作区**(与上游「拿不到会话就回退 project」同语义),
但**显式 `session:<id>` 仍然原样保留**,可以 pin 某个会话作用域。

**路径归一化**(必须归一化,否则同一个目录会分裂成两个 scope):

- 绝对路径 → 折叠 `.` / `..`、去掉末尾分隔符、盘符大写(`c:\x` → `C:\x`);
- 相对路径 → 按 `DSH_MEMORY_PROJECT` / `--project` 解析(都没有才按 `process.cwd()`)。

## 向量开关

**默认开启**,但**完全可选**。

- 检索是**混合召回**:`hybrid = max(lexical, cosine)`,**不是**加权求和。
  词法通道用 IDF + CJK bigram(每个 scope 内部独立统计 IDF),
  有强命中(共享拉丁词或 CJK bigram)用宽松阈值(`global` 0.12 / 其余 0.1),
  只有单字 CJK 命中则要求 `max(floor, 0.25)`。
- 向量通道:`minScore` 0.5,`recallN` 30,`topK` 默认 5,score 保留 4 位小数。
- 排序:score 降序 → scope 层级(session 0 > project 1 > 自定义 2 > global 3)→ `id.localeCompare`。
- 过期记录(`expiredAt < now`)跳过。

**后端生命周期**:

1. 先 `GET /health` 探活 —— **活着就复用**,不接管生命周期、不杀进程
   (所以可以和 DSH 的 8078 实例共存,本项目默认用 8199);
2. 没活才 `spawn` llama-server(`windowsHide: true`、`detached: false`),
   日志重定向到 `<store-dir>/llama-server-mcp.log`;
3. 进程退出时**只杀自己 spawn 的那个**。

**熔断**:连续失败后指数退避(1s → 2s → 4s … 上限 30s),不会每次检索都白等一次超时。
**超时分级**:交互检索 300ms 预算;写入 / 回填 10s 预算(整段内容在 CPU 上嵌入慢得多)。

**关掉向量**:

```bash
DSH_MEMORY_VECTOR=off node src/index.js
```

退化后:`memory_search` 纯词法检索,`memory_save` 不再写 `.vec` 边车,完全不碰网络。
已存在的 `.vec` 文件不受影响。

**复用 DSH 已算好的向量**:本项目默认的模型名与维度是 `qwen3-embedding-0.6b` / `1024`,
与现有 store 里的 `.vec` 头**完全一致**,所以 DSH 之前算好的向量可以直接拿来用,不必重新嵌入。
换了模型的话,头对不上,整个边车作废并重新嵌入(绝不拿旧模型的向量算相似度)。

### ⚠️ 池化方式(pooling)必须跟着模型走

`llama-server` 的 `--pooling` 决定向量落在哪个空间里。**用错了,DSH 存好的向量就全部作废**
(检索结果会变成噪声,而不是报错)。

上游 `models.js` 的原话是「BGE 系用 cls,Qwen3-Embedding 用 last」,本项目照此实现:
按模型名自动推断 —— `bge-*` → `cls`,`nomic-*` → `mean`,其余(Qwen3-Embedding 等)→ `last`。

**实测(2026-10-20,拿 `D:/dev/.dsh-memory-store/global.vec` 里 DSH 存好的向量比)**:

| llama-server 参数 | 现算向量 vs DSH 已存向量 的余弦 |
| --- | --- |
| `--pooling last` | **1.0000** —— 同一个空间,可直接复用 |
| `--pooling cls` | **0.3522** —— 完全不同的空间,混用等于噪声 |

> 所以**换模型时,除了 `DSH_MEMORY_EMBED_MODEL`,还要确认 `DSH_MEMORY_EMBED_POOLING`**。
> 换错了不会报错,只会静默地让向量检索失效 —— 这是本项目最容易踩的坑。

顺带一提:用 `cls` 时,不相关文本之间的余弦高达 **0.97**(几乎所有句子都"相似");
用 `last` 时降到 **0.41**,这才是正常嵌入空间该有的区分度。

## 已知限制

1. **与 DSH 并发写同一 scope** 有丢数据风险(见上文「为什么不会互相覆盖」的注意事项)——
   本项目的存储层是并发安全的,但**上游 DSH 插件不是**。
2. **触达计数**:检索命中后 `accessCount` 的刷新走存储层的 `touchMany(ids)` ——
   按 scope 分组,每个 scope 只取一次锁、只重写一次文件。
   只对最终返回的 topK(≤5 条)做,不对全部候选做。
   收益是打分公式里的 `accessBoost = 1 + 0.1·ln(1+accessCount)`;
   代价是每次检索会有一次小规模写盘。**这是本实现与上游的一处刻意差异** ——
   上游的 `touch` 只是把 scope 标 dirty、靠 500ms 去抖 flush(看起来免费),
   但那正是它跨进程会丢数据的那个 flush;这里没有免费的那一层。
3. **没有 LLM rerank**:上游 provider 有一个可选的第三阶段(LLM 重排,默认关闭)。
   本项目只有词法 + 向量两路召回。
4. **没有自动注入**:DSH 插件会在 agent 回合开始时自动把相关记忆注入上下文;
   MCP 侧没有这个机制 —— 其它 IDE 需要 agent **主动调用** `memory_search`。
5. **`session` 作用域在 MCP 里基本没用**:跨 IDE 的 session id 不通用。
   显式 `session:<id>` 仍然可用,但只有同一 IDE 内部才有意义。
6. **Windows 路径大小写**:归一化只统一盘符大小写(`c:` → `C:`),路径其余部分的大小写按原样保留
   (Windows 本身不区分,Linux 上可能区分)。
7. **向量是 CPU 密集型**:首次嵌入会有几秒延迟(模型加载)。

## 自测

```bash
npm install

# 一条命令跑主力三项(约 7 秒,都不碰真实 store)
npm test

# 逐项跑
node scripts/selftest-cli.mjs          # CLI 契约:--help/--version/未知参数/退出码/启动失败诊断/配置解析
node scripts/selftest-mcp.mjs          # 完整 MCP 协议端到端(真起 stdio server)
node scripts/selftest.mjs              # 存储层并发(真 fork 多进程)
node scripts/selftest-tools.mjs        # 工具层:参数校验 / scope 决策 / 渲染(内存版假 store)
node scripts/selftest-protocol.mjs     # 协议层:握手 / tools/list / tools/call(内存版假 store)
node scripts/selftest-vector.mjs       # 向量后端:配置 / 探活 / 熔断 / 生命周期
node scripts/selftest-vector-e2e.mjs   # 向量端到端:写 .vec 边车 + 语义召回

# 验收测试(会碰 store;真实库那一份需要你先指定 DSH_MEMORY_REAL_STORE,不设就跳过)
node scripts/acceptance-real.mjs       # 端到端打真实 storeDir(只写/只删自己造的记录)
node scripts/acceptance-coexist.mjs    # 与「上游式无锁写者」并存的实测数据(用临时目录)
node scripts/acceptance-standalone.mjs # 不开 DSH 的独立运行验证(纯词法可跑;自拉起后端需配环境变量)
```

| 脚本 | 覆盖 | 检查项 | 碰真实 store? |
| --- | --- | --- | --- |
| `selftest-cli.mjs` | CLI 契约:`--help`/`--version` 的零副作用、未知参数 exit 2、启动失败诊断无裸栈、`parseArgs`/`resolveConfig` 纯函数 | **115**(POSIX 114,有一条 Windows 专有断言) | 否 |
| `selftest-mcp.mjs` | 真实 stdio 握手、5 个工具的 schema、保存、检索、幂等、列表/按前缀取回、删除后不再召回、错误码、向量开关对比、落盘检查、stderr 日志 | **40** | 否 |
| `selftest.mjs` | 单进程语义、**4 进程 × 20 条真并发**、外部追加不被抹除、跨进程锁(超时/陈旧锁/粒度)、`.vec` 边车、别名映射 | **55** | 否 |
| `selftest-tools.mjs` | 路径归一化、scope 决策、全部校验错误码、检索渲染、幂等、别名、自定义作用域、schema 自检 | **60**(POSIX 59,盘符大小写折叠是 Windows 专有语义) | 否 |
| `selftest-protocol.mjs` | 握手、tools/list、tools/call 正常/错误路径、stdout 纯净性 | **18** | 否 |
| `selftest-vector.mjs` | 配置解析、探活、复用不 spawn、维度、L2 归一化、熔断退避、与已存向量的空间兼容性 | **27** | **只读** |
| `selftest-vector-e2e.mjs` | 写 `.vec` 边车 → 读回 → 不同措辞的语义召回 | **6** | 否 |
| `acceptance-real.mjs` | 对**你指定的** storeDir 跑完整协议:写入(**`path` ⇒ `project:` 作用域,并断言不是 `global`**)→ 磁盘可见 → 跨作用域读回 → 幂等 → 按前缀取回 → 删除 → 尝试确认仍能读到 DSH 既有记忆 | **18** | 需 `DSH_MEMORY_REAL_STORE`(只删自己造的) |
| `acceptance-coexist.mjs` | 与复刻上游「内存快照+全量重写」的无锁写者并发,量化双向互毁的损失 | **4** | 否(临时目录) |
| `acceptance-standalone.mjs` | **不开 DSH**:冷启动 → (可选)自拉起向量后端 → 读写 → 语义召回 → 退出后无孤儿进程 | **11** | 需 `DSH_MEMORY_REAL_STORE`(只删自己造的) |

> 检查项数在 Windows 与 Linux 上有 1~2 项差异,这是**刻意的**:被跳过的都是平台专有语义
> (盘符不存在、盘符大小写折叠),在 POSIX 上断言它们反而是错的。CI 两个平台都跑,数字对不上是正常的。

`selftest-mcp.mjs` 用官方 SDK 的 `Client` + `StdioClientTransport` 起**自己**,
真实走一遍完整的 MCP 协议握手(`initialize` → `tools/list` → `tools/call`)。

### 跑测试前必须知道的几件事

- **默认 `npm test` 不碰真实 store**:它 = `selftest-cli.mjs && selftest-mcp.mjs && selftest.mjs`。
- **`acceptance-real.mjs` 与 `acceptance-standalone.mjs` 会写 store**,所以目标库必须由你显式给出:
  ```bash
  # PowerShell
  $env:DSH_MEMORY_REAL_STORE = "D:\dev\.dsh-memory-store"; node scripts/acceptance-real.mjs
  # bash / zsh
  DSH_MEMORY_REAL_STORE=~/.dsh-memory-store node scripts/acceptance-real.mjs
  ```
  **没设这个变量时它们只打印一行提示然后 `exit(0)` 跳过**(退出码 0 表示"没测",不是"测过了")。
  脚本**不会猜路径、也不会回退到任何写死的机器路径**;入口路径从脚本自身位置推导,换机器不用改。
  它们只删自己造的记录,但半路 Ctrl-C 仍可能在库里留下几条带随机后缀标记的记录。
  想先确认脚本逻辑通、又不碰真实库:把该变量指向 `os.tmpdir()` 下的临时目录即可。
- **`acceptance-standalone.mjs` 的向量后端也只从环境变量读**:`DSH_MEMORY_EMBED_EXE` +
  `DSH_MEMORY_EMBED_MODEL`(自拉起)或 `DSH_MEMORY_EMBED_ENDPOINT`(复用已有服务)。
  都没配就打印提示,并把「自拉起后端 / 语义召回」标成**跳过** —— 不报 FAIL,也不拿作者本机的
  默认路径硬试。端口探活用 `node:net` + 原生 `fetch()`,跨平台,不需要 `netstat` / `curl`。
- ⚠️ **真实 store 是「活的」**:只要 DSH 开着,它的记忆插件就在往里写(记录、`accessCount`、
  `scopes.json` 别名),MCP 侧检索命中也会刷 `accessCount`。所以**不要拿文件 mtime 判断"测试有没有污染真实库"** ——
  改动可能来自 DSH 自己的正常写入。要判断污染,看的是**内容**:`global.jsonl` 里有没有测试专用标记字符串。
- **`acceptance-standalone.mjs` 要验证「自拉起向量后端」这一支时**,该端口(默认 8199)必须空闲;
  已被占用时它只会复用那个服务,并把「自拉起」标成**跳过**(不算失败)。
  本机实测两台 `llama-server` 常驻(8078/8199 各一个),所以默认就落在"复用"这一支。
- **`selftest-vector.mjs` 会读**(不写)真实 store 里的 `global.vec` 做向量空间比对;
  该文件不存在时自动跳过那几项。
- **`selftest-vector-e2e.mjs` 在无可用向量后端时直接 `exit(0)` 跳过** ——
  **退出码 0 不代表真的测过**。CI 里要当心这一点。
- **`acceptance-coexist.mjs` 本身是 flaky 的**(实测 8 次里约 3 次 exit 1)。原因不是本项目的锁,
  而是它故意复刻的那个"上游式写者"用固定 `${file}.tmp` 名 + rename,在 Windows 上并发 rename 同一个
  `global.jsonl` 会 `EPERM`。**这恰好是"必须用唯一 tmp 名"那条不变量的活证据**。看到 FAIL 重跑一次即可,
  不是回归。
- 所有 selftest 都在 `os.tmpdir()` 下的随机目录里跑,`selftest.mjs` 开头还有硬守卫 ——
  测试路径一旦命中真实 store 就直接中止。加 `--keep` 可以保留临时目录便于排查。

## 面向 AI agent

本仓库除了给人看的这份 README,还准备了两个 **agent 入口文件**:

| 文件 | 给谁 | 内容 |
| --- | --- | --- |
| [`AGENTS.md`](./AGENTS.md) | **接手/修改本仓库的 coding agent** | 运行时事实、启动参数与环境变量全集、**17 条改代码前必须知道的不变量**、测试地图(含平台差异与 flaky 说明)、故障 → 定位命令、CI 说明 |
| [`llms.txt`](./llms.txt) | 想**发现**本仓库的 agent / 工具(遵循 [llms.txt](https://llmstxt.org/) 约定) | 项目简介、快速开始、工具清单、配置、不变量摘要、源码结构,全部绝对 URL |

如果你正在用某个 agent 来部署这个服务,直接把 `AGENTS.md` 喂给它,比喂 README 更省 token 也更准 ——
README 里有大量"与上游的差异"「实测数据」这类对部署没用的内容。

MCP 服务本身也在**运行时**告诉客户端它能干什么:五个工具的 `description` 里写明了
"什么时候该用我 / 默认 scope 是什么 / 出错怎么改",`initialize` 时不需要额外文档。

## 许可与第三方声明

存储层与评分算法复用自上游 [`@restregular/dsh-memory`](https://github.com/RestRegular/dsh-memory)(MIT),
逐文件来源见 [`third-party-notices.md`](./third-party-notices.md)。

```
MIT License

Copyright (c) 2026 restregular
...
```
