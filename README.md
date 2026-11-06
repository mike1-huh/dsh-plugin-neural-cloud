# 云图（Neural Cloud）· DSH 记忆插件

插上就有记忆，拔掉什么都不留。自带引擎（向量库 + 多通道检索），记忆只存在你自己的电脑上。

## 它是什么

```
外壳    DSH 插件：8 个工具 + 五区面板 + 四组接口设置 + 人设卡 + 意图 + 回顾
内核    memory-engine（Kotlin）：抽取 · 去重 · 溯源 · 建边 · 向量库 · 多通道检索 · 装配 · 维护
存储    ~/.dsh/storages/memory-engine/memory-store.json（含向量，base64）
隔离    不碰手机、不连任何服务器；127.0.0.1 只指本机
```

## 需要什么

```
Java 17+   https://adoptium.net/
DSH        桌面版（插件通过 profile 加载）
```

引擎随插件分发，插件加载时会自动拉起（找不到 Java 会回退到云图自带实现，不会崩）。

## 安装

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

首次启动会在 `~/.dsh/storages/memory-engine/` 建库，并起一个本地服务（8787）。

## 一键安装（推荐给不想手改配置的人）

`
双击 一键安装.bat
`

它只做四件事，每步都先备份：

`
① 把插件拷进 <profile>\node_modules\dsh-plugin-neural-cloud
② package.json：加 dependencies（指向本地目录）+ dsh.profile.bundles
③ cordis.patch.yml：追加 id=neural-cloud 一段
④ 检查 Java 17 与引擎 jar，给出结论
`

`
已有同名依赖 → 改成指向本目录（旧值备份，可还原）
已有 patch 段 → 跳过，不重复写
JSON 改完会校验；校验不过立刻还原并报错
`

卸载：

`
删掉 <profile>\node_modules\dsh-plugin-neural-cloud
package.json / cordis.patch.yml 用同目录的 .bak-<时间戳> 还原
`

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

每轮装配时顺手做一次自动写入（最近一问一答 → 引擎抽取），不阻塞回复。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MEMORY_ENGINE` | 1 | 0 = 回退云图自带实现 |
| `MEMORY_AUTO_EXTRACT` | 1 | 0 = 关闭每轮自动写入 |
| `MEMORY_ENGINE_ENDPOINT` | http://127.0.0.1:8787 | 引擎地址 |
| `MEMORY_ENGINE_SESSION` | dsh | 记忆分池 |
| `MEMORY_DATA_DIR` | ~/.dsh/storages/memory-engine | 库目录 |
| `MEMORY_JAVA` / `JAVA_HOME` | 自动探测 | Java 17 路径 |
| `MEMORY_HOST_MODEL_ONLY` | 0 | 1 = 意图/回顾也不自己调模型 |

## 真向量（可选）

在库目录放 `memory-config.json`：

```json
{ "baseUrl": "https://api.siliconflow.cn/v1", "apiKey": "sk-…", "model": "BAAI/bge-m3" }
```

```
有它  → 向量走 bge-m3（1024 维），抽取走 chat/completions
没它  → 向量走本地哈希（256 维），抽取走规则版
```

## 自检

```
node test/load-check.mjs     插件能否加载、工具是否注册
node test/fullchain.mjs      9 个动作全跑一遍（写入/检索/反馈/心情/回顾/删除）
node test/spawn-check.mjs    引擎能否被插件拉起
```

## 回滚

```
lib/index.js.bak-*        每次改动的备份（按时间戳）
MEMORY_ENGINE=0           一个变量回到旧内核
```

## 许可

AGPL-3.0 —— 改了、或者拿它对外提供服务，都必须把源码一起开放。
