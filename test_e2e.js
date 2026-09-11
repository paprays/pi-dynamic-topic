import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
    parseTopicXml,
    stripTopicXmlFromText,
    normalizeTools,
    filterSystemPromptSkills,
    loadConfig,
    discoverSkills,
    buildRoutingInstruction,
    DEFAULT_CONFIG,
} from "./index.ts";

console.log("🚀 Starting End-to-End & Unit Test Suite for Pi Dynamic Topic & Capability Router...");

// ==========================================
// Test Suite 1: W3C DOMParser XML Parsing
// ==========================================
console.log("\n[Test 1] XML Parsing Edge Cases");

// 1.1 Standard XML
const standardXml = `
<topic>
  <title>Syncthing部署</title>
  <description>在多台服务器上配置同步节点</description>
  <mode>ops</mode>
  <tools>
    <tool>interactive_shell</tool>
    <tool>nu</tool>
  </tools>
  <skills>
    <skill>ctf-orchestrator</skill>
  </skills>
</topic>
`;
const parsed1 = parseTopicXml(standardXml);
assert.ok(parsed1, "Standard XML should be parsed");
assert.equal(parsed1.title, "Syncthing部署");
assert.equal(parsed1.description, "在多台服务器上配置同步节点");
assert.equal(parsed1.mode, "ops");
assert.deepEqual(parsed1.tools, ["interactive_shell", "nu"]);
assert.deepEqual(parsed1.skills, ["ctf-orchestrator"]);
console.log("  ✓ Standard XML parsing passed");

// 1.2 Non-standard, CDATA, newlines, brackets & entities
const weirdXml = `
一些AI的回答前缀...
<TOPIC>
  <title><![CDATA[ [C++调试] ]]></title>
  <description> 排查并修复段错误问题，优化执行性能 </description>
  <mode> reverse-engineering </mode>
  <tools>
    <tool>gdb, lsp</tool>
    <tool> ast_search </tool>
  </tools>
  <skills>
    <skill>ponytail</skill>
  </skills>
</TOPIC>
`;
const parsed2 = parseTopicXml(weirdXml);
assert.ok(parsed2, "Weird XML with CDATA and case-insensitive tags should be parsed");
assert.equal(parsed2.title, "C++调试");
assert.equal(parsed2.description, "排查并修复段错误问题，优化执行性能");
assert.equal(parsed2.mode, "reverse-engineering");
assert.deepEqual(parsed2.tools, ["gdb", "lsp", "ast_search"]);
assert.deepEqual(parsed2.skills, ["ponytail"]);
console.log("  ✓ Complex CDATA & bracketed XML parsing passed");

// 1.3 Missing tools and skills tags
const minimalXml = `
<topic>
  <title>简单对话</title>
  <description>日常闲聊与资料查询</description>
</topic>
`;
const parsed3 = parseTopicXml(minimalXml);
assert.ok(parsed3, "Minimal XML should parse with defaults");
assert.equal(parsed3.title, "简单对话");
assert.equal(parsed3.description, "日常闲聊与资料查询");
assert.equal(parsed3.mode, "general");
assert.deepEqual(parsed3.tools, []);
assert.deepEqual(parsed3.skills, []);
console.log("  ✓ Minimal XML defaults passed");

// ==========================================
// Test Suite 2: Strip XML from Assistant Text
// ==========================================
console.log("\n[Test 2] Text Stripping");
const dirtyText = `这是最终分析结果：已找到内存泄露问题。

<topic>
  <title>内存分析</title>
  <description>检测堆内存越界写入</description>
  <mode>code</mode>
</topic>`;
const cleanText = stripTopicXmlFromText(dirtyText);
assert.equal(cleanText, "这是最终分析结果：已找到内存泄露问题。");
assert.ok(!cleanText.includes("<topic>"));
console.log("  ✓ Clean stripping passed");

// ==========================================
// Test Suite 3: Tool Normalization & Aliases
// ==========================================
console.log("\n[Test 3] Tool Normalization Pipeline");
const allRegistered = [
    "read",
    "bash",
    "edit",
    "write",
    "gdb-mcp_open",
    "lsp_diagnostics",
    "lsp_fix",
    "ast_search",
    "interactive_shell",
    "nu",
];
const aliases = {
    gdb: "gdb-mcp_open",
    lsp: "lsp_diagnostics",
    shell: "interactive_shell",
};

