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
const GEOIP = {
  'cn-ip': 'cn',
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
