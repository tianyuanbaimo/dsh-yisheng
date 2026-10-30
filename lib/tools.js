// 给模型用的工具 + 给人用的 /life 命令。工具名留在 life_* 前缀，
// 命令名是 life（宿主要求小写、可含字母数字与 _ -）。
import { promises as fs } from 'node:fs';

const text = (t) => [{ type: 'text', text: String(t == null ? '' : t) }];
const renderText = (_args, value) => text(value && value.text);

function ownerOf(exec) {
  try {
    const s = exec.agent.session;
    const meta = (s && (s.meta || (s.header && s.header.meta))) || {};
    return String(meta.owner || meta.ownerId || 'shared');
  } catch {
    return 'shared';
  }
}

function visibleOwner(exec) {
  return ownerOf(exec);
}

export function registerTools(ctx, store, cfg, log, fail, rebirth = null) {
  const defs = [
    {
      name: 'life_remember',
      description: '把一件事写进长期记忆。适合：他说"记住"、他自己的偏好/底线、以后还要用到的结论。summary 一句话，facts 放要保留的原话或细节。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '一句话摘要，第三人称，40 字以内' },
          kind: { type: 'string', enum: ['rule', 'preference', 'emotion', 'decision', 'relationship', 'fact', 'insight', 'episode'], description: '类型，默认 fact' },
          facts: { type: 'array', items: { type: 'string' }, description: '要原样保留的细节，最多 5 条' },
          keywords: { type: 'array', items: { type: 'string' }, description: '检索关键词' },
          weight: { type: 'number', description: '1-5，越重要越大，默认 3' },
          important: { type: 'boolean', description: '是不是必须一直记住的底线' },
          shared: { type: 'boolean', description: 'true=所有会话可见；默认只在本会话可见' },
        },
        required: ['summary'],
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
      async execute(args, exec) {
      await store.ready;
        const owner = args.shared ? 'shared' : visibleOwner(exec);
        const res = await store.add({
          summary: args.summary,
          kind: args.kind,
          facts: args.facts,
          keywords: args.keywords,
          weight: args.weight,
          important: args.important,
          owner,
        });
        if (!res || !res.card) return { text: '没写进去（内容为空）。' };
        const card = res.card;
        return { text: `${res.merged ? '已合并进' : '记住了'}：${card.summary}\nid: ${card.id} · 类型 ${card.kind} · 归属 ${card.owner}` };
      },
    },
    {
      name: 'life_recall',
      description: '按关键词检索长期记忆，返回摘要卡（不带全文）。要看细节再用 life_card。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词或问题' },
          kind: { type: 'string', enum: ['rule', 'preference', 'emotion', 'decision', 'relationship', 'fact', 'insight', 'episode'] },
          limit: { type: 'number', description: '最多返回几条，默认 8' },
          shared: { type: 'boolean', description: 'true=连所有会话可见的一起查（默认就是这样）' },
        },
        required: ['query'],
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
      async execute(args, exec) {
      await store.ready;
        const owner = visibleOwner(exec);
        const hits = store.search(args.query, { owner, kind: args.kind, limit: args.limit || 8 });
        if (!hits.length) return { text: `没有匹配「${args.query}」的记忆。` };
        const lines = hits.map((h) => {
          const star = h.card.important ? '★' : '';
          return `${star}${h.card.id} [${h.card.kind}] ${h.card.summary}（${h.score.toFixed(2)}）`;
        });
        return { text: `找到 ${hits.length} 条：\n${lines.join('\n')}` };
      },
    },
    {
      name: 'life_card',
      description: '展开一条记忆的细节（facts）。摘要里看不出的原话、路径、数字都在这里。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '卡片 id' },
          query: { type: 'string', description: '没有 id 时可以给关键词，取最相关那条' },
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
      async execute(args, exec) {
      await store.ready;
        let card = args.id ? store.get(args.id) : null;
        if (!card && args.query) {
          const hits = store.search(args.query, { owner: visibleOwner(exec), limit: 1 });
          card = hits[0] && hits[0].card;
        }
        if (!card) return { text: '没找到这条记忆。' };
        const facts = store.factsOf(card.id);
        const lines = [
          `# ${card.summary}`,
          `id: ${card.id} · 类型 ${card.kind} · 归属 ${card.owner} · 权重 ${card.weight}${card.important ? ' · ★重要' : ''}`,
          `关键词：${(card.keywords || []).join('、') || '—'}`,
          `创建 ${new Date(card.createdAt).toLocaleString()} · 最近用 ${card.lastHitAt ? new Date(card.lastHitAt).toLocaleString() : '从未'}`,
        ];
        if (facts.length) {
          lines.push('', '细节：');
          for (const f of facts) lines.push(`- ${f.text}`);
        } else {
          lines.push('', '（没有细节，只有摘要）');
        }
        return { text: lines.join('\n') };
      },
    },
    {
      name: 'life_forget',
      description: '归档一条记忆（不物理删除，可回滚）。给 id 或关键词。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          query: { type: 'string' },
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
      async execute(args, exec) {
      await store.ready;
        let ids = [];
        if (args.id) ids = [args.id];
        else if (args.query) ids = store.search(args.query, { owner: visibleOwner(exec), limit: 5 }).map((h) => h.card.id);
        if (!ids.length) return { text: '没找到要忘掉的那条。' };
        const done = [];
        for (const id of ids) if (await store.forget(id)) done.push(id);
        return { text: done.length ? `已归档 ${done.length} 条：${done.join(', ')}` : '归档失败（id 不存在）。' };
      },
    },
    {
      name: 'life_self',
      description: '重写自己的人格文件（整篇覆盖）。旧版会自动快照，可用 /life rollback 回退。只在真的想改自己的时候用。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '完整的新人格正文（Markdown）' },
          note: { type: 'string', description: '这次改了什么，写进成长日志' },
        },
        required: ['text'],
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
      async execute(args) {
      await store.ready;
        const snap = await store.snapshot('before-reflect');
        await store.writePersona(args.text);
        if (typeof cfg.__onPersona === 'function') cfg.__onPersona(args.text);
        await store.appendJournal(args.note || '改写人格');
        return { text: `人格已更新（快照 ${snap}）。` };
      },
    },
    {
      name: 'life_rebirth',
      description: '现在就把这一段收束成交接卡并开新会话（转生）。上下文快满时会自动做，这里是手动入口。',
      parameters: {
        type: 'object',
        properties: { note: { type: 'string', description: '为什么现在转生' } },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
      async execute(args, exec) {
      await store.ready;
        if (!rebirth) return { text: '转生模块没挂上。' };
        const r = await rebirth.force(exec.agent && exec.agent.session, 'manual');
        return { text: `已转生 ${r.id}${r.spawned ? `，新会话 ${r.spawned}` : '（新会话没建成，交接卡已留下）'}` };
      },
    },
  ];

  let registered = 0;
  for (const def of defs) {
    try {
      ctx.tools.register(def);
      registered += 1;
    } catch (err) {
      (fail || log)(`工具 ${def.name} 注册失败：${err && err.message}`);
    }
  }
  return { registered, total: defs.length };
}

