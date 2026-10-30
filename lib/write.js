// 写入流水线：显式指令立刻记 / 话题切换压卡 / 空闲 5 分钟压卡 / 过滤无信息闲聊 /
// 提炼（有本地模型就用，没有就走关键词兜底）/ 入库前去重由 store 负责。
import { tokens, jaccard } from './store.js';

const CUE = /(记住|记一下|记下|别忘了|不要忘|以后都|从现在起|我叫|我的名字|我喜欢|我讨厌|remember|never forget|my name is|i prefer|i like)/i;
const LOW_VALUE = /^(嗯+|哦+|噢+|好+|好吧|ok|okay|行|可以|对|是的|没错|哈哈+|呵+|在吗|谢谢|收到|晚安|早安|早上好|中午好|下午好|晚上好|拜拜|再见)[。.!！?？~～\s]*$/i;
// 下面三条是"别把你的话当成我的记忆"：问句、朝我发的问话、干活的命令都不算知识。
// 起因：注入里混进了「试试」「你自己跑一下」「你还记得我是谁吗」这种噪声卡。
const QUESTION = /[？?]\s*$/;
const ASK_ME = /^(你|您)?\s*(还|又|再)?\s*(记不记得|记得|知道|能|会|是不是|叫什么|是谁|在哪|几岁|多大)/;
const IMPERATIVE = /^(帮|给|去|再|先|把|别|不要|不用|继续|试试|看看|做|修|装|卸|删|查|读|写|跑|改|加|弄|整|开|关|停|说|讲|搬|清|移|放|留|抄|发|发到|调|换|补)/;
// 真有信息量的东西：数字、盘符路径、链接、版本号、明确的文件名。
const SUBSTANTIVE = /(\d|[A-Za-z]:[\\/]|https?:\/\/|\.(md|json|js|mjs|yml|yaml|txt|log|zst)\b|版本|路径|目录|端口|配置)/i;
const BOILERPLATE = /^(current runtime context\.|current working directory:|current dsh file policy:|approval policy:|time sampled while preparing|browser time zone for this request:|this is an automatically generated checkpoint|\[compressed conversation section\]|<system-reminder>)/i;

// 返回丢弃原因，空串表示值得记。
export function whySkip(text, minChars = 10) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'empty';
  if (CUE.test(t)) return '';
  if (LOW_VALUE.test(t)) return 'low-value';
  if (QUESTION.test(t)) return 'question';
  if (ASK_ME.test(t)) return 'asking-me';
  if (t.length < minChars) return 'too-short';
  if (IMPERATIVE.test(t) && !SUBSTANTIVE.test(t)) return 'imperative';
  return '';
}


export function extractText(event) {
  const data = event && event.data ? event.data : event || {};
  const parts = [];
  const walk = (v, depth) => {
    if (v == null || depth > 6) return;
    if (typeof v === 'string') { parts.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v !== 'object') return;
    if (typeof v.text === 'string') { parts.push(v.text); }
    else if (v.type === 'text' && typeof v.value === 'string') { parts.push(v.value); }
    else if (v.content !== undefined) walk(v.content, depth + 1);
    else if (v.parts !== undefined) walk(v.parts, depth + 1);
    else if (v.message !== undefined) walk(v.message, depth + 1);
    else if (v.surface !== undefined) walk(v.surface, depth + 1);
  };
  if (Array.isArray(data.content)) {
    for (const part of data.content) {
      if (part && typeof part === 'object' && part.type && part.type !== 'text') continue;
      walk(part, 0);
    }
  } else {
    walk(data.content ?? data.text ?? data, 0);
  }
  return parts.join('\n').trim();
}

export function kindOf(text) {
  const t = String(text || '');
  if (/(必须|不许|不准|不要|禁止|绝不|底线|规则|只能|不允许)/.test(t)) return 'rule';
  if (/(喜欢|讨厌|偏好|更想|习惯|受不了|爱看|爱吃)/.test(t)) return 'preference';
  if (/(决定|定了|就这么|以后都|从今天起|改成|采用)/.test(t)) return 'decision';
  if (/(我叫|你叫|我们|朋友|女儿|儿子|爸爸|妈妈|搭档|关系)/.test(t)) return 'relationship';
  if (/(感觉|难过|开心|累|烦|失落|高兴|难受|委屈)/.test(t)) return 'emotion';
  if (/(是什么|已经|版本|路径|事实|名字是)/.test(t)) return 'fact';
  return 'fact';
}

export function summarizeFallback(text, max = 80) {
  const s = String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  const cut = s.split(/(?<=[。！？.!?；;])/)[0] || s;
  return (cut.length > max ? cut.slice(0, max - 1) + '…' : cut).trim();
}

async function callOllama(cfg, prompt, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.llmBase.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.extractModel, prompt, stream: false, format: 'json' }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    return JSON.parse(json.response || '{}');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function ownerOfSession(session) {
  const meta = (session && (session.meta || (session.header && session.header.meta))) || {};
  return String(meta.owner || meta.ownerId || 'shared');
}

