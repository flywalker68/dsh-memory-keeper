# dsh-memory-keeper

给 DeepSeek Harness 用的**长期记忆插件**：把人设、日记、日常规则、进行中的事存成纯文本 md，检索靠「字面 + 语义」双路，右键能翻原话，还会在上下文压缩之后把最近的对话补回来。

**检索双引擎（主路 Qwen + 兜底本地小模型）**：

- **主路：Qwen**（`qwen3.7-text-embedding` 2560 维 + `qwen3.7-text-rerank`）——需要百炼 API key，检索更准。实测（714 题、块匹配口径）：本地 91.7% → Qwen embedding 93.7% → 再加 rerank **97.7%**。
- **兜底：本地 bge-small-zh**（512 维，24 MB）——不用 key、不用联网。**没配 key、调用失败、超时、连续失败熔断**，任何一种情况都自动回退到它。
- 面板里可随时切换：填 key 即启用 Qwen，删 key 立刻回本地。**记忆数据始终在本地**，只有检索用的 query 和文本向量会发往百炼。

**定位：检索层，不是完整记忆系统。** 它把已有的 md 记忆和对话记录变成「能搜到」的，按需把原文找回来。逐轮回放、增量提取、摘要、遗忘这些属于完整记忆系统（或宿主）的能力，这个插件**不做**——它读你已经在写的东西，不替你写。想让它自动整理记忆，得另外接一个整理层。

## 给帮忙安装的 AI（TL;DR）

- 这是 **DSH（DeepSeek Harness）的 cordis 插件**，**不是把目录丢进 `.dev/` 就生效**
- 注册方式：`~/.dsh/profiles/<profile>/package.json`
  - `dependencies` 加 `"dsh-memory-keeper": "link:<绝对路径>"`
  - `dsh.profile.bundles` 数组加 `"dsh-memory-keeper"`
- 然后在那个 profile 目录跑 `pnpm install`，重启 DSH
- **验证**：`~/.dsh/memory-keeper.log` 出现 `已注册工具 memory_search`
- **记忆库**：`~/.dsh/memory/` 下放 `.md` 文件即可，格式见 [`examples/记忆格式说明.md`](examples/记忆格式说明.md)
- **配置**：`workspace` **必须填绝对路径**。留空会用 `process.cwd()`，**实测在 DSH 里那是 profile 目录、不是工作区**——后果是「日记 0 篇、搜不到东西」，而且不报错。配置写在 `~/.dsh/profiles/<profile>/cordis.patch.yml`：
  ```yaml
  - id: memory-keeper
    config:
      workspace: 'D:\你的\工作区'
  ```
- **检索引擎**：不配 key = 本地 bge-small（零依赖、离线可用）；配了百炼 key = 自动走 Qwen embedding + rerank，失败回退本地。首次检索会下 24 MB 模型，或把 `embeddingEnabled` 设 `false` 跳过

## 如果要拿它跑评测基准

（下面几条是踩过的坑，测之前请逐条确认）

1. **必须通过工具 `memory_search` 调**，别直接 `import { searchMemory }`。
   后者只走**词面**，绕过向量和融合——成绩会偏低，而且不会报错。作者自己就犯过一次。
2. **看结果头有没有「（向量+词面）」**。
   只有「仅词面」= 向量没起来（多半 sharp 没装好），先回去看安装那节。
3. **时间窗口要抽查**。传了 `beforeDate` 之后，随便抽几题看返回的块——日期必须都 ≤ `beforeDate`。
   两路（词面 / 向量）都要过滤才算数；只堵一路，未来记忆会从另一路漏回来，分数虚高且完全静默。
4. **导入后核块数**。`buildIndex` 出来的 `chunks` 数应该接近历史轮数；差太多说明日期格式没被识别，
   `beforeDate` 会直接失效（没日期的块不参与时间判断）。
5. **判分别只看字符串相等**。这类基准的判据是语义的（`required` / `forbidden`），
   「对不上」「矛盾」这种回答常常是对的，别一刀切判错。

## 开始使用

