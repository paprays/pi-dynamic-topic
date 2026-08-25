import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import net from "node:net";

const HERDR_ENV = process.env.HERDR_ENV;
const socketPath = process.env.HERDR_SOCKET_PATH;
const socketEndpoint =
  process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
const tabId = process.env.HERDR_TAB_ID;

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
 * 清理并提取首条用户消息的纯文本
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

  if (!clean) return "新对话 - 待输入";

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

  // 1. 尝试匹配完整的 <topic> 结构
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
 * 剥离文本中的 <topic>...</topic> 或独立 <title>/<description> 标签，保持对用户的回复完全干净
 */
function stripTopicXmlFromText(text: string): string {
  return text
    .replace(/<topic>[\s\S]*?<\/topic>/gi, "")
    .replace(/<title>[\s\S]*?<\/title>/gi, "")
    .replace(/<description>[\s\S]*?<\/description>/gi, "")
    .trim();
}

const TOPIC_SYSTEM_PROMPT_INSTRUCTION = `

【会话主题命名要求（CRITICAL）】
在本次回答的最终文本内容末尾，请另起一行，必须输出以下结构化 XML 标签总结当前会话主题（不要只写在思考/thinking过程中，必须输出在最终回答中）：
<topic>
  <title>2~6个字的短标题</title>
  <description>10~25个字的任务或问题核心描述</description>
</topic>
说明：
- <title> 提取核心领域或动作（如：Kitty配置、Herdr导航、快速排序等）。
- <description> 提取具体场景或目标。
`;

export default function (pi: ExtensionAPI) {
  let isFirstTurn = false;
  let topicGenerated = false;
  let currentTopic: string | undefined;

  function applyTopic(topic: string, notify = false, ctx?: ExtensionContext) {
    currentTopic = topic;
    topicGenerated = true;
    setTerminalTitle(topic);
    sendHerdrTabRename(topic);
    if (notify && ctx) {
      ctx.ui.notify(`会话主题已更新为: ${topic}`, "info");
    }
  }

  // 1. 会话初始化：检查历史记录
  pi.on("session_start", async (_event, ctx) => {
    topicGenerated = false;
    currentTopic = undefined;
    isFirstTurn = false;

    const branch = ctx.sessionManager.getBranch();
    let userMsgCount = 0;
    let firstUserText = "";

    for (const entry of branch) {
      if (entry.type === "message") {
        if (entry.message.role === "user") {
          userMsgCount++;
          if (!firstUserText) {
            firstUserText = extractUserText(entry.message.content);
          }
        } else if (entry.message.role === "assistant") {
          // 尝试从历史助手的回答中提取主题
          if (Array.isArray(entry.message.content)) {
            for (const part of entry.message.content) {
              if (part.type === "text" && typeof part.text === "string") {
                const found = extractTopicFromXml(part.text);
                if (found) {
                  applyTopic(found);
                  break;
                }
              }
            }
          }
        }
      }
    }

    if (userMsgCount === 0) {
      isFirstTurn = true;
    } else if (!topicGenerated && firstUserText) {
      // 如果之前没提取到，则先用 fallback 兜底
      applyTopic(generateFallbackTopic(firstUserText));
    }
  });

  // 2. 接收用户输入（如果是首条，立刻更新即时标题）
  pi.on("input", async (event, ctx) => {
    if (event.text && !topicGenerated) {
      const instant = generateFallbackTopic(event.text);
      applyTopic(instant);
    }
  });

  // 3. 在第一次对话开始前，将结构化 XML 主题总结指令注入到 System Prompt
  pi.on("before_agent_start", async (event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const userMsgCount = branch.filter((e: any) => e.type === "message" && e.message?.role === "user").length;
    
    // 如果是第一轮对话，或者尚未成功提取过主题
    if (userMsgCount <= 1 || !topicGenerated || isFirstTurn) {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + TOPIC_SYSTEM_PROMPT_INSTRUCTION,
      };
    }
  });

  // 4. 当 AI 回复结束时：从 AI 的回复文本中精准解析 <topic><title>...</title><description>...</description></topic>
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    let foundTopic: string | null = null;
    let modified = false;

    if (Array.isArray(event.message.content)) {
      // 1. 先检查所有部分（包括 text 和 thinking），优先提取 topic
      for (const part of event.message.content) {
        if ((part.type === "text" || part.type === "thinking") && typeof (part.text || part.thinking) === "string") {
          const raw = part.text || part.thinking || "";
          if (!foundTopic) {
            foundTopic = extractTopicFromXml(raw);
          }
        }
      }

      // 2. 清理正文中的 XML 标签
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
        applyTopic(foundTopic, true, ctx);
        isFirstTurn = false;
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

  // 5. 在 Compact (上下文压缩) 时：在 customInstructions 中要求输出结构化 <topic> 标签
  pi.on("session_before_compact", async (event, _ctx) => {
    const additionalInstruction = `
请在压缩总结末尾另起一行输出结构化会话主题：
<topic>
  <title>2~6字短标题</title>
  <description>10~25字核心内容描述</description>
</topic>`;
    return {
      customInstructions: (event.customInstructions || "") + additionalInstruction,
    };
  });

  pi.on("session_compact", async (event, ctx) => {
    const summary = event.compactionEntry?.summary;
    if (summary) {
      const found = extractTopicFromXml(summary);
      if (found) {
        applyTopic(found, true, ctx);
      }
    }
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