// 3.1 Aliases & fuzzy match
const requested = ["gdb", "lsp", "ast", "nu", "non_existent_tool_xyz"];
const normalized = normalizeTools(requested, allRegistered, aliases);
assert.deepEqual(
    normalized,
    ["gdb-mcp_open", "lsp_diagnostics", "ast_search", "nu"],
    "Tools should resolve aliases and ignore invalid ones"
);
console.log("  ✓ Tool normalization & alias resolution passed");

// ==========================================
// Test Suite 4: Skills Cold Start & Prompt Filter
// ==========================================
console.log("\n[Test 4] System Prompt Skills Filtering");
const fullPrompt = `You are an agent.
<available_skills>
  <skill>
    <name>ponytail</name>
    <description>Lazy senior developer</description>
  </skill>
  <skill>
    <name>academic-paper</name>
    <description>Paper writing assistant</description>
  </skill>
</available_skills>
Follow instructions carefully.`;

// 4.1 Cold start: 0 active skills -> complete removal of <available_skills>
const coldPrompt = filterSystemPromptSkills(fullPrompt, new Set());
assert.ok(!coldPrompt.includes("<available_skills>"), "Cold start must strip <available_skills>");
assert.ok(!coldPrompt.includes("ponytail"), "Cold start must strip skill names");
assert.ok(coldPrompt.includes("You are an agent."), "Base prompt must be intact");
console.log("  ✓ Cold start prompt isolation passed");

// 4.2 Active skill: only ponytail active
const activePrompt = filterSystemPromptSkills(fullPrompt, new Set(["ponytail"]));
assert.ok(activePrompt.includes("<available_skills>"), "Active skills should retain wrapper");
assert.ok(activePrompt.includes("<name>ponytail</name>"), "Must keep active ponytail skill");
assert.ok(!activePrompt.includes("academic-paper"), "Must filter out non-active academic skill");
console.log("  ✓ Selective skill retention passed");

// ==========================================
// Test Suite 5: Config Loading & Precedence
// ==========================================
console.log("\n[Test 5] Configuration Loading Precedence");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-topic-test-"));
const projectConfigDir = path.join(tmpDir, ".pi", "extension-settings");
fs.mkdirSync(projectConfigDir, { recursive: true });
fs.writeFileSync(
    path.join(projectConfigDir, "dynamic-topic.json"),
    JSON.stringify({
        version: 1,
        baseTools: ["read", "write"],
        modes: {},
        customToolAliases: { test: "test_tool" },
    })
);

const loaded = loadConfig(tmpDir);
assert.deepEqual(loaded.baseTools, ["read", "write"], "Should load project-level config over default");
assert.equal(loaded.customToolAliases.test, "test_tool");
console.log("  ✓ Project-level config precedence passed");

// Clean up temp dir
fs.rmSync(tmpDir, { recursive: true, force: true });

// ==========================================
// Test Suite 6: Routing Prompt Builder
// ==========================================
console.log("\n[Test 6] Routing Instruction Builder");
const instruction = buildRoutingInstruction(["gdb-mcp_open", "nu"], ["ponytail", "academic-paper"]);
assert.ok(instruction.includes("gdb-mcp_open, nu"));
assert.ok(instruction.includes("ponytail, academic-paper"));
assert.ok(instruction.includes("<topic>"));
console.log("  ✓ Routing instruction generation passed");

// ==========================================
// Test Suite 7: Full Mock Pi Lifecycle Simulation
// ==========================================
console.log("\n[Test 7] Full Mock Pi Extension Lifecycle");
import dynamicTopicExtension from "./index.ts";

let activeTools = [];
const eventHandlers = new Map();
const commands = new Map();
const appendedEntries = [];
let notifiedMessages = [];