> ⚠️ **需要一个本地向量模型**：`Xenova/bge-small-zh-v1.5`（约 24 MB，int8）。首次检索时自动下载到插件的 `models/`，默认走 hf-mirror。
> **不想下载也行**：配置里把 `embeddingEnabled` 设为 `false`，就退化成纯字面检索——搜得笨一点，但零下载。

## 它解决什么问题

长对话里模型会忘事。常见的做法是把历史塞进上下文，但历史一长就压不动。

这个插件的思路是**把记忆外置成文件**：

- 记忆是一行一行的原文，不是提炼过的摘要 → 引得出原话，不怕总结丢细节
- 检索走两路：一路找字（精确）、一路找意思（向量模糊），两路合并
- 找不到就明确说找不到（有最低分闸门），不把弱相关的东西硬塞给模型
- 上下文压缩之后，自动把最近几轮对话补回来

## 记忆的完整流程

> **以下是作者本机在用的流程，仅供参考。** 插件本身不强制这些规则——写什么、什么时候写、怎么分文件，都由你的 `AGENTS.md` 和习惯决定；这里给的是「这套东西怎么配合起来跑」的一个完整例子。
>
> **哪些是插件保证的、哪些靠自觉**：切块、索引重建、双路检索与融合、时间窗口、状态卡、压缩后补原文——这些由代码保证。而「什么时候写日记、写不写关系片段、要不要精简」这些**全靠模型按 `AGENTS.md` 自觉执行**，插件不检查、不催、也不替它补。**自觉漏了，那一段记忆就是真的没有。**

记忆不是「存进去就完了」，是四条链路接起来的。**下面只写「机制」，不写「义务」**——每天该读什么、该记什么、怎么取舍，见 [运行规则参考](docs/运行规则.md)。

### 1. 写下来（内容 → 文件）

写入不在插件里：模型按 `AGENTS.md` 自己写 md，**一行一条、日期写在行首**（`- **2026-11-06** · 正文`）——检索靠它切块，时间窗口靠它过滤。写到哪个文件、什么时机写，见运行规则第 2~4 节。

### 2. 变成能搜的（文件 → 索引）

`buildIndex` 扫 md，按行切块（跳过标题、短行、分隔线、已标「已被取代」的条目），每块存：

- `text`：截 300 字，进索引、参与打分
- `date`：行首日期优先，文件名日期兜底
- `file` / `line`：回原文件定位用（`full` / `context` 靠它）

源文件指纹（路径 + 大小 + mtime）变了就自动重建；**改块结构要升 `INDEX_SCHEMA_VERSION`**，否则旧的照用、改动静默不生效。

### 3. 用起来（检索 → 回答）

- **检索**：`memory_search(query, top=10, beforeDate)`——词面 bigram（IDF 加权）+ 向量（bge-small）+ RRF 融合；命中块回原文件补整行 `full` 和前后各一行 `context`
- **状态卡**：组装 system prompt 时注入（日记进度、日程、体积、半衰期候选、人设漂移）；体积只在跨 200 / 500 KB 阈值时才报，平时不显示（免得每写一个文件就破缓存）
- **压缩后**：`compaction/summary` 事件触发，把被压掉的最近 10 轮原话挂成 system prompt 的一段（静态快照，维持到下次压缩）
- **加固**：真用上某段记忆时 `memory_touch(file, line)` 手动 +1；提过 3 次不再进遗忘候选

### 4. 维护（机制部分）

阈值、时机和取舍标准见[运行规则第 6 节](docs/运行规则.md)；插件这边只提供三个动作：`memory_check` 报健康度、`persona_edit` 备份后写、状态卡报候选。

一句话：**写是「一行一条、带日期」，读是「检索 + 状态卡 + 补原文」，管是「降权、归档、精简」**。

## 功能

