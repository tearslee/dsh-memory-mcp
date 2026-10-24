# AGENTS.md

> 面向**接手/修改本仓库**的 coding agent。首屏(前 25 行)给出结论,后面是可核实的细节。
> 写给人的完整说明在 [README.md](./README.md);这里只写「动手前必须知道的事」。

**这是什么**:把 `@restregular/dsh-memory` 的长期记忆库(JSONL + 本地向量)抽成**独立 stdio MCP 服务**,让
DSH / Trae / WorkBuddy / ZCode 等任意 MCP 客户端共用同一份 `storeDir`。五个工具:`memory_save` / `memory_search` /
`memory_list` / `memory_get` / `memory_forget`。

**数据落在哪**:纯文件,无数据库、无后台服务。`<storeDir>/global.jsonl`、`<storeDir>/projects/<sha1(scope)>.jsonl`、
同名 `.vec` 向量边车、`<storeDir>/.locks/`、`<storeDir>/scopes.json`(只有登记过别名才存在)。

**进程由谁拉起**:IDE 的 `mcp.json` 直接 `spawn` 一个 `node <repo>/src/index.js`。它不是守护进程、不监听端口、
MCP 走 stdio JSON-RPC。唯一会开端口的进程是向量后端 `llama-server`(默认 8199)。
命令行自描述:`node src/index.js --help` / `--version` 在**不加载 SDK、不建目录**的前提下直接打印并退出 0。

**三条不可违反(违反会静默坏数据,不报错)**:
1. **不改数据格式**:JSONL 记录字段、`scope → 文件名` 映射、`.vec` 边车头与行格式,必须与上游 DSH 插件逐字节兼容。
   一改,两边就写到不同的桶/不同的向量空间里,而且**不报错**,只是检索结果慢慢变垃圾。
2. **写操作必须在锁内重新读盘**:任何「读-改-写」都要在 `withLock(scope, fn, { root })` 里、读时**重新 `readFileSync`**。
   引入内存快照、批量 flush、脏标记去抖,就会重现上游 `MemoryStore.flush()` 的确定性丢记录。
3. **stdout 只能有 JSON-RPC**:运行期日志一律 `console.error`(只有 `--help`/`--version` 写 stdout)。
   动手验证时显式传 `--store-dir` 指向临时目录 —— `DEFAULT_STORE_DIR` 是 `~/.dsh-memory-store`,
   构造 `SharedStore` 会立刻 `mkdir` 它,别在开发者自己的主目录里留实验垃圾。

---

## 1. 运行时事实(读过源码)

| 事实 | 值 | 出处 |
| --- | --- | --- |
| Node | `>=20.3.0` | `package.json` `engines`;真实下限由 `src/vector.js:366` 的 `AbortSignal.any()` 决定(20.3.0 才提供,20.2 及以前是 `undefined`)。原值 `>=22.13.0` 无源码依据,已下调 |
| 模块 | `"type": "module"`,纯 ESM,无构建步骤 | `package.json` |
| 入口 | `src/index.js`(`bin.dsh-memory-mcp`),有 shebang;`--help` / `--version` / 退出码 0/1/2 | `package.json` + `src/index.js` |
| 唯一外部依赖 | `@modelcontextprotocol/sdk@1.32.2`(精确版本,非 `^`) | `package.json` |
| 依赖只用在哪 | 只有 `src/server.js` 三行 import(`server/index.js`、`server/stdio.js`、`types.js`) | grep `from '@modelcontextprotocol` |
| 其余 8 个 src 文件 | 零外部依赖,只 import `node:*` 与彼此 | 同上 |
| 版本号 | `0.1.0`,两处必须同步:`package.json` `version` 与 `src/server.js` `SERVER_VERSION` | `selftest-cli.mjs` 断言 |

`src/` 共 9 个文件:`index.js` `server.js` `tools.js` `store.js` `lock.js` `scope.js` `scope-names.js`
`scoring.js` `vector.js`。`package.json` 的 `exports` 把它们逐个映射成子路径(`./store` `./vector` …),
**新增文件必须同步补 `exports`**,否则 `import 'dsh-memory-mcp/xxx'` 会失败。

### 启动参数(`src/index.js` → `parseArgs`)

四个 flag 名 × 两种写法,共 8 种组合**全部支持**(空格形式 `--flag <v>`,等号形式 `--flag=<v>`):

