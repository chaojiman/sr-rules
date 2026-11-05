/**
 * 把 appshubcc/bett-rules 的 .list（mihomo hosts 格式）转成小火箭可用格式
 *
 * geosite:  +.example.com  →  example.com / .example.com （两行，精确 + 后缀）
 *           example.com    →  example.com
 * geoip:    1.0.1.0/24     →  IP-CIDR,1.0.1.0/24
 *           IPv6 段        →  IP-CIDR6,...,no-resolve
 *
 * 注意：IP 规则一律不加 no-resolve。
 *       加了 no-resolve 会让该规则对「域名请求」直接跳过，IP 兜底形同失效。
 * 输出到 rules/，供小火箭 DOMAIN-SET / RULE-SET 直接引用
 * 用法: node build-rules.mjs
 */
import fs from 'fs';
import path from 'path';

const SRC = 'https://raw.githubusercontent.com/appshubcc/bett-rules/meta/geo';
const OUT = path.resolve('shadowrocket/rules');

// 输出文件名 → bett-rules geosite 分类名
const GEOSITE = {
  ai: 'category-ai-!cn',
  ads: 'category-ads',
  google: 'google',
  youtube: 'youtube',
  netflix: 'netflix',
  telegram: 'telegram',
  meta: 'meta',
  tiktok: 'tiktok',
  spotify: 'spotify',
  github: 'github',
  microsoft: 'microsoft',
  apple: 'apple',
  paypal: 'paypal',
  steam: 'steam',
  china: 'geolocation-cn',
  // 境外已知域名。作用不是「兜底」（FINAL 也能兜），而是让境外域名在
  // 命中 GEOIP 之前就确定走向，避免触发本地 DNS 解析 —— 国内 DoH 对
  // 境外域名普遍返回污染 IP（如 okx → 169.254.0.2），一旦解析就会误判。
  global: 'geolocation-!cn',
  private: 'private',
  douyin: 'douyin',
};

// 输出文件名 → bett-rules geoip 分类名
// 注：cn-ip 已停用 —— 与配置末尾的 GEOIP,CN 是同一份数据，只保留后者
const GEOIP = {
  'private-ip': 'private',
};

// 合并类：把多个 blackmatrix7 规则集合成 1 个（减少引用条数）
const BM7 = 'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule';
const MERGE = {
  // B 站单独一条，指向独立的「哔哩哔哩」组（默认直连，可切代理）
  bilibili: ['Shadowrocket/BiliBili/BiliBili.list'],
  'cn-direct': [
    'Shadowrocket/NetEaseMusic/NetEaseMusic.list',
    'Shadowrocket/Baidu/Baidu.list',
    'Surge/WeChat/WeChat.list',
    'Shadowrocket/DouYin/DouYin.list',
    'Shadowrocket/ByteDance/ByteDance.list',
    'Shadowrocket/XiaoHongShu/XiaoHongShu.list',
    'Shadowrocket/Zhihu/Zhihu.list',
    'Shadowrocket/Sina/Sina.list',
    'Shadowrocket/DouBan/DouBan.list',
  ],
};

fs.mkdirSync(OUT, { recursive: true });

async function get(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(url + ' → ' + r.status);
  return r.text();
}

const only = process.argv.slice(2);
const want = (k) => only.length === 0 || only.includes(k);

let total = 0;
let files = 0;

for (const [out, src] of Object.entries(GEOSITE)) {
  if (!want(out)) continue;
  const txt = await get(`${SRC}/geosite/${src}.list`);
  const lines = [];
  for (const raw of txt.split('\n')) {
    const d = raw.trim();
    if (!d || d.startsWith('#')) continue;
    if (d.startsWith('+.')) {
      const s = d.slice(2);
      lines.push(s, '.' + s);
    } else {
      lines.push(d);
    }
  }
  fs.writeFileSync(path.join(OUT, out + '.list'), lines.join('\n') + '\n');
  total += lines.length;
  files++;
  console.log(`${out.padEnd(10)} ← geosite/${src.padEnd(24)} ${String(lines.length).padStart(6)} 行`);
}