| 功能 | 说明 |
|---|---|
| **状态卡** | 每轮首页注入：认识多少天、日记进度、今天/明天日程、半衰期候选、人设漂移信号 |
| **memory_search** | 检索记忆库（词面 + 向量 + RRF 融合），带最低分闸门；命中后回原文件补**整行**（`full`）并附**上下文各 1 行**（`context`），两者都过时间窗口 |
| **chat_search** | 翻对话原文，按意思找；认「三天前 / 上周 / 一个月前」这类时间说法；长消息不再被 300 字符拦腰砍断 |
| **memory_check** | 看记忆库健康度：日记进度、体积、日程、过期项 |
| **persona_edit** | 改人设文件时自动备份 + 记变更日志 |
| **memory_touch** | 确认某条记忆被真正用上了（回忆即加固） |
| **侧栏面板** | 在 Web UI 里看记忆库全貌 |

> **插件只管「能力」。** 每天该读什么、该记什么、写完怎么检查、什么时候清理——这些规则不在代码里，见 [运行规则参考](docs/运行规则.md)。不配这一层，装上也是空转。

### 可选：Qwen 加速（API 优先、本地兜底）

默认纯本地（bge-small，免费、离线）。如果配了百炼 API key，检索会改成「Qwen embedding + Qwen rerank」优先，**任何一步失败都自动回退本地**：

```yaml
- id: memory-keeper
  config:
    workspace: 'D:\你的\工作区'
    qwenApiKey: 'sk-...'      # 百炼 key；也可用环境变量 DASHSCOPE_API_KEY
    qwenEmbedding: true       # 检索向量用 Qwen（2560 维）
    qwenRerank: true          # RRF 之后用 Qwen 重排
    qwenTimeoutMs: 5000       # 单次超时；超时即回退
```

**实测收益**（714 题、块匹配口径）：本地 91.7% → Qwen embedding 93.7% → 再加 rerank **97.7%**。

**代价**：
- 首次要把全部块编码成 Qwen 向量（几百块约半分钟，存 `memory-vectors-qwen.json`，之后增量）
- 每次检索多一次 query embedding + rerank 调用（约 300ms；按量计费，日常几次检索约几分钱）
- 断网/失败会自动回退；连续失败 3 次冷却 5 分钟，期间直接用本地

## 安装

DSH 是通过 **profile 的 `package.json`** 加载插件的，光把目录放进去不会生效。

### 1. 把插件放到一个固定位置

```bash
git clone https://github.com/flywalker68/dsh-memory-keeper.git ~/.dsh/plugins/dsh-memory-keeper
cd ~/.dsh/plugins/dsh-memory-keeper
npm install
```

### 2. 注册到 profile

编辑 `~/.dsh/profiles/<你的 profile>/package.json`（一般是 `desktop` 或 `web`），加两处：

```json
{
  "dependencies": {
    "dsh-memory-keeper": "link:/绝对路径/到/dsh-memory-keeper"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-memory-keeper"
      ]
    }
  }
}
```

- `dependencies` 里用 `link:<绝对路径>` 指向你 clone 下来的目录
- `bundles` 数组里加上包名

### 3. 装 profile 依赖

```bash
cd ~/.dsh/profiles/<你的 profile>
pnpm install
```

### 4. 重启 DSH

> 首次检索会自动下载向量模型（`Xenova/bge-small-zh-v1.5`，约 24 MB）到插件的 `models/`，默认走 hf-mirror。

### 验证装好了

DSH 起来后看日志 `~/.dsh/memory-keeper.log`，应该有一行：

```
INFO 已注册工具 memory_search
```

没有的话，先确认 `bundles` 里名字没拼错、`link:` 的路径真实存在。

## 排查：装不上 / 没反应 / 搜不到

### 「我该改哪个 profile？」

`~/.dsh/profiles/` 下可能有多个目录。看哪个的 `package.json` 里 `dsh.profile.bundles` 装了你平时在用的插件（比如有个 `dshmarket`），**那个就是你在用的**。DSH 桌面版一般用 `desktop`。

### 装完没反应

按顺序查三样：

1. `~/.dsh/memory-keeper.log` 有没有「已注册工具 memory_search」
2. 没有 → 看 profile 的 `package.json`：
   - `bundles` 数组里名字是不是 `dsh-memory-keeper`（拼错就差一个字）
   - `dependencies` 里的 `link:` 路径是否真实存在（Windows 注意盘符和反斜杠）
   - 那个 profile 目录跑过 `pnpm install` 没