| 参数 | 说明 |
| --- | --- |
| `--project <dir>` / `--project-dir <dir>` | 决定 `project` 作用域。缺省 `DSH_MEMORY_PROJECT` → `process.cwd()` |
| `--store-dir <dir>` / `--store <dir>` | 记忆目录。缺省 `DSH_MEMORY_STORE_DIR` → `DEFAULT_STORE_DIR`(`~/.dsh-memory-store`,**不是**作者本机路径) |
| `-h` / `--help` | 用法打到 **stdout**,exit 0。**不启动服务、不探活向量、不建 store 目录、不加载 MCP SDK** —— 所以依赖没装也能查用法 |
| `-v` / `--version` | 打 `dsh-memory-mcp <version>`,exit 0。版本来自 `packageVersion()`(读 `package.json`,单一来源) |

- 两个路径都过 `resolve()`,相对路径按**进程 cwd** 解析。
- **未知参数不再被静默忽略**:`--store_dir` / `--storedir` / `--nope` 一律 stderr 报错 + **exit 2**,
  **不会**回退到默认 store(旧行为会让笔误悄悄写到默认目录,使用者以为在用自己指定的库)。
- flag 缺值(`--store-dir` 结尾、或下一个 token 又是 `--xxx`)同样 exit 2,**不会**把 `--help` 当目录名吃掉。
- `--project` 指向的目录不存在时**只告警、不阻止启动**(project 作用域仍按该路径建立)。
- 退出码约定:`0` 正常(含 `--help`/`--version`、stdin 关闭后退出);`1` 启动失败(store 目录不可用、依赖缺失);
  `2` 参数错误(此时不启动服务、不碰 store)。
- 运行期日志全部 stderr;唯一写 stdout 的是 `--help` / `--version`(那时 MCP 会话还没建立)。

### 环境变量(11 个,全部 `DSH_MEMORY_` 前缀)

| 变量 | 默认 | 语义 |
| --- | --- | --- |
| `DSH_MEMORY_PROJECT` | `process.cwd()` | 同 `--project` |
| `DSH_MEMORY_STORE_DIR` | `~/.dsh-memory-store` | 同 `--store-dir` |
| `DSH_MEMORY_SCOPE_ALL` | 关 | 真值(`1/true/yes/on`)⇒ `memory_save` 省略 scope 时默认写 `project` |
| `DSH_MEMORY_VECTOR` | 开 | 假值(`off/0/false/no/disabled`)⇒ 纯词法检索 |
| `DSH_MEMORY_EMBED_ENDPOINT` | — | 直接指定已有服务;**设了就永不 spawn、也永不杀** |
| `DSH_MEMORY_EMBED_EXE` | `D:\dev\llamacpp\llama-server.exe` | llama-server 可执行文件 |
| `DSH_MEMORY_EMBED_MODEL` | `D:\dev\models\Qwen3-Embedding-0.6B-Q8_0.gguf` | gguf 模型文件 |
| `DSH_MEMORY_EMBED_PORT` | `8199` | 端口(DSH 的 provider 用 8078) |
| `DSH_MEMORY_EMBED_THREADS` | `6` | llama-server `-t` |
| `DSH_MEMORY_EMBED_POOLING` | 按模型名推断 | `bge*`→`cls`、`nomic*`→`mean`、其余→`last` |
| `DSH_MEMORY_DEBUG` | 关 | 真值 ⇒ 启动失败时额外打印完整调用栈(默认只打一行) |

> ⚠️ **换机器必踩的坑有两个,不是一个**:
> 1. `DEFAULTS.exe` / `DEFAULTS.model`(`src/vector.js` 的 `DEFAULTS` 对象)是**作者本机的绝对 Windows 路径**
>    (`D:\dev\llamacpp\llama-server.exe`、`D:\dev\models\...gguf`)。别人 clone 后直接跑,向量后端会 spawn 失败
>    并静默退化为纯词法检索。正确做法:设 `DSH_MEMORY_EMBED_EXE` / `DSH_MEMORY_EMBED_MODEL`,
>    或用 `DSH_MEMORY_EMBED_ENDPOINT` 指向已有的 embedding 服务,或 `DSH_MEMORY_VECTOR=off` 直接关向量。
> 2. `DEFAULT_STORE_DIR` **已经**改成平台中立的 `~/.dsh-memory-store`(不再是作者本机路径)。
>    但它**只保证"能跑",不保证"跑对了库"** —— 本服务真正要共用的是 DSH 插件的 `storeDir`。
>    两者不一致时服务照常启动,只是读到的是另一份(空的)记忆库。所以 `main()` 在用默认值启动时
>    会打一条 `ℹ️ 未指定 --store-dir ...` 提示,要求核对与 DSH 是否同一个目录。**别把那条提示删掉**。
>
> 另:两个 `acceptance-*.mjs` 已**不再**写死任何本机路径 —— 目标库读 `DSH_MEMORY_REAL_STORE`(未设则跳过)、
> 向量后端读 `DSH_MEMORY_EMBED_EXE`/`MODEL`,仓库入口从脚本自身位置推导(见 §3)。