for (const [out, src] of Object.entries(GEOIP)) {
  if (!want(out)) continue;
  const txt = await get(`${SRC}/geoip/${src}.list`);
  const lines = [];
  for (const raw of txt.split('\n')) {
    const d = raw.trim();
    if (!d || d.startsWith('#')) continue;
    if (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(d)) lines.push(`IP-CIDR,${d}`);
    else if (d.includes(':') && d.includes('/')) lines.push(`IP-CIDR6,${d}`);
  }
  fs.writeFileSync(path.join(OUT, out + '.list'), lines.join('\n') + '\n');
  total += lines.length;
  files++;
  console.log(`${out.padEnd(10)} ← geoip/${src.padEnd(24)} ${String(lines.length).padStart(6)} 行`);
}

for (const [out, paths] of Object.entries(MERGE)) {
  if (!want(out)) continue;
  const set = new Set();
  const dropped = {};
  for (const p of paths) {
    const txt = await get(`${BM7}/${p}`);
    for (const raw of txt.split('\n')) {
      let l = raw.trim();
      if (!l || l.startsWith('#')) continue;
      const type = (l.split(',')[0] || '').toUpperCase();
      // 只保留小火箭 RULE-SET 确定支持的类型
      if (!['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6'].includes(type)) {
        dropped[type] = (dropped[type] || 0) + 1;
        continue;
      }
      // 不加 no-resolve：加了会让 IP 规则对所有域名请求失效（源里自带的也剥掉）
      l = l.replace(/,no-resolve$/i, '');
      set.add(l);
    }
  }
  const lines = [...set];
  fs.writeFileSync(path.join(OUT, out + '.list'), lines.join('\n') + '\n');
  total += lines.length;
  files++;
  const dropNote = Object.keys(dropped).length
    ? `  (丢弃 ${Object.entries(dropped).map(([k, v]) => `${k}×${v}`).join(' ')}）`
    : '';
  console.log(`${out.padEnd(10)} ← 合并 ${paths.length} 个源          ${String(lines.length).padStart(6)} 行${dropNote}`);
}

console.log(`\n${files} 个文件 / 合计 ${total} 行 → ${OUT}`);