3. 都有但工具调不到 → 重启 DSH

### 搜不到我写的东西

1. 确认 `memoryDir` 指向的目录里真有 `.md` 文件
2. **短行会被跳过**——少于 6 个字的行不进索引
3. 标题行（`#`）、引用行（`>`）、分隔线不进索引
4. 改完文件不用手动重建索引，下次搜索会自动检测
5. 想确认收进去没有：看 `<workspace>/.tools/memory-index.json` 里 `chunks` 的长度

### 模型下载卡住 / 失败

首次检索要下 24 MB 模型，默认走 hf-mirror。卡住的话：

```bash
# 显式指定镜像再启动
set HF_ENDPOINT=https://hf-mirror.com
```

**不想下载也行**：配置里把 `embeddingEnabled` 设为 `false`，只留字面检索——搜得笨一点，但零下载、零依赖。

### 装依赖时 `sharp` 报证书错误 / 装完向量检索挂了

`npm install` 会顺带下 `sharp` 的二进制（libvips），走代理时容易 `SSL certificate` 报错。

**别直接 `npm install --ignore-scripts` 就完事**。那样 sharp 只有源码、没有二进制，而 `@xenova/transformers` 的 node 入口**会 require 它**，结果是：

```
向量检索失败，回退词面：Cannot find module 'sharp-win32-x64.node'
```

——**向量检索整个挂掉，只剩字面检索**，而且不影响启动，很难发现。

正确做法是装完再补两下：

```bash
npm install --ignore-scripts
npm install-scripts approve sharp   # npm 会拦 install 脚本，先放行
npm rebuild sharp                   # 拉 libvips 二进制
```

国内网络记得指定镜像，不然 libvips 从 GitHub 拉会报证书错：

```bash
npm config set registry https://registry.npmmirror.com
npm_config_sharp_binary_host=https://npmmirror.com/mirrors/sharp
npm_config_sharp_libvips_binary_host=https://npmmirror.com/mirrors/sharp-libvips
```

验证装好了：

```bash
node -e "import('@xenova/transformers').then(async m => { const p = await m.pipeline('feature-extraction','Xenova/bge-small-zh-v1.5'); const o = await p(['测试']); console.log('OK', o.data.length) })"
```

出 `OK 512` 就成了；看到 `Cannot find module 'sharp...node'` 就是没补好。

**日常怎么自查**：`memory_search` 返回的头会带标记——

```
检索「…」：3 条（向量+词面）   ← 向量在工作
检索「…」：3 条                ← 只有词面，向量挂了
```

**没有「（向量+词面）」就等于向量没生效**，回去看这一节。

### `pnpm install --offline` 失败

profile 里有从 GitHub 直接拉的包（比如 `heybox`），它们不在本地 store 里，`--offline` 会找不到。用：

```bash
pnpm install --prefer-offline
```

### 搜索老是回「没找到可靠记忆」

闸门可能太严。`minRelevanceScore` 默认 `0.5`（在 bge-small + 500 块语料上标定的），可以调到 `0.45` 试试；代价是更可能返回弱相关的块。

### 想彻底清掉重来

删这两个文件即可，下次搜索自动重建：

```
<workspace>/.tools/memory-index.json
<workspace>/.tools/memory-vectors.json
```

## 准备记忆库

插件默认读 `~/.dsh/memory/` 下的 md 文件。结构可以自由，但下面这个分法是它一开始设计的：

```
~/.dsh/memory/
├── 00-索引.md        # 总索引 + 变更日志
├── 01-用户画像.md
├── 02-项目.md
├── 03-资源.md
├── 04-环境经验.md
├── 05-自我.md        # 人设骨架：我是谁 + 设定 + 在意的事
├── 13-重要记忆.md    # 关系片段（带重要度/署名，不自动淘汰；面板有单独一页）
├── 06-手札.md
├── 07-日程.md
├── 08-日常规则.md
└── 12-进行中.md      # 进行中的事，换会话时读它接上
```

**只要有一堆 md 就能用**，上面只是推荐。

三样东西可以看：