const mockPi = {
    getAllTools: () => [
        { name: "read" },
        { name: "bash" },
        { name: "edit" },
        { name: "write" },
        { name: "grep" },
        { name: "find" },
        { name: "ls" },
        { name: "web_search" },
        { name: "ask_user" },
        { name: "fetch_content" },
        { name: "get_search_content" },
        { name: "gdb-mcp_open" },
        { name: "lsp_diagnostics" },
        { name: "lsp_fix" },
        { name: "ast_search" },
        { name: "nu" },
        { name: "interactive_shell" },
        { name: "generate_image" },
    ],
    getActiveTools: () => activeTools,
    setActiveTools: (tools) => {
        activeTools = tools;
    },
    appendEntry: (type, data) => {
        appendedEntries.push({ type, data });
    },
    on: (eventName, handler) => {
        eventHandlers.set(eventName, handler);
    },
    registerCommand: (name, def) => {
        commands.set(name, def);
    },
    getCommands: () => Array.from(commands.entries()).map(([name, def]) => ({ name, ...def })),
};

const mockCtx = {
    sessionManager: {
        getEntries: () => [],
    },
    ui: {
        notify: (msg, level) => {
            notifiedMessages.push({ msg, level });
        },
    },
    model: { id: "test-model" },
    modelRegistry: {
        complete: async (_model, _ctx) => ({
            role: "assistant",
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        modes: {
                            code: { description: "AI code", recommendedTools: ["gdb-mcp_open"], recommendedSkills: ["ponytail"] },
                            ppt: { description: "AI ppt", recommendedTools: ["generate_image"], recommendedSkills: ["browser-act"] },
                            custom_ai: { description: "AI custom", recommendedTools: ["interactive_shell"], recommendedSkills: [] },
                        },
                        customToolAliases: { gdb: "gdb-mcp_open", image: "generate_image" }
                    })
                }
            ]
        })
    }
};

// Initialize extension
dynamicTopicExtension(mockPi);
assert.ok(eventHandlers.has("session_start"), "Should register session_start");
assert.ok(eventHandlers.has("input"), "Should register input");
assert.ok(eventHandlers.has("before_agent_start"), "Should register before_agent_start");
assert.ok(eventHandlers.has("message_end"), "Should register message_end");
assert.ok(commands.has("topic"), "Should register /topic command");
assert.ok(commands.has("mode"), "Should register /mode command");

// 7.1 Cold start
await eventHandlers.get("session_start")({}, mockCtx);
assert.equal(activeTools.length, DEFAULT_CONFIG.baseTools.length, "Cold start should only activate baseTools");
assert.ok(!activeTools.includes("gdb-mcp_open"), "gdb must NOT be active in cold start");
assert.ok(!activeTools.includes("lsp_diagnostics"), "lsp must NOT be active in cold start");
console.log("  ✓ Lifecycle: Cold start activation passed");

// 7.2 Turn 1 Input transform
const inputResult1 = await eventHandlers.get("input")({ text: "帮我用 gdb 排查这个 c++ 错误" }, mockCtx);
assert.equal(inputResult1.action, "transform", "Turn 1 must transform input prompt");
assert.ok(inputResult1.text.includes("[Session Topic & Capability Routing (this turn ONLY)]"));
assert.ok(inputResult1.text.includes("gdb-mcp_open"));
console.log("  ✓ Lifecycle: Turn 1 prompt transform passed");

// 7.3 Assistant Message End with XML Response
const assistantMsg = {
    role: "assistant",
    content: [
        {
            type: "text",
            text: `我已经分析了原因，准备进行调试。\n\n<topic>\n  <title>C++排错</title>\n  <description>使用 GDB 排查段错误并修复</description>\n  <mode>code</mode>\n  <tools>\n    <tool>gdb</tool>\n    <tool>lsp</tool>\n  </tools>\n  <skills>\n    <skill>karpathy-guidelines</skill>\n  </skills>\n</topic>`,
        },
    ],
};
const msgEndResult = await eventHandlers.get("message_end")({ message: assistantMsg }, mockCtx);
assert.ok(msgEndResult, "Should return modified message");
assert.equal(msgEndResult.message.content[0].text.trim(), "我已经分析了原因，准备进行调试。");
assert.ok(!msgEndResult.message.content[0].text.includes("<topic>"), "XML block must be stripped");

// Check active tools now includes gdb-mcp_open & lsp_diagnostics
assert.ok(activeTools.includes("gdb-mcp_open"), "gdb-mcp_open should now be dynamically activated!");
assert.ok(activeTools.includes("lsp_diagnostics"), "lsp_diagnostics should now be dynamically activated!");
assert.ok(activeTools.includes("read"), "baseTools must remain active");

