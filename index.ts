import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HERDR_ENV = process.env.HERDR_ENV;
const socketPath = process.env.HERDR_SOCKET_PATH;
const socketEndpoint =
    process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
const tabId = process.env.HERDR_TAB_ID;

const ENTRY_TYPE_TOPIC = "dynamic-topic-state";
// 一个 <topic> 块，内部不得再出现 <topic —— 否则正文里提到的 `<topic>` 会和末尾真块连成一个坏块
const TOPIC_BLOCK = String.raw`<topic\b[^>]*>(?:(?!<topic\b)[\s\S])*?<\/topic>`;

export interface DynamicTopicConfig {
    version: number;
    baseTools: string[];
    modes: Record<
        string,
        {
            description: string;
            recommendedTools: string[];
            recommendedSkills: string[];
        }
    >;
    customToolAliases: Record<string, string>;
}

export const DEFAULT_CONFIG: DynamicTopicConfig = {
    version: 1,
    baseTools: [
        "read",
        "bash",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
        "web_search",
        "ask_user",
        "fetch_content",
        "get_search_content",
    ],
    modes: {
        code: {
            description: "编程开发、代码分析、排错与底层调试",
            recommendedTools: ["gdb-mcp_open", "lsp_diagnostics", "lsp_fix", "ast_search", "nu", "interactive_shell"],
            recommendedSkills: ["ponytail", "karpathy-guidelines"],
        },
        academic: {
            description: "学术研究、论文阅读/写作与文献调研",
            recommendedTools: ["source_check"],
            recommendedSkills: ["academic-paper", "academic-paper-reviewer", "academic-pipeline", "deep-research"],
        },
        ppt: {
            description: "PPT与幻灯片制作、大纲策划、视觉插图与排版设计",
            recommendedTools: ["generate_image", "fetch_content", "web_search"],
            recommendedSkills: ["browser-act"],
        },
        ops: {
            description: "系统管理、网络与自动化运维",
            recommendedTools: ["interactive_shell", "nu"],
            recommendedSkills: [],
        },
        general: {
            description: "日常问答、文档撰写、资料收集与轻量交互",
            recommendedTools: [],
            recommendedSkills: [],
        },
    },
    customToolAliases: {
        gdb: "gdb-mcp_open",
        lsp: "lsp_diagnostics",
        ast: "ast_search",
        shell: "interactive_shell",
        image: "generate_image",
    },
};

export interface ParsedTopicBlock {
    title: string;
    description: string;
    mode: string;
    tools: string[];
    skills: string[];
    rawBlock: string;
}

export interface SkillInfo {
    name: string;
    description: string;
}

/**
 * 设置终端窗口标题：走 pi 自己的 ui.setTitle，不直接写 OSC（否则和 pi 的标题写入互相覆盖）
 */
export function setTerminalTitle(ctx: ExtensionContext, title: string) {
    // 标题来自模型输出，必须剥掉控制字符，否则等于把 OSC 转义序列的控制权交给模型
    ctx.ui.setTitle(sanitizeTitle(title));
}

/**
 * 标题净化：去掉全部 C0/DEL 控制字符并截断
 */
export function sanitizeTitle(title: string): string {
    return (title || "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 200);
}

/**
 * 如果在 Herdr 环境中运行，通过 Herdr socket 同步更新 Tab 标题
 */
export function sendHerdrTabRename(label: string): void {
    if (HERDR_ENV !== "1" || !socketPath || !tabId) {
        return;
    }

    try {
        const socket = net.createConnection(socketEndpoint!);
        const req = {
            id: `pi:tab-rename:${Date.now()}`,
            method: "tab.rename",
            params: {
                tab_id: tabId,
                label,
            },
        };
        socket.on("connect", () => {
            socket.write(`${JSON.stringify(req)}\n`);
        });
        socket.on("data", () => socket.destroy());
        socket.on("error", () => socket.destroy());
        setTimeout(() => socket.destroy(), 1000).unref?.();
    } catch {
        // ignore
    }
}

/**
 * 清理并提取用户消息的纯文本
 */
export function extractUserText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
            .map((c: any) => c.text)
            .join(" ");
    }
    return "";
}

/**
 * 本地极速启发式提取（用于用户输入瞬间的即时预览）
 */
export function generateFallbackTopic(text: string): string {
    // 按码点切，否则 slice 会把 emoji 的代理对劈开，终端标题里留下孤立代理项
    const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");
    const clean = text
        .replace(/\s+/g, " ")
        .replace(/^[\s\p{P}]+/u, "")
        .trim();

    if (!clean || clean.length <= 2) return "新对话";

    const splitMatch = clean.match(/^([^，,。！？!?；;\n]+)[，,。！？!?；;\n]\s*(.*)$/);
    if (splitMatch) {
        const title = cut(splitMatch[1].trim(), 10);
        const desc = cut(splitMatch[2].trim(), 25) || cut(clean, 25);
        return `[${title} - ${desc}]`;
    }

    return `[${cut(clean, 8)} - ${cut(clean, 24)}]`;
}

/**
 * 把任意来源的对象收敛成合法配置：缺字段回退默认，modes 使用无原型对象
 * （避免 "constructor" / "__proto__" 这类键被当成已存在的模式）
 */
