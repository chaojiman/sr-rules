/**
 * 把 appshubcc/bett-rules 的 .list（mihomo hosts 格式）转成小火箭可用格式
 *
 * geosite:  +.example.com  →  example.com / .example.com （两行，精确 + 后缀）
 *           example.com    →  example.com
 * geoip:    1.0.1.0/24     →  IP-CIDR,1.0.1.0/24,no-resolve
 *           IPv6 段        →  IP-CIDR6,...,no-resolve
 *
 * 输出到 rules/，供小火箭 DOMAIN-SET / RULE-SET 直接引用
 * 用法: node build-rules.mjs
 */
import fs from 'fs';
import path from 'path';

const SRC = 'https://raw.githubusercontent.com/appshubcc/bett-rules/meta/geo';
const OUT = path.resolve('rules');

// 输出文件名 → bett-rules geosite 分类名
const GEOSITE = {
  ai: 'category-ai-!cn',
  crypto: 'category-cryptocurrency',
  ads: 'category-ads',
  google: 'google',
  youtube: 'youtube',
  netflix: 'netflix',
  telegram: 'telegram',
  twitter: 'twitter',
  meta: 'meta',
  tiktok: 'tiktok',
  spotify: 'spotify',
  github: 'github',
  microsoft: 'microsoft',
  apple: 'apple',
  paypal: 'paypal',
  steam: 'steam',
  china: 'geolocation-cn',
  // global (geolocation-!cn) 6.7 万行，收益等同 FINAL 兜底，不生成
  private: 'private',
  douyin: 'douyin',
};

// 输出文件名 → bett-rules geoip 分类名
const GEOIP = {
  'cn-ip': 'cn',
  'private-ip': 'private',
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
    if (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(d)) lines.push(`IP-CIDR,${d},no-resolve`);
    else if (d.includes(':') && d.includes('/')) lines.push(`IP-CIDR6,${d},no-resolve`);
  }
  fs.writeFileSync(path.join(OUT, out + '.list'), lines.join('\n') + '\n');
  total += lines.length;
  files++;
  console.log(`${out.padEnd(10)} ← geoip/${src.padEnd(24)} ${String(lines.length).padStart(6)} 行`);
}

console.log(`\n${files} 个文件 / 合计 ${total} 行 → ${OUT}`);
