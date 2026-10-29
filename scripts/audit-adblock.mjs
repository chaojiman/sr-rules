/**
 * 审计 adblock 模块引用的所有外部脚本
 *
 * 检查项：网络外发 / 动态执行 / Cookie 读取 / 本地存储
 * 输出每个脚本的实际外发目标，便于判断是否可信。
 *
 * 用法: node audit-adblock.mjs [--json]
 */
import fs from 'fs';

const MOD = new URL('../adblock/blockAds.srmodule', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const JSON_OUT = process.argv.includes('--json');

const txt = fs.readFileSync(MOD, 'utf8').replace(/\r/g, '').split('\n');
const a = txt.findIndex((l) => l.trim() === '[Script]');
const b = txt.findIndex((l) => l.trim() === '[MITM]');

const urls = new Set();
for (let i = a; i < b; i++) {
  const m = txt[i].match(/script-path=(https?:\/\/[^ ,]+)/);
  if (m) urls.add(m[1].trim());
}

const PATTERNS = [
  ['网络外发', /\$httpClient|\$task\.fetch|fetch\s*\(|XMLHttpRequest|\.ajax\s*\(|axios/],
  ['动态执行', /\beval\s*\(|new\s+Function\s*\(/],
  ['本地存储', /\$persistentStore|\$prefs/],
  ['Cookie读取', /document\.cookie|\$request\.headers\.Cookie/i],
];

const results = [];
const list = [...urls];
let done = 0;

async function check(u) {
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { u, err: `HTTP ${r.status}` };
    const code = await r.text();
    const hits = {};
    for (const [name, re] of PATTERNS) if (re.test(code)) hits[name] = true;
    const hosts = [
      ...new Set(
        (code.match(/https?:\/\/([a-zA-Z0-9.-]+)/g) || [])
          .map((s) => s.replace(/https?:\/\//, ''))
          .filter((h) => !/github|githubusercontent/.test(h)),
      ),
    ];
    return { u, size: code.length, hits, hosts };
  } catch (e) {
    return { u, err: e.message.slice(0, 40) };
  }
}

for (let i = 0; i < list.length; i += 8) {
  const rs = await Promise.all(list.slice(i, i + 8).map(check));
  results.push(...rs);
  done += rs.length;
  process.stderr.write(`\r扫描 ${done}/${list.length}`);
}
process.stderr.write('\n');

if (JSON_OUT) {
  console.log(JSON.stringify(results, null, 1));
  process.exit(0);
}

const errs = results.filter((r) => r.err);
const net = results.filter((r) => r.hits?.['网络外发']);
const evl = results.filter((r) => r.hits?.['动态执行']);
const ck = results.filter((r) => r.hits?.['Cookie读取']);

console.log(`\n脚本总数 ${results.length}  |  下载失败 ${errs.length}`);
errs.forEach((e) => console.log(`  ✗ ${e.err}  ${e.u}`));

console.log(`\n【网络外发】${net.length} 个 —— 逐个看目标域名`);
for (const r of net) {
  console.log(`  ${r.u.replace('https://raw.githubusercontent.com/', '')}`);
  console.log(`     → ${(r.hosts || []).join(', ') || '（仅 GitHub）'}`);
}

console.log(`\n【动态执行】${evl.length} 个`);
evl.forEach((r) => console.log(`  ${r.u}`));

console.log(`\n【读取 Cookie】${ck.length} 个 ${ck.length ? '⚠️' : '✅'}`);
ck.forEach((r) => console.log(`  ${r.u}`));
