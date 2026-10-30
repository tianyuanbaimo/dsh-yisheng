/**
 * dsh-yisheng · 入口
 *
 * 五层写入 → 摘要卡 + 细节 → 三路注入 → 转生。
 * 注入只读同步数据：检索/重排在 user/message 时异步跑一次，结果按会话冻结，
 * 这样同一个会话里系统提示不会因为记忆变了而反复变动（护住前缀缓存）。
 */
import { createStore, resolveDir } from './store.js';
import { createWriter } from './write.js';
import { createRetrieve } from './retrieve.js';
import { createRebirth } from './rebirth.js';
import { registerCommand, registerTools } from './tools.js';
import { renderSoulBlock, renderStatus } from './prompt.js';
import { promises as fs, appendFileSync } from 'node:fs';

export const name = 'dsh-yisheng';
export const inject = ['tools', 'commands', 'systemPrompt'];

const DEFAULTS = {
  dataDir: '',
  inject: true,
  promptMaxChars: 2000,
  personaMaxChars: 2600,
  importantCards: 8,
  recentCards: 5,
  relevantCards: 3,
  idleWriteMs: 5 * 60 * 1000,
  minCardChars: 10,
  topicShift: true,
  autoRebirth: true,
  rebirthAt: 32000,
  rebirthNewSession: true,
  extractModel: '',
  llmBase: 'http://127.0.0.1:11434',
  llmTimeoutMs: 8000,
  rerankModel: '',
  rerankBase: 'http://127.0.0.1:11434',
  rerankTimeoutMs: 2000,
  sectionOrder: 10050,
};

