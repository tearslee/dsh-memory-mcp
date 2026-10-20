# dsh-memory-mcp

> **让 DSH 的长期记忆跨 IDE 共享 —— Trae / WorkBuddy / 任何支持 MCP 的 agent 都能读能写同一份记忆。**

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
              D:/dev/.dsh-memory-store
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
      "command": "C:\\...\\node.exe",
      "args": ["D:\\dev\\dsh-memory-mcp\\src\\index.js", "--store-dir", "D:\\dev\\.dsh-memory-store"]
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

三者**只共用同一个数据目录** `D:/dev/.dsh-memory-store`,记忆因此互通 —— 仅此而已,
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

`scripts/acceptance-standalone.mjs`(在 8078/8199 全空闲、无任何 llama-server 的状态下):

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
- [环境变量](#环境变量)
- [五个工具](#五个工具)
- [Trae / WorkBuddy 配置](#trae--workbuddy-配置)
- [与 DSH 共存的设计](#与-dsh-共存的设计)
- [scope 语义(与 DSH 的差异)](#scope-语义与-dsh-的差异)
- [向量开关](#向量开关)
- [已知限制](#已知限制)
- [自测](#自测)

---

## 安装

```bash
cd D:\dev\dsh-memory-mcp
npm install
```

**依赖清单**(由本项目 `src/server.js` 引入):

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | `1.32.1` | MCP 协议实现(`Server` / `StdioServerTransport` / `Client`) |

存储层(`src/store.js` / `src/scoring.js` / `src/scope.js` / `src/scope-names.js` / `src/lock.js`)**零外部依赖**,只用 Node.js 内置模块。

> `package.json` 由项目负责人统一维护,依赖只此一项。

## 启动

```bash
# 最简:用默认 store 目录(D:/dev/.dsh-memory-store),工作区 = 当前目录
node src/index.js

# 指定工作区(决定 project 作用域)
node src/index.js --project D:\dev\ruoyi-vue-pro\ruoyi-vue-pro

# 指定存储目录(与 DSH 插件共用)
node src/index.js --store-dir D:\dev\.dsh-memory-store

# 两者一起
node src/index.js --project D:\dev\my-app --store-dir D:\dev\.dsh-memory-store
```

启动参数:

| 参数 | 说明 | 缺省 |
| --- | --- | --- |
| `--project <dir>` | 当前工作区目录(绝对或相对)。决定 `project` / `project:<路径>` 作用域。 | `DSH_MEMORY_PROJECT` → `process.cwd()` |
| `--store-dir <dir>` | 记忆存储目录。 | `DSH_MEMORY_STORE_DIR` → `D:/dev/.dsh-memory-store` |

进程是 **stdio 传输**:stdout 只输出 MCP 协议消息,**所有日志走 stderr**。
`SIGINT` / `SIGTERM` 会优雅退出,并且**只终止自己拉起的** llama-server(复用的外部服务原样保留)。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_MEMORY_PROJECT` | `process.cwd()` | 当前工作区目录,等价于 `--project`。 |
| `DSH_MEMORY_STORE_DIR` | `D:/dev/.dsh-memory-store` | 存储目录,等价于 `--store-dir`。 |
| `DSH_MEMORY_SCOPE_ALL` | `false` | `true` ⇒ `memory_save` 省略 scope 时默认写 **project** 而不是 **global**。 |
| `DSH_MEMORY_VECTOR` | 开启 | `off`(或 `0`/`false`/`no`)⇒ 完全关闭向量,退化为纯词法检索。 |
| `DSH_MEMORY_EMBED_ENDPOINT` | — | 直接指定已有的 embedding 服务(如 `http://127.0.0.1:8078`)。**设了它就永不 spawn 进程。** |
| `DSH_MEMORY_EMBED_EXE` | `D:\dev\llamacpp\llama-server.exe` | llama-server 可执行文件。 |
| `DSH_MEMORY_EMBED_MODEL` | `D:\dev\models\Qwen3-Embedding-0.6B-Q8_0.gguf` | gguf 模型文件。 |
| `DSH_MEMORY_EMBED_PORT` | `8199` | 端口(避开 DSH 的 8078,两者可共存)。 |
| `DSH_MEMORY_EMBED_THREADS` | `6` | llama-server 线程数。 |
| `DSH_MEMORY_EMBED_POOLING` | 按模型推断 | 池化方式。**换模型时务必确认这一项**(见下)。 |

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

出错时返回 `isError: true` + `{ ok: false, code, message }`,`code` 取值:
`CONTENT_EMPTY` `IMPORTANCE_RANGE` `KIND_INVALID` `TOPK_RANGE` `LIMIT_RANGE` `IDS_EMPTY`
`TARGET_REQUIRED` `TARGET_AMBIGUOUS` `SCOPE_INVALID` `SCOPE_NOT_WRITABLE`
`PATH_SCOPE_CONFLICT` `PATH_INVALID`。**不抛栈**,文本里写明怎么改。

> 注意 `memory_search` 的记录数组字段是 **`records`**(不是 `results`),与上游
> `lib/tools/index.js` 的 `{ records: [...] }` 对齐。

## Trae / WorkBuddy 配置

两个 IDE 的 MCP 配置格式一样(`mcpServers` 对象)。下面两段直接贴进对应配置文件即可。

### Trae

配置文件:`%APPDATA%\Trae CN\User\mcp.json`(本机实测路径)。
也可以在 Trae 里 **设置 → MCP 服务器 → 添加** 手动填。

### WorkBuddy

配置文件:`%USERPROFILE%\.workbuddy\mcp.json`。

### 本机实际使用的配置(两份格式完全相同)

```json
{
  "mcpServers": {
    "dsh-memory": {
      "command": "C:\\Users\\Administrator\\AppData\\Local\\Programs\\PhpWebStudy-Data\\env\\node\\node.exe",
      "args": [
        "D:\\dev\\dsh-memory-mcp\\src\\index.js",
        "--store-dir",
        "D:\\dev\\.dsh-memory-store"
      ],
      "env": {
        "DSH_MEMORY_STORE_DIR": "D:\\dev\\.dsh-memory-store",
        "DSH_MEMORY_EMBED_EXE": "D:\\dev\\llamacpp\\llama-server.exe",
        "DSH_MEMORY_EMBED_MODEL": "D:\\dev\\models\\Qwen3-Embedding-0.6B-Q8_0.gguf",
        "DSH_MEMORY_EMBED_POOLING": "last"
      }
    }
  }
}
```

> `command` 写的是 **node 的绝对路径**而不是 `node` —— IDE 拉起 MCP 时继承的 PATH 常常不含 node,
> 写 `node` 会报「不是内部或外部命令」。

### 关于 `--project`:全局配置里**故意不写**

> ⚠️ 上面这份配置里**没有** `--project`,这是刻意的。
>
> MCP 配置是**全局**的(一个配置文件服务所有项目),而 `--project` 是单一值。
> 一旦写死成 `D:\dev\ruoyi-vue-pro\ruoyi-vue-pro`,那么你在 Trae 里打开**任何其它项目**时,
> 它的 `project` 作用域都会错误地落到 ruoyi-vue-pro 那个目录 —— 所有项目的记忆混进同一个桶。
>
> 不写 `--project` 时,服务退回 `process.cwd()`。**正确用法是按项目单独配一份**:
>
> - **项目级配置**(推荐):在项目根放 `.trae/mcp.json`(Trae 需在设置里开启「项目级 MCP」),
>   或 `.workbuddy/mcp.json`(WorkBuddy),此时加 `--project <项目绝对路径>`。
> - **或者干脆不用 project 作用域**:`memory_save` 默认写 `global`,
>   `memory_search` 默认检索「当前项目 + global」。全局配置下项目识别可能不准,
>   但 `global` 那部分始终正确 —— 而跨 IDE 共享的本来就是 `global`。
> - 想让保存默认落到项目而不是 global,加 `"DSH_MEMORY_SCOPE_ALL": "true"`。

**如果 IDE 不支持 `env` 字段**,把环境变量写进 `command` 的调用脚本里,或者直接省略
`--store-dir`(默认就是 `D:/dev/.dsh-memory-store`)。

## 与 DSH 共存的设计

**存储目录相同,进程独立,互不干扰。**

```
D:/dev/.dsh-memory-store/
├── global.jsonl                    ← scope 键 "global"
├── global.vec                      ← 向量边车,首行 #qwen3-embedding-0.6b\t1024
├── projects/<sha1(scope)>.jsonl    ← 其他任何 scope 键
├── projects/<sha1(scope)>.vec
├── scopes.json                     ← 作用域别名
└── settings.json                   ← DSH 的注入设置(MCP 不读)
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

# 完整 MCP 协议自测(主脚本)
node scripts/selftest-mcp.mjs

# 存储层并发自测(真实多进程)
node scripts/selftest.mjs

# 其它分层自测
node scripts/selftest-tools.mjs       # 工具层:参数校验 / scope 决策 / 渲染(用内存版假 store)
node scripts/selftest-protocol.mjs    # MCP 协议层:握手 / tools/list / tools/call(用内存版假 store)
node scripts/selftest-vector.mjs       # 向量后端:配置 / 探活 / 熔断 / 生命周期
node scripts/selftest-vector-e2e.mjs   # 向量端到端:写 .vec 边车 + 语义召回

# 验收测试
node scripts/acceptance-real.mjs      # 端到端打真实 storeDir(只写/只删自己造的记录)
node scripts/acceptance-coexist.mjs   # 与「上游式无锁写者」并存的实测数据
node scripts/acceptance-standalone.mjs # 不开 DSH 的独立运行验证(需先确保 8078/8199 无占用)
```

| 脚本 | 覆盖 | 碰真实 store? |
| --- | --- | --- |
| `selftest-mcp.mjs` | 真实 stdio 握手、5 个工具的 schema、保存、检索、幂等、列表/按前缀取回、删除后不再召回、错误码、向量开关对比、落盘检查、stderr 日志 | 否 |
| `selftest.mjs` | 单进程语义、**4 进程 × 20 条真并发**、外部追加不被抹除、跨进程锁(超时/陈旧锁/粒度)、`.vec` 边车、别名映射 | 否 |
| `selftest-tools.mjs` | 路径归一化、scope 决策、全部校验错误码、检索渲染、幂等、别名、自定义作用域、schema 自检 | 否 |
| `selftest-protocol.mjs` | 握手、tools/list、tools/call 正常/错误路径、stdout 纯净性 | 否 |
| `selftest-vector.mjs` | 配置解析、探活、复用不 spawn、维度、L2 归一化、熔断退避、与 DSH 已存向量的空间兼容性 | 否 |
| `selftest-vector-e2e.mjs` | 写 `.vec` 边车 → 读回 → 不同措辞的语义召回 | 否 |
| `acceptance-real.mjs` | 对**真实** storeDir 跑完整协议:写入 → 磁盘可见 → 跨作用域读回 → 幂等 → 按前缀取回 → 删除 → 确认仍能读到 DSH 既有记忆 | **是**(只删自己造的) |
| `acceptance-coexist.mjs` | 与复刻上游「内存快照+全量重写」的无锁写者并发,量化双向互毁的损失 | 否(临时目录) |
| `acceptance-standalone.mjs` | **不开 DSH**:冷启动 → 自拉起向量后端 → 读写 → 语义召回 → 退出后无孤儿进程 | **是**(只删自己造的) |

`selftest-mcp.mjs` 用官方 SDK 的 `Client` + `StdioClientTransport` 起**自己**,
真实走一遍完整的 MCP 协议握手(`initialize` → `tools/list` → `tools/call`),
共 **40 项检查**。

**除 `acceptance-real.mjs` 外,所有测试都在 `os.tmpdir()` 下的随机目录里跑**,
`D:/dev/.dsh-memory-store` 一个字节都不会被碰(`selftest.mjs` 开头还有硬守卫,
指向真实路径直接中止)。加 `--keep` 可以保留临时目录便于排查。

## 许可与第三方声明

存储层与评分算法复用自上游 [`@restregular/dsh-memory`](https://github.com/RestRegular/dsh-memory)(MIT),
逐文件来源见 [`third-party-notices.md`](./third-party-notices.md)。

```
MIT License

Copyright (c) 2026 restregular
...
```
