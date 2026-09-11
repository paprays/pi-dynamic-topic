import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DOMParser } from "@xmldom/xmldom";

const HERDR_ENV = process.env.HERDR_ENV;
const socketPath = process.env.HERDR_SOCKET_PATH;
const socketEndpoint =
    process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
const tabId = process.env.HERDR_TAB_ID;

const ENTRY_TYPE_TOPIC = "dynamic-topic-state";

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
        process.stdout.write(`\x1b]0;${title}\x07`);
    }
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
    const clean = text
        .replace(/\s+/g, " ")
        .replace(/^[\s\p{P}]+/u, "")
        .trim();

    if (!clean || clean.length <= 2) return "新对话";

    const splitMatch = clean.match(/^([^，,。！？!?；;\n]+)[，,。！？!?；;\n]\s*(.*)$/);
    if (splitMatch) {
        const title = splitMatch[1].trim().slice(0, 10);
        const desc = splitMatch[2].trim().slice(0, 25) || clean.slice(0, 25);
        return `[${title} - ${desc}]`;
    }

    const title = clean.slice(0, 8);
    const desc = clean.slice(0, 24);
    return `[${title} - ${desc}]`;
}

/**
 * 解析用户配置，项目级优先，回退到全局或默认值
 */
export function loadConfig(cwd: string): DynamicTopicConfig {
    const projectPath = path.join(cwd, ".pi", "extension-settings", "dynamic-topic.json");
    if (fs.existsSync(projectPath)) {
        try {
            return JSON.parse(fs.readFileSync(projectPath, "utf-8"));
        } catch {
            // ignore
        }
    }

    const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    const globalPath = path.join(agentDir, "extension-settings", "dynamic-topic.json");
    if (fs.existsSync(globalPath)) {
        try {
            return JSON.parse(fs.readFileSync(globalPath, "utf-8"));
        } catch {
            // ignore
        }
    }

    return DEFAULT_CONFIG;
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
                const fmLines = fmMatch[1].split("\n");
                for (const line of fmLines) {
                    const colonIdx = line.indexOf(":");
                    if (colonIdx > 0) {
                        const key = line.slice(0, colonIdx).trim();
                        const val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
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
 * 使用 W3C DOMParser 标准解析 <topic> 结构
 */
export function parseTopicXml(text: string): ParsedTopicBlock | null {
    if (!text) return null;
    const match = text.match(/<topic[\s\S]*?<\/topic>/i);
    if (!match) return null;

    const rawBlock = match[0];
    try {
        const parser = new DOMParser({
            onError: () => {},
        } as any);
        const doc = parser.parseFromString(rawBlock, "text/xml");

        const getFirstText = (tag: string) =>
            doc.getElementsByTagName(tag)[0]?.textContent?.trim() || "";

        const getAllTexts = (tag: string) => {
            const nodes = doc.getElementsByTagName(tag);
            const results: string[] = [];
            for (let i = 0; i < nodes.length; i++) {
                const val = nodes[i].textContent?.trim();
                if (val) {
                    for (const sub of val.split(/[\s,]+/)) {
                        if (sub.trim()) results.push(sub.trim());
                    }
                }
            }
            return results;
        };

        const title = getFirstText("title").replace(/^\[|\]$/g, "").trim();
        const description = getFirstText("description").replace(/^\[|\]$/g, "").trim();
        const mode = getFirstText("mode").trim() || "general";

        let tools = getAllTexts("tool");
        if (tools.length === 0) {
            const toolsContainer = getFirstText("tools");
            if (toolsContainer) {
                tools = toolsContainer.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
            }
        }

        let skills = getAllTexts("skill");
        if (skills.length === 0) {
            const skillsContainer = getFirstText("skills");
            if (skillsContainer) {
                skills = skillsContainer.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
            }
        }

        return {
            title,
            description,
            mode,
            tools,
            skills,
            rawBlock,
        };
    } catch {
        return null;
    }
}

/**
 * 从回复文本中剥离 XML 标签
 */
export function stripTopicXmlFromText(text: string): string {
    if (!text) return "";
    return text
        .replace(/<topic[\s\S]*?<\/topic>/gi, "")
        .replace(/<title>[\s\S]*?<\/title>/gi, "")
        .replace(/<description>[\s\S]*?<\/description>/gi, "")
        .replace(/<mode>[\s\S]*?<\/mode>/gi, "")
        .replace(/<tools>[\s\S]*?<\/tools>/gi, "")
        .replace(/<skills>[\s\S]*?<\/skills>/gi, "")
        .trimEnd();
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

        // 3. 后缀/前缀/模糊包含匹配
        const fuzzy = allToolsLower.find(
            (t) =>
                t.lower.endsWith(`_${targetLower}`) ||
                t.lower.endsWith(`-${targetLower}`) ||
                t.lower.startsWith(`${targetLower}_`) ||
                t.lower.startsWith(`${targetLower}-`) ||
                t.lower.includes(targetLower)
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
 * 构造首轮注入给 User Prompt 的协议指令
 */
export function buildRoutingInstruction(availableTools: string[], availableSkills: string[]): string {
    return `
[Session Topic & Capability Routing (this turn ONLY)]
At the very end of your final answer, on a new line, output:
<topic>
  <title>2-6 Chinese characters, short</title>
  <description>10-25 Chinese characters, the core task or question</description>
  <mode>code | academic | ppt | ops | general | custom</mode>
  <tools>
    <tool>tool_name</tool>
  </tools>
  <skills>
    <skill>skill_name</skill>
  </skills>
</topic>
Rules:
- <title> & <description>: summarize current session in Chinese.
- <mode>: broad intent category for mental focus (e.g. code, academic, ppt, ops, general).
- <tools> & <skills>: freely choose ANY tools and skills you need from the full available list below. You can freely mix tools across domains.
- Available Tools Pool: [${availableTools.join(", ")}]
- Available Skills Pool: [${availableSkills.join(", ")}]
- This rule applies to this turn only; do not repeat it in later turns.
`;
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

    // 如果运行在活跃会话环境中且有模型注册器与默认模型，通过大模型进行深度语义归纳
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
    let config: DynamicTopicConfig = DEFAULT_CONFIG;
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
        ctx?: ExtensionContext
    ) {
        currentTopic = topic;
        currentMode = mode || "general";
        activeSkills = new Set(skills.map((s) => s.toLowerCase()));
        activeSkillInstructions = loadSkillInstructions(skills);

        // 合并基础工具与模型自选工具
        const mergedTools = Array.from(new Set([...config.baseTools, ...tools]));
        pi.setActiveTools(mergedTools);

        // 持久化到 Session 自定义 Entry
        try {
            pi.appendEntry(ENTRY_TYPE_TOPIC, {
                topic,
                mode: currentMode,
                tools,
                skills,
            });
        } catch {
            // ignore
        }

        setTerminalTitle(topic);
        sendHerdrTabRename(topic);

        if (notify && ctx?.ui) {
            ctx.ui.notify(
                `🎯 [${currentMode}] ${topic}\n激活工具: ${tools.join(", ") || "基础集"} | 技能: ${skills.join(", ") || "无"}`,
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

        const entries = ctx.sessionManager.getEntries();
        let savedState: any = null;
        let firstUserText = "";
        let userMsgCount = 0;

        for (const entry of entries) {
            if (entry.type === "custom" && (entry as any).customType === ENTRY_TYPE_TOPIC) {
                savedState = (entry as any).data;
            } else if (entry.type === "message" && entry.message?.role === "user") {
                userMsgCount++;
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
        } else if (userMsgCount === 0) {
            pi.setActiveTools(config.baseTools);
            shouldInjectInNextPrompt = true;
        } else {
            const fallback = generateFallbackTopic(firstUserText);
            applyTopic(fallback, "general", [], [], false, ctx);
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

            const allTools = pi.getAllTools().map((t) => t.name);
            const nonBaseTools = allTools.filter((t) => !config.baseTools.includes(t));
            const availableSkills = Array.from(discoveredSkillsMap.values()).map((s) => s.name);

            const instruction = buildRoutingInstruction(
                nonBaseTools.length > 0 ? nonBaseTools : allTools,
                availableSkills
            );

            return {
                action: "transform",
                text: `${event.text}\n\n${instruction}`,
            };
        }

        return { action: "continue" };
    });

    // 4. 发送给大模型前：过滤系统提示词，实现技能按需隔离注入
    pi.on("before_agent_start", async (event) => {
        let systemPrompt = filterSystemPromptSkills(event.systemPrompt, activeSkills);

        if (activeSkillInstructions.length > 0) {
            systemPrompt = `${systemPrompt}\n\n## Activated Skills Instructions\n${activeSkillInstructions.join("\n\n")}`;
        }

        return { systemPrompt };
    });

    // 5. 模型回复结束：解析 XML 并动态调整工具与技能
    pi.on("message_end", async (event, ctx) => {
        if (!expectingTopic || event.message.role !== "assistant") return;

        let parsedBlock: ParsedTopicBlock | null = null;
        let modified = false;

        if (Array.isArray(event.message.content)) {
            for (const part of event.message.content) {
                if (
                    (part.type === "text" || part.type === "thinking") &&
                    typeof (part.text || part.thinking) === "string"
                ) {
                    const raw = part.text || part.thinking || "";
                    if (!parsedBlock) {
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
                    ctx
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

    // 7. 注册 /topic 与 /mode 命令
    pi.registerCommand("topic", {
        description: "查看、切换模式或初始化配置: /topic [init | mode <name> | [标题 - 描述]]",
        handler: async (args, ctx) => {
            const trimmed = args.trim();

            // 子命令: /topic init [--project]
            if (trimmed.startsWith("init")) {
                const isProject = trimmed.includes("--project");
                const cwd = process.cwd();
                refreshDiscoveredSkills(cwd);

                ctx.ui.notify("🔍 正在扫描环境中的全部工具与技能，并由 AI 智能归纳模式...", "info");

                const allTools = pi.getAllTools();
                const allSkills = Array.from(discoveredSkillsMap.values());

                // 调用 AI 模型进行多模式归纳
                const newConfig = await synthesizeConfigWithAi(allTools, allSkills, ctx);

                const targetDir = isProject
                    ? path.join(cwd, ".pi", "extension-settings")
                    : path.join(
                          process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
                          "extension-settings"
                      );
                const targetFile = path.join(targetDir, "dynamic-topic.json");

                try {
                    fs.mkdirSync(targetDir, { recursive: true });
                    if (fs.existsSync(targetFile)) {
                        fs.copyFileSync(targetFile, `${targetFile}.bak`);
                    }
                    fs.writeFileSync(targetFile, JSON.stringify(newConfig, null, 2), "utf-8");
                    config = newConfig;
                    const modeKeys = Object.keys(newConfig.modes).join(", ");
                    ctx.ui.notify(
                        `✅ AI 成功初始化模式配置至: ${targetFile}\n可用模式: [${modeKeys}]`,
                        "success"
                    );
                } catch (err: any) {
                    ctx.ui.notify(`❌ 写入配置失败: ${err.message}`, "error");
                }
                return;
            }

            // 子命令: /topic mode <name>
            if (trimmed.startsWith("mode")) {
                const modeName = trimmed.replace(/^mode\s*/, "").trim().toLowerCase();
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

    pi.registerCommand("mode", {
        description: "切换或初始化模式: /mode [code | academic | ppt | ops | general | init]",
        handler: async (args, ctx) => {
            const trimmed = args.trim();
            if (trimmed.startsWith("init")) {
                const topicCmd = (pi as any).getCommands?.()?.find?.((c: any) => c.name === "topic");
                if (topicCmd) {
                    return topicCmd.handler(trimmed, ctx);
                }
            }

            if (!trimmed) {
                const available = Object.entries(config.modes)
                    .map(([k, v]) => `• ${k}: ${v.description}`)
                    .join("\n");
                ctx.ui.notify(`当前模式: ${currentMode}\n可用模式列表:\n${available}`, "info");
                return;
            }

            const topicCmd = (pi as any).getCommands?.()?.find?.((c: any) => c.name === "topic");
            if (topicCmd) {
                topicCmd.handler(`mode ${trimmed}`, ctx);
            }
        },
    });
}
