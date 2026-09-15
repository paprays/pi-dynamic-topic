/**
 * 路由注入生命周期回归测试
 *
 * 覆盖：首轮注入契约、单轮隔离、空输入不吃注入位、模板插值、
 *       配置驱动的模式表、compact 后重注入、compact 失败、
 *       resume/fork 恢复、技能隔离与漏输出自愈、topic 解析落库。
 *
 * 运行：node test_routing_lifecycle.js
 *
 * 每个场景都重新调用一次扩展工厂，扩展状态全在工厂闭包里，
 * 因此天然拿到干净实例，无需清模块缓存。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 隔离真实用户环境
const isolatedAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rl-agent-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;

import ext, { DEFAULT_CONFIG, buildRoutingInstruction } from "./index.ts";

const TOOLS = [
    ...DEFAULT_CONFIG.baseTools,
    "gdb-mcp_open",
    "nu",
    "ast_search",
    "generate_image",
];
const HEADER = "[Session Topic & Capability Routing (this turn ONLY)]";
const SP =
    "前言\n<available_skills>\n<skill><name>ponytail</name></skill>\n<skill><name>deep-research</name></skill>\n</available_skills>\n后语";
const TOPIC_CODE =
    "搞定。\n<topic><title>调试</title><description>排查段错误</description>" +
    "<mode>code</mode><tools><tool>gdb-mcp_open</tool></tools>" +
    "<skills><skill>ponytail</skill></skills></topic>";

const reply = (text) => ({ message: { role: "assistant", content: [{ type: "text", text }] } });
const savedState = (data) => ({ type: "custom", customType: "dynamic-topic-state", data });
const userMsg = (text) => ({
    type: "message",
    message: { role: "user", content: [{ type: "text", text }] },
});
const ok = (name) => console.log(`  ✓ ${name}`);

function harness({ entries = [] } = {}) {
    let tools = [];
    const ev = new Map();
    const cmds = new Map();
    const notes = [];
    const appended = [];
    ext({
        getAllTools: () => TOOLS.map((name) => ({ name })),
        getActiveTools: () => tools,
        setActiveTools: (t) => {
            tools = t;
        },
        appendEntry: (type, data) => appended.push({ type, data }),
        on: (n, h) => ev.set(n, h),
        registerCommand: (n, d) => cmds.set(n, d),
        getCommands: () => [],
    });
    const ctx = {
        sessionManager: { getEntries: () => entries },
        ui: { notify: (msg, level) => notes.push({ msg, level }) },
        model: { id: "test-model" },
        modelRegistry: { complete: async () => ({ role: "assistant", content: [] }) },
    };
    return {
        ev,
        cmds,
        notes,
        appended,
        ctx,
        tools: () => tools,
        start: () => ev.get("session_start")({}, ctx),
        input: (text) => ev.get("input")({ text }, ctx),
        prompt: () => ev.get("before_agent_start")({ systemPrompt: SP }, ctx),
        reply: (text) => ev.get("message_end")(reply(text), ctx),
        end: () => ev.get("agent_end")({}, ctx),
        compact: () => ev.get("session_compact")({}, ctx),
    };
}

console.log("🚀 Routing Lifecycle Suite (first-turn / compact / resume)");

// ==========================================
// Suite 1: 首轮注入契约与单轮隔离
// ==========================================
console.log("\n[Suite 1] 首轮注入与单轮隔离");
{
    const h = harness();
    await h.start();
    assert.deepEqual(h.tools(), DEFAULT_CONFIG.baseTools, "冷启动只开基础工具");
    assert.ok(!h.ev.has("session_compact_failed"), "失败事件不上钩（压缩失败上下文未变）");
    ok("1.1 冷启动只激活 baseTools");

    const q = "帮我用 gdb 排查这个 C++ 段错误";
    const r1 = await h.input(q);
    assert.equal(r1.action, "transform");
    assert.ok(r1.text.startsWith(q), "原用户文本必须原样保留在前");
    assert.ok(r1.text.includes(HEADER), "必须带协议头");
    assert.ok(r1.text.includes("Available Tools Pool"));
    assert.ok(r1.text.includes("gdb-mcp_open"), "池里必须有非基础工具");
    assert.ok(!r1.text.includes("${"), "模板必须完成插值");
    ok("1.2 首轮注入且模板已插值");

    for (const t of ["第二轮问题", "第三轮问题", "第四轮问题"]) {
        assert.equal((await h.input(t)).action, "continue", `"${t}" 不得再注入`);
    }
    ok("1.3 同会话只注入一次");

    const h2 = harness();
    await h2.start();
    assert.equal((await h2.input("")).action, "continue", "空文本本就无需注入");
    assert.equal((await h2.input("真正的第一句")).action, "transform", "空输入不得消费注入位");
    ok("1.4 空文本输入不消费注入位");
}

// ==========================================
// Suite 2: 模板插值（曾经实测漏出源码占位符）
// ==========================================
console.log("\n[Suite 2] 模板插值");
{
    const noModes = buildRoutingInstruction(["nu"], ["ponytail"], undefined);
    assert.ok(!noModes.includes("${"), "无 modes 时也必须插值");
    assert.ok(noModes.includes("code | academic | ppt | ops | general | custom"));
    assert.ok(noModes.includes("[nu]") && noModes.includes("[ponytail]"));
    ok("2.1 无 modes 时插值完整");

    const withModes = buildRoutingInstruction(["gdb-mcp_open"], ["deep-research"], {
        code: {
            description: "编程与调试",
            recommendedTools: ["gdb-mcp_open"],
            recommendedSkills: ["deep-research"],
        },
    });
    assert.ok(!withModes.includes("${"), "有 modes 时也不得漏占位符");
    assert.ok(withModes.includes("Defined Modes & Defaults:"));
    assert.ok(withModes.includes("code:"));
    assert.ok(withModes.includes("编程与调试"));
    ok("2.2 有 modes 时渲染模式表且无残留占位符");
}

// ==========================================
// Suite 3: 配置文件驱动的模式表进入注入
// ==========================================
console.log("\n[Suite 3] 配置驱动的模式表");
{
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rl-proj-"));
    const cfgDir = path.join(proj, ".pi", "extension-settings");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
        path.join(cfgDir, "dynamic-topic.json"),
        JSON.stringify({
            version: 1,
            modes: {
                special: {
                    description: "特化模式描述",
                    recommendedTools: ["nu"],
                    recommendedSkills: ["ponytail"],
                },
            },
        })
    );
    const prevCwd = process.cwd();
    process.chdir(proj);
    try {
        const h = harness();
        await h.start();
        assert.ok(
            DEFAULT_CONFIG.baseTools.every((t) => h.tools().includes(t)),
            "只配 modes 时 baseTools 必须回落到默认值"
        );
        const r = await h.input("随便问一句");
        assert.equal(r.action, "transform");
        assert.ok(r.text.includes("Defined Modes & Defaults:"), "配置里的模式要以定义表形式注入");
        assert.ok(r.text.includes("special:"));
        assert.ok(r.text.includes("特化模式描述"));
        assert.ok(!r.text.includes("${"), "配置驱动路径同样不得漏占位符");
        ok("3.1 配置文件的 modes 进入注入指令");
    } finally {
        process.chdir(prevCwd);
        fs.rmSync(proj, { recursive: true, force: true });
    }
}

// ==========================================
// Suite 4: compact 后重注入
// ==========================================
console.log("\n[Suite 4] compact 重注入");
{
    const h = harness();
    await h.start();
    await h.input("第一轮");
    await h.reply(TOPIC_CODE);
    await h.end();
    const routed = h.tools();
    assert.ok(routed.includes("gdb-mcp_open"), "路由后 gdb 必须激活");

    await h.compact();
    const r = await h.input("压缩后的第一句话");
    assert.equal(r.action, "transform", "compact 后必须重新注入");
    assert.ok(r.text.includes(HEADER));
    assert.ok(r.text.includes("Available Tools Pool"));
    assert.ok(!r.text.includes("${"));
    assert.deepEqual(h.tools(), routed, "compact 不得改变工具集");
    ok("4.1 compact 成功后下一次输入重注入");

    assert.equal((await h.input("压缩后的第二句话")).action, "continue", "compact 注入也是单次");
    ok("4.2 compact 注入同样单次生效");

    await h.end();
    await h.compact();
    assert.equal((await h.input("第二次压缩后")).action, "transform", "每次 compact 都要重新武装");
    ok("4.3 多次 compact 每次都重新武装");
}

// ==========================================
// Suite 5: compact 失败
// ==========================================
console.log("\n[Suite 5] compact 失败");
{
    const h = harness();
    await h.start();
    await h.input("第一轮");
    await h.reply(TOPIC_CODE);
    await h.end();
    const routed = h.tools();

    assert.ok(!h.ev.has("session_compact_failed"), "失败事件不上钩");
    assert.deepEqual(h.tools(), routed, "compact 失败后工具保持不变");
    assert.equal((await h.input("压缩失败后的下一句")).action, "continue", "失败后不得注入");
    ok("5.1 失败不注入且工具不变");
}

// ==========================================
// Suite 6: resume / fork
// ==========================================
console.log("\n[Suite 6] resume / fork");
{
    const entries = [
        userMsg("历史第一问"),
        savedState({
            topic: "[调试 - 排查段错误]",
            mode: "code",
            tools: ["gdb-mcp_open"],
            skills: ["ponytail"],
        }),
    ];
    const h = harness({ entries });
    await h.start();
    assert.deepEqual(
        h.tools(),
        [...DEFAULT_CONFIG.baseTools, "gdb-mcp_open"],
        "resume 必须恢复已路由的工具"
    );
    assert.equal((await h.input("继续")).action, "continue", "resume 不重新注入协议");
    const sp = await h.prompt();
    assert.ok(sp.systemPrompt.includes("ponytail"), "resume 必须恢复技能过滤");
    assert.ok(!sp.systemPrompt.includes("deep-research"), "未激活技能必须被过滤");
    ok("6.1 resume 恢复工具与技能，且不重复注入");

    // ponytail: 恢复分支走 applyTopic，会再写一条 state entry（每次 resume +1）。
    // 当前行为如此，此处只固定现状；若后续改成幂等写入，改这条断言即可。
    assert.equal(h.appended.length, 1, "resume 会复写一条状态条目（当前行为）");
    assert.equal(h.appended[0].type, "dynamic-topic-state");
    assert.equal(h.appended[0].data.mode, "code");
    ok("6.2 resume 复写状态条目");

    const h2 = harness({ entries: [userMsg("旧会话第一问"), userMsg("旧会话第二问")] });
    await h2.start();
    assert.deepEqual(h2.tools(), DEFAULT_CONFIG.baseTools, "无状态历史只能拿到基础工具");
    assert.equal((await h2.input("继续")).action, "continue", "无状态历史不得注入");
    assert.equal(h2.notes.length, 0, "fallback 不应打扰用户");
    ok("6.3 有历史但无状态：仅 fallback，不注入");
}

// ==========================================
// Suite 7: 技能隔离与自愈
// ==========================================
console.log("\n[Suite 7] 技能隔离与自愈");
{
    const h = harness();
    await h.start();
    await h.input("第一问");
    const cold = await h.prompt();
    assert.ok(!cold.systemPrompt.includes("ponytail"), "注入等待期技能应被隔离");
    await h.reply(
        "<topic><title>闲聊</title><description>普通对话</description><mode>general</mode></topic>"
    );
    const after = await h.prompt();
    assert.ok(!after.systemPrompt.includes("ponytail"), "general 未选技能 → 保持隔离");
    ok("7.1 冷启动隔离 + 按模式过滤");

    const h2 = harness();
    await h2.start();
    await h2.input("第一问");
    await h2.prompt();
    await h2.reply("我忘了输出 topic 块");
    await h2.end();
    const healed = await h2.prompt();
    assert.ok(healed.systemPrompt.includes("ponytail"), "漏输出时技能必须回来");
    ok("7.2 漏输出 topic 后技能自愈");
}

// ==========================================
// Suite 8: topic 解析 → 激活 → 落库 → 剥离
// ==========================================
console.log("\n[Suite 8] topic 解析落库");
{
    const h = harness();
    await h.start();
    await h.input("第一问");
    const res = await h.reply(TOPIC_CODE);
    assert.ok(res && res.message, "message_end 应返回改写后的消息");
    const text = res.message.content[0].text;
    assert.ok(text.includes("搞定。"), "正文必须保留");
    assert.ok(!text.includes("<topic>"), "assistant 文本里的 topic 块必须剥掉");
    assert.equal(h.appended.length, 1);
    assert.equal(h.appended[0].type, "dynamic-topic-state");
    assert.equal(h.appended[0].data.mode, "code");
    assert.deepEqual(h.appended[0].data.tools, ["gdb-mcp_open"]);
    assert.ok(h.tools().includes("gdb-mcp_open"), "解析后必须真的激活工具");
    ok("8.1 解析→激活→落库→剥离");

    const clean = await h.reply("没有 topic 块");
    assert.equal(clean, undefined, "无 topic 时不得改写消息");
    assert.equal(h.appended.length, 1, "无 topic 时不得落库");
    ok("8.2 无 topic 块：不改写、不落库");
}

// ==========================================
// Suite 9: compact 后会话重入（session_start）
// 回归：session_start 曾无条件把 shouldInjectInNextPrompt 清成 false，
//       导致 compact 与下一条用户输入之间发生任何会话重入时，重注入被静默取消。
// ==========================================
console.log("\n[Suite 9] compact 后会话重入");
{
    const saved = () =>
        savedState({ topic: "[旧话题]", mode: "code", tools: ["gdb-mcp_open"], skills: ["ponytail"] });

    // 9.1 压缩后重入 → 下一条输入仍须注入
    const h = harness({ entries: [userMsg("第一问"), { type: "compaction" }, saved()] });
    await h.start();
    const r = await h.input("压缩后重入的第一句");
    assert.equal(r.action, "transform", "compact 后会话重入仍须注入");
    assert.ok(r.text.includes(HEADER));
    assert.ok(h.tools().includes("gdb-mcp_open"), "重入仍须恢复工具");
    ok("9.1 compact + session_start 再入 → 仍注入");

    // 9.2 无压缩的普通 resume 不得被误注入
    const h2 = harness({ entries: [userMsg("历史第一问"), saved()] });
    await h2.start();
    assert.equal((await h2.input("普通 resume")).action, "continue", "无压缩的 resume 不该注入");
    ok("9.2 无 compact 的 resume 不注入");

    // 9.3 压缩后又发过用户消息 → 注入机会已用掉，不得重复注入
    const h3 = harness({
        entries: [userMsg("第一问"), { type: "compaction" }, userMsg("压缩后第一句"), saved()],
    });
    await h3.start();
    assert.equal((await h3.input("再下一句")).action, "continue", "压缩后的注入机会已消费");
    ok("9.3 压缩后已发过话 → 不注入");

    // 9.4 冷启动仍注入（userMsgCount === 0）
    const h4 = harness();
    await h4.start();
    assert.equal((await h4.input("全新会话")).action, "transform", "冷启动必须注入");
    ok("9.4 冷启动仍注入");

    // 9.5 只有历史、没存过状态、也没压缩 → 只 fallback，不注入
    const h5 = harness({ entries: [userMsg("旧会话第一问")] });
    await h5.start();
    assert.equal((await h5.input("继续")).action, "continue", "无状态历史不得注入");
    ok("9.5 无状态历史不注入");
}

fs.rmSync(isolatedAgentDir, { recursive: true, force: true });
console.log("\n🎉 ROUTING LIFECYCLE SUITE PASSED.");