async function readVersion() {
  try {
    const raw = await fs.readFile(new URL('../package.json', import.meta.url), 'utf8');
    return JSON.parse(raw).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function ownerOf(session) {
  const meta = (session && (session.meta || (session.header && session.header.meta))) || {};
  return String(meta.owner || meta.ownerId || 'shared');
}

function titleOf(session) {
  const m = (session && session.meta) || {};
  return String(m.title || (session && session.header && session.header.title) || '').trim();
}

export function apply(ctx, config = {}) {
  // 排障：设 YISHENG_DEBUG=<文件路径> 时把装载阶段写进文件，用来确认插件到底有没有被宿主装载。
  const debugMark = (stage) => {
    const p = process.env.YISHENG_DEBUG;
    if (!p) return;
    try { appendFileSync(p, `${new Date().toISOString()} ${stage}\n`); } catch { /* 忽略 */ }
  };
  debugMark('apply');

  const cfg = { ...DEFAULTS, ...config };
  const log = (msg) => {
    try { ctx.logger?.info?.(`dsh-yisheng: ${msg}`); } catch { /* 忽略 */ }
  };
  const fail = (where, err) => {
    try { console.error(`[dsh-yisheng] ${where} failed: ${err && (err.stack || err.message) || err}`); } catch { /* 忽略 */ }
  };

  const store = createStore({ dir: cfg.dataDir || resolveDir(''), log });
  const writer = createWriter({ store, cfg, log });
  const retrieve = createRetrieve({ store, cfg, log });
  const rebirth = createRebirth({ ctx, store, writer, cfg, log });
  // 人格改动后立刻反映到注入里，不用等下次启动
  cfg.__onPersona = (text) => { personaCache = String(text || ''); };

  const relevance = new Map(); // sid -> {ids, query, at}
  const snapshots = new Map(); // key -> {text, at}
  let personaCache = '';
  let loadedVersion = '0.0.0';

  async function refreshRelevance(session, sid, query) {
    try {
      const owner = ownerOf(session);
      const picked = await retrieve.pick(query, { owner, topK: cfg.relevantCards });
      const ids = picked.relevant.map((c) => c.id);
      const prev = relevance.get(sid);
      if (prev && prev.query === query && prev.ids.join(',') === ids.join(',')) return;
      relevance.set(sid, { ids, query, at: Date.now() });
      if (ids.length) await store.touch(ids).catch(() => {});
    } catch (err) { fail('retrieve', err); }
  }

  function relevantCards(sid, owner) {
    const hit = relevance.get(sid);
    if (hit && hit.ids.length) {
      return hit.ids.map((id) => store.get(id)).filter(Boolean).slice(0, cfg.relevantCards);
    }
    const title = relevance.get(sid)?.query || '';
    return title ? store.search(title, { owner, limit: cfg.relevantCards }).map((h) => h.card) : [];
  }

  function buildText(session) {
    // 注入文本在装配期调用，抛异常会让整轮装配失败，兜底返回空串。
    try {
      return buildTextInner(session);
    } catch (err) {
      fail('prompt-build', err);
      return '';
    }
  }

  function buildTextInner(session) {
    const sid = (session && session.id) || 'unknown';
    const owner = ownerOf(session);
    const s = store.stats();
    const important = store.important(owner, cfg.importantCards);
    const recent = store.recent(owner, cfg.recentCards);
    const relevant = relevantCards(sid, owner);
    const rebirthText = rebirth.forPrompt(sid);
    const key = [s.revision, s.personaRevision, sid, important.map((c) => c.id).join(','), recent.map((c) => c.id).join(','), relevant.map((c) => c.id).join(','), rebirthText ? 'r' : ''].join('|');
    const cached = snapshots.get(key);
    if (cached && Date.now() - cached.at < 30000) return cached.text;

    const text = renderSoulBlock({
      persona: personaCache,
      important,
      recent,
      relevant,
      rebirth: rebirthText,
      maxChars: cfg.promptMaxChars,
      personaMax: cfg.personaMaxChars,
    });
    if (snapshots.size > 40) snapshots.clear();
    snapshots.set(key, { text, at: Date.now() });
    return text;
  }

  function registerSection() {
    if (!cfg.inject) return;
    try {
      if (!ctx.systemPrompt?.section) return;
      ctx.systemPrompt.section({
        name: 'yisheng:identity',
        order: cfg.sectionOrder,
        text: (context) => buildText(context && context.session),
      });
    } catch (err) {
      fail('section', err);
    }
  }

  function registerEvents() {
    ctx.on?.('session/event', (session, event) => {
      try {
        if (!event) return;
        writer.observe(session, event);
        rebirth.observe(session, event);
        const sid = session && session.id;
        if (!sid) return;
        if (event.type === 'user/message') {
          const turns = writer.recentTurns(sid, 1);
          const text = (turns[0] && turns[0].user) || '';
          if (text) void refreshRelevance(session, sid, text);
        }
      } catch (err) { fail('session-event', err); }
    }, { global: true });
  }

  async function boot(toolsReg) {
    await store.ready;
    await rebirth.load();
    personaCache = await store.readPersona();
    // 人格晚于首次装配加载，清掉缓存，下一轮就带上人格
    snapshots.clear();

    loadedVersion = await readVersion();
    const s = store.stats();
    log([
      `就绪 · v${loadedVersion} · 人格 v${s.personaRevision + 1}`,
      `${s.cards} 张卡 / ${s.facts} 条细节`,
      `转生 ${s.rebirths} 次`,
      `工具 ${toolsReg.registered}/${toolsReg.total}`,
      store.dir,
    ].join(' · '));

    if (cfg.rerankModel) void retrieve.warmup().catch(() => {});
  }

  // 注册一律同步做：apply 之后 context 可能变为 inactive，再碰宿主服务就会抛
  // "cannot get required service ... in inactive context"。
  let toolsReg = { registered: 0, total: 0 };
  try {
    registerSection();
    registerEvents();
    toolsReg = registerTools(ctx, store, cfg, log, fail, rebirth);
    registerCommand(ctx, store, cfg, log, fail, rebirth);
  } catch (err) {
    fail('register', err);
  }

  boot(toolsReg).then(() => debugMark(`boot-ok v${loadedVersion}`)).catch((err) => {
    debugMark(`boot-fail v${loadedVersion}: ${err && err.message}`);
    fail('boot', err);
  });

  ctx.on?.('dispose', () => { void writer.dispose().catch(() => {}); });

  return {
    store,
    writer,
    retrieve,
    rebirth,
    buildText,
    renderStatus,
    flush: () => writer.dispose(),
  };
}
