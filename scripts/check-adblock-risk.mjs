/**
 * 扫描 adblock 模块的高风险规则
 *
 * 背景：模块对某些 App 的「主 API」做 MITM + Map Local / Script，
 * 一旦命中版本检查、配置下发、登录等关键接口并返回 {}，App 会直接不可用。
 * 已经踩过两次：京东（卡顿）、山姆（无法访问）。
 *
 * 判定规则：
 *   🔴 高危 —— 主 API 域名（api*.xxx / api-*.xxx）且规则命中
 *              version / config / update / init / start / login / token / auth
 *   🟡 中危 —— 主 API 域名，但规则只命中广告位
 *   ⚪ 低危 —— 普通子域名
 *
 * 用法: node check-adblock-risk.mjs
 */
import fs from 'fs';
import path from 'path';

const MOD = path.resolve('adblock/blockAds.srmodule');
const txt = fs.readFileSync(MOD, 'utf8').replace(/\r/g, '').split('\n');

const SECS = ['Rule', 'Header Rewrite', 'URL Rewrite', 'Body Rewrite', 'Map Local', 'Script', 'MITM'];
const start = {};
txt.forEach((l, i) => {
  const m = l.match(/^\[(.+)\]$/);
  if (m) start[m[1]] = i;
});
const endOf = (n) => {
  const i = SECS.indexOf(n);
  return i + 1 < SECS.length ? start[SECS[i + 1]] : txt.length;
};

// 主 API 判定
const isMainApi = (h) => /^api[-.]/i.test(h) || /^api\d*[-.]/i.test(h);

// 关键接口：命中即可能影响 App 基本功能
const CRITICAL = /(version|update|login|auth|token|signin|register|bootstrap|app\/start|startup|splash_config)/i;
// 次要接口：多半是广告/实验配置，误报率高
const MAYBE = /(config|init|launch|start|home|index)/i;

const findings = [];

for (const sec of ['URL Rewrite', 'Map Local', 'Script', 'Body Rewrite']) {
  if (start[sec] === undefined) continue;
  let hosts = [];
  let app = '';
  for (let i = start[sec] + 1; i < endOf(sec); i++) {
    const l = txt[i];
    if (/^# > /.test(l)) {
      app = l.slice(4).trim();
      hosts = [];
      continue;
    }
    if (/^# hostname =/.test(l)) {
      hosts = l
        .replace(/^# hostname =\s*/, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    if (!l || l.startsWith('#') || l.startsWith('[')) continue;
    if (!hosts.length) continue;

    const mainHosts = hosts.filter(isMainApi);
    if (!mainHosts.length) continue;

    const critical = CRITICAL.test(l);
    const maybe = !critical && MAYBE.test(l);
    findings.push({
      level: critical ? '🔴' : maybe ? '🟡' : '⚪',
      app,
      section: sec,
      hosts: mainHosts.join(', '),
      rule: l.length > 120 ? l.slice(0, 120) + '…' : l,
    });
  }
}

// 按危险等级排序
// MITM 实际生效的域名集合 —— 不在这个集合里的规则不会执行
const mitmSet = new Set();
if (start['MITM'] !== undefined) {
  for (let i = start['MITM'] + 1; i < txt.length; i++) {
    if (/^hostname\s*=/.test(txt[i])) {
      txt[i]
        .replace(/^hostname\s*=\s*/, '')
        .replace(/%APPEND%/, '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .forEach((h) => mitmSet.add(h));
    }
  }
}

// 已豁免 = 规则还在但域名已移出 MITM，不会执行
const active = findings.filter((f) => f.hosts.split(', ').some((h) => mitmSet.has(h.toLowerCase())));
const exempted = findings.filter((f) => !active.includes(f));
findings.length = 0;
findings.push(...active);

const ORDER = { '🔴': 0, '🟡': 1, '⚪': 2 };
findings.sort((a, b) => ORDER[a.level] - ORDER[b.level]);

const red = findings.filter((f) => f.level === '🔴');
const yellow = findings.filter((f) => f.level === '🟡');
const white = findings.filter((f) => f.level === '⚪');

console.log(`\n🔴 高危（主 API + 版本/登录/启动接口）${red.length} 条 —— 最可能导致 App 不可用`);
for (const f of red) {
  console.log(`  [${f.section}] ${f.app}`);
  console.log(`    ${f.hosts}`);
  console.log(`    ${f.rule}`);
}

console.log(`\n🟡 中危（主 API + config/init/home 类）${yellow.length} 条`);
const byApp = {};
for (const f of yellow) byApp[f.app || '(未分组)'] = (byApp[f.app || '(未分组)'] || 0) + 1;
console.log('  ' + Object.entries(byApp).map(([k, v]) => `${k}×${v}`).join('  '));

console.log(`\n⚪ 其余（主 API + 纯广告位）${white.length} 条`);
console.log(`\n合计 ${findings.length} 条规则实际生效`);
console.log(`已豁免 ${exempted.length} 条（规则存在，但域名已移出 MITM，不会执行）`);
