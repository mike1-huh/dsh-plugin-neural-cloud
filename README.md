# 云图（Neural Cloud）

**一个真正把"记忆"当系统工程做的 DSH 插件：自带向量库、自带引擎、自带库文件。**

插上就有记忆，拔掉不留痕迹 —— 数据只在你自己的电脑上。

---

## 为什么不是"又一个记忆插件"

DSH 的记忆插件已经不少，绝大多数长这样：

```
一句对话 → 调一次模型 → 抽一条 → 存 JSON → 关键词匹配召回
```

跑起来能用，但一上量就露馅：记不牢（重复堆叠）、想不起（召回靠字面）、说不清（为什么想起这条？不知道）、收不住（上下文被记忆挤爆）。

云图把这件事拆成八件事，每件都做到底：

| 常见做法 | 云图 |
|---|---|
| 存一句算一句，重复了也不管 | **写入前查重**：字符 n-gram 重合 ≥0.72 丢弃；同批（同事件/120 秒内）合并 |
| 召回只做关键词或词袋 | **向量 + 词面 + 关键词 + 实体 + 时间 + 图 + 超边 + 档位 + 近期**，加权 RRF 融合，通道各有自己的 K |
| 想起什么说不清 | **每条命中自带 `why`**：`semantic#2, entity#1, vector#9, stier#7` —— 可解释、可调 |
| 只记"发生过什么" | **记"还没发生"**：`planState`（pending / done / dropped），「明天去医院」和「去过了」不会混淆 |
| 一条时间轴 | **双层时间**：真实时间（created）与世界时间（worldTime）分开存、分开放检索 —— 角色扮演里这两条从来不是一回事 |
| 存完就忘，不知道出自哪里 | **溯源**：每条记 `sourceMsgIds`，能回查原话；同时按证据**建边**，形成"这些是一件事"的记忆图 |
| 记忆一股脑塞进提示词 | **装配预算**：常驻 40% / 设定 10% / 相关 45% / 旧事 15%，超了从旧那头丢，绝不挤爆上下文 |
| 越用越脏，没人清理 | **维护**：S 永不归档 / A 60 天 / B 30 天 / C 14 天，被动到期的自动沉底；被误归档的 S/A 会捞回来 |
| 出问题只能删库 | **可回退**：`MEMORY_ENGINE=0` 一个变量回到旧内核；改动前一律 `*.bak-<时间戳>` |
| 依赖外部服务或云端 | **自带引擎**：Kotlin 编译好的发行包随插件分发，`127.0.0.1` 起在你自己机器上，不注册、不上传、不限流 |

## 三个别人不容易抄走的设计

**① 引擎随插件走，而不是插件去连某个服务**

```
engine/            编译好的引擎（4 MB，10 个 jar）
data/              你的记忆（JSON + base64 向量）
```

装完即用，不用配数据库、不用注册账号、不用联网。想搬家，拷目录；想清空，删文件；想卸载，删目录。**没有后台、没有云端、没有"我们的服务器"**。

**② 锚点、先验、乘子全部有界**

档位、新鲜度、命中频率这些先验，只做 `0.85–1.25` 的乘子 —— 它们能把**本来相关**的那条往前送，但永远不会把不相关的硬拉进来。这是 RRF 最容易被玩坏的地方，云图把它锁死了。

**③ 向量不是"可选加分项"，而是基础设施**

每条记忆落库即算向量（默认 bge-m3 1024 维；不配 key 时退回本地哈希），向量单独成档、按内容 hash 失效、写盘原子化（临时文件 + rename）。向量挂了检索会立刻降级但不会崩，健康状态会写进日志。

---

## 它是什么

```
外壳    DSH 插件：10 个工具 + 五区面板 + 四组接口设置 + 人设卡 + 意图 + 回顾
内核    memory-engine（Kotlin）：抽取 · 去重 · 溯源 · 建边 · 向量库 · 多通道检索 · 装配 · 维护
存储    ~/.dsh/storages/memory-engine/memory-store.json（含向量，base64）
隔离    不碰手机、不连任何服务器；127.0.0.1 只指本机
```

## 需要什么

```
Java 17+   https://adoptium.net/
DSH        桌面版（插件通过 profile 加载）
```

引擎随插件分发，插件加载时自动拉起（找不到 Java 会回退到插件内置实现，不会崩，也不会丢消息）。

## 安装

### 一键安装（推荐）

```
双击 一键安装.bat
```

它只做四件事，每步都先备份、改完校验、失败自动还原：

```
① 拷插件到 <profile>\node_modules\dsh-plugin-neural-cloud
② package.json：加 dependencies（link 本地目录）+ dsh.profile.bundles
③ cordis.patch.yml：追加 id=neural-cloud 一段
④ 检查 Java 17 与引擎 jar，打印结论
```

已有同名依赖会改成指向本目录（旧值备份）；已有 patch 段会跳过，不重复写。