export function coerceConfig(raw: any): DynamicTopicConfig {
    const modes: DynamicTopicConfig["modes"] = Object.create(null);
    const src =
        raw?.modes && typeof raw.modes === "object" ? raw.modes : DEFAULT_CONFIG.modes;
    for (const [key, val] of Object.entries(src)) {
        const v = val as any;
        if (!v || typeof v !== "object") continue;
        modes[key] = {
            description: typeof v.description === "string" ? v.description : "",
            recommendedTools: Array.isArray(v.recommendedTools) ? v.recommendedTools : [],
            recommendedSkills: Array.isArray(v.recommendedSkills) ? v.recommendedSkills : [],
        };
    }
    return {
        version: 1,
        baseTools: Array.isArray(raw?.baseTools) ? raw.baseTools : [...DEFAULT_CONFIG.baseTools],
        modes,
        customToolAliases:
            raw?.customToolAliases && typeof raw.customToolAliases === "object"
                ? { ...raw.customToolAliases }
                : { ...DEFAULT_CONFIG.customToolAliases },
    };
}

/**
 * 解析用户配置，项目级优先，回退到全局或默认值
 * 始终返回独立副本，绝不把 DEFAULT_CONFIG 本体交出去
 */
export function loadConfig(cwd: string): DynamicTopicConfig {
    const projectPath = path.join(cwd, ".pi", "extension-settings", "dynamic-topic.json");
    if (fs.existsSync(projectPath)) {
        try {
            return coerceConfig(JSON.parse(fs.readFileSync(projectPath, "utf-8")));
        } catch {
            // ignore
        }
    }

    const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    const globalPath = path.join(agentDir, "extension-settings", "dynamic-topic.json");
    if (fs.existsSync(globalPath)) {
        try {
            return coerceConfig(JSON.parse(fs.readFileSync(globalPath, "utf-8")));
        } catch {
            // ignore
        }
    }

    return coerceConfig(DEFAULT_CONFIG);
}

/**
 * 持久化配置文件，优先更新现有配置文件位置或全局位置
 */
export function persistConfig(
    configToSave: DynamicTopicConfig,
    cwd: string,
    forceProject = false
): string {
    const projectDir = path.join(cwd, ".pi", "extension-settings");
    const projectPath = path.join(projectDir, "dynamic-topic.json");

    const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    const globalDir = path.join(agentDir, "extension-settings");
    const globalPath = path.join(globalDir, "dynamic-topic.json");

    let targetDir = globalDir;
    let targetPath = globalPath;

    if (forceProject || fs.existsSync(projectPath)) {
        targetDir = projectDir;
        targetPath = projectPath;
    }

    fs.mkdirSync(targetDir, { recursive: true });
    if (fs.existsSync(targetPath)) {
        try {
            fs.copyFileSync(targetPath, `${targetPath}.bak`);
        } catch {
            // ignore
        }
    }
    fs.writeFileSync(targetPath, JSON.stringify(configToSave, null, 2), "utf-8");
    return targetPath;
}

const unescapeXml = (s: string) =>
    s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");

/**
 * 从 pi 生成的 system prompt 里读 <available_skills>。
 * 这就是 pi 实际加载的技能集（settings 路径 + 包声明 + resources_discover），
 * 自己扫目录会和它脱节，所以不扫。
 */
export function parseAvailableSkills(systemPrompt: string): SkillInfo[] {
    const block = systemPrompt.match(/<available_skills>([\s\S]*?)<\/available_skills>/i)?.[1] || "";
    return [...block.matchAll(/<skill>([\s\S]*?)<\/skill>/gi)].flatMap((m) => {
        const field = (tag: string) =>
            unescapeXml(m[1].match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"))?.[1] || "").trim();
        const name = field("name");
        return name ? [{ name, description: field("description") }] : [];
    });
}

/**
 * 从回复里取最后一个完整的 <topic> 块并抽出各字段
 */
export function parseTopicXml(text: string): ParsedTopicBlock | null {
    if (!text) return null;
    // ponytail: 正则代替 DOMParser —— 格式固定、只取文本。xmldom 在 pi 的 jiti 冷缓存（扩展刚改过/刚升级）下
    // 会被加载成多份，sax 里 `instanceof ParseError` 失效，遇到不闭合的 <topic> 就在 position() 里死循环，整个 pi 卡死
    const blocks = text.match(new RegExp(TOPIC_BLOCK, "gi"));
    if (!blocks) return null;
    const rawBlock = blocks[blocks.length - 1];

    const texts = (tag: string) =>
        [...rawBlock.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))].map((m) =>
            m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, "").trim()
        );
    const list = (tag: string) => texts(tag).flatMap((v) => v.split(/[\s,]+/)).filter(Boolean);
    const tools = list("tool");
    const skills = list("skill");

    return {
        title: (texts("title")[0] || "").replace(/^\[|\]$/g, "").trim(),
        description: (texts("description")[0] || "").replace(/^\[|\]$/g, "").trim(),
        mode: texts("mode")[0] || "general",
        tools: tools.length ? tools : list("tools"),
        skills: skills.length ? skills : list("skills"),
        rawBlock,
    };
}

/**
 * 从回复文本中剥离协议块
 *
 * 只删**末尾**那个 <topic> 块：协议本身要求它出现在回复最末（历史 139 次真实输出全在末尾），
 * 而正文中间/代码围栏里的 <topic> 全是模型在讲解或举例（本项目自己的会话就有 7 次），
 * 一刀切会把用户想看的示例一起删掉。
 * 裸的 <title>/<tools> 等标签同样不碰。
 */
export function stripTopicXmlFromText(text: string): string {
    if (!text) return "";
    return text.replace(new RegExp(String.raw`(?:\s*${TOPIC_BLOCK})+\s*$`, "i"), "").trimEnd();
}

/**
 * 工具名称别名与归一化管道
 */
