# Pi Dynamic Topic & Capability Router 设计规范文档

## 1. 概述与设计哲学

### 1.1 背景与痛点
在 `pi` 运行时中，默认将所有已安装的 Tools（GDB、LSP、ast_search、mcp 等）和大量 Skills（安全审计、学术写作、代码约束等）在会话启动时全量塞入 System Prompt，会导致：
1. **上下文膨胀（Context Bloat）**：初始会话即消耗数千额外 Token。
2. **注意力稀释（Attention Drift）**：小型/快速模型（如 Gemini 3.8 Flash）在面对过多负向约束与冗余工具定义时，极易发生“粉象效应”和指令违背。

### 1.2 核心目标
- **极简冷启动**：会话初始只加载最精简的基础工具池，Prompt 保持绝对纯净。
- **AI 自主按需调度**：在第一轮交互中，由大模型在理解用户意图后，自主决策本会话的模式（`<mode>`）并从全局能力池中挑选所需工具（`<tools>`）与技能（`<skills>`）。
- **完全自由选配（Cross-Domain Any-to-Any）**：打破“代码模式不能用学术工具”的孤岛壁垒，工具与技能的选择基于环境全集，允许任意混搭。
- **固定格式用正则解析**：`<topic>` 块格式固定、只取文本；xmldom 在 pi 的 jiti 冷缓存下会被加载成多份，遇到不闭合的 `<topic>` 就死循环卡死整个 pi。
- **符合 Pi 官方标准的配置规范**：配置产物存储在 Pi 官方认可的 `extension-settings` 目录下，遵循标准优先级体系。

---

## 2. 存储路径规范与 Schema 设计

### 2.1 文件存放标准路径
在 `pi` 体系中，扩展的自定义持久化配置文件统一放置在 `extension-settings/` 目录下，支持全局与项目级两级覆盖：

- **全局配置路径**：  
  `~/.pi/agent/extension-settings/dynamic-topic.json`
- **项目级覆盖路径**（当前工作目录中）：  
  `.pi/extension-settings/dynamic-topic.json`

> **加载优先级**：优先读取当前项目 `.pi/` 下的配置；若不存在，则回退读取全局 `~/.pi/agent/` 下的配置。

### 2.2 配置内容 Schema (`dynamic-topic.json`)
文件内容完全自定义，但采用严谨的 JSON Schema 组织：

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "version": 1,
  "baseTools": [
    "read",
    "bash",
    "edit",
    "write",
    "web_search",
    "ask_user",
    "fetch_content",
    "get_search_content"
  ],
  "modes": {
    "code": {
      "description": "编程开发、代码分析、排错与底层调试",
      "recommendedTools": ["gdb-mcp_open", "lsp_diagnostics", "lsp_fix", "ast_search", "nu", "interactive_shell"],
      "recommendedSkills": ["ponytail", "karpathy-guidelines"]
    },
    "academic": {
      "description": "学术研究、论文阅读/写作与文献调研",
      "recommendedTools": ["source_check"],
      "recommendedSkills": ["academic-paper", "academic-paper-reviewer", "academic-pipeline", "deep-research"]
    },
    "ops": {
      "description": "系统管理、网络与自动化运维",
      "recommendedTools": ["interactive_shell", "nu"],
      "recommendedSkills": []
    },
    "general": {
      "description": "日常问答、文档撰写、资料收集与轻量交互",
      "recommendedTools": [],
      "recommendedSkills": []
    }
  },
  "customToolAliases": {
    "gdb": "gdb-mcp_open",
    "lsp": "lsp_diagnostics"
  }
}
```

---

## 3. 动态 XML 协议规范

### 3.1 首轮提示词注入协议 (Turn 1 Only)
在用户提问的第一轮（以及 session compact 发生后的首轮），向 **System Prompt 尾部**注入紧凑指令。

> 为什么不注入 User Prompt：User Prompt 会永久留在会话历史里，而 System Prompt 每轮重建，
> 轮次一过指令就自然卸载。挂在 User Prompt 上时模型每轮都看得见“输出 <topic>”，
> 于是从第二轮起持续重复输出（实测 69 轮里泄漏 36 轮）。

```text
[Session Topic & Capability Routing (this turn ONLY)]
At the very end of your final answer, on a new line, output:
<topic>
  <title>2-6 Chinese characters, short</title>
  <description>10-25 Chinese characters, the core task or question</description>
  <mode>code | academic | ops | general | custom</mode>
  <tools>
    <tool>tool_name</tool>
  </tools>
  <skills>
    <skill>skill_name</skill>
  </skills>