// Check persistence
const lastEntry = appendedEntries[appendedEntries.length - 1];
assert.equal(lastEntry.type, "dynamic-topic-state");
assert.equal(lastEntry.data.mode, "code");
assert.deepEqual(lastEntry.data.tools, ["gdb-mcp_open", "lsp_diagnostics"]);
assert.deepEqual(lastEntry.data.skills, ["karpathy-guidelines"]);
console.log("  ✓ Lifecycle: Assistant response capability unlocking passed");

// 7.4 Turn 2 Input (No transform)
const inputResult2 = await eventHandlers.get("input")({ text: "第二轮问题，无需注入" }, mockCtx);
assert.equal(inputResult2.action, "continue", "Turn 2 must NOT inject routing instructions");
console.log("  ✓ Lifecycle: Turn 2 single-turn isolation passed");

// 7.5 Manual command: /mode
commands.get("mode").handler("", mockCtx);
assert.ok(notifiedMessages.some((m) => m.msg.includes("当前生效: code") || m.msg.includes("当前模式: code")));
console.log("  ✓ Command: /mode info query passed");

// 7.6 Manual mode switch: /mode ops
commands.get("mode").handler("ops", mockCtx);
assert.ok(activeTools.includes("interactive_shell"));
assert.ok(!activeTools.includes("gdb-mcp_open"));
console.log("  ✓ Command: /mode ops dynamic switch passed");

// 7.7 /topic init --project
const testProjDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-topic-init-"));
const prevCwd = process.cwd();
try {
    process.chdir(testProjDir);
    await commands.get("topic").handler("init --project", mockCtx);
    const targetInit = path.join(testProjDir, ".pi", "extension-settings", "dynamic-topic.json");
    assert.ok(fs.existsSync(targetInit), "Should create .pi/extension-settings/dynamic-topic.json");
    const parsedInit = JSON.parse(fs.readFileSync(targetInit, "utf-8"));
    assert.ok(parsedInit.modes.code, "Should have code mode");
    assert.ok(parsedInit.modes.academic, "Should have academic mode");
    assert.ok(parsedInit.customToolAliases.gdb, "Should configure gdb alias");
    assert.ok(parsedInit.modes.ppt, "Should have ppt mode");
    assert.ok(parsedInit.modes.custom_ai, "Should have AI synthesized custom_ai mode");
    assert.ok(parsedInit.customToolAliases.image, "Should configure image alias");
    console.log("  ✓ Command: /topic init --project with AI synthesis passed");
} finally {
    process.chdir(prevCwd);
    fs.rmSync(testProjDir, { recursive: true, force: true });
}

// 7.8 Manual mode switch: /mode ppt
commands.get("mode").handler("ppt", mockCtx);
assert.ok(activeTools.includes("generate_image"), "generate_image must be active in ppt mode");
assert.ok(activeTools.includes("fetch_content"), "fetch_content must be active in ppt mode");
// 7.9 /mode list
await commands.get("mode").handler("list", mockCtx);
assert.ok(notifiedMessages.some((m) => m.msg.includes("可用工作模式列表")));
console.log("  ✓ Command: /mode list passed");

// 7.10 /mode add
await commands.get("mode").handler("add review 代码安全审计与重构 --tools ast_search --skills ponytail-review", mockCtx);
assert.ok(notifiedMessages.some((m) => m.msg.includes("成功添加模式 [review]")));
assert.ok(notifiedMessages.some((m) => m.level === "success"));

// Switch to the newly added mode
await commands.get("mode").handler("review", mockCtx);
assert.ok(activeTools.includes("ast_search"), "ast_search should be activated in review mode");
console.log("  ✓ Command: /mode add & switch passed");

// 7.11 /mode edit
await commands.get("mode").handler("edit review 深度代码安全审查 --tools ast_search,nu", mockCtx);
assert.ok(notifiedMessages.some((m) => m.msg.includes("成功修改模式 [review]")));
assert.ok(activeTools.includes("nu"), "nu should now be activated after edit");
console.log("  ✓ Command: /mode edit passed");

// 7.12 /mode del
await commands.get("mode").handler("del review", mockCtx);
assert.ok(notifiedMessages.some((m) => m.msg.includes("成功删除模式 [review]")));
console.log("  ✓ Command: /mode del passed");

console.log("\n🎉 ALL 7 TEST SUITES PASSED FLAWLESSLY! 100% E2E VERIFIED.");
