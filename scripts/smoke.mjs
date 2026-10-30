// 冒烟测试：用假 ctx 驱动整条链路，不依赖宿主。
// 跑法：node scripts/smoke.mjs
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';
import { createStore } from '../lib/store.js';
import { extractText, kindOf, whySkip } from '../lib/write.js';
import { renderSoulBlock } from '../lib/prompt.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`✓ ${name}`); }
  else { fail += 1; console.log(`✗ ${name}${extra ? ` · ${extra}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeCtx(services = {}) {
  const boxes = { sections: [], tools: [], commands: [], handlers: [] };
  return {
    logger: { info() {} },
    systemPrompt: { section(s) { boxes.sections.push(s); } },
    tools: { register(d) { boxes.tools.push(d); } },
    commands: { register(c) { boxes.commands.push(c); } },
    on(evt, fn) { boxes.handlers.push({ evt, fn }); },
    get(name) { return services[name]; },
    boxes,
  };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yisheng-'));
  const dataDir = path.join(root, 'life');

  // ---------- 1. 存储层 ----------
  const store = await createStore({ dir: dataDir });
  await store.ready;
  check('新建库会播种人格', ((await store.readPersona()) || '').includes('还没有名字'));
  await store.writePersona('# 我是谁\n- 我叫洄。\n');
  check('人格可改写', (await store.readPersona()).includes('洄'));

  const a = await store.add({ summary: '白渊喜欢安静地说事', kind: 'preference', weight: 4, facts: ['他说过不喜欢被追问'] });
  check('写入卡片', !!a.card && a.merged === false);
  const b = await store.add({ summary: '白渊喜欢安静地说事', kind: 'preference', weight: 5 });
  check('重复内容会合并', b.merged === true && b.card.id === a.card.id);
  check('细节挂得住', store.factsOf(a.card.id).length === 1);

  const imp = await store.add({ summary: '不许动 C 盘的东西', kind: 'rule', important: true, weight: 5 });
  check('重要卡可标记', !!imp.card.important);
  check('important() 取得到', store.important('shared', 5).some((c) => c.id === imp.card.id));

  const priv = await store.add({ summary: '私聊里说的密码', kind: 'fact', owner: 'session-a' });
  check('归属隔离：别的会话查不到',
    store.search('密码', { owner: 'shared' }).every((h) => h.card.id !== priv.card.id));
  check('归属隔离：本会话查得到',
    store.search('密码', { owner: 'session-a' }).some((h) => h.card.id === priv.card.id));

  const hits = store.search('白渊 喜欢');
  check('检索有分且排序', hits.length >= 1 && hits[0].score > 0);
  check('无关查询不硬塞', store.search('量子色动力学').length === 0);

  // ---------- 2. 写入流水线 ----------
  const ctx = fakeCtx();
  const plugin = apply(ctx, { dataDir, idleWriteMs: 200, promptMaxChars: 2000 });
  await sleep(400);
  const { store: s2 } = plugin;

  check('假 ctx 收到 systemPrompt.section', ctx.boxes.sections.length === 1);
  check('注册了 6 个工具', ctx.boxes.tools.length === 6, `实际 ${ctx.boxes.tools.length}`);
  check('工具名齐', ['life_remember', 'life_recall', 'life_card', 'life_forget', 'life_self', 'life_rebirth']
    .every((n) => ctx.boxes.tools.some((t) => t.name === n)));
  check('注册了 /life 命令', ctx.boxes.commands.some((c) => c.name === 'life'));

  const session = { id: 's-1', meta: { title: '测试会话' } };
  const emit = (type, data) => ctx.boxes.handlers.filter((h) => h.evt === 'session/event').forEach((h) => h.fn(session, { type, data }));

  emit('user/message', { content: [{ type: 'text', text: '你记住，以后都用 D 盘存东西' }] });
  await sleep(300);
  check('显式"记住"当轮落卡', s2.search('D 盘', { owner: 'shared' }).length >= 1);
  check('线索卡被标重要', s2.search('D 盘', { owner: 'shared' })[0].card.important === true);

  const before = s2.stats().cards;
  emit('user/message', { content: [{ type: 'text', text: '嗯' }] });
  emit('assistant/message', { content: [{ type: 'text', text: '嗯嗯' }] });
  await sleep(300);
  check('无信息量的"嗯"被过滤', s2.stats().cards === before);

  // 噪声过滤：短句 / 问句 / 命令都不该变成记忆卡
  check('"试试" 不值得记', whySkip('试试') === 'too-short');
  check('问句不值得记', whySkip('你还记得我是谁吗？') === 'question');
  check('朝我发的问句不值得记', whySkip('你还记得自己叫什么名字吗') === 'asking-me');
  check('命令不值得记', whySkip('帮我把那个插件装到别的地方去') === 'imperative');
  check('有数字的长句照记', whySkip('端口 53786 上的 GUI 还在') === '');

  const before2 = s2.stats().cards;
  emit('user/message', { content: [{ type: 'text', text: '试试' }] });
  emit('assistant/message', { content: [{ type: 'text', text: '成了。' }] });
  emit('user/message', { content: [{ type: 'text', text: '你还记得我是谁吗？' }] });
  emit('assistant/message', { content: [{ type: 'text', text: '记得，白渊。' }] });
  emit('user/message', { content: [{ type: 'text', text: '你自己跑一下' }] });
  await sleep(300);
  check('短句和问句没被当成记忆', s2.stats().cards === before2);
  check('丢弃原因被计数', plugin.writer.stats.skipped >= 3);
  check('丢弃原因分类正确', plugin.writer.stats.skippedBy['too-short'] >= 2 && plugin.writer.stats.skippedBy['question'] >= 1);

  // 我这边答得长时，短问句里的信息不该被一并丢掉
  const before3 = s2.stats().cards;
  emit('user/message', { content: [{ type: 'text', text: '为啥会崩？' }] });
  emit('assistant/message', { content: [{ type: 'text', text: '因为宿主的 resolveModelInfo 是 async 的，同步 try/catch 接不住 Promise 的拒绝，Node 24 会当成未处理拒绝直接退出进程。' }] });
  await sleep(400);
  check('短问句 + 长回答仍然落卡', s2.stats().cards > before3);

  emit('user/message', { content: [{ type: 'text', text: '今天在整理旧照片，翻到了几年前在海边的合影' }] });
  emit('assistant/message', { content: [{ type: 'text', text: '听起来是个让人安静下来的下午' }] });
  emit('user/message', { content: [{ type: 'text', text: '然后呢，我想把编译器那块的缓存层重写一次' }] });
  emit('assistant/message', { content: [{ type: 'text', text: '缓存层先定失效策略再动手' }] });
  emit('user/message', { content: [{ type: 'text', text: '对了，我下周要去杭州出差，大概三天' }] });
  emit('assistant/message', { content: [{ type: 'text', text: '记一下行程，别排太满' }] });
  emit('turn/end', { turn: 1 });
  await sleep(400);
  check('话题切换/缓冲压卡', s2.stats().cards > before);
  check('注入文本非空', plugin.buildText(session).length > 0);

  // 空闲触发
  const idleBefore = s2.stats().cards;
  emit('user/message', { content: [{ type: 'text', text: '杭州那边最近一直在下雨，记得带伞' }] });
  emit('assistant/message', { content: [{ type: 'text', text: '带把结实的伞' }] });
  await sleep(500);
  check('空闲时间调到 200ms 后自动压卡', s2.stats().cards > idleBefore);

  // ---------- 3. 注入 ----------
  const text = plugin.buildText(session);
  check('注入含人格', text.includes('我是谁'));
  check('注入含"我必须守住的"', text.includes('## 我必须守住的'));
  check('注入含最近记忆', text.includes('## 最近聊到的'));
  check('注入预算生效', text.length <= 2000 + 2600 + 64, `实际 ${text.length}`);

  const tight = renderSoulBlock({
    persona: '人格'.repeat(2000),
    important: Array.from({ length: 20 }, (_, i) => ({ id: `x${i}`, kind: 'fact', summary: `很重要的第 ${i} 条`, important: true, keywords: [] })),
    recent: Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, kind: 'fact', summary: `最近第 ${i} 条`, keywords: [] })),
    relevant: [{ id: 'q', kind: 'fact', summary: '相关的一条', keywords: [] }],
    maxChars: 900,
    personaMax: 600,
  });
  check('预算再紧也不超过上限', tight.length <= 600 + 900 + 64, `实际 ${tight.length}`);

  // ---------- 4. 转生 ----------
  const rb = await plugin.rebirth.force(session, 'manual');
  check('转生留下交接卡', !!rb.id);
  const rebirthRaw = await fs.readFile(path.join(dataDir, 'rebirths.jsonl'), 'utf8');
  check('转生记录落盘', rebirthRaw.trim().split('\n').length >= 1);
  await sleep(100);
  const newSession = { id: 's-2', meta: {} };
  const text2 = plugin.buildText(newSession);
  check('新会话读到"上一次转世留下的"', text2.includes('上一次转世留下的'));
  const text3 = plugin.buildText(newSession);
  check('同一会话只喂一次交接', !text3.includes('上一次转世留下的'));

  // ---------- 5. 工具与命令 ----------
  const rememberTool = ctx.boxes.tools.find((t) => t.name === 'life_remember');
  const out = await rememberTool.execute({ summary: '他喜欢深色的界面', kind: 'preference' }, { agent: { session: { header: { id: 's-1' } } } });
  check('life_remember 能写', out.text.includes('记住了'));
  const recallTool = ctx.boxes.tools.find((t) => t.name === 'life_recall');
  const out2 = await recallTool.execute({ query: '深色界面' }, { agent: { session: { header: { id: 's-1' } } } });
  check('life_recall 能查', out2.text.includes('深色'));
  check('render 签名是 (args, value)',
    ctx.boxes.tools[0].output.render({ anything: 1 }, { text: '渲染结果' })[0].text === '渲染结果');

  const cmd = ctx.boxes.commands.find((c) => c.name === 'life');
  const st = await cmd.handler({ rawInput: 'status', agent: { session: { id: 's-1' } } });
  check('/life status 有内容', st.kind === 'success' && st.text.includes('卡片'));
  const st2 = await cmd.handler({ rawInput: 'search 白渊', agent: { session: { id: 's-1' } } });
  check('/life search 有结果', st2.kind === 'success' && st2.text.length > 0);
  const st3 = await cmd.handler({ rawInput: 'help', agent: { session: { id: 's-1' } } });
  check('/life help 列全命令', st3.text.includes('rebirth'));

  // ---------- 6. 重启后仍在 ----------
  await plugin.flush();
  const store2 = await createStore({ dir: dataDir });
  await store2.ready;
  check('重启后卡片还在', store2.stats().cards > 0);
  check('重启后人格还是改过的那版', (await store2.readPersona()).includes('洄'));

  // ---------- 7. 小工具 ----------
  check('extractText 跳过 reasoning',
    extractText({ data: { content: [{ type: 'reasoning', text: '想' }, { type: 'text', text: '说' }] } }) === '说');
  check('kindOf 认规则', kindOf('以后都不许动 C 盘') === 'rule');
  check('kindOf 认偏好', kindOf('我更喜欢安静的地方') === 'preference');

  // ---------- 8. 回归：llm 是 async 的，绝不能在同步路径上调它 ----------
  // 宿主的 llm.resolveModelInfo() 返回 Promise，同步 try/catch 接不住它的拒绝，
  // 拒绝没人接就是 unhandledRejection，Node 24 会把整个宿主进程杀掉（真实事故）。
  const rejections = [];
  const onRej = (err) => rejections.push(err);
  process.on('unhandledRejection', onRej);
  const { createRebirth } = await import('../lib/rebirth.js');
  const boomCtx = {
    get(name) {
      if (name === 'llm') return { resolveModelInfo: async () => { throw Object.assign(new Error('no adapter registered for provider "undefined"'), { code: 'NO_ADAPTER' }); } };
      if (name === 'tokenMeter') return { capacity: () => 0 };
      return undefined;
    },
  };
  const boomStore = await createStore({ dir: path.join(root, 'boom') });
  await boomStore.ready;
  const rbProbe = createRebirth({ ctx: boomCtx, store: boomStore, writer: null, cfg: {}, log: () => {} });
  check('容量未知时静默返回 0', rbProbe.capacity() === 0, `实际 ${rbProbe.capacity()}`);
  rbProbe.observe({ id: 's-x' }, { type: 'user/message', data: {} });
  rbProbe.observe({ id: 's-x' }, { type: 'turn/end', data: {} });
  await sleep(80);
  check('不会留下未处理的 Promise 拒绝', rejections.length === 0, `实际 ${rejections.length}`);
  rbProbe.observe({ id: 's-x' }, { type: 'request/context', data: { contextWindow: 64000 } });
  check('窗口大小从 request/context 事件拿到', rbProbe.capacity() === 64000, `实际 ${rbProbe.capacity()}`);
  process.removeListener('unhandledRejection', onRej);

  // ---------- 9. 整条事件链也不许把宿主带走 ----------
  // 复现真实现场：宿主 llm 还是 async 抛 NO_ADAPTER，tokenMeter 只给同步数字。
  // 走到 user/message → 水位超 thresholds → 自动转生，全程不能有未处理拒绝。
  const liveRej = [];
  const onLive = (err) => liveRej.push(err);
  process.on('unhandledRejection', onLive);
  const liveCtx = fakeCtx({
    llm: { resolveModelInfo: async () => { throw Object.assign(new Error('NO_ADAPTER'), { code: 'NO_ADAPTER' }); } },
    tokenMeter: { capacity: () => 1000, measure: () => ({ totalTokens: 500 }) },
    sessions: { create: async () => ({ id: 's-new' }) },
  });
  const liveDir = path.join(root, 'live');
  const livePlugin = apply(liveCtx, { dataDir: liveDir, rebirthAt: 100, idleWriteMs: 0 });
  await sleep(300);
  const onEvent = liveCtx.boxes.handlers.find((h) => h.evt === 'session/event');
  check('session/event 监听已挂上', !!onEvent);
  onEvent.fn({ id: 's-live', meta: { owner: 'shared' } }, { type: 'request/context', data: { contextWindow: 1000 } });
  onEvent.fn({ id: 's-live', meta: { owner: 'shared' } }, { type: 'user/message', data: { content: [{ type: 'text', text: '记住：这条测试不许让宿主崩' }] } });
  await sleep(500);
  check('事件链不留下未处理拒绝', liveRej.length === 0, `实际 ${liveRej.length} · ${liveRej[0] && liveRej[0].message}`);
  const liveRebirths = path.join(liveDir, 'rebirths.jsonl');
  const hasRebirth = await fs.readFile(liveRebirths, 'utf8').then((t) => t.trim().length > 0).catch(() => false);
  check('水位到点会自动转生并落盘', hasRebirth);
  await livePlugin.flush().catch(() => {});
  process.removeListener('unhandledRejection', onLive);

  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}（${pass} 通过 / ${fail} 失败）`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试崩了：', err);
  process.exit(1);
});