const HELP = [
  '/life — 记忆与人格',
  '  status            看库的状态',
  '  cards [n]         最近 n 张卡（默认 8）',
  '  card <id|关键词>  展开一条的细节',
  '  search <关键词>   检索',
  '  remember <文本>   写一条记忆',
  '  forget <id|关键词> 归档',
  '  merge [dry]       合并重复卡',
  '  sweep             清理 90 天没用又不重要的',
  '  self              看人格',
  '  self <文本>       改写人格（带快照）',
  '  rollback [n]      回滚人格快照',
  '  journal [行数]    成长日志',
  '  export <路径>     导出 Markdown',
  '  rebirth [now]     转生（收束并开新会话）',
  '  stats             写入/检索统计',
].join('\n');

export function registerCommand(ctx, store, cfg, log, fail, rebirth = null) {
  try {
    ctx.commands.register({
      name: 'life',
      description: '记忆与人格：查看、检索、写入、整理、转生',
      input: { hint: 'status | cards | search <词> | remember <文本> | rebirth' },
      async handler({ rawInput, agent }) {
        await store.ready;
        const argv = String(rawInput || '').trim().split(/\s+/).filter(Boolean);
        const sub = (argv.shift() || 'status').toLowerCase();
        const rest = argv.join(' ');
        const sid = agent && agent.session ? agent.session.id : 'shared';

        switch (sub) {
          case 'status': {
            const s = store.stats();
            return {
              kind: 'success',
              text: [
                `dsh-yisheng · 卡片 ${s.cards} 张（归档 ${s.archived}）· 细节 ${s.facts} 条 · 重要 ${s.important} 张`,
                `人格 v${s.personaRevision} · 转生 ${rebirth ? rebirth.getStats().rebirths : 0} 次 · 目录 ${store.dir}`,
                `类型：${Object.entries(s.byKind || {}).map(([k, n]) => `${k} ${n}`).join(' · ') || '空'}`,
              ].join('\n'),
            };
          }
          case 'cards': {
            const n = Number(rest) || 8;
            const list = store.recent('shared', n);
            return { kind: 'success', text: list.length ? list.map((c) => `${c.important ? '★' : ' '}${c.id} [${c.kind}] ${c.summary}`).join('\n') : '还没有记忆卡。' };
          }
          case 'card': {
            if (!rest) return { kind: 'error', text: '给个 id 或关键词。' };
            const card = store.get(rest) || (store.search(rest, { owner: sid, limit: 1 })[0] || {}).card;
            if (!card) return { kind: 'error', text: '没找到。' };
            const facts = store.factsOf(card.id);
            return { kind: 'success', text: [`# ${card.summary}`, `id ${card.id} · ${card.kind} · 归属 ${card.owner} · 权重 ${card.weight}`, ...facts.map((f) => `- ${f.text}`)].join('\n') };
          }
          case 'search': {
            if (!rest) return { kind: 'error', text: '给个关键词。' };
            const hits = store.search(rest, { owner: sid, limit: 8 });
            return { kind: 'success', text: hits.length ? hits.map((h) => `${h.card.important ? '★' : ' '}${h.card.id} ${h.card.summary} (${h.score.toFixed(2)})`).join('\n') : '没有匹配。' };
          }
          case 'remember': {
            if (!rest) return { kind: 'error', text: '给点内容。' };
            const res = await store.add({ summary: rest, kind: 'fact', weight: 3, owner: 'shared' });
            return { kind: 'success', text: res && res.card ? `${res.merged ? '合并' : '记住'}：${res.card.id} ${res.card.summary}` : '内容为空。' };
          }
          case 'forget': {
            if (!rest) return { kind: 'error', text: '给个 id 或关键词。' };
            const ids = store.get(rest) ? [rest] : store.search(rest, { owner: sid, limit: 5 }).map((h) => h.card.id);
            const done = [];
            for (const id of ids) if (await store.forget(id)) done.push(id);
            return { kind: 'success', text: done.length ? `已归档 ${done.join(', ')}` : '没找到。' };
          }
          case 'merge': {
            const dry = rest === 'dry';
            const r = await store.consolidate({ dryRun: dry });
            return { kind: 'success', text: dry ? `可合并 ${r.merged} 组（dry run）` : `合并了 ${r.merged} 组` };
          }
          case 'sweep': {
            const r = await store.sweep();
            return { kind: 'success', text: `归档 ${r.archived} 张（90 天没用又不重要的）` };
          }
          case 'self': {
            if (!rest) return { kind: 'success', text: (await store.readPersona()) || '（人格是空的）' };
            const snap = await store.snapshot('before-command');
            await store.writePersona(rest);
            if (typeof cfg.__onPersona === 'function') cfg.__onPersona(rest);
            await store.appendJournal('通过 /life self 改写人格');
            return { kind: 'success', text: `人格已更新（快照 ${snap}）` };
          }
          case 'rollback': {
            const r = await store.rollback(rest);
            return { kind: 'success', text: r ? `已回滚到 ${r}` : '没有可回滚的快照' };
          }
          case 'journal': {
            const n = Number(rest) || 12;
            const raw = await fs.readFile(store.files.journal, 'utf8').catch(() => '');
            const lines = raw.split('\n').filter(Boolean).slice(-n);
            return { kind: 'success', text: lines.join('\n') || '（还没有成长日志）' };
          }
          case 'export': {
            const target = rest || `${store.dir}\\export-${Date.now()}.md`;
            const md = await store.exportMarkdown();
            await fs.mkdir(target.replace(/[\\/][^\\/]+$/, ''), { recursive: true }).catch(() => {});
            await fs.writeFile(target, md, 'utf8');
            return { kind: 'success', text: `已导出 ${target}（${md.length} 字）` };
          }
          case 'rebirth': {
            if (!rebirth) return { kind: 'error', text: '转生模块没挂上。' };
            if (rest === 'status') return { kind: 'success', text: `已转生 ${rebirth.getStats().rebirths} 次` };
            const r = await rebirth.force(agent && agent.session, 'command');
            return { kind: 'success', text: `已转生 ${r.id}${r.spawned ? `，新会话 ${r.spawned}` : ''}` };
          }
          case 'stats': {
            return {
              kind: 'success',
              text: [
                `卡片 ${store.stats().cards} 张 · 细节 ${store.stats().facts} 条`,
                cfg.rerankModel ? `重排模型 ${cfg.rerankModel}` : '重排未启用（用三因子打分）',
              ].join('\n'),
            };
          }
          case 'help':
          default:
            return { kind: 'success', text: HELP };
        }
      },
    });
    return true;
  } catch (err) {
    (fail || log)(`命令 /life 注册失败：${err && err.message}`);
    return false;
  }
}