### 向量后端(`src/vector.js`)

- 端口 `8199`、host `127.0.0.1`、线程 `6`、维度 `1024`、API model 名 `qwen3-embedding-0.6b`。
- 生命周期:`probe()` 打 `GET /health` → 活着就 `reused`(**不接管、不杀**);不活才 `spawn`(`windowsHide: true`,
  `detached: false`),日志 **append** 到 `<store-dir>/llama-server-mcp.log`。退出时只 `stop()` 自己 spawn 的。
- 超时分级:交互检索 `300ms`(`DEFAULT_TIMEOUT_MS`),写入/回填 `10s`(`DEFAULT_WRITE_TIMEOUT_MS`)。
- 熔断:失败后指数退避 `1s→2s→4s…` 上限 `30s`;自己 spawn 且尚未就绪时的超时**不计入**熔断(冷启动保护)。
- `embed()` 失败返回 `null`,调用方静默退化 —— 所以「检索变差」不会在日志以外的地方报错。
- 日志诚实性(改过,别再退回):`#spawn()` 先登记 child → 挂监听 → **最后**才打「已启动」,且只在拿到 pid 时打 pid;
  拿不到时打「正在启动 llama-server(pid 未分配)」,**绝不出现 `pid=?`**。exe 不存在走**异步 `error` 事件**,
  会明确写「向量后端不可用,退化为纯词法检索」+ 提示核对 `DSH_MEMORY_EMBED_EXE`。
- `waitUntilReady()` 在 `!child && !spawned` 时**立刻返回 false**,不再空转满 120 秒;等待期间打一次进度提示。

### 工具层(`src/tools.js`,不 import MCP SDK —— 保持可单测)

- `KINDS` 恰六种:`fact` / `decision` / `preference` / `procedure` / `note` / `rule`;`memory_save` 省略 `kind` ⇒ `note`。
- 数值边界:`topK` 默认 5、范围 1~20;`limit` 默认 50、范围 1~200;`memory_get.ids` 最多 50;`RECALL_N=30`(先取候选再截 topK)。
- 打分:`hybrid = max(lexical, cosine)`(**不是**加权求和),再乘 `recency(30 天半衰期) × importanceFactor × accessBoost × (被取代 ? 0.3 : 1)`。
  词法地板 `global` 0.12 / 其余 0.10;只有弱命中(单字 CJK)时抬到 `max(floor, 0.25)`;向量 `minScore` 0.5。
- 省略 scope 的默认口径(schema 里逐个写明,别改):`memory_save`→`global`;`memory_search`/`memory_list`→当前 `project` + `global`;
  `memory_forget` 走 query→当前 `project`;裸 `session`→当前 `project`;`all`/`*` 只读。
- `memory_search` 只用 `touchMany()` 对**最终 topK** 刷 `accessCount`(每个 scope 一次锁一次重写);换成循环 `touch()` 会让写放大 N 倍。
- `structuredContent` 的记录数组字段叫 **`records`**(对齐上游),不是 `results`;`ok:false` 时同时带 `isError: true`。

**错误码全集**(`code` 字段,均已从源码核对):

