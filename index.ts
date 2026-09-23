import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

export interface DiscoveredSkill {
    name: string;
    description: string;
    filePath: string;
}

/**
 * 设置终端窗口标题 (OSC 0 / OSC 2)
 */
export function setTerminalTitle(title: string) {
    if (process.stdout.isTTY) {
        // 标题来自模型输出，必须剥掉控制字符，否则等于把 OSC 转义序列的控制权交给模型
        process.stdout.write(`\x1b]0;${sanitizeTitle(title)}\x07`);
    }
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

/**
 * 递归扫描技能文件（深度限制在4层以内以保证性能）
 */
export function discoverSkills(dirs: string[], depthLimit = 4): Map<string, DiscoveredSkill> {
    const skills = new Map<string, DiscoveredSkill>();

    function scan(dir: string, currentDepth: number) {
        if (!fs.existsSync(dir) || currentDepth > depthLimit) return;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name === ".git" || (entry.name === "node_modules" && currentDepth > 0)) continue;
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    const skillMd = path.join(fullPath, "SKILL.md");
                    if (fs.existsSync(skillMd)) {
                        parseSkillFile(skillMd, entry.name);
                    } else {
                        scan(fullPath, currentDepth + 1);
                    }
                }
            }
        } catch {
            // ignore
        }
    }

    function parseSkillFile(filePath: string, fallbackName: string) {
        try {
            const content = fs.readFileSync(filePath, "utf-8");
            let name = fallbackName;
            let description = "";
            const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
            if (fmMatch) {
                const fmLines = fmMatch[1].split(/\r?\n/);
                for (let i = 0; i < fmLines.length; i++) {
                    const line = fmLines[i];
                    const colonIdx = line.indexOf(":");
                    // 缩进行是上一个键的续行，不是新键
                    if (colonIdx > 0 && !/^\s/.test(line)) {
                        const key = line.slice(0, colonIdx).trim();
                        let val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
                        // ponytail: 只认 YAML 块标量 `>` / `|`，折成一行；完整 YAML 等真遇到再上解析器
                        if (/^[>|][+-]?$/.test(val)) {
                            const body: string[] = [];
                            while (i + 1 < fmLines.length && /^(\s|$)/.test(fmLines[i + 1])) body.push(fmLines[++i].trim());
                            val = body.filter(Boolean).join(" ");
                        }
                        if (key === "name" && val) name = val;
                        if (key === "description" && val) description = val;
                    }
                }
            }
            skills.set(name.toLowerCase(), { name, description, filePath });
        } catch {
            // ignore
        }
    }

    for (const d of dirs) {
        scan(d, 0);
    }

    return skills;
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
 * 过滤并精简系统提示词中的技能列表，实现冷启动绝对隔离
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
 * 构造首轮注入给 User Prompt 的协议指令
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
- Output it exactly once, in the first assistant reply of this session. This instruction is not repeated, so never emit <topic> again.
`;
}

/**
 * 解析模式参数支持 --tools, --skills, --desc
 * 按 token 切分而非正则抠取：工具名/技能名里的连字符必须原样保留
 */
export function parseModeArgs(rawArgs: string) {
    const tokens = rawArgs.trim().match(/"[^"]*"|'[^']*'|\S+/g) || [];
    const unquote = (s: string) => s.replace(/^["']|["']$/g, "");
    const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

    let tools: string[] | undefined;
    let skills: string[] | undefined;
    let desc: string | undefined;
    const positional: string[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === "--tools" || t === "-t") tools = split(unquote(tokens[++i] || ""));
        else if (t === "--skills" || t === "-s") skills = split(unquote(tokens[++i] || ""));
        else if (t === "--desc" || t === "-d") desc = unquote(tokens[++i] || "");
        else positional.push(unquote(t));
    }

    const name = positional[0]?.toLowerCase();
    if (!desc && positional.length > 1) {
        desc = positional.slice(1).join(" ");
    }

    return { name, desc, tools, skills };
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
 * 结合 AI 模型或启发式规则，自动分析环境并归纳生成模式配置
 */
export async function synthesizeConfigWithAi(
    allTools: { name: string; description?: string }[],
    allSkills: { name: string; description?: string }[],
    ctx?: ExtensionContext
): Promise<DynamicTopicConfig> {
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

    if (ctx?.modelRegistry && ctx?.model) {
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

            const response = await ctx.modelRegistry.complete(
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
                }
            );

            const contentText = response.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("\n");

            const jsonMatch = contentText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.modes && typeof parsed.modes === "object") {
                    return {
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
                    };
                }
            }
        } catch {
            // AI 请求失败或被取消时安全回退至启发式生成
        }
    }

    return heuristicConfig;
}

export default function (pi: ExtensionAPI) {
    let currentTopic: string | undefined;
    let currentMode: string = "general";
    let activeSkills = new Set<string>();
    let activeSkillInstructions: string[] = [];
    let shouldInjectInNextPrompt = false;
    let expectingTopic = false;
    // 路由是否真的落过地。模型漏输出 <topic> 时必须放行全部技能，否则整个会话静默失能
    let routingApplied = false;
    let config: DynamicTopicConfig = coerceConfig(DEFAULT_CONFIG);
    let discoveredSkillsMap = new Map<string, DiscoveredSkill>();

    function refreshDiscoveredSkills(cwd: string) {
        const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
        const dirs = [
            path.join(agentDir, "skills"),
            path.join(os.homedir(), ".agents", "skills"),
            path.join(cwd, ".pi", "skills"),
            path.join(cwd, ".agents", "skills"),
            path.join(agentDir, "git"),
            path.join(agentDir, "npm", "node_modules"),
        ];
        discoveredSkillsMap = discoverSkills(dirs);
    }

    function loadSkillInstructions(skillsList: string[]): string[] {
        const instructions: string[] = [];
        for (const s of skillsList) {
            const entry = discoveredSkillsMap.get(s.toLowerCase());
            if (entry) {
                try {
                    const content = fs.readFileSync(entry.filePath, "utf-8");
                    const clean = content.replace(/^---\r?\n[\s\S]*?\r?\n---/, "").trim();
                    instructions.push(`### Skill: ${entry.name}\n${clean}`);
                } catch {
                    // ignore
                }
            }
        }
        return instructions;
    }

    function applyTopic(
        topic: string,
        mode: string,
        tools: string[],
        skills: string[],
        notify = false,
        ctx?: ExtensionContext,
        // 模型改选时是否保留已激活的能力：池子里不再重复列出已加载项，
        // 所以这里必须累加，否则模型没重新点名的那几项会被静默丢掉
        mergeActive = false
    ) {
        currentTopic = topic;
        currentMode = mode || "general";
        const requestedSkills = skills.map((s) => s.toLowerCase());
        activeSkills = mergeActive
            ? new Set([...activeSkills, ...requestedSkills])
            : new Set(requestedSkills);
        activeSkillInstructions = loadSkillInstructions(Array.from(activeSkills));
        routingApplied = true;

        // 合并基础工具与模型自选工具
        const keep = mergeActive ? pi.getActiveTools() : [];
        const mergedTools = Array.from(new Set([...keep, ...config.baseTools, ...tools]));
        pi.setActiveTools(mergedTools);

        // 持久化到 Session 自定义 Entry
        try {
            pi.appendEntry(ENTRY_TYPE_TOPIC, {
                topic,
                mode: currentMode,
                tools: mergedTools.filter((t) => !config.baseTools.includes(t)),
                skills: Array.from(activeSkills),
            });
        } catch {
            // ignore
        }

        setTerminalTitle(topic);
        sendHerdrTabRename(topic);

        if (notify && ctx?.ui) {
            ctx.ui.notify(
                `🎯 [${currentMode}] ${topic}\n激活工具: ${mergedTools.filter((t) => !config.baseTools.includes(t)).join(", ") || "基础集"} | 技能: ${Array.from(activeSkills).join(", ") || "无"}`,
                "info"
            );
        }
    }

    // 1. 会话初始化 (Session Start)
    pi.on("session_start", async (_event, ctx) => {
        const cwd = process.cwd();
        config = loadConfig(cwd);
        refreshDiscoveredSkills(cwd);

        currentTopic = undefined;
        currentMode = "general";
        activeSkills.clear();
        activeSkillInstructions = [];
        shouldInjectInNextPrompt = false;
        expectingTopic = false;
        routingApplied = false;

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
            applyTopic(
                savedState.topic,
                savedState.mode || "general",
                savedState.tools || [],
                savedState.skills || [],
                false,
                ctx
            );
            shouldInjectInNextPrompt = compactionPending;
        } else if (userMsgCount === 0) {
            pi.setActiveTools(config.baseTools);
            shouldInjectInNextPrompt = true;
        } else {
            const fallback = generateFallbackTopic(firstUserText);
            applyTopic(fallback, "general", [], [], false, ctx);
            shouldInjectInNextPrompt = compactionPending;
        }
    });

    // 2. 会话压缩后重新激活路由 (Session Compact)
    pi.on("session_compact", async () => {
        shouldInjectInNextPrompt = true;
    });

    // 3. 用户输入拦截 (Input Hook)
    pi.on("input", async (event) => {
        if (!event.text) return { action: "continue" };

        if (shouldInjectInNextPrompt) {
            shouldInjectInNextPrompt = false;
            expectingTopic = true;

            const preview = generateFallbackTopic(event.text);
            setTerminalTitle(preview);
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
        const availableSkills = Array.from(discoveredSkillsMap.values())
            .filter((s) => !activeSkills.has(s.name.toLowerCase()))
            .map((s) => ({ name: s.name, description: s.description }));
        const instruction = buildRoutingInstruction(extraTools, availableSkills, config.modes);
        return `${basePrompt}\n\n${instruction}`;
    }

    // 4. 发送给大模型前：过滤系统提示词，实现技能按需隔离注入
    pi.on("before_agent_start", async (event) => {
        // 只在「等待路由」或「路由已落地」时过滤技能。
        // 模型漏输出 <topic> 时两者皆假，原样放行，避免技能整个会话消失且无自愈
        let systemPrompt = buildTurnSystemPrompt(event.systemPrompt);
        if (expectingTopic || routingApplied) {
            systemPrompt = filterSystemPromptSkills(systemPrompt, activeSkills);
        }

        if (activeSkillInstructions.length > 0) {
            systemPrompt = `${systemPrompt}\n\n## Activated Skills Instructions\n${activeSkillInstructions.join("\n\n")}`;
        }

        return { systemPrompt };
    });

    // 5. 模型回复结束：解析 XML 并动态调整工具与技能
    // 解析只在「等待路由」时做；剥离则无条件 —— 首轮指令会永久留在上下文里，
    // 模型后续轮次仍会照抄输出 <topic>，不剥掉既脏屏，又让模型从自己的历史里
    // 学到「每轮都该输出」，把泄漏自我强化下去。
    pi.on("message_end", async (event, ctx) => {
        if (event.message.role !== "assistant") return;

        let parsedBlock: ParsedTopicBlock | null = null;
        let modified = false;

        if (Array.isArray(event.message.content)) {
            for (const part of event.message.content) {
                if (
                    (part.type === "text" || part.type === "thinking") &&
                    typeof (part.text || part.thinking) === "string"
                ) {
                    const raw = part.text || part.thinking || "";
                    if (expectingTopic && !parsedBlock) {
                        parsedBlock = parseTopicXml(raw);
                    }
                }
            }

            const newContent = event.message.content.map((part: any) => {
                if (part.type === "text" && typeof part.text === "string") {
                    const stripped = stripTopicXmlFromText(part.text);
                    if (stripped !== part.text) {
                        modified = true;
                        return { ...part, text: stripped };
                    }
                }
                return part;
            });

            if (parsedBlock) {
                expectingTopic = false;

                const allRegisteredTools = pi.getAllTools().map((t) => t.name);
                const normalizedTools = normalizeTools(
                    parsedBlock.tools,
                    allRegisteredTools,
                    config.customToolAliases
                );

                const topicStr = parsedBlock.description
                    ? `[${parsedBlock.title} - ${parsedBlock.description}]`
                    : `[${parsedBlock.title}]`;

                applyTopic(
                    topicStr,
                    parsedBlock.mode,
                    normalizedTools,
                    parsedBlock.skills,
                    true,
                    ctx,
                    true
                );
            }

            if (modified) {
                return {
                    message: {
                        ...event.message,
                        content: newContent,
                    },
                };
            }
        }
    });

    // 6. Agent 单轮结束重置锁
    pi.on("agent_end", async () => {
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
            refreshDiscoveredSkills(cwd);

            ctx.ui.notify("🔍 正在扫描环境中的全部工具与技能，并由 AI 智能归纳模式...", "info");

            const allTools = pi.getAllTools();
            const allSkills = Array.from(discoveredSkillsMap.values());

            const newConfig = await synthesizeConfigWithAi(allTools, allSkills, ctx);
            const savedPath = persistConfig(newConfig, cwd, isProject);
            config = newConfig;
            const modeKeys = Object.keys(newConfig.modes).join(", ");
            ctx.ui.notify(
                `✅ 成功初始化工作模式配置至: ${savedPath}\n可用模式: [${modeKeys}]`,
                "success"
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
            ctx.ui.notify(`✅ 成功添加模式 [${name}] 并持久化至 ${savedPath}`, "success");
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
                applyTopic(currentTopic || "[常规模式]", "general", [], [], true, ctx);
            }
            ctx.ui.notify(`✅ 成功删除模式 [${name}] 并持久化至 ${savedPath}`, "success");
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
                const allTools = pi.getAllTools().map((t) => t.name);
                const normalized = normalizeTools(
                    config.modes[name].recommendedTools,
                    allTools,
                    config.customToolAliases
                );
                applyTopic(
                    currentTopic || `[模式更新 - ${name}]`,
                    name,
                    normalized,
                    config.modes[name].recommendedSkills,
                    true,
                    ctx
                );
            }
            ctx.ui.notify(`✅ 成功修改模式 [${name}] 并持久化至 ${savedPath}`, "success");
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

        const allTools = pi.getAllTools().map((t) => t.name);
        const normalized = normalizeTools(
            modeConfig.recommendedTools,
            allTools,
            config.customToolAliases
        );
        applyTopic(
            currentTopic || `[模式切换 - ${modeName}]`,
            modeName,
            normalized,
            modeConfig.recommendedSkills,
            true,
            ctx
        );
    }

    // 7. 注册 /mode 与 /topic 命令
    pi.registerCommand("mode", {
        description: "模式管理 (增删改列与切换): /mode [list | add | del | edit | init | <name>]",
        handler: async (args, ctx) => {
            await handleModeOperation(args, ctx);
        },
    });

    pi.registerCommand("topic", {
        description: "会话主题与模式管理: /topic [init | mode ... | [标题 - 描述]]",
        handler: async (args, ctx) => {
            const trimmed = args.trim();

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
            let newTopic = trimmed;
            if (!newTopic.startsWith("[") || !newTopic.endsWith("]")) {
                newTopic = `[${newTopic}]`;
            }
            const currentNonBase = pi.getActiveTools().filter((t) => !config.baseTools.includes(t));
            applyTopic(
                newTopic,
                currentMode,
                currentNonBase,
                Array.from(activeSkills),
                true,
                ctx
            );
        },
    });
}
