// 读取：三路注入（灵魂设定另算）+ 重排。重排是可选的本地模型，
// 没配就退回三因子打分；配了就 2 秒超时、结果缓存、失败降级，绝不把对话卡住。
export function createRetrieve({ store, cfg, log = () => {} }) {
  const cache = new Map();
  const TTL = 10 * 60 * 1000;
  const MAX = 100;
  const stats = { picks: 0, rerank: 0, hits: 0, degraded: 0, warmup: false };

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > TTL) { cache.delete(key); return null; }
    return hit.value;
  }
  function cacheSet(key, value) {
    if (cache.size >= MAX) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
    cache.set(key, { at: Date.now(), value });
  }

  async function callRerank(query, items) {
    const list = items.map((x, i) => `${i + 1}. ${x.card.summary}`).join('\n');
    const prompt = [
      '按和问题的相关程度给候选记忆排序，只输出 JSON：{"order":[序号数组]}，从最相关到最不相关，全部列出。',
      `问题：${query}`,
      '候选：',
      list,
    ].join('\n');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.rerankTimeoutMs || 2000);
    const t0 = Date.now();
    try {
      const res = await fetch(`${cfg.rerankBase.replace(/\/$/, '')}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.rerankModel, prompt, stream: false, format: 'json' }),
        signal: ctrl.signal,
      });
      if (!res.ok) return { ok: false, reason: `http-${res.status}`, ms: Date.now() - t0 };
      const json = await res.json();
      const parsed = JSON.parse(json.response || '{}');
      const order = Array.isArray(parsed.order) ? parsed.order.map((n) => Number(n) - 1) : [];
      const picked = order.map((i) => items[i]).filter(Boolean);
      if (!picked.length) return { ok: false, reason: 'empty-order', ms: Date.now() - t0 };
      for (const x of items) if (!picked.includes(x)) picked.push(x);
      return { ok: true, items: picked, ms: Date.now() - t0 };
    } catch (err) {
      return { ok: false, reason: err && err.name === 'AbortError' ? 'timeout' : 'error', ms: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  }

  async function pick(query, { owner = 'shared', topK } = {}) {
    stats.picks += 1;
    const q = String(query || '').trim();
    const importantCards = store.important(owner, cfg.importantCards || 8);
    const recentCards = store.recent(owner, cfg.recentCards || 5);

    let candidates = [];
    if (q) candidates = store.search(q, { owner, limit: 10 });
    else candidates = store.recent(owner, 10).map((card) => ({ card, score: 0.5 }));

    let relevant = candidates.slice(0, topK || cfg.relevantCards || 3);
    let degraded = null;

    if (q && candidates.length > 1 && cfg.rerankModel) {
      const key = `${owner}|${q}|${candidates.map((x) => x.card.id).join(',')}`;
      const cached = cacheGet(key);
      if (cached) {
        relevant = cached.slice(0, topK || cfg.relevantCards || 3);
        stats.hits += 1;
      } else {
        const r = await callRerank(q, candidates);
        if (r.ok) {
          relevant = r.items.slice(0, topK || cfg.relevantCards || 3);
          cacheSet(key, relevant);
          stats.rerank += 1;
        } else {
          degraded = r.reason;
          stats.degraded += 1;
        }
      }
    }

    const same = (a, b) => a.id === b.id;
    const dedupe = (list) => {
      const seen = new Set();
      return list.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
    };
    const rel = dedupe(relevant.map((x) => x.card));
    const imp = dedupe(importantCards).filter((c) => !rel.some((r) => same(c, r)));
    const rec = dedupe(recentCards).filter((c) => !rel.some((r) => same(c, r)) && !imp.some((r) => same(c, r)));

    return { important: imp, recent: rec, relevant: rel, degraded, candidates: candidates.length };
  }

  async function warmup() {
    if (!cfg.rerankModel) return false;
    try {
      await fetch(`${cfg.rerankBase.replace(/\/$/, '')}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.rerankModel, prompt: 'ok', stream: false, options: { num_predict: 1 } }),
      });
      stats.warmup = true;
      log('重排模型已预热');
      return true;
    } catch {
      log('重排模型预热失败，走降级');
      return false;
    }
  }

  return { pick, warmup, stats, getStats: () => ({ ...stats }) };
}