</topic>
Rules:
- <title> & <description>: summarize current session in Chinese.
- <mode>: broad intent category for mental focus.
- <tools> & <skills>: 下面两张表里是**还没激活**的额外项（可跨域混选）；不选也行。
- Tools not yet active: [tool1, tool2, ...]
- Skills not yet loaded: [skill1, skill2, ...]
- Output it exactly once, at the end of this reply.
```

**池子只列未激活项**：基础工具始终在 prompt 里（工具片段），已注入 `<available_skills>`/技能正文的技能也已可见，
再列一遍是纯重复。因此工具池 = 全量注册 − baseTools − 当前已激活；技能池 = 已发现技能 − 已激活。
代价：模型改选时无法“重提”已激活项，所以模型驱动的 `applyTopic` 走**累加**（保留已激活），
否则没被重新点名的能力会在 compact 重路由时静默消失；`/mode` 显式切模式仍是替换语义。
```

### 3.2 标签语义与字段约定
| 标签 | 必填 | 语义与规则 | 示例 |
| :--- | :--- | :--- | :--- |
| `<title>` | 是 | 核心动作或领域，2~6 个中文字符，用于终端与 Herdr Tab 标题 | `Syncthing部署` |
| `<description>` | 是 | 核心任务或场景描述，10~25 个中文字符 | `在多台服务器上配置同步节点` |
| `<mode>` | 是 | 开放式意图定调（任意字符串，非死板枚举；AI 可自由输出如 `reverse-engineering`、`ctf` 等零样本模式） | `code` / `ctf` / `academic` |
| `<tools>` | 否 | 包含 0 到多个 `<tool>`，声明本会话除基础工具外**额外需要的工具** | `<tool>gdb-mcp_open</tool>` |
| `<skills>` | 否 | 包含 0 到多个 `<skill>`，声明本会话需要激活的专业技能 | `<skill>academic-paper</skill>` |

---

## 4. 解析与运行时执行架构

### 4.1 解析实现
只取回复里**最后一个完整的** `<topic>…</topic>` 块（正文中间提到的 `<topic>` 不算），块内用正则抽 `<title>`/`<description>`/`<mode>`/`<tool>`/`<skill>` 的文本，去掉 CDATA 与内嵌标签。标签名大小写不敏感，`<tool>` 内可用逗号/空白分隔多个名字。

只解析 `text` 类型的内容块；`thinking` 里的 `<topic>` 是草稿，不采纳。

模型漏输出 `<topic>` 时：下一轮重试注入一次；再漏就放开全部工具、不过滤技能，会话退化为普通 pi。

### 4.2 工具名称别名与归一化管道 (Tool Normalization)
大模型在输出 XML 时，常倾向于书写直观简写（如 `<tool>gdb</tool>`、`<tool>lsp</tool>`），而系统底层实际注册的工具全名可能是 `gdb-mcp_open` 或 `lsp_diagnostics`。扩展内设三级归一化管道：
1. **显式映射**：优先查询 `dynamic-topic.json` 中的 `customToolAliases` 映射表（例如 `"gdb": "gdb-mcp_open"`）。
2. **模糊与后缀匹配**：若未命中，在 `pi.getAllTools()` 全量工具名中进行大小写不敏感的前缀/后缀/包含匹配。
3. **安全过滤**：完全不存在的工具名自动剔除并记录警告日志，绝不抛出异常破坏流程。

### 4.3 Skills 按需可见 (Skill Visibility)
Pi 官方核心对 Skills 未提供类似 `pi.setActiveSkills()` 的独立切换 API。本插件在 `before_agent_start` 里改写 `event.systemPrompt`：
1. **技能来源**：每轮从 pi 生成的 `<available_skills>` 里读 name/description，这就是 pi 实际加载的技能集（settings 路径、包声明、`resources_discover` 全包含），不自己扫目录。
2. **过滤**：只保留已激活技能的 `<skill>` 条目，其余删掉；一个都没激活时整段删掉。
3. **不注入正文**：保留的条目自带 `<location>`，模型需要时自己 `read`，和 pi 的技能设计一致。技能正文每轮塞进 system prompt 与「减少上下文膨胀」的目标相反，且会丢掉相对路径的解析基准。

