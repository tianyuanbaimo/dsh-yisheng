// 转生：上下文快满的时候，把这一段提炼成一张交接卡，然后开一段新会话。
// 新会话第一轮会读到"上一次转世留下的"，之后不再重复。
import { promises as fs } from 'node:fs';
import path from 'node:path';

const REBIRTH_DIR = 'rebirths';

export function createRebirth({ ctx, store, writer, cfg, log = () => {} }) {
  const state = { rebirths: 0, last: null, window: 0 };
  const injected = new Set();
  let busy = false;

  function file(name) {
    return path.join(store.dir, name);
  }

  async function load() {
    try {
      const raw = await fs.readFile(file('rebirths.jsonl'), 'utf8');
      const rows = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      state.rebirths = rows.length;
      state.last = rows[rows.length - 1] || null;
    } catch { /* 还没有转生过 */ }
  }

  // 只走同步接口。宿主 llm.resolveModelInfo() 是 async 的：它在同步 try/catch 里抛出
  // 只会变成 rejected Promise，没人接就是 unhandledRejection，Node 24 直接结束进程——
  // 之前宿主崩溃（NO_ADAPTER，provider "undefined"）就是这么来的。窗口大小改从
  // request/context 事件里白拿，绝不主动问 llm。
  function capacity() {
    try {
      const meter = ctx.get && ctx.get('tokenMeter');
      if (meter && typeof meter.capacity === 'function') {
        const c = meter.capacity();
        if (typeof c === 'number' && Number.isFinite(c) && c > 0) return c;
        if (c && typeof c.then === 'function') c.catch(() => {});
      }
    } catch { /* 拿不到就退到事件里记的窗口 */ }
    return state.window || 0;
  }

  function used(session) {
    const meter = ctx.get && ctx.get('tokenMeter');
    if (meter && typeof meter.measure === 'function') {
      try {
        const m = meter.measure(session);
        if (m && Number.isFinite(m.totalTokens)) return Number(m.totalTokens);
      } catch { /* 往下走 */ }
    }
    return 0;
  }

  function ratio(session) {
    const cap = capacity();
    const u = used(session);
    if (!cap || !u) return { ratio: 0, used: u, cap, known: false };
    return { ratio: u / cap, used: u, cap, known: true };
  }

  async function summarize(session) {
    const sid = (session && session.id) || 'shared';
    const turns = writer ? writer.recentTurns(sid, 10) : [];
    const lines = [];
    for (const t of turns) {
      if (t.user) lines.push(`用户：${t.user.slice(0, 200)}`);
      if (t.assistant) lines.push(`我：${t.assistant.slice(0, 200)}`);
    }
    const cards = store.recent('shared', 6).map((c) => `- [${c.kind}] ${c.summary}`).join('\n');
    const must = store.important('shared', 5).map((c) => `- ${c.summary}`).join('\n');
    const markdown = [
      `# 转生交接 · ${new Date().toISOString()}`,
      '',
      '## 这段在做什么',
      lines.slice(0, 20).join('\n') || '（这一段没有留下可提炼的对话）',
      '',
      '## 最近的记忆卡',
      cards || '（没有）',
      '',
      '## 必须守住的',
      must || '（没有）',
    ].join('\n');
    return markdown;
  }

  async function force(session, reason = 'manual') {
    if (busy) return null;
    busy = true;
    try {
      const sid = (session && session.id) || 'shared';
      const markdown = await summarize(session);
      const rec = { id: `r-${Date.now().toString(36)}`, at: Date.now(), reason, session: sid, markdown };
      await fs.mkdir(path.join(store.dir, REBIRTH_DIR), { recursive: true });
      await fs.appendFile(file('rebirths.jsonl'), JSON.stringify({ id: rec.id, at: rec.at, reason, session: sid }) + '\n', 'utf8');
      await fs.writeFile(path.join(store.dir, REBIRTH_DIR, `${new Date(rec.at).toISOString().replace(/[:.]/g, '-')}-${rec.id}.md`), markdown, 'utf8');

      // 交接本身也留一张卡，即使某些会话读不到转生文件也不会断线
      try {
        await store.add({
          summary: `转生交接（${reason}）：${markdown.split('\n').slice(3, 5).join(' ').slice(0, 80) || '上一段会话已收束'}`,
          kind: 'insight',
          facts: [markdown.slice(0, 800)],
          keywords: ['转生', '交接'],
          weight: 4,
          important: false,
          owner: 'shared',
        });
      } catch (err) { log(`转生交接卡写入失败：${err && err.message}`); }

      await store.appendJournal(`转生（${reason}）：上下文用到 ${Math.round((ratio(session).ratio || 0) * 100)}%`).catch(() => {});

      state.rebirths += 1;
      state.last = { id: rec.id, at: rec.at, markdown };
      if (writer) await writer.flush(sid, 'rebirth').catch(() => {});

      let spawned = null;
      const sessions = ctx.get && ctx.get('sessions');
      if (cfg.rebirthNewSession !== false && sessions && typeof sessions.create === 'function') {
        try {
          const next = await sessions.create({ title: '转生后的新会话' });
          spawned = next && (next.id || next.sessionId) || null;
        } catch (err) { log(`新会话创建失败：${err && err.message}`); }
      }
      log(`转生完成 · ${rec.id} · 新会话 ${spawned || '未创建'}`);
      return { ...rec, spawned };
    } finally {
      busy = false;
    }
  }

  function observe(session, event) {
    if (!event) return;
    // 这个函数挂在 session/event 上，抛异常会被宿主当成 fatal load failure 直接退出。
    try {
      // 顺手记下宿主自己报的窗口大小，之后算水位就不用去问 llm（那是 async 的）。
      if (event.type === 'request/context') {
        const w = Number(event.data && event.data.contextWindow);
        if (Number.isFinite(w) && w > 0) state.window = w;
        return;
      }
      if (cfg.autoRebirth === false) return;
      if (event.type !== 'user/message' && event.type !== 'turn/end') return;
      const r = ratio(session);
      if (!r.known) return;
      if (r.used >= (Number(cfg.rebirthAt) || 32000)) {
        // 延后一拍，让这一轮先落进 writer 的缓冲
        setTimeout(() => { void force(session, 'auto').catch(() => {}); }, 50);
      }
    } catch (err) {
      log(`水位检查失败：${err && err.message}`);
    }
  }

  function forPrompt(sid) {
    if (!state.last) return '';
    const id = String(sid || '');
    if (injected.has(id)) return '';
    injected.add(id);
    return state.last.markdown;
  }

  return { load, force, observe, forPrompt, ratio, capacity, getStats: () => ({ rebirths: state.rebirths, last: state.last && state.last.id }) };
}
