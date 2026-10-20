# 第三方声明 / Third-party notices

本包（`@local/dsh-memory-store`）的以下源文件**逐字复制**自上游项目
[`@restregular/dsh-memory`](https://github.com/RestRegular/dsh-memory) v0.7.2
的已安装构建产物
（`C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@restregular\dsh-memory\lib\provider\`）。
复制的是**纯函数与算法**部分——跨进程并发安全所需的存储层是本包新写的，算法语义刻意保持
与上游完全一致，以便本包与 DSH 插件读写同一份数据文件时行为不漂移。

| 本包文件 | 上游来源 | 复制内容 |
| --- | --- | --- |
| `src/scoring.js` | `lib/provider/scoring.js` | `tokenize` / `buildStats` / `lexicalScore` / `hasStrongHit` / `recencyFactor` / `recordScore` / `cosine` / `normalizeInPlace` / `LruSet` |
| `src/scope.js` | `lib/provider/scope.js` | `MAX_SCOPE_NAME_CHARS` / `MAX_PREFIXED_SCOPE_CHARS` / `RESERVED_SCOPE_NAMES` / `normalizeScopeName` / `normalizeScopeInput` / `scopeKind` / `isCustomScope` / `scopeTier` / `SCOPE_NOT_WRITABLE` / `resolveCurrentScopes` / `resolveScopeRef` / `writeScopeForDefault` / `scopeShortHash` |
| `src/store.js` | `lib/provider/store.js` | `scopeFileName` / `isCustomScopeKey` / `firstScopeInFile` / `normalizeContent` / `contentHash` / `newId`、base64 向量编解码、以及 `save()` 的幂等去重语义与 `enforceLimit` 的排序公式 |
| `src/scope-names.js` | `lib/provider/scope-names.js` | `ScopeNames` 的别名语义（`nameOf` / `scopeOf` / `claim` / `release`） |

上游以 **MIT License** 发布，其许可证全文与版权声明如下。

---

## @restregular/dsh-memory — MIT License

```
MIT License

Copyright (c) 2026 restregular

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 本包与上游的差异（非逐字复制的新写代码）

本包**没有**复制上游的 `MemoryStore` / `ScopeStore` 类，因为它们正是本包要修掉的缺陷所在：

- 上游 `MemoryStore.loadScope()` 每个 scope 在进程内**只读盘一次**（`loaded` Set），
  之后所有写都基于内存快照；
- 上游 `MemoryStore.flush()` 拿内存快照**全量重写**整个文件。
  两个进程共用时，B 的快照里没有 A 刚写的记录，B 的一次 flush 就把 A 的记录**确定性抹掉**。

本包的对应实现见 `src/lock.js` 与 `src/store.js`：粒度为单个 scope 文件的**独占锁文件**
（`openSync(path, 'wx')` / O_EXCL），每个「读-改-写」事务都在锁内**重新从磁盘读取**该
scope 的全部记录，写盘走 tmp + `renameSync` 原子替换，`.vec` 向量边车走**单行 append**
（append 语义天然跨进程安全），删除向量时才在锁内全量重写 `.vec`。