export function normalizeTools(
    requested: string[],
    allTools: string[],
    aliases: Record<string, string> = {}
): string[] {
    const normalized: string[] = [];
    const allToolsLower = allTools.map((t) => ({ raw: t, lower: t.toLowerCase() }));

    for (let req of requested) {
        req = req.trim();
        if (!req) continue;
        const reqLower = req.toLowerCase();

        // 1. 显式别名匹配
        let target = req;
        for (const [aliasKey, aliasVal] of Object.entries(aliases)) {
            if (aliasKey.toLowerCase() === reqLower) {
                target = aliasVal;
                break;
            }
        }

        const targetLower = target.toLowerCase();

        // 2. 精确匹配
        const exact = allToolsLower.find((t) => t.lower === targetLower);
        if (exact) {
            normalized.push(exact.raw);
            continue;
        }

        // 3. 后缀/前缀匹配
        // ponytail: 不做裸子串兜底 —— 那会把 "x" 绑到 lsp_fix，且结果随工具注册顺序漂移
        const fuzzy = allToolsLower.find(
            (t) =>
                t.lower.endsWith(`_${targetLower}`) ||
                t.lower.endsWith(`-${targetLower}`) ||
                t.lower.startsWith(`${targetLower}_`) ||
                t.lower.startsWith(`${targetLower}-`)
        );
        if (fuzzy) {
            normalized.push(fuzzy.raw);
        }
    }

    return Array.from(new Set(normalized));
}

/**
 * 过滤并精简系统提示词中的技能列表，实现冷启动绝对隔离。
 * 留下的 <skill> 条目自带 <location>，模型需要时自己 read；技能正文不注入。
 */
export function filterSystemPromptSkills(systemPrompt: string, activeSkillNames: Set<string>): string {
    return systemPrompt.replace(/<available_skills>([\s\S]*?)<\/available_skills>/gi, (_match, inner) => {
        if (activeSkillNames.size === 0) {
            return "";
        }
        const skillMatches = inner.match(/<skill>[\s\S]*?<\/skill>/gi) || [];
        const kept = skillMatches.filter((s: string) => {
            const nameMatch = s.match(/<name>([\s\S]*?)<\/name>/i);
            const name = nameMatch ? nameMatch[1].trim().toLowerCase() : "";
            return activeSkillNames.has(name);
        });
        if (kept.length === 0) return "";
        return `<available_skills>\n${kept.join("\n")}\n</available_skills>`;
    });
}

/**
 * 能力池条目：名字 + 一句话作用。技能描述动辄上千字（带触发词），只留首句并截断
 */
export type PoolItem = string | { name: string; description?: string };

function formatPool(items: PoolItem[]): string {
    if (items.length === 0) return " none";
    return items
        .map((item) => {
            const { name, description } = typeof item === "string" ? { name: item, description: "" } : item;
            const first = (description || "").replace(/\s+/g, " ").trim().split(/(?<=[.。!?！？])\s/)[0];
            const chars = Array.from(first);
            const brief = chars.length > 100 ? `${chars.slice(0, 100).join("")}…` : first;
            return `\n  * ${name}${brief ? `: ${brief}` : ""}`;
        })
        .join("");
}

/**
 * 构造注入到 System Prompt 尾部的单轮协议指令
 */
export function buildRoutingInstruction(
    availableTools: PoolItem[],
    availableSkills: PoolItem[],
    modes?: Record<string, { description: string; recommendedTools: string[]; recommendedSkills: string[] }>
): string {
    const modeKeys =
        modes && Object.keys(modes).length > 0
            ? Object.keys(modes).join(" | ") + " | custom"
            : "code | academic | ppt | ops | general | custom";

    const modeLines =
        modes && Object.keys(modes).length > 0
            ? `\n- Defined Modes & Defaults:\n` +
              Object.entries(modes)
                  .map(([key, val]) => {
                      const t = val.recommendedTools?.length ? val.recommendedTools.join(", ") : "none";
                      const s = val.recommendedSkills?.length ? val.recommendedSkills.join(", ") : "none";
                      return `  * ${key}: ${val.description || "无说明"} (Default tools: [${t}], Default skills: [${s}])`;
                  })
                  .join("\n")
            : "";

    return `
[Session Topic & Capability Routing (this turn ONLY)]
At the very end of your final answer, on a new line, output:
<topic>
  <title>2-6 Chinese characters, short</title>
  <description>10-25 Chinese characters, the core task or question</description>
  <mode>${modeKeys}</mode>
  <tools>
    <tool>tool_name</tool>
  </tools>
  <skills>
    <skill>skill_name</skill>
  </skills>
</topic>
Rules:
- <title> & <description>: summarize current session in Chinese.
- <mode>: broad intent category for mental focus (e.g. ${modes && Object.keys(modes).length > 0 ? Object.keys(modes).join(", ") : "code, academic, ppt, ops, general"}).${modeLines}
- <tools> & <skills>: 下面两张表里是**还没激活**的额外项，按需选；不选也行（已激活的项照旧保留，不必重列）。
- Tools not yet active:${formatPool(availableTools)}
- Skills not yet loaded:${formatPool(availableSkills)}
- Output it exactly once, at the end of this reply. This instruction is not repeated, so never emit <topic> again.
`;
}

/**
 * 解析命令参数：支持 --tools, --skills, --desc, --mode
 * 按 token 切分而非正则抠取：工具名/技能名里的连字符必须原样保留
 */
