# dsh-memory-keeper

给 DeepSeek Harness 用的**长期记忆插件**：把人设、日记、日常规则、进行中的事存成纯文本 md，检索靠「字面 + 语义」双路，右键能翻原话，还会在上下文压缩之后把最近的对话补回来。

数据全在本地，不调 API、不需要 key。

## 给帮忙安装的 AI（TL;DR）

- 这是 **DSH（DeepSeek Harness）的 cordis 插件**，**不是把目录丢进 `.dev/` 就生效**
- 注册方式：`~/.dsh/profiles/<profile>/package.json`
  - `dependencies` 加 `"dsh-memory-keeper": "link:<绝对路径>"`
  - `dsh.profile.bundles` 数组加 `"dsh-memory-keeper"`
- 然后在那个 profile 目录跑 `pnpm install`，重启 DSH
- **验证**：`~/.dsh/memory-keeper.log` 出现 `已注册工具 memory_search`
- **记忆库**：`~/.dsh/memory/` 下放 `.md` 文件即可，格式见 [`examples/记忆格式说明.md`](examples/记忆格式说明.md)
- **配置**：至少把 `workspace` 填成绝对路径（留空会用 `process.cwd()`，未验证是否等于工作区）
- **不需要 API key**；首次检索会下 24 MB 模型，或把 `embeddingEnabled` 设 `false` 跳过

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

## 功能

| 功能 | 说明 |
|---|---|
| **状态卡** | 每轮首页注入：认识多少天、日记进度、今天/明天日程、半衰期候选、人设漂移信号 |
| **memory_search** | 检索记忆库（词面 + 向量 + RRF 融合），带最低分闸门 |
| **chat_search** | 翻对话原文，按意思找；认「三天前 / 上周 / 一个月前」这类时间说法 |
| **memory_check** | 看记忆库健康度：日记进度、体积、日程、过期项 |
| **persona_edit** | 改人设文件时自动备份 + 记变更日志 |
| **memory_touch** | 确认某条记忆被真正用上了（回忆即加固） |
| **侧栏面板** | 在 Web UI 里看记忆库全貌 |

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
├── 05-自我.md        # 人设 + 关系片段 + 我在意的事
├── 06-手札.md
├── 07-日程.md
├── 08-日常规则.md
└── 12-进行中.md      # 进行中的事，换会话时读它接上
```

**只要有一堆 md 就能用**，上面只是推荐。

每种文件的具体格式（哪些写法认得出、哪些会被跳过、日期 / 日程 / 钩子怎么标）见 **[`examples/记忆格式说明.md`](examples/记忆格式说明.md)**。

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

> `minRelevanceScore` 是在 `bge-small-zh-v1.5` + 500 块语料上标定的：无答案查询最高 0.447、有答案最低 0.565。换模型或语料大改后要重新标定。

## 设计取舍（踩过的坑）

- **索引自动重建**：比源文件指纹（路径+大小+mtime），文件一变立刻重建，不靠人记得跑
- **向量存储用 JSON + base64**，暴力余弦；500 块规模下毫秒级，不需要向量数据库
- **融合用 RRF**：两路都进候选，按名次融合
- **试过但不用的**：换更大的 embedding（在中文记忆语料上反而更差）、cross-encoder reranker（零收益且吃 1.3 GB 内存）、查询扩展（池里本来就有答案时没用）
- **索引字段改动必须同步三处**：切块提取、序列化（返回结构）、schema 版本——漏一处就是字段丢失或索引不重建

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
| **`workspace` 留空时的行为** | 代码里用 `process.cwd()`，但 DSH 加载插件时 cwd 是不是工作区**没确认**。**稳妥做法：直接填绝对路径** |
| **日志路径** | 作者本机是 `~/.dsh/memory-keeper.log`；不同系统或配置可能不同 |
| **关掉 `embeddingEnabled` 的效果** | 逻辑上退化成纯字面检索，**没实测过检索质量** |
| **面板（client）在 Web UI 里的样子** | 代码在 `client/client.js`，但没在其他人的 DSH 版本上试过 |

如果你踩到上面任何一条，开个 issue 说一声——这几处正是需要真实环境验证的地方，比作者自己在本机猜有用。

## 许可

MIT