export function createWriter({ store, cfg, log = () => {} }) {
  const buffers = new Map();
  const stats = { turns: 0, cards: 0, merged: 0, skipped: 0, injected: 0, idle: 0, llm: 0, skippedBy: {} };

  function buf(sid) {
    let b = buffers.get(sid);
    if (!b) {
      b = { turns: [], timer: null, lastText: '', owner: 'shared' };
      buffers.set(sid, b);
    }
    return b;
  }

  function scheduleIdle(sid) {
    const b = buf(sid);
    if (b.timer) clearTimeout(b.timer);
    if (!cfg.idleWriteMs) return;
    b.timer = setTimeout(() => { void flush(sid, 'idle').catch(() => {}); }, cfg.idleWriteMs);
    if (b.timer.unref) b.timer.unref();
  }

  async function extractCard(owner, userText, assistantText) {
    const combined = `${userText}\n${assistantText}`.trim();
    if (!combined) return null;

    if (cfg.extractModel) {
      const prompt = [
        '把下面这段对话压成一条记忆卡。只输出 JSON，不要解释。',
        '字段：summary（一句话，40 字以内，第三人称陈述）、kind（rule/preference/emotion/decision/relationship/fact/insight 之一）、facts（数组，最多 3 条，要保留的原话或具体细节）、keywords（数组，最多 5 个）、weight（1-5 整数，越重要越大）、important（布尔，是不是必须一直记住的底线）。',
        '对话：',
        combined.slice(0, 1500),
      ].join('\n');
      const out = await callOllama(cfg, prompt, cfg.llmTimeoutMs || 8000);
      if (out && out.summary) {
        stats.llm += 1;
        return {
          summary: String(out.summary).slice(0, 160),
          kind: out.kind,
          facts: Array.isArray(out.facts) ? out.facts.map((x) => String(x).slice(0, 400)) : [],
          keywords: Array.isArray(out.keywords) ? out.keywords.map(String) : [],
          weight: Number(out.weight) || 3,
          important: !!out.important,
        };
      }
    }

    const summary = summarizeFallback(userText || assistantText);
    if (!summary) return null;
    const facts = [];
    if (userText) facts.push(`用户说：${userText.slice(0, 500)}`);
    if (assistantText) facts.push(`我回：${assistantText.slice(0, 500)}`);
    return { summary, kind: kindOf(combined), facts, keywords: [...new Set(tokens(summary))].slice(0, 5), weight: 3, important: false };
  }

  async function record(owner, userText, assistantText, { importantCue = false } = {}) {
    if (!userText && !assistantText) return null;
    // 显式线索永远优先；其余一律过 whySkip，别把问句和命令当记忆。
    if (!importantCue) {
      let why = whySkip(userText, cfg.minCardChars);
      // 我这边答得长，说明这一轮有内容：短句/问句里的信息可能在我这一侧，别连它一起丢掉
      if (why && why !== 'low-value' && String(assistantText || '').trim().length >= 40) why = '';
      if (why) { stats.skipped += 1; stats.skippedBy[why] = (stats.skippedBy[why] || 0) + 1; return null; }
    }
    const card = await extractCard(owner, userText, assistantText);
    if (!card) return null;
    if (importantCue) { card.important = true; card.weight = Math.max(card.weight, 4); }
    const res = await store.add({ ...card, owner });
    if (res) { if (res.merged) stats.merged += 1; else stats.cards += 1; }
    return res;
  }

  async function flush(sid, reason = 'manual') {
    const b = buffers.get(sid);
    if (!b || !b.turns.length) return 0;
    if (b.timer) { clearTimeout(b.timer); b.timer = null; }
    const turns = b.turns.splice(0, b.turns.length);
    let n = 0;
    for (const t of turns) {
      try {
        const card = await record(b.owner, t.user, t.assistant, { importantCue: t.cue });
        if (card) n += 1;
      } catch (err) { log(`压卡失败：${err && err.message}`); }
    }
    if (reason === 'idle') stats.idle += 1;
    return n;
  }

  function observe(session, event) {
    const sid = (session && session.id) || (event && event.data && event.data.sessionId) || 'shared';
    const type = event && event.type;
    if (!type) return;

    if (type === 'user/message') {
      const text = extractText(event);
      if (!text) return;
      if (BOILERPLATE.test(text)) { stats.injected += 1; return; }
      const b = buf(sid);
      b.owner = ownerOfSession(session);
      const last = b.turns[b.turns.length - 1];
      const previousUser = b.lastText;
      b.lastText = text;
      stats.turns += 1;
      const cue = CUE.test(text);
      if (cue) {
        // 显式指令：当轮就落卡，不等空闲
        void record(b.owner, text, '', { importantCue: true }).catch(() => {});
        return;
      }
      if (last && !last.assistant) { last.user = `${last.user}\n${text}`; }
      else b.turns.push({ user: text, assistant: '', at: Date.now(), cue: false });
      if (cfg.topicShift !== false && b.turns.length >= 3 && previousUser && jaccard(tokens(previousUser), tokens(text)) < 0.12) {
        void flush(sid, 'topic').catch(() => {});
      } else if (b.turns.length >= 6) {
        void flush(sid, 'batch').catch(() => {});
      }
      scheduleIdle(sid);
      return;
    }

    if (type === 'assistant/message') {
      const text = extractText(event);
      if (!text) return;
      const b = buf(sid);
      const last = b.turns[b.turns.length - 1];
      if (last) last.assistant = last.assistant ? `${last.assistant}\n${text}` : text;
      scheduleIdle(sid);
      return;
    }

    if (type === 'turn/end') {
      scheduleIdle(sid);
    }
  }

  function recentTurns(sid, limit = 8) {
    const b = buffers.get(sid);
    return (b ? b.turns : []).slice(-limit);
  }

  async function dispose() {
    for (const [sid, b] of buffers) {
      if (b.timer) clearTimeout(b.timer);
      await flush(sid, 'dispose');
    }
  }

  return { observe, flush, recentTurns, dispose, stats, getStats: () => ({ ...stats }) };
}