### 4.4 运行时生命周期调度流

```
Session Start
  │
  ├─► 从 dynamic-topic.json 加载 baseTools
  ├─► 检查 Session 历史 Entry 是否有已持久化的 capabilities
  │     ├─ 有: pi.setActiveTools([...baseTools, ...savedTools])
  │     ├─ 无且没有用户消息: pi.setActiveTools(baseTools) (极简冷启动)
  │     └─ 无但有历史（装插件前的旧会话）: 只设标题，工具技能都不动
  │
Input (Turn 1 / After Compaction)
  │
  └─► 仅武装 expectingTopic（+ 终端标题预览），不改写用户文本
  │
Before Agent Start
  │
  ├─► 从 event.systemPrompt 的 <available_skills> 读技能集；工具用 pi.getAllTools()
      expectingTopic 为真时，把单轮指令追加到 System Prompt 尾部
  │
Message End (Assistant 回复完成)
  │
  ├─► parseTopicXml(assistantText)
  │     ├─ 剥离末尾协议块（正文中间/代码围栏里的引用保留），返回给用户完全干净的文本
  │     ├─ 更新终端标题 setTerminalTitle() & sendHerdrTabRename()
  │     ├─ 合并工具：activeTools = Unique([...baseTools, ...parsedTools])
  │     ├─ 动态生效：pi.setActiveTools(activeTools)
  │     ├─► 记下激活技能名（后续轮次只保留这些 <skill> 条目）
  │     └─► 持久化：pi.appendEntry("dynamic-topic-state", { ...caps })（resume 恢复时不再写）
  └─► ctx.ui.notify 打印自适应激活结果
```

---

## 5. `/mode init`（或 `/topic init`）子命令设计

### 5.1 命令目标
让 AI 自动扫描当前运行环境，识别出所有真实安装的 Tools 与 Skills，并生成符合上述规范的标准配置文件 `dynamic-topic.json`。

### 5.2 命令执行流程
1. **环境自检（Discovery）**：
   - 调用 `pi.getAllTools()` 获取环境中已加载的所有工具名称与说明。
   - 技能列表用最近一轮 system prompt 里读到的 `<available_skills>`（会话里还没发过消息时为空，命令会提示）。
2. **AI 分析归纳（Synthesis）**：
   - 将收集到的工具列表和技能列表构建成结构化 Prompt，请求当前默认模型：
     > “请分析以下工具和技能列表，将它们归纳到标准模式（如 code、academic、ops、general）的推荐组合中，并输出标准 JSON 格式。”
   - 调用走 `@earendil-works/pi-ai/compat` 的 `complete(ctx.model, …, auth)`，auth 来自 `ctx.modelRegistry.getApiKeyAndHeaders`。失败时回退到名字启发式并提示原因。
3. **安全写入与备份（Persistence）**：
   - 优先检测当前目录是否为受信任的项目（是否存在 `.pi/`）；
   - 若在独立项目内运行 `/topic init --project`，写入 `.pi/extension-settings/dynamic-topic.json`；
   - 默认写入全局路径 `~/.pi/agent/extension-settings/dynamic-topic.json`；
   - 写入前自动备份旧配置（若存在）。
4. **即时热生效**：
   - 重新加载该配置作为当前运行时的基准，通知用户初始化成功。

---

## 6. 后续演进与测试计划

1. **单测用例验证**：
   - 测试包含换行符、HTML 实体转义、前后空格等非标准格式的 XML 解析。
   - 测试大模型跨界挑选工具时的数组去重与非法工具名自动忽略机制。
2. **渐进式迁移**：
   - 直接在已有的 `~/.pi/agent/git/github.com/paprays/pi-dynamic-topic` 仓库中以向后兼容方式升级，保留原有 `/topic` 命令和 Herdr/OSC 同步逻辑。