| 错误码 | 触发点 |
| --- | --- |
| `CONTENT_EMPTY` / `QUERY_EMPTY` | `content` / `query` 非法或空(**两个不同码,README 只列了前者**) |
| `KIND_INVALID` | `kind` 不在六种里(`memory_save` 与 `memory_list` 共用) |
| `IMPORTANCE_RANGE` / `TOPK_RANGE` / `LIMIT_RANGE` / `IDS_EMPTY` | 对应参数越界或空数组 |
| `TARGET_REQUIRED` / `TARGET_AMBIGUOUS` | `memory_forget` 的 id 与 query 都不给 / 都给 |
| `SCOPE_INVALID` | 作用域名不合法(含 `:`、`/`、`\`、`..`、控制字符、超长、保留名) |
| `SCOPE_NOT_WRITABLE` | 用 `all` 写;或 `memory_forget` 把 `all` 与 query 同用 |
| `PATH_SCOPE_CONFLICT` | 同时给 `path` 与 `scope:"global"/"session"/"all"` |
| `PATH_INVALID` | `path` 为空串 |
| `SCOPE_NAME_INVALID` / `SCOPE_NAME_TAKEN` | 别名非法 / 别名已被别的项目占用(来自 `scope-names.js`) |
| `STORE_ERROR` | 存储层返回无法识别的 `save` 结果(适配层兜底) |
| `LOCK_TIMEOUT` / `LOCK_RECURSION` | 取锁 10s 超时 / 同进程递归加锁(`lock.js` 的 error code 原样透出) |
| `UNKNOWN_TOOL` / `TOOL_ERROR` | 工具名不存在 / 任何未归类异常 |

---

## 2. 不变量清单(改代码前必须知道)

1. **JSONL 记录字段与上游字节级兼容**。`store.save()` 写出的记录形状固定:
   `id`(uuid v4)、`scope`、`kind`、`content`、`tags`、`source`、`createdAt`、`updatedAt`、`lastAccessedAt`、
   `accessCount`、`importance`,可选 `supersedes`、`expiredAt`。新增字段会被 `persist()` 全量重写进**所有**记录,
   等于替 DSH 也改写了一遍文件 —— 加字段前先确认上游读得动。
2. **scope → 文件名映射不可改**(`scopeFileName()`):`global` → `global.jsonl`,**其余任何键** →
   `projects/<sha1(scope)>.jsonl`。锁文件同理:`<root>/.locks/<sha1(scope)>.lock`;`scopes.json` 用固定键
   `@@scopes.json`(整体一把锁)。
3. **`.vec` 边车格式**:首行 `#<model>\t<dims>`(例:`#qwen3-embedding-0.6b\t1024`),之后每行
   `<id>\t<base64(Float32Array 原始字节)>`。头**只含 model 与 dims,不含 pooling**。
4. **读-改-写必须在锁内重新读盘**。`readScope()` 每次现读;不要在 `SharedStore` 实例上缓存 Map。
   读路径刻意不加锁(list/search),别好心给它加锁 —— 那会把读串行化。
5. **`.vec` 写入用单行 append**(`appendFileSync`),绝不整文件重写。唯一例外:删记录时 `removeVectors()`
   在锁内过滤式重写(可接受,向量量级小)。身份不匹配时 `appendSidecar` 返回 `{appended:false}` 而**不是**覆盖。
6. **pooling 必须跟模型走**。用错不报错,只是把检索变成噪声(实测同一条记录 `last` → cos 1.0000,`cls` → 0.3522)。
7. **`vecIdentity` 必须在第一次 `readSidecar()` 之前设好**。`src/index.js` 靠**构造函数参数**
   `new SharedStore(dir, { vecIdentity })` 保证顺序;后置 `setVecIdentity()` 会重犯上游 issue #1 的时序坑。
8. **锁是同步的**:`withLock(scope, fn, opts)` 的 `fn` 必须是同步函数;同进程对同一把锁递归加锁会抛
   `LockRecursionError`(提前拦,不等 10s)。锁超时 **10s 抛错**,不无限等;陈旧判定 = 同机 pid 已死 **或** 持锁超 30s。
9. **原子写 tmp 名必须带 pid + 随机数**。上游固定 `${file}.tmp`,两个进程并发会互相覆盖同一个 tmp,
   那不是原子写。删除类操作也用 `atomicWrite`,不要退回 `writeFileSync`。
10. **`contentHash = sha1(\`${scope}::${normalizeContent(content)}\`)`** —— 幂等去重与「按 query 删除」都建在它上面。
    改公式 = 新旧记录去重不到一起(历史数据里同名内容会变成两条)。
11. **`global` 永不删文件**:即使被清空也只写空文件(`persist()` 有特判);`removeFiles('global')` 返回 `false`。
12. **别名不得跨路径共用**(`SCOPE_NAME_TAKEN`),项目作用域的身份永远是 `project:<绝对路径>`,别名只影响展示。
13. **`src/index.js` 里 `import('./server.js')` 必须保持动态导入**。`server.js` 静态依赖 MCP SDK,
    而 ESM 的静态 import 在**链接阶段**就崩 —— `main()` 的 try/catch 和 `main().catch()` 都轮不到执行,
    用户只会看到十行英文栈。只有动态导入才能把「依赖没装」翻译成中文提示,也才能让 `--help` / `--version`
    在 `node_modules` 缺失时照常工作。同理:`src/index.js` 的顶层**不得**静态 import `./server.js`。
14. **`--help` / `--version` 必须在任何 `mkdir` / 动态 import 之前返回**。一旦有人把初始化挪到它们前面,
    「依赖没装也能查用法」和「参数错误不碰 store」这两个契约就同时失效。

---

## 3. 测试地图(行数与耗时为本机实测,node v26.3.0)

| 脚本 | 耗时 | 检查项 | 碰真实 store? | 备注 |
| --- | --- | --- | --- | --- |
| `selftest-cli.mjs` | 2.3s | 115(Win)/114(POSIX) | 否 | CLI 契约:`--help`/`--version`/未知参数/退出码/启动失败诊断/配置解析。零副作用(缺依赖场景用 tmpdir 副本模拟) |
| `selftest-mcp.mjs` | 1.1s | 40 | 否 | 真起 stdio server(SDK `Client` + `StdioClientTransport`),`--keep` 保留 tmpdir |
| `selftest.mjs` | 3.5s | 55 | 否 | 真 fork 子进程(`--worker` 自己);开头 `assertNotRealStore()` 硬守卫,命中真实路径直接中止 |
| `selftest-tools.mjs` | 0.06s | 60(Win)/59(POSIX) | 否 | 纯内存假 store,只 import `tools.js`/`scope.js` |
| `selftest-protocol.mjs` | 0.4s | 18 | 否 | 内存假 store + 临时入口,验证 stdout 纯净性 |
| `selftest-vector.mjs` | 0.35s | 27 | **只读** | 若 `D:\dev\.dsh-memory-store\global.vec` 存在会**读**它做向量空间比对;不写 |
| `selftest-vector-e2e.mjs` | 0.6s | 6 | 否 | 用 tmpdir;无可用后端时**直接 `exit(0)` 跳过**(退出码 0 不代表测过) |
| `acceptance-coexist.mjs` | 0.5s | 4 | 否(临时目录) | spawn `legacy-writer.mjs` 复刻上游无锁写者,量化双向丢数据。**已知 flaky,见下** |
| `acceptance-real.mjs` | 数秒 | 18 | 需 `DSH_MEMORY_REAL_STORE` | 打**你指定**的 storeDir(未设环境变量则打印提示 `exit(0)` 跳过)。写入用 `path` 参数并**断言** scope 为 `project:<测试目录>`;结束按 id 删自己造的 |
| `acceptance-standalone.mjs` | 最长 ~2min | 11 | 需 `DSH_MEMORY_REAL_STORE` | 入口从脚本自身位置推导(`scripts/..`),不再写死;向量后端未配 `DSH_MEMORY_EMBED_EXE`/`MODEL` 时相关小节标「跳过」 |
| `probe-zcode-handshake.mjs` | <1s | 3 | **只读** | 读用户自己的 `~/.zcode/cli/config.json`,照 ZCode 的 spawn 方式(cwd=工作区、env 合并、stderr=pipe)起进程 → initialize → `tools/list` → 真调 `memory_search`。**不写记忆库**,所以对真实 store 安全 |

注意:

- 所有 selftest **可以并发跑**,彼此不共享可变状态。
- ⚠️ **检查项数在 Windows 与 POSIX 上有 1~2 项差异,这是刻意的**,不是漏数。被 `if (WIN)` 跳过的
  都是**平台专有语义**:盘符不存在(`Q:` 在 POSIX 上只是普通目录名)、盘符大小写折叠
  (`c:` 与 `C:` 在 POSIX 上确实是两个不同名字)。**在 POSIX 上断言这些反而是错的。**
  曾经这三个脚本在真 Linux 上分别红 6 / 10 / 1 项,根因全是"断言写死了 Windows 路径语义",
  不是 `src/` 的 bug —— 已按「保留断言意图、按平台取样例值」修掉,**别再改回去**。
- ⚠️ 构造"建不出来的目录"时,POSIX 侧**不要用 `/proc/...`**:实测 `mkdir /proc/xxx` 在该环境里
  会**挂住不返回**(120s+ 才被 kill)。用「**父路径是普通文件**」→ 必然 `ENOTDIR`,可控且不依赖权限位
  (CI 若以 root 跑,`chmod 500` 挡不住 root)。
- **CI**(`.github/workflows/ci.yml`)跑 `ubuntu-latest` + `windows-latest` × Node `20/22/24`,
  用 `npm ci`(依赖已提交的 `package-lock.json`)。CI 里 `DSH_MEMORY_VECTOR=off`,且**不跑**
  `selftest:vector*`(无 llama-server;`selftest-vector.mjs` 还会读作者本机路径)与任何 `acceptance-*`。
  改了测试集就同步改 workflow,反之亦然。
- ⚠️ **作为依赖从 npm 装进别的项目时**,`node_modules` 是**平铺(hoisted)**的:本包自己那层
  `node_modules/` 通常根本不存在,SDK 在上一级。所以判断「依赖在不在」必须用
  `import.meta.resolve(...)`(Node 自己的解析器),**不能**看 `existsSync(ROOT/node_modules/...)` ——
  后者在 hoisted 布局下会误报"依赖缺失"。(`selftest-cli.mjs` 的 `dependencyResolvable()` 就是为此而写。)
- `selftest-cli.mjs` 的「缺依赖」用例是把 `src/` + `package.json` **复制到 `os.tmpdir()` 下的临时目录**
  (副本祖先没有 `node_modules`,ESM 解析必然失败)再跑,所以它**不碰**真实 `node_modules`,中断不留破损。
  (早期版本曾用「把 SDK 改名成 `sdk.__selftest_bak`」来模拟,实测强杀在 ~280ms 的改名窗口内 **4/4 次**
  会把依赖留在改名状态、拖垮后续所有脚本,已废弃 —— **别再改回去**。)
- 默认 `npm test` = `selftest-cli.mjs && selftest-mcp.mjs && selftest.mjs`(`package.json`),三者都不碰真实 store。
- `selftest-mcp.mjs` 会依次探活 `8199` / `8078` / `8200`,探到就复用、探不到就**尝试自行 spawn**
  llama-server(用 `DSH_MEMORY_EMBED_EXE` 的默认值,换机器上必然失败并静默退化为纯词法)。
  它自己会被 server 的 `shutdown` 收掉,但脚本整体会因此慢几秒。
- `acceptance-standalone.mjs` 的向量后端**只从环境变量读**:`DSH_MEMORY_EMBED_EXE` +
  `DSH_MEMORY_EMBED_MODEL`(自拉起),或 `DSH_MEMORY_EMBED_ENDPOINT`(复用已有服务)。两者都没配时它
  打印提示并把「自拉起后端 / 语义召回」标成**跳过**(不算失败);不再拿默认值里的本机路径硬试。
  端口探活走 `node:net` 的 `connect()` + 原生 `fetch()` 打 `/health`,**不再 shell 出 `netstat` / `curl`**,
  所以在 Linux / macOS 上也能跑。要验证「冷启动自拉起」那一支,`8199` 必须空闲;已被占用时它只会
  复用该服务并把「自拉起」标成跳过(实测本机两台 llama-server 常驻 8078/8199,所以默认就落在这一支)。
- `acceptance-coexist.mjs` **本身是 flaky 的**(实测 8 次里 3 次 exit 1,报
  `✗ FAIL 上游式写者正常跑完(exit=0)`)。原因不是本项目的锁,而是被测对象的内禀缺陷:
  `legacy-writer.mjs` 刻意复刻上游「固定 `${file}.tmp` + `renameSync`」,而 `SharedStore` 用
  「带 pid+随机数的 tmp + rename」;两者在 Windows 上并发 rename 到**同一个** `global.jsonl` 时,
  后者会拿到 `EPERM: operation not permitted, rename ...`。
  **这恰好是文档里那个论点的活证据** —— 上游的固定 tmp 名在并发下不稳定,所以本项目必须用唯一 tmp 名。
  看到这个 FAIL 时:重跑一次;它不影响产物正确性,也**不是**回归。
- ⚠️ 两个 `acceptance-*`(real / standalone)会**写 store**,所以目标库必须由调用方显式给出:
  `DSH_MEMORY_REAL_STORE=<你的 storeDir>`。**没设就打印提示并 `exit(0)` 跳过**,绝不回退到任何写死的机器路径。
  除非用户在真实库上明确授权,不要跑;想先确认脚本逻辑通,把该变量指向 `os.tmpdir()` 下的目录即可。
- ⚠️ **真实 store 是「活的」**:只要 DSH 开着,它的记忆插件就在往里写(记录、`accessCount`、`scopes.json` 别名)。
  **不要用文件 mtime 判断"测试有没有污染真实库"** —— 改动可能来自 DSH 自己的正常写入
  (实测本机 `projects/7d0429ad....jsonl` 的 mtime 会在你什么都没跑时自己变)。
  判污染看**内容**:`global.jsonl` 里有没有测试专用标记字符串;本仓库的测试都用带随机后缀的标记。
- `selftest-vector.mjs` 文件头写着「加 `--spawn` 才测试自动拉起」,但脚本**没有**任何 `process.argv` 处理,
  该开关不存在;它永远不会 spawn。
- `acceptance-real.mjs` 曾经传 `project` 参数(而 schema 里只有 `path`),该入参被静默忽略、记录实际落到
  `global` —— 也就是说它当时**没有在测**「写 project 作用域」。现已改成 `path`,并补了两条断言兜住这个坑:
  `sc.scope === project:<测试目录>`、以及磁盘上新增的文件在 `projects/` 下。**别只改参数名而不留断言** ——
  静默忽略的入参不会报错,只会让报告假绿。

---

## 3.5 宿主契约:各 IDE 怎么拉起本服务(实测,2026-10-20)

> 这一节记的是**宿主侧的事实**,不是本仓库的代码。改配置前先看这里,能省掉大量试错。

| 宿主 | 配置文件 | 键路径 | 键形状 |
| --- | --- | --- | --- |
| Trae | `%APPDATA%\Trae CN\User\mcp.json` | 顶层 `mcpServers` | `{ name: { command, args, env } }` |
| WorkBuddy | `%USERPROFILE%\.workbuddy\mcp.json` | 顶层 `mcpServers` | 同上 |
| **ZCode** | `%USERPROFILE%\.zcode\cli\config.json` | **嵌套 `mcp.servers`** | `{ name: { type, command, args, env, timeoutMs } }` |

**ZCode 的坑(全部对 `ZCode.exe` / `resources/glm/zcode.cjs` 求证过)**:

1. **键路径不同**:写顶层 `mcpServers` 会被当成「没配 MCP」而**静默忽略**,不报错。
2. **schema 严格**:zod `.strict()`,多一个不认识的键 ⇒ **整个 server 被丢掉**。
   可用键:`type` `command` `args` `cwd` `env` `enabled` `timeoutMs` `alwaysLoad` `protocolVersion`。
   `command` 必须是**字符串** —— 写成数组 `["npx","-y",...]` 会让设置页崩在 `command.trim is not a function`。
3. **`cwd` 不要写**:不写时 ZCode 拿**当前工作区**当 MCP 进程的 cwd(`createTransport` 里
   `cwd: t.cwd ? resolve(...) : a ?? this.workingDirectory`)。所以 `project` 作用域天然跟随工作区,
   **不需要**像 Trae/WorkBuddy 那样额外配项目级文件。这是 ZCode 相对另外两个宿主的一个真实优势。
4. **不展开 `${...}`**:模板变量只对插件自带的 MCP 生效,配置文件里必须写绝对路径。
5. **没有 `zcode mcp add` 命令**:只能改 JSON 或走 **设置 → MCP** 图形界面。
6. **改完要重启会话**:ZCode 每个工作区起一个 `app-server` 子进程,配置在它启动时读一次;
   `~/.zcode/cli/log/*.jsonl` 里有 `mcp.server.connected` / `mcp.server.failed` / `mcp.tools.registered` 事件可查。
7. **兜底文件** `~/.agents/mcp.json` 只在**同一作用域的 `.zcode` 里一个 MCP server 都没有时**才读。

**端口共享**:ZCode 实例与 Trae/WorkBuddy 实例会**复用同一个 8199 向量后端**
(`ensureReady()` 先探活,活着就复用、不接管生命周期)。实测本机 8199 由某个 MCP 实例 spawn,
ZCode 侧起手时打的是 `vector: 复用已有服务 http://127.0.0.1:8199(不接管生命周期)`。
所以**不要**给每个宿主配不同端口 —— 那只会白白多占一份 600MB 的模型内存。

---

## 4. 故障 → 定位

| 现象 | 先看什么 |
| --- | --- |
| 客户端工具列表为空 / 握手失败 / IDE 报 404 类错误 | `command` 是否为 node **绝对路径**(IDE 继承的 PATH 常不含 node)、`args` 是否指向真实的 `src/index.js`、stderr 有没有输出。stdio 型 MCP 没有端口可连 |
| **ZCode 里看不到这个 server / 设置页里没有它** | 键路径必须是**嵌套的 `mcp.servers`**(不是顶层 `mcpServers`);zod `.strict()` ⇒ 多写一个不认识的键会让**整个 server 被丢掉**;`command` 必须是字符串不是数组。改完要**重启会话**。见 [3.5 宿主契约](#35-宿主契约各-ide-怎么拉起本服务实测2026-10-20) |
| 8199 被占 / 连到了别人的向量服务 | `netstat -ano -p tcp \| findstr ":8199 "` 取 pid → `Get-Process -Id <pid>`;`curl -s http://127.0.0.1:8199/health`。**探活成功就复用**,所以「端口在监听」不代表是本进程拉起的 |
| 记忆「没生效」:明明存了却搜不到 / 检索结果是空的 | **先看 stderr 首三行**里实际生效的 `store-dir`,再核对它是不是 DSH 插件的 `storeDir`。用默认目录启动时 `main()` 会打 `ℹ️ 未指定 --store-dir ...` 提示 —— 那条提示存在就说明你在用默认库,很可能不是 DSH 那一份 |
| 检索结果忽然变差、没有语义命中 | 后端可能压根没起来:`<store-dir>/llama-server-mcp.log` 尾部;或 `.vec` 头被整体丢弃(stderr 里有 `identity mismatch` / `legacy sidecar without identity header` 警告) |
| llama-server 起不来 | 同上日志文件;再核对 `DSH_MEMORY_EMBED_EXE` / `DSH_MEMORY_EMBED_MODEL` 是否真实存在(默认值是作者机器路径) |
| 写入卡住 10s 后报错 | `<store-dir>/.locks/<sha1>.lock` 里的 `{pid,hostname,acquiredAt}`;同机 pid 已死或超 30s 会自动接管。报错文案带 `code: LOCK_TIMEOUT` |
| `ERR_MODULE_NOT_FOUND` | 正常启动时**不该再看到这个裸栈**:`src/index.js` 动态 import `./server.js`,缺依赖会翻译成中文「缺依赖 ⇒ 在仓库根目录运行 npm install」并 exit 1。仍见到裸栈 = 有人把静态 import 改回来了(`DSH_MEMORY_DEBUG=1` 才会附完整栈);另一来源是误 import `@restregular/dsh-memory` —— 上游包**不能**直接 import(`exports` 不含 `lib/*`,裸包根会因 `@deepseek-ai/cordis` peer 依赖报同一个错) |
| `npm install` 后依赖树变大 | 正常:SDK 自己带 `express`/`ajv`/`zod` 等传递依赖。本项目只用它三行 import,存储层仍然零外部依赖 |
| Windows 上偶发 `EPERM`/`EACCES` | 是文件删除/改名窗口,不是 bug。锁层把 `EEXIST/EPERM/EACCES` 一律当「暂时拿不到」重试;自建逻辑请照抄这个口径。⚠️ 但**固定 tmp 名 + rename** 在这种窗口下会硬失败(`acceptance-coexist.mjs` 的 flaky 就是这么来的)—— 所以 `atomicWrite` 的 tmp 名必须唯一,别退化成 `${file}.tmp` |

调试入口:`node src/index.js --store-dir <tmp> --project <tmp>` 后,stderr 首三行会打印实际生效的
`store-dir` / `project` / 默认保存作用域 —— **先看这三行**,99% 的「写错地方」都在这里露馅。

---

## 5. 提交前自检

按顺序跑(也可以并行,彼此独立):

```bash
node scripts/selftest-cli.mjs        # 2.3s,CLI 契约 115 项(Windows)/114(POSIX)
node scripts/selftest-tools.mjs      # 0.1s,参数/scope 决策 60 项(Win)/59(POSIX)
node scripts/selftest-protocol.mjs   # 0.4s,协议层 18 项
node scripts/selftest-mcp.mjs        # 1.1s,端到端 40 项
node scripts/selftest.mjs            # 3.5s,多进程并发 55 项
```

- `npm test` = `selftest-cli.mjs && selftest-mcp.mjs && selftest.mjs`。**从 npm 装进别的项目时也能跑**
  (`files` 已包含 `scripts/`),用来验证"装好了没":`npm test` 或 `node scripts/selftest-cli.mjs`。

- 动过 `store.js` / `lock.js` / `scope*.js` → 必须跑 `selftest.mjs`(它是唯一真的起多进程的)。
- 动过 `tools.js` 的 schema 或错误码 → 跑 `selftest-tools.mjs` + `selftest-protocol.mjs`,并同步 README 的错误码表。
- 动过 `vector.js` → 跑 `selftest-vector.mjs`;它只读、可安全跑。
- 动过 `index.js` 的参数/帮助/退出码 → 跑 `selftest-cli.mjs`;它还会断言「`--help` 里列的 flag 真的能被 `parseArgs` 解析」
  —— 改行为时**必须同步改 `helpText()`**,否则这条会红(这是刻意的:防 `--help` 变成第二份过期文档)。
- `package.json` 的 `version` 与 `src/server.js` 的 `SERVER_VERSION` 目前都是 `0.1.0`,`selftest-cli.mjs` 会断言两者一致;
  发版时两处一起改。
- **不要**用真实 `D:/dev/.dsh-memory-store` 做实验,也不要 `git push`。