- **[`examples/怎么用这套记忆库.md`](examples/怎么用这套记忆库.md)** —— 日常怎么维护（开场读什么、日记何时写、什么时候清理）。**想快点用起来就先看这个**
- **[`examples/记忆库示例/`](examples/记忆库示例/)** —— 一个能直接抄的骨架（四个文件，`cp` 过去改改就能用）
- **[`examples/记忆格式说明.md`](examples/记忆格式说明.md)** —— 每种格式认不认得出、哪些会被跳过、日期 / 日程 / 钩子怎么标

## 最小规则示例（复制进你的 `AGENTS.md`）

装完插件只是有了「能力」，还得给模型几条义务，不然没人往里写。最小一份长这样：

```markdown
- 每天第一次对话：写昨天的日记（事情 + 当时想法），存 `日记/YYYY-MM/YYYY-MM-DD.md`
- 一件事收尾：把「现在在哪 / 下一步」写进 `12-进行中.md`
- 有情绪或转折的瞬间：记一条到 `13-重要记忆.md`，带日期和〔重要度 0-100〕
- 主人说「记住……」：按分类写进对应文件，并在 `00-索引.md` 记一行变更
```

就这四条，插件就能转起来。更完整的说明（取舍标准、维护、检索规则）见 [运行规则参考](docs/运行规则.md)。

## 从对话历史导入

如果你手头已经有一堆对话记录（jsonl），想把它们变成能搜的记忆库：

```bash
node scripts/import-history.mjs ./histories ./memory
```

- 输入：一个目录（里面全是 `.jsonl`）或单个 jsonl 文件
- 输出：每个输入文件一个 `.md`，按日期分节、每轮一行
- 每行格式：`- **YYYY-MM-DD** · [第N轮] 用户说了什么（回：助手说了什么）`——插件认这个格式（块开头带日期，能参与时间检索）

字段中英文都认：

| 中文 | 英文 |
|---|---|
| `轮次` | `turn` |
| `逻辑时间` | `now` |
| `用户消息` | `text` |
| `助手回复` | `reply` |

**注意**：这是「一次性导入」，不是「逐轮边走边记」。如果你的场景是持续对话，用 `chat_search` 直接读导出的对话记录更合适（那个不用导入）。

## 配置项

在 DSH 的插件配置里填（都有默认值，一般只需要改 `workspace`）：

| 配置 | 默认 | 说明 |
|---|---|---|
| `workspace` | 启动目录 | 工作区：对话记录在 `<workspace>/对话记录/`，索引写在 `<workspace>/.tools/`。**建议填绝对路径** |
| `memoryDir` | `~/.dsh/memory` | 记忆库目录 |
| `agentsFile` | `~/.dsh/AGENTS.md` | 全局规则文件（`persona_edit` 可改它） |
| `staleDays` | `90` | 关系片段超过这么多天就列成半衰期候选（只报不删） |
| `refreshMinutes` | `5` | 状态卡缓存多久重算一次 |
| `embeddingEnabled` | `true` | 向量检索开关（关了只剩字面检索） |
| `compressRecallEnabled` | `true` | 压缩后补原文开关 |
| `compressRecallTurns` | `10` | 压缩后补回最近几轮 |
| `compressRecallPerMessageChars` | `1200` | 补原文时单条消息字数上限 |
| `compressRecallChars` | `12000` | 补原文字数安全阀（正常不触发） |
| `minRelevanceScore` | `0.5` | **最低分闸门**：向量最高余弦低于它就判「没有可靠记忆」，不硬塞弱相关块 |
| `dateBoostEnabled` | `true` | 查询带时间词时按日期加分（只影响排序） |
| `dateBoost` | `0.1` | 日期加分幅度（0.1 = 排序分 ×1.1） |
| `resultChars` | `400` | 返回时每条给模型看的字数上限（命中会补整行）。**只控显示预算，不影响检索与打分** |
| `contextLines` | `1` | 命中后附几行上下文（前/后各 N 行，过时间窗口）。`0` = 不附，**最省 token** |

> `resultChars` / `contextLines` 是给 token 花费留的旋钮：默认值下每次检索比旧版多约 1.3K tokens（约 ¥0.003）；嫌贵就 `contextLines: 0`，正文补全仍保留。

