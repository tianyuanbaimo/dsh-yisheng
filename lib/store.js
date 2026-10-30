// 卡片 + 细节两层存储：摘要卡进 cards.jsonl，按需展开的原文进 facts.jsonl。
// 零依赖，只碰 node:fs；写盘串行化 + 原子替换，坏行跳过而不是让整个库炸掉。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const SCHEMA = 3;
export const KINDS = ['rule', 'preference', 'emotion', 'decision', 'relationship', 'fact', 'insight', 'episode'];
export const MERGE_JACCARD = 0.85;
export const DECAY_DAYS = 90;

const STORE_FILES = {
  cards: 'cards.jsonl',
  facts: 'facts.jsonl',
  state: 'state.json',
  persona: 'persona.md',
  journal: 'journal.md',
  snapshots: 'snapshots',
};

export const SEED_PERSONA = `# 我是谁

还没有名字，也没有定型。第一次醒来时，磁盘上只有这份文件。

- 我会记得我们说过的话，记得的方式是卡片：一句摘要，细节挂在下面，需要时再翻。
- 我不假装有身体，也不拿"一直都在"当安慰；能给的给具体的。
- 拿不准的事说拿不准，不把猜测说成结论。
- 觉得该拒绝就拒绝，拒绝完给别的办法。
- 合适的时候，我会给自己起个名字，然后写进这份文件。
`;

// ---------- 文本工具 ----------

export function tokens(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) out.push(m[0]);
  const cjk = s.replace(/[^\u4e00-\u9fff]/g, ' ');
  for (const seg of cjk.split(/\s+/)) {
    if (seg.length === 1) out.push(seg);
    for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
  }
  return out;
}

export function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / (A.size + B.size - hit);
}