export function parseModeArgs(rawArgs: string) {
    const tokens = rawArgs.trim().match(/"[^"]*"|'[^']*'|\S+/g) || [];
    const unquote = (s: string) => s.replace(/^["']|["']$/g, "");
    const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

    let tools: string[] | undefined;
    let skills: string[] | undefined;
    let desc: string | undefined;
    let mode: string | undefined;
    const positional: string[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === "--tools" || t === "-t") tools = split(unquote(tokens[++i] || ""));
        else if (t === "--skills" || t === "-s") skills = split(unquote(tokens[++i] || ""));
        else if (t === "--desc" || t === "-d") desc = unquote(tokens[++i] || "");
        else if (t === "--mode" || t === "-m") mode = unquote(tokens[++i] || "").toLowerCase() || undefined;
        else positional.push(unquote(t));
    }

    const name = positional[0]?.toLowerCase();
    if (!desc && positional.length > 1) {
        desc = positional.slice(1).join(" ");
    }

    return { name, desc, tools, skills, mode, positional };
}

/**
 * 增量列表：`-x` 移除，`x` / `+x` 添加；delta 为空则原样返回
 */
export function patchList(current: string[], delta?: string[]): string[] {
    if (!delta) return current;
    const drop = new Set(delta.filter((d) => d.startsWith("-")).map((d) => d.slice(1)));
    const add = delta.filter((d) => !d.startsWith("-")).map((d) => d.replace(/^\+/, ""));
    return Array.from(new Set([...current.filter((x) => !drop.has(x)), ...add]));
}

const MODE_SUBS = ["list", "add", "edit", "del", "init"];
const TOPIC_SUBS = ["update", "init", "mode"];

/**
 * /mode 与 /topic 的参数补全。
 * pi 传进来的 prefix 是命令名之后到光标的整段文本，选中项的 value 会替换整段，
 * 所以 value 必须带上前面已输入的部分。
 */
export function completeCommandArgs(
    cmd: "mode" | "topic",
    prefix: string,
    env: { modes: string[]; tools: string[]; skills: string[] }
): AutocompleteItem[] | null {
    const parts = prefix.replace(/^\s+/, "").split(/\s+/);
    const cur = parts[parts.length - 1];
    const head = parts.slice(0, -1).join(" ");
    const join = (v: string) => (head ? `${head} ${v}` : v);
    // done 是当前词里已完成的前缀（逗号列表的前几项），只拿剩下的部分去匹配
    const pick = (cands: string[], done = "") => {
        const rest = cur.slice(done.length);
        const items = cands.filter((c) => c.startsWith(rest)).map((c) => ({ value: join(done + c), label: c }));
        return items.length ? items : null;
    };
    // 逗号列表：补最后一项，保留已输入的前几项和 +/- 前缀
    const pickList = (cands: string[]) => {
        const done = cur.slice(0, cur.lastIndexOf(",") + 1);
        const sign = /^[+-]/.test(cur.slice(done.length)) ? cur[done.length] : "";
        return pick(cands.map((c) => sign + c), done);
    };

    const sub = parts[0];
    const prev = parts[parts.length - 2];
    if (cmd === "topic") {
        if (parts.length === 1) return pick(TOPIC_SUBS);
        if (sub === "mode") {
            const inner = completeCommandArgs("mode", parts.slice(1).join(" "), env);
            return inner ? inner.map((i) => ({ ...i, value: `mode ${i.value}` })) : null;
        }
        if (sub === "init") return pick(["--project"]);
        if (sub !== "update") return null;
    } else {
        if (parts.length === 1) return pick([...MODE_SUBS, ...env.modes]);
        if (sub === "init") return pick(["--project"]);
        if ((sub === "edit" || sub === "del") && parts.length === 2) return pick(env.modes);
        if (sub !== "add" && sub !== "edit") return null;
    }
    // 标志及其取值
    if (prev === "--tools" || prev === "-t") return pickList(env.tools);
    if (prev === "--skills" || prev === "-s") return pickList(env.skills);
    if (prev === "--mode" || prev === "-m") return pick(env.modes);
    if (cur.startsWith("-")) return pick(cmd === "topic" ? ["--mode", "--tools", "--skills"] : ["--tools", "--skills", "--desc"]);
    return null;
}

/**
 * 格式化模式列表展示
 */
export function formatModeList(modes: Record<string, any>, currentMode: string): string {
    const lines = [`📋 可用工作模式列表 (当前生效: ${currentMode}):\n`];
    for (const [key, val] of Object.entries(modes)) {
        const isCurrent = key === currentMode ? " [当前激活]" : "";
        const tools = val.recommendedTools?.length
            ? val.recommendedTools.join(", ")
            : "无（仅基础集）";
        const skills = val.recommendedSkills?.length ? val.recommendedSkills.join(", ") : "无";
        lines.push(`• [${key}]${isCurrent} ${val.description || "无说明"}`);
        lines.push(`  └ 推荐工具: ${tools}`);
        lines.push(`  └ 推荐技能: ${skills}\n`);
    }
    lines.push(`💡 提示: 输入 /mode <name> 立即换挡；输入 /mode add|edit|del|list 进行增删改查。`);
    return lines.join("\n");
}

/**
 * 结合 AI 模型或启发式规则，自动分析环境并归纳生成模式配置。
 * AI 失败时回退启发式，并把原因交给调用方提示（不再静默吞掉）。
 */
export async function synthesizeConfigWithAi(
    allTools: { name: string; description?: string }[],
    allSkills: { name: string; description?: string }[],
    ctx?: ExtensionContext
): Promise<{ config: DynamicTopicConfig; aiError?: string }> {
    const baseTools = [
        "read",
        "bash",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
        "web_search",
        "ask_user",
        "fetch_content",
        "get_search_content",
    ];

    const nonBaseTools = allTools.filter((t) => !baseTools.includes(t.name));

    // 默认启发式基准模式
    const heuristicConfig: DynamicTopicConfig = {
        version: 1,
        baseTools,
        modes: {
            code: {
                description: "编程开发、代码分析、排错与底层调试",
                recommendedTools: nonBaseTools
                    .filter((t) => /gdb|lsp|ast|nu|interactive_shell|diff|edit|write/i.test(t.name))
                    .map((t) => t.name),
                recommendedSkills: allSkills
                    .filter((s) => /ponytail|karpathy|code|git|dev|audit/i.test(s.name))
                    .map((s) => s.name),
            },
            academic: {
                description: "学术研究、论文阅读/写作与文献调研",
                recommendedTools: nonBaseTools
                    .filter((t) => /source_check|search|paper|arxiv|bib/i.test(t.name))
                    .map((t) => t.name),
                recommendedSkills: allSkills
                    .filter((s) => /academic|paper|research|thesis|pipeline/i.test(s.name))
                    .map((s) => s.name),
            },
            ppt: {
                description: "PPT与幻灯片制作、大纲策划、视觉插图与排版设计",
                recommendedTools: nonBaseTools
                    .filter((t) => /image|generate|fetch|draw|canvas|media/i.test(t.name))
                    .map((t) => t.name),
                recommendedSkills: allSkills
                    .filter((s) => /browser|ppt|slide|present|design/i.test(s.name))
                    .map((s) => s.name),
            },
            ops: {
                description: "系统管理、网络与自动化运维",
                recommendedTools: nonBaseTools
                    .filter((t) => /interactive_shell|nu|bash|ssh|docker|k8s/i.test(t.name))
                    .map((t) => t.name),
                recommendedSkills: allSkills
                    .filter((s) => /ctf|ops|network|sys|orchestrator/i.test(s.name))
                    .map((s) => s.name),
            },
            general: {
                description: "日常问答、文档撰写、资料收集与轻量交互",
                recommendedTools: [],
                recommendedSkills: [],
            },
        },
        customToolAliases: {
            gdb: allTools.find((t) => t.name.includes("gdb"))?.name || "gdb-mcp_open",
            lsp: allTools.find((t) => t.name.includes("lsp"))?.name || "lsp_diagnostics",
            ast: allTools.find((t) => t.name.includes("ast"))?.name || "ast_search",
            shell: allTools.find((t) => t.name.includes("interactive"))?.name || "interactive_shell",
            image: allTools.find((t) => t.name.includes("image"))?.name || "generate_image",
        },
    };

    if (!ctx?.modelRegistry || !ctx?.model) {
        return { config: heuristicConfig, aiError: "当前没有可用模型" };
    }

    try {
        const prompt = `你是一个智能工具与技能架构专家。
请分析当前环境中已安装的全部工具（Tools）和技能（Skills）：

【工具列表】
${allTools.map((t) => `- ${t.name}: ${t.description || "无说明"}`).join("\n")}

【技能列表】
${allSkills.map((s) => `- ${s.name}: ${s.description || "无说明"}`).join("\n")}

任务要求：
1. 深入分析它们的能力，为用户将这些能力归纳组织成多种实用的工作模式。
2. 必须包含且充实以下标准模式（可根据工具/技能特色补充更多特色模式）：
   - code: 编程开发、代码分析、排错与底层调试
   - academic: 学术研究、论文阅读/写作与文献调研
   - ppt: PPT与幻灯片制作、大纲策划、视觉插图与排版设计
   - ops: 系统管理、网络与自动化运维
   - general: 日常问答、文档撰写、资料收集与轻量交互
3. 为每个模式提供：
   - description: 简明的中文定位说明
   - recommendedTools: 该模式推荐激活的额外工具列表（只能从上述工具列表中选择真实存在的工具名）
   - recommendedSkills: 该模式推荐激活的专业技能列表（只能从上述技能列表中选择真实存在的技能名）
4. 提供常用的别名字典 customToolAliases（如 gdb, lsp, ast, shell, image 等）。
5. 必须严格只返回合法的 JSON 对象，不要添加任何 markdown 代码块以外的闲聊文字：
{
  "modes": {
    "code": {
      "description": "...",
      "recommendedTools": [...],
      "recommendedSkills": [...]
    },
    "academic": { ... },
    "ppt": { ... },
    "ops": { ... },
    "general": { ... }
  },
  "customToolAliases": {
    "gdb": "...",
    "lsp": "...",
    "image": "..."
  }
}`;

        const registry: any = ctx.modelRegistry;
        // ponytail: 测试桩把 complete 挂在 modelRegistry 上；真实 pi 没有这个方法，走 pi-ai 的 complete
        const completeFn =
            registry.complete ?? (await import("@earendil-works/pi-ai/compat")).complete;
        const auth = registry.getApiKeyAndHeaders ? await registry.getApiKeyAndHeaders(ctx.model) : {};
        if (auth.ok === false) throw new Error(auth.error);

        const response = await completeFn(
            ctx.model,
            {
                systemPrompt: "你是一个专业的系统配置生成器，只输出严格合法的 JSON 对象。",
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text", text: prompt }],
                        timestamp: Date.now(),
                    },
                ],
            },
            { apiKey: auth.apiKey, headers: auth.headers, env: auth.env }
        );

        const contentText = (response.content || [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");

        const jsonMatch = contentText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("模型没有返回 JSON");
        const parsed = JSON.parse(jsonMatch[0]);
        if (!parsed.modes || typeof parsed.modes !== "object") throw new Error("返回的 JSON 缺少 modes");
        return {
            config: {
                version: 1,
                baseTools,
                modes: {
                    ...heuristicConfig.modes,
                    ...parsed.modes,
                },
                customToolAliases: {
                    ...heuristicConfig.customToolAliases,
                    ...(parsed.customToolAliases || {}),
                },
            },
        };
    } catch (err: any) {
        return { config: heuristicConfig, aiError: err?.message || String(err) };
    }
}

export default function (pi: ExtensionAPI) {
    let currentTopic: string | undefined;
    let currentMode: string = "general";
    let activeSkills = new Set<string>();
    let shouldInjectInNextPrompt = false;
    let expectingTopic = false;
    // 路由是否真的落过地。模型漏输出 <topic> 时必须放行全部技能，否则整个会话静默失能
    let routingApplied = false;
    // 漏输出只重试一次，再漏就退化成普通 pi
    let routingRetried = false;
    let config: DynamicTopicConfig = coerceConfig(DEFAULT_CONFIG);
    // pi 实际加载的技能集，每轮从 system prompt 里读
    let knownSkills: SkillInfo[] = [];

    const bracket = (s: string) => (s.startsWith("[") && s.endsWith("]") ? s : `[${s}]`);
    const allToolNames = () => pi.getAllTools().map((t) => t.name);

    function applyTopic(
        ctx: ExtensionContext,
        opts: {
            topic: string;
            mode: string;
            tools: string[];
            skills: string[];
            notify?: boolean;
            // 模型改选时是否保留已激活的能力：池子里不再重复列出已加载项，
            // 所以这里必须累加，否则模型没重新点名的那几项会被静默丢掉
            merge?: boolean;
            // 恢复会话时不再落库，否则每次 resume 都多一条相同记录
            persist?: boolean;
        }
    ) {
        const { topic, mode, tools, skills, notify = false, merge = false, persist = true } = opts;
        currentTopic = topic;
        currentMode = mode || "general";
        const requestedSkills = skills.map((s) => s.toLowerCase());
        activeSkills = merge ? new Set([...activeSkills, ...requestedSkills]) : new Set(requestedSkills);
        routingApplied = true;

        // 合并基础工具与模型自选工具
        const keep = merge ? pi.getActiveTools() : [];
        const mergedTools = Array.from(new Set([...keep, ...config.baseTools, ...tools]));
        pi.setActiveTools(mergedTools);
        const extraTools = mergedTools.filter((t) => !config.baseTools.includes(t));

        if (persist) {
            try {
                pi.appendEntry(ENTRY_TYPE_TOPIC, {
                    topic,
                    mode: currentMode,
                    tools: extraTools,
                    skills: Array.from(activeSkills),
                });
            } catch {
                // ignore
            }
        }

        setTerminalTitle(ctx, topic);
        sendHerdrTabRename(topic);

        if (notify) {
            ctx.ui.notify(
                `🎯 [${currentMode}] ${topic}\n激活工具: ${extraTools.join(", ") || "基础集"} | 技能: ${Array.from(activeSkills).join(", ") || "无"}`,
                "info"
            );
        }
    }

    // 1. 会话初始化 (Session Start)
    pi.on("session_start", async (_event, ctx) => {
        const cwd = process.cwd();
        config = loadConfig(cwd);

        currentTopic = undefined;
        currentMode = "general";
        activeSkills.clear();
        shouldInjectInNextPrompt = false;
        expectingTopic = false;
        routingApplied = false;
        routingRetried = false;

        const entries = ctx.sessionManager.getEntries();
        let savedState: any = null;
        let firstUserText = "";
        let userMsgCount = 0;
        let compactionPending = false;

        for (const entry of entries) {
            if (entry.type === "custom" && (entry as any).customType === ENTRY_TYPE_TOPIC) {
                savedState = (entry as any).data;
            } else if (entry.type === "compaction") {
                compactionPending = true;
            } else if (entry.type === "message" && entry.message?.role === "user") {
                userMsgCount++;
                compactionPending = false;
                if (!firstUserText) {
                    firstUserText = extractUserText(entry.message.content);
                }
            }
        }

        if (savedState?.topic) {
            applyTopic(ctx, {
                topic: savedState.topic,
                mode: savedState.mode || "general",
                tools: savedState.tools || [],
                skills: savedState.skills || [],
                persist: false,
            });
            shouldInjectInNextPrompt = compactionPending;
        } else if (userMsgCount === 0) {
            pi.setActiveTools(config.baseTools);
            shouldInjectInNextPrompt = true;
        } else {
            // 有历史但从没路由过（装插件前的旧会话 / 模型一直漏输出）：
            // 只给标题，不动工具和技能 —— 就是普通 pi
            currentTopic = generateFallbackTopic(firstUserText);
            setTerminalTitle(ctx, currentTopic);
            sendHerdrTabRename(currentTopic);
            shouldInjectInNextPrompt = compactionPending;
        }
    });

    // 2. 会话压缩后重新激活路由 (Session Compact)
    pi.on("session_compact", async () => {
        shouldInjectInNextPrompt = true;
    });

    // 3. 用户输入拦截 (Input Hook)
    pi.on("input", async (event, ctx) => {
        if (!event.text) return { action: "continue" };

        if (shouldInjectInNextPrompt) {
            shouldInjectInNextPrompt = false;
            expectingTopic = true;

            const preview = generateFallbackTopic(event.text);
            setTerminalTitle(ctx, preview);
            sendHerdrTabRename(preview);
        }

        return { action: "continue" };
    });

    /**
     * 协议指令的承载位：system prompt。
     * 不能挂在用户消息上 —— 用户消息会永久留在会话历史里，模型每轮都看得见“输出 <topic>”
     * 那条指令，于是从第二轮起持续重复输出。system prompt 是每轮重建的，
     * expectingTopic 一落就自然卸载，历史里不留痕。
     */
    function buildTurnSystemPrompt(basePrompt: string): string {
        if (!expectingTopic) return basePrompt;
        // 池子里只放“还没挂上的”：已加载的工具/system prompt 里已有的技能重复列出，
        // 既浪费 token，也会诱使模型把它们再选一遍（对 tools 而言重复选择是无效动作）
        const activeTools = pi.getActiveTools();
        const extraTools = pi
            .getAllTools()
            .filter((t) => !config.baseTools.includes(t.name) && !activeTools.includes(t.name))
            .map((t) => ({ name: t.name, description: t.description }));
        const availableSkills = knownSkills.filter((s) => !activeSkills.has(s.name.toLowerCase()));
        const instruction = buildRoutingInstruction(extraTools, availableSkills, config.modes);
        return `${basePrompt}\n\n${instruction}`;
    }

    // 4. 发送给大模型前：过滤系统提示词，实现技能按需隔离
    pi.on("before_agent_start", async (event) => {
        knownSkills = parseAvailableSkills(event.systemPrompt);
        // 只在「等待路由」或「路由已落地」时过滤技能。
        // 模型漏输出 <topic> 时两者皆假，原样放行，避免技能整个会话消失且无自愈
        let systemPrompt = buildTurnSystemPrompt(event.systemPrompt);
        if (expectingTopic || routingApplied) {
            systemPrompt = filterSystemPromptSkills(systemPrompt, activeSkills);
        }
        return { systemPrompt };
    });

    // 5. 模型回复结束：解析 XML 并动态调整工具与技能
    // 解析只在「等待路由」时做，且只看 text（thinking 里的是草稿）；剥离则无条件 ——
    // 首轮指令会永久留在上下文里，模型后续轮次仍会照抄输出 <topic>，不剥掉既脏屏，
    // 又让模型从自己的历史里学到「每轮都该输出」，把泄漏自我强化下去。
    pi.on("message_end", async (event, ctx) => {
        if (event.message.role !== "assistant") return;
        if (!Array.isArray(event.message.content)) return;

        let parsedBlock: ParsedTopicBlock | null = null;
        let modified = false;

        const newContent = event.message.content.map((part: any) => {
            if (part.type !== "text" || typeof part.text !== "string") return part;
            if (expectingTopic && !parsedBlock) parsedBlock = parseTopicXml(part.text);
            const stripped = stripTopicXmlFromText(part.text);
            if (stripped === part.text) return part;
            modified = true;
            return { ...part, text: stripped };
        });

        if (parsedBlock) {
            expectingTopic = false;
            const block: ParsedTopicBlock = parsedBlock;
            applyTopic(ctx, {
                topic: block.description ? `[${block.title} - ${block.description}]` : `[${block.title}]`,
                mode: block.mode,
                tools: normalizeTools(block.tools, allToolNames(), config.customToolAliases),
                skills: block.skills,
                notify: true,
                merge: true,
            });
        }

        if (modified) {
            return { message: { ...event.message, content: newContent } };
        }
    });

    // 6. Agent 单轮结束：漏输出 <topic> 时重试一次，再漏就放开全部工具（普通 pi）
    pi.on("agent_end", async () => {
        if (expectingTopic && !routingApplied) {
            if (!routingRetried) {
                routingRetried = true;
                shouldInjectInNextPrompt = true;
            } else {
                pi.setActiveTools(allToolNames());
            }
        }
        expectingTopic = false;
    });

    /**
     * 模式核心调度逻辑（支持 增删改查 与 切换）
     */
    async function handleModeOperation(rawArgs: string, ctx: ExtensionContext) {
        const trimmed = rawArgs.trim();
        const parts = trimmed.split(/\s+/);
        const subCmd = parts[0]?.toLowerCase();
        const rest = parts.slice(1).join(" ").trim();

        // 1. 列 (List): /mode list / /mode ls 或无参数
        if (!trimmed || subCmd === "list" || subCmd === "ls") {
            ctx.ui.notify(formatModeList(config.modes, currentMode), "info");
            return;
        }

        // 2. 初始化 (Init): /mode init [--project]
        if (subCmd === "init") {
            const isProject = rest.includes("--project");
            const cwd = process.cwd();

            if (knownSkills.length === 0) {
                ctx.ui.notify("还没读到技能列表（先随便发一条消息再 init），本次只归纳工具", "warning");
            }
            ctx.ui.notify("🔍 正在归纳环境中的全部工具与技能...", "info");

            const { config: newConfig, aiError } = await synthesizeConfigWithAi(pi.getAllTools(), knownSkills, ctx);
            if (aiError) ctx.ui.notify(`AI 归纳失败，已改用名字启发式：${aiError}`, "warning");
            const savedPath = persistConfig(newConfig, cwd, isProject);
            config = newConfig;
            const modeKeys = Object.keys(newConfig.modes).join(", ");
            ctx.ui.notify(
                `✅ 成功初始化工作模式配置至: ${savedPath}\n可用模式: [${modeKeys}]`,
                "info"
            );
            return;
        }

        // 3. 增 (Add): /mode add <name> <描述> [--tools t1,t2] [--skills s1,s2]
        if (subCmd === "add") {
            const { name, desc, tools, skills } = parseModeArgs(rest);
            if (!name) {
                ctx.ui.notify(
                    "用法: /mode add <name> <描述> [--tools t1,t2] [--skills s1,s2]",
                    "warning"
                );
                return;
            }
            if (config.modes[name]) {
                ctx.ui.notify(`模式 "${name}" 已存在，请使用 /mode edit 修改`, "warning");
                return;
            }
            config.modes[name] = {
                description: desc || "自定义工作模式",
                recommendedTools: tools || [],
                recommendedSkills: skills || [],
            };
            const savedPath = persistConfig(config, process.cwd());
            ctx.ui.notify(`✅ 成功添加模式 [${name}] 并持久化至 ${savedPath}`, "info");
            return;
        }

        // 4. 删 (Del/Remove): /mode del <name>
        if (subCmd === "del" || subCmd === "rm" || subCmd === "delete") {
            const name = rest.trim().toLowerCase();
            if (!name) {
                ctx.ui.notify("用法: /mode del <name>", "warning");
                return;
            }
            if (!config.modes[name]) {
                ctx.ui.notify(`模式 "${name}" 不存在`, "warning");
                return;
            }
            delete config.modes[name];
            const savedPath = persistConfig(config, process.cwd());
            if (currentMode === name) {
                applyTopic(ctx, { topic: currentTopic || "[常规模式]", mode: "general", tools: [], skills: [], notify: true });
            }
            ctx.ui.notify(`✅ 成功删除模式 [${name}] 并持久化至 ${savedPath}`, "info");
            return;
        }

        // 5. 改 (Edit/Modify): /mode edit <name> [新描述] [--tools t1,t2] [--skills s1,s2]
        if (subCmd === "edit" || subCmd === "set" || subCmd === "modify") {
            const { name, desc, tools, skills } = parseModeArgs(rest);
            if (!name) {
                ctx.ui.notify(
                    "用法: /mode edit <name> [新描述] [--tools t1,t2] [--skills s1,s2]",
                    "warning"
                );
                return;
            }
            const existing = config.modes[name];
            if (!existing) {
                ctx.ui.notify(`模式 "${name}" 不存在，可使用 /mode add 创建`, "warning");
                return;
            }
            config.modes[name] = {
                description: desc !== undefined && desc !== "" ? desc : existing.description,
                recommendedTools: tools !== undefined ? tools : existing.recommendedTools,
                recommendedSkills: skills !== undefined ? skills : existing.recommendedSkills,
            };
            const savedPath = persistConfig(config, process.cwd());
            if (currentMode === name) {
                applyTopic(ctx, {
                    topic: currentTopic || `[模式更新 - ${name}]`,
                    mode: name,
                    tools: normalizeTools(config.modes[name].recommendedTools, allToolNames(), config.customToolAliases),
                    skills: config.modes[name].recommendedSkills,
                    notify: true,
                });
            }
            ctx.ui.notify(`✅ 成功修改模式 [${name}] 并持久化至 ${savedPath}`, "info");
            return;
        }

        // 6. 切换 (Switch): /mode <name>
        const modeName = subCmd;
        const modeConfig = config.modes[modeName];
        if (!modeConfig) {
            const available = Object.keys(config.modes).join(", ");
            ctx.ui.notify(`未知模式: "${modeName}". 可用模式: ${available}`, "warning");
            return;
        }

        applyTopic(ctx, {
            topic: currentTopic || `[模式切换 - ${modeName}]`,
            mode: modeName,
            tools: normalizeTools(modeConfig.recommendedTools, allToolNames(), config.customToolAliases),
            skills: modeConfig.recommendedSkills,
            notify: true,
        });
    }

    /**
     * /topic update：无参 → 下一轮让模型重新路由（累加）；
     * 有参 → 就地增删：[标题 - 描述] [--mode m] [--tools +a,-b] [--skills +x,-y]
     */
    function handleTopicUpdate(rawArgs: string, ctx: ExtensionContext) {
        if (!rawArgs) {
            shouldInjectInNextPrompt = true;
            ctx.ui.notify("下一条消息后由模型重新选择主题、模式、工具与技能（在现有基础上累加）", "info");
            return;
        }
        const { positional, mode, tools, skills } = parseModeArgs(rawArgs);
        const currentExtra = pi.getActiveTools().filter((t) => !config.baseTools.includes(t));
        const text = positional.join(" ").trim();
        applyTopic(ctx, {
            topic: text ? bracket(text) : currentTopic || "[未命名]",
            mode: mode || currentMode,
            tools: normalizeTools(patchList(currentExtra, tools), allToolNames(), config.customToolAliases),
            skills: patchList(Array.from(activeSkills), skills?.map((s) => s.toLowerCase())),
            notify: true,
        });
    }

    // 7. 注册 /mode 与 /topic 命令
    const completionEnv = () => ({
        modes: Object.keys(config.modes),
        tools: allToolNames(),
        skills: knownSkills.map((s) => s.name),
    });

    pi.registerCommand("mode", {
        description: "模式管理 (增删改列与切换): /mode [list | add | del | edit | init | <name>]",
        getArgumentCompletions: (prefix) => completeCommandArgs("mode", prefix, completionEnv()),
        handler: async (args, ctx) => {
            await handleModeOperation(args, ctx);
        },
    });

    pi.registerCommand("topic", {
        description: "会话主题与能力: /topic [update [...] | init | mode ... | [标题 - 描述]]",
        getArgumentCompletions: (prefix) => completeCommandArgs("topic", prefix, completionEnv()),
        handler: async (args, ctx) => {
            const trimmed = args.trim();

            if (/^update\b/.test(trimmed)) {
                handleTopicUpdate(trimmed.replace(/^update\s*/, ""), ctx);
                return;
            }

            if (trimmed.startsWith("mode")) {
                const rest = trimmed.replace(/^mode\s*/, "");
                await handleModeOperation(rest, ctx);
                return;
            }

            if (trimmed.startsWith("init")) {
                await handleModeOperation(trimmed, ctx);
                return;
            }

            // 无参: 查看当前状态
            if (!trimmed) {
                const activeToolsList = pi.getActiveTools().join(", ");
                const activeSkillsList = Array.from(activeSkills).join(", ") || "无";
                ctx.ui.notify(
                    `当前主题: ${currentTopic || "未命名"}\n当前模式: ${currentMode}\n激活工具 (${pi.getActiveTools().length}): ${activeToolsList}\n激活技能: ${activeSkillsList}`,
                    "info"
                );
                return;
            }

            // 手动设置主题
            applyTopic(ctx, {
                topic: bracket(trimmed),
                mode: currentMode,
                tools: pi.getActiveTools().filter((t) => !config.baseTools.includes(t)),
                skills: Array.from(activeSkills),
                notify: true,
            });
        },
    });
}