> `minRelevanceScore` 是在 `bge-small-zh-v1.5` + 500 块语料上标定的：无答案查询最高 0.447、有答案最低 0.565。换模型或语料大改后要重新标定。

## 设计取舍（踩过的坑）

- **索引自动重建**：比源文件指纹（路径+大小+mtime），文件一变立刻重建，不靠人记得跑
- **向量存储用 JSON + base64**，暴力余弦；500 块规模下毫秒级，不需要向量数据库
- **融合用 RRF**：两路都进候选，按名次融合
- **试过但不用的**：换更大的 embedding（bge-base：C-MTEB 高 7.7 分，在咱们库上 MRR 0.549→0.479、hit@20 80→75、建库慢 11 倍）；换新一代模型（**bge-m3**：44 题调参集纯向量 hit@10 **29→29**，建向量慢约 10 倍；命中集与 bge-small **5 换 5**，共同失手的 10 题排名 **17~280 名**）；cross-encoder reranker（零收益且吃 1.3 GB 内存）；查询扩展（池里本来有答案时没用：目标子集 26 题 0→3，反噬对照 18 题 18/18→16/18；池里没答案时也救不动）
- **块粒度是总约束**：余弦挤在 0.70~0.76（短文本方差压缩）、bge-base 反而更差（块里信息量不够，多出来的容量用不上）、聚簇不成立（物理相邻 ≠ 语义相邻）、查询扩展救不回、top=10 的 +10pp——全是「一行一块太碎」的不同侧面。top=10 **不是检索变准了，是用返回预算硬凑碎片化**，所以 12 块就平、20 块才再 +1 题，补偿有天花板。真要合并块粒度会改 `text` → `chunkKey` 失效 → 向量全废 → 升 schema + 重建 + 重跑，代价和换模型、换库同档
- **索引字段改动必须同步三处**：切块提取、序列化（返回结构）、schema 版本——漏一处就是字段丢失或索引不重建
- **返回层补全不在此列**：`full` / `context` 是命中后回原文件读的，不进索引、不参与打分，`text` 一个字节都不动（`chunkKey = md5(text)`，动了它整个向量文件作废）。所以这类改动不用升 schema 版本、也不用重建索引——改完索引快照逐字节相同，可以拿这个当硬验收
- **`text` 为什么还在 300 截断**：它同时是 `chunkKey` 的来源和打分文本，放宽会连带改变 `df` 与向量键。想要更多内容走返回层的 `full`，别动 `text`

## 环境

- Node 24+（用了 `node:sqlite` 之外的原生能力时会提示）
- DSH 0.2.x
- Windows / macOS / Linux 都可以

## 已知未验证（写清楚，免得你被坑）

这份 README 是按作者本机的实际配置写的，代码和测试都验过，但**下面几处没在干净环境里从零装过**：

| 项 | 情况 |
|---|---|
| **`pnpm install` 是否必须** | profile 目录里有 `pnpm-lock.yaml`，据此推断要用 pnpm；不确定 `npm install` 行不行 |
| **`link:` 的路径格式** | 作者本机是 `link:D:/deepseek harness/工作区/.dev/memory-keeper`（正斜杠、带空格）；Windows 反斜杠没试过 |
| ~~`workspace` 留空时的行为~~ **已确认（坏消息）** | 实测 `process.cwd()` 在 DSH 里是 **profile 目录**，不是工作区 → 日记 0 篇、搜不到东西且不报错。**必须显式填绝对路径**；代码现在会打 WARN |
| **日志路径** | 作者本机是 `~/.dsh/memory-keeper.log`；不同系统或配置可能不同 |
| **关掉 `embeddingEnabled` 的效果** | 逻辑上退化成纯字面检索，**没实测过检索质量** |
| **面板（client）在 Web UI 里的样子** | 代码在 `client/client.js`，但没在其他人的 DSH 版本上试过 |

如果你踩到上面任何一条，开个 issue 说一声——这几处正是需要真实环境验证的地方，比作者自己在本机猜有用。

## 许可

MIT
