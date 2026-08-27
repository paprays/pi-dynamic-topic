import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import net from "node:net";

const HERDR_ENV = process.env.HERDR_ENV;
const socketPath = process.env.HERDR_SOCKET_PATH;
const socketEndpoint =
    process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
const tabId = process.env.HERDR_TAB_ID;

const ENTRY_TYPE_TOPIC = "dynamic-topic-state";

const TOPIC_USER_PROMPT_INSTRUCTION = `

【会话主题命名要求（仅本轮有效）】
在本次回答的最终文本内容末尾，请另起一行，必须输出以下结构化 XML 标签总结当前会话主题：
<topic>
  <title>2~6个字的短标题</title>
  <description>10~25个字的任务或问题核心描述</description>
</topic>
说明：
- <title> 提取核心领域或动作（如：Kitty配置、Herdr导航、快速排序等）。
- <description> 提取具体场景或目标。
`;

/**
 * 设置终端窗口标题 (OSC 0 / OSC 2)
 */
function setTerminalTitle(title: string) {
    if (process.stdout.isTTY) {
        process.stdout.write(`\x1b]0;${title}\x07`);
    }
}

/**
 * 如果在 Herdr 环境中运行，通过 Herdr socket 同步更新 Tab 标题
 */
function sendHerdrTabRename(label: string): void {
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
function extractUserText(content: unknown): string {
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
function generateFallbackTopic(text: string): string {
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
 * 从结构化 XML <topic><title>...</title><description>...</description></topic> 标签中解析主题
 */
function extractTopicFromXml(text: string): string | null {
    if (!text) return null;

    const topicBlockMatch = text.match(/<topic>([\s\S]*?)<\/topic>/i);
    const targetText = topicBlockMatch ? topicBlockMatch[1] : text;

    const titleMatch = targetText.match(/<title>([\s\S]*?)<\/title>/i);
    const descMatch = targetText.match(/<description>([\s\S]*?)<\/description>/i);

    if (titleMatch && descMatch) {
        const title = titleMatch[1].trim().replace(/^\[|\]$/g, "");
        const desc = descMatch[1].trim().replace(/^\[|\]$/g, "");
        if (title && desc) {
            return `[${title} - ${desc}]`;
        }
    } else if (titleMatch) {
        const title = titleMatch[1].trim().replace(/^\[|\]$/g, "");
        if (title) {
            return `[${title}]`;
        }
    } else if (topicBlockMatch && !titleMatch && !descMatch) {
        const rawTopic = topicBlockMatch[1].trim().replace(/^\[|\]$/g, "");
        if (rawTopic) {
            return `[${rawTopic}]`;
        }
    }

    return null;
}

/**
 * 剥离文本中的 <topic> 标签，保持对用户的回复干净
 */
function stripTopicXmlFromText(text: string): string {
    return text
        .replace(/<topic>[\s\S]*?<\/topic>/gi, "")
        .replace(/<title>[\s\S]*?<\/title>/gi, "")
        .replace(/<description>[\s\S]*?<\/description>/gi, "")
        .trimEnd();
}

export default function (pi: ExtensionAPI) {
    let currentTopic: string | undefined;
    let shouldInjectInNextPrompt = false;
    let expectingTopic = false;

    function applyTopic(topic: string, notify = false, ctx?: ExtensionContext) {
        currentTopic = topic;

        // 持久化到 Session 记录中（自定义 Entry）
        try {
            pi.appendEntry(ENTRY_TYPE_TOPIC, { topic });
        } catch {
            // ignore
        }

        setTerminalTitle(topic);
        sendHerdrTabRename(topic);
        if (notify && ctx) {
            ctx.ui.notify(`会话主题已更新为: ${topic}`, "info");
        }
    }

    // 1. 会话初始化：检查历史持久化记录
    pi.on("session_start", async (_event, ctx) => {
        currentTopic = undefined;
        shouldInjectInNextPrompt = false;
        expectingTopic = false;

        const entries = ctx.sessionManager.getEntries();
        let firstUserText = "";
        let userMsgCount = 0;

        for (const entry of entries) {
            if (entry.type === "custom" && (entry as any).customType === ENTRY_TYPE_TOPIC) {
                const savedTopic = (entry as any).data?.topic;
                if (savedTopic) {
                    currentTopic = savedTopic;
                }
            } else if (entry.type === "message" && entry.message?.role === "user") {
                userMsgCount++;
                if (!firstUserText) {
                    firstUserText = extractUserText(entry.message.content);
                }
            }
        }

        if (currentTopic) {
            setTerminalTitle(currentTopic);
            sendHerdrTabRename(currentTopic);
        } else if (userMsgCount === 0) {
            // 全新会话：准备在第一轮时注入
            shouldInjectInNextPrompt = true;
        } else if (firstUserText) {
            // 有历史对话但未存过 topic，生成 fallback 兜底，且后续对话不乱注入
            const fallback = generateFallbackTopic(firstUserText);
            applyTopic(fallback);
        }
    });

    // 2. 发生 Compact：标记下一次用户输入时重新提取主题
    pi.on("session_compact", async () => {
        shouldInjectInNextPrompt = true;
    });

    // 3. 用户输入拦截：仅在启动首句或 Compact 后的首句附加指令到 User Prompt 中
    pi.on("input", async (event) => {
        if (!event.text) return { action: "continue" };

        if (shouldInjectInNextPrompt) {
            shouldInjectInNextPrompt = false;
            expectingTopic = true; // 开启状态锁，仅等待本轮 AI 回复中的 topic

            // 即时预览
            const preview = generateFallbackTopic(event.text);
            setTerminalTitle(preview);
            sendHerdrTabRename(preview);

            return {
                action: "transform",
                text: `${event.text}\n\n${TOPIC_USER_PROMPT_INSTRUCTION}`,
            };
        }

        return { action: "continue" };
    });

    // 4. AI 回复结束：仅在开启 expectingTopic 状态锁时才解析主题并清理 XML
    pi.on("message_end", async (event, ctx) => {
        if (!expectingTopic || event.message.role !== "assistant") return;

        let foundTopic: string | null = null;
        let modified = false;

        if (Array.isArray(event.message.content)) {
            for (const part of event.message.content) {
                if ((part.type === "text" || part.type === "thinking") && typeof (part.text || part.thinking) === "string") {
                    const raw = part.text || part.thinking || "";
                    if (!foundTopic) {
                        foundTopic = extractTopicFromXml(raw);
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

            if (foundTopic) {
                expectingTopic = false; // 成功捕获，立即关锁
                applyTopic(foundTopic, true, ctx);
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

    // 5. Agent 本轮完全结束时，确保状态锁关闭
    pi.on("agent_end", async () => {
        expectingTopic = false;
    });

    // 6. 注册手动查看/修改主题命令
    pi.registerCommand("topic", {
        description: "查看或手动设置当前对话主题 [简短title - description]",
        handler: async (args, ctx) => {
            if (!args.trim()) {
                ctx.ui.notify(
                    currentTopic ? `当前主题: ${currentTopic}` : "当前尚未生成主题",
                    "info"
                );
                return;
            }

            let newTopic = args.trim();
            if (!newTopic.startsWith("[") || !newTopic.endsWith("]")) {
                newTopic = `[${newTopic}]`;
            }

            applyTopic(newTopic, true, ctx);
        },
    });
}