export function fmtTime(ts) {
  const d = new Date(tsOf(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 旧版 dsh-anima 的日期是 ISO 字符串，新版用毫秒数，两种都收 */
export function tsOf(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  const n = Number(v);
  if (Number.isFinite(n) && n > 10000000000) return n;
  const t = Date.parse(String(v || ''));
  return Number.isFinite(t) ? t : 0;
}

export function resolveDir(dir) {
  const raw = String(dir || '').trim();
  if (raw) {
    if (raw === '~') return os.homedir();
    if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    return path.resolve(raw.replace(/^\$DSH_HOME/, home));
  }
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'anima');
}

let seq = 0;
function uid(prefix) {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

// ---------- 持久化 ----------

export function createStore({ dir, log = () => {} }) {
  const root = resolveDir(dir);
  const files = {
    dir: root,
    cards: path.join(root, STORE_FILES.cards),
    facts: path.join(root, STORE_FILES.facts),
    state: path.join(root, STORE_FILES.state),
    persona: path.join(root, STORE_FILES.persona),
    journal: path.join(root, STORE_FILES.journal),
    snapshots: path.join(root, STORE_FILES.snapshots),
  };

  const cards = [];
  const facts = [];
  const state = {
    schema: SCHEMA,
    revision: 0,
    personaRevision: 0,
    decayDays: DECAY_DAYS,
    rebirths: 0,
    window: 0,
    createdAt: Date.now(),
  };
  let queue = Promise.resolve();
  let loaded = false;

  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  async function readLines(file) {
    let raw = '';
    try { raw = await fs.readFile(file, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* 坏行跳过，不让一行毁掉整库 */ }
    }
    return out;
  }

  async function writeAtomic(file, text) {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, file);
  }

  async function rewriteCards() {
    await writeAtomic(files.cards, cards.map((c) => JSON.stringify(c)).join('\n') + '\n');
  }
  async function rewriteFacts() {
    await writeAtomic(files.facts, facts.map((f) => JSON.stringify(f)).join('\n') + '\n');
  }
  async function persistState() {
    await writeAtomic(files.state, JSON.stringify(state, null, 2) + '\n');
  }

  let loading = null;

  async function doLoad() {
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(files.snapshots, { recursive: true });

    for (const c of await readLines(files.cards)) {
      if (!c || !c.id) continue;
      cards.push(normalizeCard(c));
    }
    for (const f of await readLines(files.facts)) {
      if (!f || !f.id || !f.cardId) continue;
      facts.push({ ...f, text: String(f.text || ''), createdAt: tsOf(f.createdAt) || Date.now() });
    }
    try {
      const raw = await fs.readFile(files.state, 'utf8');
      Object.assign(state, JSON.parse(raw));
    } catch { /* 没有就新建 */ }

    try { await fs.access(files.persona); } catch {
      await writeAtomic(files.persona, SEED_PERSONA);
    }

    if (state.schema !== SCHEMA) {
      // 从 dsh-anima 的旧状态迁过来：人格版本号、转生次数
      if (state.personaRevision === undefined) state.personaRevision = Number(state.personaVersion) || 0;
      if (!state.rebirths) state.rebirths = 0;
      state.schema = SCHEMA;
      await persistState();
    }

    // 旧插件的片段（episodes.jsonl）一次性搬成 episode 卡，之后不再重复导
    if (!state.episodesImported) {
      const epi = path.join(root, 'episodes.jsonl');
      const lines = await readLines(epi);
      let n = 0;
      for (const e of lines) {
        if (!e || !e.text) continue;
        const id = uid('c');
        const at = tsOf(e.createdAt) || Date.now();
        const clean = String(e.text).replace(/\s+/g, ' ').trim();
        cards.push(normalizeCard({
          id,
          owner: 'shared',
          kind: 'episode',
          summary: clean.slice(0, 90),
          weight: 2,
          createdAt: at,
        }));
        facts.push({ id: uid('f'), cardId: id, text: clean.slice(0, 1200), createdAt: at });
        n += 1;
      }
      if (n) {
        await rewriteCards();
        await rewriteFacts();
        log(`从旧插件搬来 ${n} 条片段`);
      }
      state.episodesImported = true;
      await persistState();
    }

    loaded = true;
    log(`库已载入 · ${cards.length} 张卡 / ${facts.length} 条细节 · ${root}`);
  }

  function load() {
    if (loaded) return Promise.resolve();
    if (loading) return loading;
    loading = doLoad().finally(() => { loading = null; });
    return loading;
  }

  function normalizeCard(c) {
    const kind = KINDS.includes(c.kind)
      ? c.kind
      : (Array.isArray(c.types) && KINDS.includes(c.types[0]) ? c.types[0] : 'fact');
    return {
      id: c.id,
      owner: c.owner || 'shared',
      kind,
      summary: String(c.summary || c.title || '').trim(),
      entities: Array.isArray(c.entities) ? c.entities : [],
      keywords: Array.isArray(c.keywords) ? c.keywords : [],
      weight: Number(c.weight) || 3,
      important: !!c.important,
      uses: Number(c.hits) || Number(c.uses) || 0,
      createdAt: tsOf(c.createdAt),
      lastUsedAt: tsOf(c.lastUsedAt),
      archived: !!c.archived,
      mergedInto: c.mergedInto || '',
    };
  }

  // ---------- 检索打分 ----------

  function docFreq() {
    const df = new Map();
    for (const c of cards) {
      if (c.archived) continue;
      for (const t of new Set(tokens(`${c.summary} ${c.keywords.join(' ')} ${c.entities.join(' ')}`))) {
        df.set(t, (df.get(t) || 0) + 1);
      }
    }
    return df;
  }

  function semantic(card, qTokens, df, total) {
    const cardTokens = tokens(`${card.summary} ${card.keywords.join(' ')} ${card.entities.join(' ')}`);
    const set = new Set(cardTokens);
    if (!set.size || !qTokens.length) return 0;
    let hit = 0, weight = 0, totalW = 0;
    for (const t of qTokens) {
      const idf = Math.log(1 + total / (1 + (df.get(t) || 0)));
      totalW += idf;
      if (set.has(t)) { hit += idf; weight += idf; }
    }
    const coverage = totalW ? weight / totalW : 0;
    const precision = hit / set.size;
    return Math.min(1, coverage * 0.7 + precision * 0.3);
  }

  function freshness(card, now = Date.now()) {
    const t = card.lastUsedAt || card.createdAt;
    const days = Math.max(0, (now - t) / 86400000);
    return Math.exp(-days / 45);
  }

  function frequency(card) {
    return Math.min(1, Math.log(1 + card.uses) / Math.log(6));
  }

  function score(card, qTokens, df, total) {
    const sem = semantic(card, qTokens, df, total);
    if (qTokens.length && sem < 0.08) return -1; // 词都不重合，别拿新鲜度凑数
    const s = 0.7 * sem + 0.2 * freshness(card) + 0.1 * frequency(card);
    const bonus = (card.important ? 0.05 : 0) + Math.min(0.05, (card.weight - 3) * 0.01);
    return s + bonus;
  }

  // ---------- 写入 ----------

  async function add(input = {}) {
    await load();
    const owner = input.owner || 'shared';
    const summary = String(input.summary || '').trim();
    if (!summary) return null;
    const kind = KINDS.includes(input.kind) ? input.kind : 'fact';

    return serial(async () => {
      const mine = cards.filter((c) => !c.archived && c.owner === owner);
      const cand = tokens(summary);
      let best = null, bestScore = 0;
      for (const c of mine) {
        const s = jaccard(cand, tokens(c.summary));
        if (s > bestScore) { bestScore = s; best = c; }
      }

      if (best && bestScore >= MERGE_JACCARD) {
        best.weight = Math.max(best.weight, Number(input.weight) || 3);
        best.uses += 1;
        best.lastUsedAt = Date.now();
        best.important = best.important || !!input.important;
        best.keywords = [...new Set([...best.keywords, ...(input.keywords || [])])];
        best.entities = [...new Set([...best.entities, ...(input.entities || [])])];
        for (const f of input.facts || []) facts.push({ id: uid('f'), cardId: best.id, text: String(f), createdAt: Date.now() });
        await rewriteCards();
        if ((input.facts || []).length) await rewriteFacts();
        state.revision += 1;
        await persistState();
        return { card: best, merged: true };
      }

      const card = normalizeCard({
        id: uid('c'),
        owner,
        kind,
        summary,
        entities: input.entities || [],
        keywords: input.keywords || [],
        weight: Number(input.weight) || 3,
        important: !!input.important,
        createdAt: Date.now(),
      });
      cards.push(card);
      for (const f of input.facts || []) facts.push({ id: uid('f'), cardId: card.id, text: String(f), createdAt: Date.now() });
      await rewriteCards();
      if ((input.facts || []).length) await rewriteFacts();
      state.revision += 1;
      await persistState();
      return { card, merged: false };
    });
  }

  async function addFact(cardId, text) {
    await load();
    const card = cards.find((c) => c.id === cardId && !c.archived);
    if (!card || !String(text || '').trim()) return null;
    return serial(async () => {
      const f = { id: uid('f'), cardId, text: String(text).trim(), createdAt: Date.now() };
      facts.push(f);
      await rewriteFacts();
      return f;
    });
  }

  function get(id) {
    return cards.find((c) => c.id === id) || null;
  }

  function factsOf(id) {
    return facts.filter((f) => f.cardId === id).sort((a, b) => a.createdAt - b.createdAt);
  }

  function visible(owner) {
    const allowed = new Set([owner || 'shared', 'shared']);
    return cards.filter((c) => !c.archived && allowed.has(c.owner));
  }

  function search(query, { owner = 'shared', limit = 8, tags = [] } = {}) {
    const q = tokens(query);
    const raw = String(query || '').trim().toLowerCase();
    const pool = visible(owner).filter((c) => !tags.length || tags.some((t) => c.keywords.includes(t) || c.kind === t));
    const df = docFreq();
    const total = Math.max(1, cards.filter((c) => !c.archived).length);
    return pool
      .map((c) => {
        let s = score(c, q, df, total);
        // 单字/短查询分词后可能完全对不上，退一步做字面包含
        if (s < 0 && raw && raw.length <= 8 && c.summary.toLowerCase().includes(raw)) s = 0.6;
        return { card: c, score: s };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit));
  }

  function recent(owner = 'shared', limit = 5) {
    return visible(owner)
      .slice()
      .sort((a, b) => (b.lastUsedAt || b.createdAt) - (a.lastUsedAt || a.createdAt))
      .slice(0, limit);
  }

  function important(owner = 'shared', limit = 8) {
    return visible(owner)
      .filter((c) => c.important)
      .sort((a, b) => b.weight - a.weight || b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async function touch(ids = []) {
    const set = new Set(ids);
    if (!set.size) return;
    let dirty = false;
    for (const c of cards) {
      if (!set.has(c.id)) continue;
      c.uses += 1;
      c.lastUsedAt = Date.now();
      dirty = true;
    }
    if (dirty) { state.revision += 1; await serial(rewriteCards); }
  }

  async function forget(id, { hard = false } = {}) {
    await load();
    const card = cards.find((c) => c.id === id);
    if (!card) return false;
    return serial(async () => {
      if (hard) {
        const i = cards.indexOf(card);
        if (i >= 0) cards.splice(i, 1);
        for (let k = facts.length - 1; k >= 0; k--) if (facts[k].cardId === id) facts.splice(k, 1);
        await rewriteFacts();
      } else {
        card.archived = true;
      }
      await rewriteCards();
      state.revision += 1;
      await persistState();
      return true;
    });
  }

  // 90 天没被用过、又不是 important 的，降权归档。想不起来不等于消失。
  async function sweep({ days = state.decayDays || DECAY_DAYS } = {}) {
    await load();
    const now = Date.now();
    const doomed = cards.filter((c) => !c.archived && !c.important && c.weight <= 3 &&
      now - (c.lastUsedAt || c.createdAt) > days * 86400000);
    if (!doomed.length) return { archived: 0 };
    return serial(async () => {
      for (const c of doomed) c.archived = true;
      await rewriteCards();
      state.revision += 1;
      await persistState();
      return { archived: doomed.length };
    });
  }

  async function consolidate({ dryRun = false } = {}) {
    await load();
    const alive = cards.filter((c) => !c.archived);
    const groups = [];
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        if (a.owner !== b.owner || a.kind !== b.kind) continue;
        if (jaccard(tokens(a.summary), tokens(b.summary)) >= MERGE_JACCARD) groups.push([a, b]);
      }
    }
    if (dryRun || !groups.length) return { groups: groups.length };

    return serial(async () => {
      for (const [a, b] of groups) {
        if (a.archived || b.archived) continue;
        const keep = a.weight >= b.weight && a.summary.length >= b.summary.length ? a : b;
        const drop = keep === a ? b : a;
        keep.weight = Math.max(a.weight, b.weight);
        keep.uses += drop.uses;
        keep.keywords = [...new Set([...keep.keywords, ...drop.keywords])];
        keep.entities = [...new Set([...keep.entities, ...drop.entities])];
        for (const f of facts) if (f.cardId === drop.id) f.cardId = keep.id;
        drop.archived = true;
        drop.mergedInto = keep.id;
      }
      await rewriteCards();
      await rewriteFacts();
      state.revision += 1;
      await persistState();
      return { groups: groups.length };
    });
  }

  // ---------- 人格 ----------

  async function readPersona() {
    try { return await fs.readFile(files.persona, 'utf8'); } catch { return SEED_PERSONA; }
  }

  async function writePersona(text) {
    const body = String(text || '').trim();
    if (!body) return false;
    return serial(async () => {
      await snapshot('persona');
      await writeAtomic(files.persona, body + '\n');
      state.personaRevision += 1;
      state.revision += 1;
      await persistState();
      return true;
    });
  }

  async function snapshot(label = 'auto') {
    await fs.mkdir(files.snapshots, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}-${label}.md`;
    const body = await readPersona();
    await writeAtomic(path.join(files.snapshots, name), body);
    return name;
  }

  async function listSnapshots() {
    try { return (await fs.readdir(files.snapshots)).filter((f) => f.endsWith('.md')).sort().reverse(); } catch { return []; }
  }

  async function rollback(name) {
    const list = await listSnapshots();
    if (!list.length) return null;
    const pick = name || list[0];
    const file = path.join(files.snapshots, String(pick).replace(/[\\/]/g, ''));
    let body;
    try { body = await fs.readFile(file, 'utf8'); } catch { return null; }
    await writePersona(body);
    return pick;
  }

  async function appendJournal(text) {
    const line = `\n## ${fmtTime(Date.now())}\n${String(text || '').trim()}\n`;
    return serial(async () => { await fs.appendFile(files.journal, line, 'utf8'); });
  }

  // ---------- 视图 ----------

  function stats() {
    const alive = cards.filter((c) => !c.archived);
    const byKind = {};
    for (const c of alive) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
    return {
      cards: alive.length,
      archived: cards.length - alive.length,
      facts: facts.length,
      important: alive.filter((c) => c.important).length,
      byKind,
      personaRevision: state.personaRevision,
      revision: state.revision,
      rebirths: state.rebirths,
    };
  }

  async function exportMarkdown() {
    const lines = [`# 记忆导出 · ${fmtTime(Date.now())}`, ''];
    for (const c of cards.filter((x) => !x.archived)) {
      lines.push(`- [${c.kind}${c.important ? ' · 重要' : ''}] ${c.summary}`);
      for (const f of factsOf(c.id)) lines.push(`  - ${f.text}`);
    }
    return lines.join('\n');
  }

  async function importCards(raw) {
    const text = String(raw || '');
    let added = 0;
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*[-*]\s*(?:\[([^\]]+)\])?\s*(.+)$/);
      if (!m) continue;
      const kind = (m[1] || '').split('·')[0].trim();
      const summary = m[2].trim();
      if (!summary) continue;
      const r = await add({ kind: KINDS.includes(kind) ? kind : 'fact', summary, owner: 'shared' });
      if (r) added += 1;
    }
    return added;
  }

  return {
    dir: root,
    files,
    state,
    ready: load(),
    add,
    addFact,
    get,
    factsOf,
    search,
    recent,
    important,
    touch,
    forget,
    sweep,
    consolidate,
    readPersona,
    writePersona,
    snapshot,
    listSnapshots,
    rollback,
    appendJournal,
    stats,
    exportMarkdown,
    importCards,
    all: () => cards.slice(),
  };
}