### 手动安装

```
① 把整个目录放进 DSH 的插件搜索路径，例如：
   <你的 dsh profile>/node_modules/dsh-plugin-neural-cloud/
② 在 profile 的 package.json 里加：
   dependencies: { "dsh-plugin-neural-cloud": "link:<这个目录>" }
   dsh.profile.bundles 里加 "dsh-plugin-neural-cloud"
③ 在 profile 的 cordis.patch.yml 里加：

   - id: neural-cloud
     name: dsh-plugin-neural-cloud
     config:
       injectLimit: 6
       defaultLimit: 8

④ 重启 DSH
```

首次启动会在 `~/.dsh/storages/memory-engine/` 建库，并在本机起一个服务（8787）。

## 工具

| 工具 | 作用 |
|---|---|
| memory_remember | 写一条记忆（keys / tier / entities / quote / planState / eventTime / sourceMsgIds） |
| memory_recall | 检索，返回条目 + 分数 + 命中通道（why） |
| memory_blocks | 装配成可直接塞提示词的分块文本 |
| memory_feedback | hit / wrong / pin |
| memory_forget | 归档或真删 |
| memory_status | 状态面板（人设 / 心情 / 记忆概况 / 引擎侧条数） |
| memory_mood | 读 / 写心情 |
| memory_config | 四组接口（对话 / 摘要 / 向量 / 回顾） |
| memory_hindsight_write | 写一条回顾 |
| im_qq_send | QQ 发消息（可选） |

## 注入

```
system-prompt/assemble
  → 人设（原样） + 【云图记忆】只能依据下面这些条目回答，没有依据就说记不清：- …
```

每轮装配时顺手做一次自动写入（最近一问一答 → 引擎抽取），不阻塞回复、3 秒内不重复。

## 依赖（哪些必须，哪些不必）

| 项 | 是否必须 | 说明 |
|---|---|---|
| Java 17+ | **必须** | 引擎随包分发，但要有 JRE |
| DSH 桌面版 | **必须** | 插件靠 profile 加载 |
| 向量接口（bge-m3） | 可选 | 不配就用本地哈希向量，装上也能量 |
| 对话模型 | 可选 | 不配就用规则抽取，装上也能量 |
| **hindsight 本地模型** | **不需要** | 回顾默认由宿主模型写（`memory_hindsight_write`），不用下载任何东西 |
| 本地小模型（调参） | **不需要** | 自动调参不在本插件里；那是配套 App 侧的能力 |

一句话：**只有 Java 17 是硬要求**，其余都能降级运行，不会因为缺东西就废掉。

## 记忆的分层

```
事实层            tier A / B / C      每轮抽取写入，受衰减与去重管理，参与召回打分
信念层（回顾）     tier R              常驻、只保留最新一条、不参与打分，装配时排最前
```

```
· 回顾 → /api/hindsight → 写 R 档；写新的时覆盖旧的
· 检索时 R 不进候选（它是常驻上下文，不是"可能被想起"的东西）
· 不需要回顾就别调 memory_hindsight_write，其它功能照常
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MEMORY_ENGINE` | 1 | 0 = 回退插件内置实现 |
| `MEMORY_AUTO_EXTRACT` | 1 | 0 = 关闭每轮自动写入 |
| `MEMORY_ENGINE_ENDPOINT` | http://127.0.0.1:8787 | 引擎地址 |
| `MEMORY_ENGINE_SESSION` | dsh | 记忆分池 |
| `MEMORY_DATA_DIR` | ~/.dsh/storages/memory-engine | 库目录 |
| `MEMORY_JAVA` / `JAVA_HOME` | 自动探测 | Java 17 路径 |
| `MEMORY_HOST_MODEL_ONLY` | 0 | 1 = 意图/回顾也不自己调模型 |

## 真向量（可选但强烈建议）

在库目录放 `memory-config.json`：

```json
{ "baseUrl": "https://api.siliconflow.cn/v1", "apiKey": "sk-…", "model": "BAAI/bge-m3" }
```

```
有它  → 向量走 bge-m3（1024 维），抽取走 chat/completions
没它  → 向量走本地哈希（256 维），抽取走规则版 —— 装上就能用，只是慢一点笨一点
```

## 自检（不用装也能验）

```
node test/load-check.mjs     插件能否加载、工具是否注册
node test/fullchain.mjs      9 个动作全跑一遍（写入/检索/反馈/心情/回顾/删除）
node test/spawn-check.mjs    引擎能否被插件拉起
```

## 卸载

```
删掉 <profile>\node_modules\dsh-plugin-neural-cloud
package.json / cordis.patch.yml 用同目录的 .bak-<时间戳> 还原
记忆库：删 ~/.dsh/storages/memory-engine/ 整个目录
```

## 许可

AGPL-3.0 —— 改了、或者拿它对外提供服务，都必须把源码一起开放。
