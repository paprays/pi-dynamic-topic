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
                    // 支持逗号或空格分割
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
- <tools> & <skills>: freely choose ANY tools and skills you need from the full available list below. You can freely mix tools across domains (e.g. choose academic skills in code mode).
- Available Tools Pool: [${availableTools.join(", ")}]
- Available Skills Pool: [${availableSkills.join(", ")}]
- This rule applies to this turn only; do not repeat it in later turns.
`;
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
                    // 剥离 frontmatter
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

        if (notify && ctx) {
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
            // 恢复历史能力状态
            applyTopic(
                savedState.topic,
                savedState.mode || "general",
                savedState.tools || [],
                savedState.skills || [],
                false,
                ctx
            );
        } else if (userMsgCount === 0) {
            // 全新冷启动：仅激活 baseTools，并标记首轮注入
            pi.setActiveTools(config.baseTools);
            shouldInjectInNextPrompt = true;
        } else {
            // 有对话但未保存过状态：兜底生成
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
            expectingTopic = true; // 开启状态锁

            const preview = generateFallbackTopic(event.text);
            setTerminalTitle(preview);
            sendHerdrTabRename(preview);

            // 获取全部注册工具与发现的全部技能
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

        // 如果有激活技能的详细说明，追加到系统提示词尾部
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
                expectingTopic = false; // 成功捕获，立即解锁

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

                const allTools = pi.getAllTools().map((t) => t.name);
                const allSkills = Array.from(discoveredSkillsMap.values()).map((s) => s.name);

                // 启发式分类模式
                const newConfig: DynamicTopicConfig = {
                    version: 1,
                    baseTools: config.baseTools,
                    modes: {
                        code: {
                            description: "编程开发、代码分析、排错与底层调试",
                            recommendedTools: allTools.filter((t) =>
                                /gdb|lsp|ast|nu|interactive_shell|diff|edit|write/i.test(t)
                            ),
                            recommendedSkills: allSkills.filter((s) =>
                                /ponytail|karpathy|code|git|dev|audit/i.test(s)
                            ),
                        },
                        academic: {
                            description: "学术研究、论文阅读/写作与文献调研",
                            recommendedTools: allTools.filter((t) =>
                                /source_check|search|fetch|paper/i.test(t)
                            ),
                            recommendedSkills: allSkills.filter((s) =>
                                /academic|paper|research|thesis|pipeline/i.test(s)
                            ),
                        },
                        ops: {
                            description: "系统管理、网络与自动化运维",
                            recommendedTools: allTools.filter((t) =>
                                /interactive_shell|nu|bash|ssh|docker|k8s/i.test(t)
                            ),
                            recommendedSkills: allSkills.filter((s) =>
                                /ctf|ops|network|sys|orchestrator/i.test(s)
                            ),
                        },
                        general: {
                            description: "日常问答、文档撰写、资料收集与轻量交互",
                            recommendedTools: [],
                            recommendedSkills: [],
                        },
                    },
                    customToolAliases: {
                        gdb: allTools.find((t) => t.includes("gdb")) || "gdb-mcp_open",
                        lsp: allTools.find((t) => t.includes("lsp")) || "lsp_diagnostics",
                        ast: allTools.find((t) => t.includes("ast")) || "ast_search",
                        shell: allTools.find((t) => t.includes("interactive")) || "interactive_shell",
                    },
                };

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
                    ctx.ui.notify(`✅ 成功初始化配置至: ${targetFile}`, "success");
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
        description: "切换或查看模式: /mode [code | academic | ops | general]",
        handler: async (args, ctx) => {
            if (!args.trim()) {
                const available = Object.entries(config.modes)
                    .map(([k, v]) => `• ${k}: ${v.description}`)
                    .join("\n");
                ctx.ui.notify(`当前模式: ${currentMode}\n可用模式列表:\n${available}`, "info");
                return;
            }
            // 代理到 /topic mode
            const topicCmd = (pi as any).getCommands?.()?.find?.((c: any) => c.name === "topic");
            if (topicCmd) {
                topicCmd.handler(`mode ${args.trim()}`, ctx);
            }
        },
    });
}
