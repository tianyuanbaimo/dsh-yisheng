// 注入文本：人格 + 三路记忆。人格和记忆各自算预算——
// 人格写长了不该把"必须守住的"挤掉。
const KIND_LABEL = {
  rule: '规则', preference: '偏好', emotion: '情绪', decision: '决定',
  relationship: '关系', fact: '事实', insight: '判断', episode: '片段',
};

const ITEM_MAX = 140;

function line(card) {
  const star = card.important ? '★' : '';
  const tag = KIND_LABEL[card.kind] || card.kind;
  let s = String(card.summary || '').replace(/\s+/g, ' ').trim();
  if (s.length > ITEM_MAX) s = s.slice(0, ITEM_MAX - 1) + '…';
  return `- ${star}[${tag}] ${s}`;
}

export function renderSoulBlock({
  persona = '',
  important = [],
  recent = [],
  relevant = [],
  rebirth = '',
  maxChars = 2000,
  personaMax = 2600,
  degraded = null,
}) {
  let who = String(persona || '').trim();
  if (who.length > personaMax) who = who.slice(0, personaMax - 1) + '…';

  const buckets = {
    rebirth: rebirth ? [`## 上一次转世留下的\n${String(rebirth).trim().slice(0, 800)}`] : [],
    relevant: relevant.map((c) => line(c)),
    recent: recent.map((c) => line(c)),
    must: important.map((c) => line(c)),
    howto: [
      '## 怎么用这份记忆',
      '- 上面是摘要，不是原文。要细节就调 life_card 展开，别凭摘要猜。',
      '- 不确定的事就问，别把这里没写的东西说成记得。',
      '- 想让某件事留下来，直接说"记住"；说"忘掉"我会归档它。',
    ],
  };

  const titles = {
    rebirth: (body) => body,
    relevant: (body) => `## 和眼下这件事有关的记忆\n${body.join('\n')}`,
    recent: (body) => `## 最近聊到的\n${body.join('\n')}`,
    must: (body) => `## 我必须守住的\n${body.join('\n')}`,
    howto: (body) => body.join('\n'),
  };

  const budget = Math.max(200, Number(maxChars) || 2000);
  const render = () => {
    const parts = [];
    if (who) parts.push(who);
    for (const k of ['rebirth', 'relevant', 'recent', 'must', 'howto']) {
      const body = buckets[k];
      if (body && body.length) parts.push(titles[k](body));
    }
    return parts.join('\n\n');
  };

  // 先砍"最近"和"片段"，最后才动"必须守住的"；整节砍完还不够就硬截断。
  const order = ['recent', 'relevant', 'rebirth', 'must', 'howto'];
  let out = render();
  for (const key of order) {
    while (out.length > budget + personaMax && buckets[key] && buckets[key].length > 1) {
      buckets[key].pop();
      out = render();
    }
    if (out.length <= budget + personaMax) break;
    if (buckets[key] && buckets[key].length) {
      buckets[key].length = 0;
      out = render();
      if (out.length <= budget + personaMax) break;
    }
  }

  const cap = budget + personaMax;
  if (out.length > cap) out = out.slice(0, cap - 1) + '…';
  if (degraded) out += `\n\n（重排降级：${degraded}，这次按三因子打分取的相关记忆）`;
  return out;
}

export function renderStatus(stats, persona = '') {
  const lines = [
    'dsh-yisheng · 记忆在线',
    `- 卡片 ${stats.cards} 张（归档 ${stats.archived}）· 细节 ${stats.facts} 条 · 重要 ${stats.important} 张`,
    `- 人格 v${stats.personaRevision} · 转生 ${stats.rebirths} 次 · 库版本 ${stats.revision}`,
  ];
  const kinds = Object.entries(stats.byKind || {}).map(([k, n]) => `${KIND_LABEL[k] || k} ${n}`).join(' · ');
  if (kinds) lines.push(`- 分布：${kinds}`);
  const first = String(persona || '').split('\n').find((l) => l.trim().startsWith('-'));
  if (first) lines.push(`- 人格开头：${first.trim().slice(0, 60)}`);
  return lines.join('\n');
}