// ═══════════════════════════════════════════════════════
// ADLite：外部规则集转成本地 DOMAIN-SET
// ═══════════════════════════════════════════════════════
// 上游给的是 RULE-SET（53,068 条 DOMAIN-SUFFIX，逐条规则匹配）。转成纯域名
// DOMAIN-SET 后，客户端按域名集合查，解析和内存开销都显著下降。
if (want('adlite')) {
  try {
    const txt = await get('https://yfamilys.com/rule/ADLite.list');
    const set = new Set();
    let ipDropped = 0;
    let otherDropped = 0;
    for (const raw of txt.split('\n')) {
      const l = raw.trim();
      if (!l || l.startsWith('#')) continue;
      let m;
      if ((m = l.match(/^DOMAIN-SUFFIX,(.+)$/i))) {
        const d = m[1].trim();
        set.add(d);
        set.add('.' + d);
      } else if ((m = l.match(/^DOMAIN,(.+)$/i))) {
        set.add(m[1].trim());
      } else if (/^IP-CIDR6?,/i.test(l)) {
        ipDropped++;
      } else {
        otherDropped++;
      }
    }
    const lines = [...set];
    fs.writeFileSync(path.join(OUT, 'adlite.list'), lines.join('\n') + '\n');
    total += lines.length;
    files++;
    console.log(
      `adlite     ← ADLite.list 转换        ${String(lines.length).padStart(6)} 行` +
        `  (丢弃 IP-CIDR×${ipDropped} 其他×${otherDropped}，均与 GEOIP/其他集重叠)`,
    );
  } catch (err) {
    console.log(`⚠️  ADLite 拉取失败，沿用现有 adlite.list：${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════
// 影子规则裁剪
// ═══════════════════════════════════════════════════════
// 小火箭的规则是「从上往下，命中即停」。因此某条规则集里的域名，如果已经被
// 配置里更早的规则命中，它就永远不会生效 —— 白占内存和加载时间。
// 实测全量 149,487 条域名里有 53,338 条（35.7%）属于这种情况。
// 这里按 config.conf 的真实顺序模拟一遍匹配，把这些死条目剔掉。
// 只裁域名条目（纯域名 / DOMAIN / DOMAIN-SUFFIX），IP-CIDR、AND 等一律保留。
const SELF_PREFIX = 'https://raw.githubusercontent.com/chaojiman/sr-rules/main/shadowrocket/rules/';

function classifyRuleLine(l) {
  let m;
  // 规则集文件里的 DOMAIN* 行不带策略；万一带了（第三个字段）也只取域名
  if ((m = l.match(/^DOMAIN-SUFFIX,([^,]+)/i))) return { kind: 's', d: m[1].trim() };
  if ((m = l.match(/^DOMAIN,([^,]+)/i))) return { kind: 'e', d: m[1].trim() };
  if ((m = l.match(/^DOMAIN-KEYWORD,([^,]+)/i))) return { kind: 'k', d: m[1].trim() };
  if (l.startsWith('.')) return { kind: 's', d: l.slice(1) };
  if (/^[a-z0-9*_-]+(\.[a-z0-9*_-]+)+$/i.test(l)) return { kind: 'e', d: l };
  return null;
}

function makeMatcher() {
  const exact = new Set();
  const suffix = new Set();
  const kws = [];
  return {
    add(c) {
      if (c.kind === 's') suffix.add(c.d);
      else if (c.kind === 'e') exact.add(c.d);
      else kws.push(c.d);
    },
    hit(d) {
      if (exact.has(d)) return true;
      const parts = d.split('.');
      for (let i = 0; i < parts.length; i++) if (suffix.has(parts.slice(i).join('.'))) return true;
      return kws.some((k) => d.includes(k));
    },
  };
}

function entryMatches(item, d) {
  if (item.type === 'inline') {
    const c = item.c;
    if (c.kind === 'e') return d === c.d;
    if (c.kind === 's') return d === c.d || d.endsWith('.' + c.d);
    return d.includes(c.d);
  }
  return item.matchSet.hit(d);
}

async function pruneShadowed() {
  const conf = fs.readFileSync(path.resolve('shadowrocket/config.conf'), 'utf8').split('\n');
  const s = conf.findIndex((l) => l.trim() === '[Rule]');
  const e = conf.findIndex((l, i) => i > s && /^\[.+\]$/.test(l.trim()));
  const entries = conf.slice(s + 1, e).filter((l) => l.trim() && !l.trim().startsWith('#'));

  // ① 按配置顺序载入每个条目
  const model = [];
  for (const line of entries) {
    const p = line.split(',').map((x) => x.trim());
    const type = p[0];
    const policy = p[p.length - 1];
    if (type === 'DOMAIN' || type === 'DOMAIN-SUFFIX' || type === 'DOMAIN-KEYWORD') {
      // 注意：不能用 classifyRuleLine(line) —— 它会把策略字段一起吞进域名（cn,DIRECT）
      const kind = type === 'DOMAIN' ? 'e' : type === 'DOMAIN-SUFFIX' ? 's' : 'k';
      model.push({ type: 'inline', c: { kind, d: p[1] }, policy });
      continue;
    }
    if (type !== 'RULE-SET' && type !== 'DOMAIN-SET') continue;
    const url = p[1];
    const localName = url.startsWith(SELF_PREFIX) ? url.slice(SELF_PREFIX.length) : null;
    const localPath = localName ? path.join(OUT, localName) : null;
    let text;
    if (localPath) {
      if (!fs.existsSync(localPath)) continue;
      text = fs.readFileSync(localPath, 'utf8');
    } else {
      try {
        text = await get(url);
      } catch (err) {
        console.log(`⚠️  裁剪跳过 ${url.split('/').pop()}：${err.message}`);
        continue;
      }
    }
    const lines = text.split('\n');
    const matchSet = makeMatcher();
    for (const raw of lines) {
      const t = raw.trim();
      if (!t || t.startsWith('#')) continue;
      const c = classifyRuleLine(t);
      if (c) matchSet.add(c);
    }
    model.push({ type: 'set', name: localName || url.split('/').pop(), localPath, lines, matchSet, policy });
  }

  // ② 裁剪：维护一个「已经命中过什么」的全局匹配器
  const gm = makeMatcher();
  const report = [];
  for (const item of model) {
    if (item.type === 'inline') {
      gm.add(item.c);
      continue;
    }
    const keepLines = [];
    let removed = 0;
    let kept = 0;
    const survivors = [];
    for (const raw of item.lines) {
      const t = raw.trim();
      if (!t || t.startsWith('#')) {
        keepLines.push(raw);
        continue;
      }
      const c = classifyRuleLine(t);
      if (!c) {
        keepLines.push(raw);
        continue;
      }
      if (gm.hit(c.d)) {
        removed++;
        continue;
      }
      keepLines.push(raw);
      kept++;
      survivors.push(c);
    }
    for (const c of survivors) gm.add(c);
    item.keepLines = keepLines;
    item.removed = removed;
    item.kept = kept;
    if (removed) report.push({ name: item.name, removed, kept, local: !!item.localPath });
  }

  // ③ 校验：抽样域名在「裁剪前 / 裁剪后」必须命中同一个策略
  const allDomains = [];
  for (const item of model) {
    if (item.type !== 'set') continue;
    for (const raw of item.lines) {
      const t = raw.trim();
      if (!t || t.startsWith('#')) continue;
      const c = classifyRuleLine(t);
      if (c) allDomains.push(c.d);
    }
  }
  const step = Math.max(1, Math.floor(allDomains.length / 3000));
  const sample = allDomains.filter((_, i) => i % step === 0);

  const judge = (items, d) => {
    for (const item of items) if (entryMatches(item, d)) return item.policy;
    return 'FINAL';
  };

  const prunedModel = model.map((item) => {
    if (item.type !== 'set') return item;
    const matchSet = makeMatcher();
    for (const raw of item.keepLines) {
      const t = raw.trim();
      if (!t || t.startsWith('#')) continue;
      const c = classifyRuleLine(t);
      if (c) matchSet.add(c);
    }
    return { ...item, matchSet };
  });

  const mismatch = [];
  for (const d of sample) {
    const a = judge(model, d);
    const b = judge(prunedModel, d);
    if (a !== b) mismatch.push(`${d}: ${a} → ${b}`);
  }
  if (mismatch.length) {
    console.error(`❌ 影子裁剪校验失败（${mismatch.length}/${sample.length}）：\n  ${mismatch.slice(0, 10).join('\n  ')}`);
    process.exit(1);
  }

  // ④ 写回
  let totalRemoved = 0;
  for (const item of model) {
    if (item.type !== 'set' || !item.localPath || !item.removed) continue;
    fs.writeFileSync(item.localPath, item.keepLines.join('\n'));
    totalRemoved += item.removed;
  }

  console.log(`\n影子裁剪：剔除 ${totalRemoved} 条永远不可能命中的域名（抽样 ${sample.length} 个域名校验，策略 100% 一致）`);
  for (const r of report.filter((x) => x.local).sort((a, b) => b.removed - a.removed)) {
    console.log(`  ${r.name.padEnd(20)} -${String(r.removed).padStart(6)}  剩 ${r.kept}`);
  }
  const remote = report.filter((x) => !x.local);
  if (remote.length) {
    console.log(`  （另有 ${remote.length} 个外部规则集含重复条目，无权修改：${remote.map((r) => r.name.replace(/\.list$/, '')).join('、')}）`);
  }
}

if (only.length === 0) {
  await pruneShadowed();
} else {
  console.log('\n（部分构建模式，跳过影子裁剪 —— 裁剪需要全部规则集齐全）');
}
