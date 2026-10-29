/**
 * 拉取 fmz200/wool_scripts 的 blockAds 模块，剔除全部金融类 App，
 * 输出到 adblock/blockAds.srmodule 供小火箭安装。
 *
 * 为什么剔除：
 *   上游模块对 33 个银行域名开启 MITM（工行/建行/农行/中行/招行/浦发/民生/
 *   交行/邮储/中信/光大/兴业/北京/江苏/吉林/广发/平安…），这些 App 普遍有
 *   证书固定，解密后直接无法联网。必须剔除。
 *
 * 剔除范围：
 *   1. [MITM] hostname 列表中的金融域名
 *   2. 段落名命中金融关键词的整段（Rule / URL Rewrite / Map Local / Script…）
 *
 * 其余规则、脚本、上游更新全部保留。
 *
 * 用法: node build-adblock.mjs [--check]
 */
import fs from 'fs';
import path from 'path';

const SRC = 'https://raw.githubusercontent.com/fmz200/wool_scripts/main/Shadowrocket/module/blockAds.srmodule';
const OUT = path.resolve('adblock/blockAds.srmodule');
const CHECK_ONLY = process.argv.includes('--check');

// ── 段落名命中即整段删除 ──────────────────────────────
const FIN_SECTION = /(银行|信用卡|证券|基金|保险|金融|钱包|支付|银联|农商)/;

// ── 域名黑名单（MITM 列表 + 保险丝）────────────────────
// 只匹配域名结尾，不会误伤 xxxbank.com.cn 之外的东西
const DOMAIN_PATTERNS = [
  /(^|\.)ccb\.com$/,
  /(^|\.)ccb\.com\.cn$/,
  /(^|\.)icbc\.com\.cn$/,
  /(^|\.)abchina\.com(\.cn)?$/,
  /(^|\.)boc\.cn$/,
  /(^|\.)bankofchina\.com$/,
  /(^|\.)cmbchina\.com$/,
  /(^|\.)psbc\.com$/,
  /(^|\.)bankcomm\.com$/,
  /(^|\.)bankcomm\.cn$/,
  /(^|\.)spdb\.com\.cn$/,
  /(^|\.)citicbank\.com$/,
  /(^|\.)cmbc\.com\.cn$/,
  /(^|\.)hxb\.com\.cn$/,
  /(^|\.)cebbank\.com$/,
  /(^|\.)bankofbeijing\.com\.cn$/,
  /(^|\.)jsbchina\.cn$/,
  /(^|\.)jlbank\.com\.cn$/,
  /(^|\.)cgbchina\.com\.cn$/,
  /(^|\.)cib\.com\.cn$/,
  /(^|\.)cmbchina\.com$/,
  /(^|\.)95516\.com$/,
  /(^|\.)unionpay\.com$/,
  /(^|\.)unionpaysecure\.com$/,
  /(^|\.)alipay\.com$/,
  /(^|\.)alipayobjects\.com$/,
  /(^|\.)tenpay\.com$/,
  /(^|\.)tenpay\.com\.cn$/,
  /(^|\.)paas\.cmbchina\.com$/,
];

const isFinHost = (h) => DOMAIN_PATTERNS.some((re) => re.test(h));

// ── 执行 ─────────────────────────────────────────────
const res = await fetch(SRC, { signal: AbortSignal.timeout(60000) });
if (!res.ok) throw new Error(`${SRC} → HTTP ${res.status}`);
const src = (await res.text()).replace(/\r\n/g, '\n');
const lines = src.split('\n');

const out = [];
let skip = false;
const removedSections = [];
const removedHosts = new Set();

// 段落边界：'# > ' 标题 / '# >>>' 分隔 / '[Section]' 段头
const isBoundary = (l) => /^# > /.test(l) || /^# >>>/.test(l) || /^\[.+\]$/.test(l);

for (const line of lines) {
  // 段落删除状态机
  if (isBoundary(line)) {
    if (/^# > /.test(line)) {
      const name = line.slice(4).trim();
      if (FIN_SECTION.test(name)) {
        skip = true;
        removedSections.push(name);
      } else {
        skip = false;
      }
    } else if (!/^# > /.test(line)) {
      skip = false; // 分隔符 / 段头 → 退出跳过
    }
  }

  // MITM 行：按域名过滤（在 skip 判断之外，因为 MITM 永远是独立的一行）
  if (/^hostname\s*=\s*%APPEND%/.test(line)) {
    const head = 'hostname = %APPEND% ';
    const hosts = line
      .slice(head.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const kept = [];
    for (const h of hosts) {
      if (isFinHost(h)) removedHosts.add(h);
      else kept.push(h);
    }
    out.push(head + kept.join(', '));
    continue;
  }

  if (skip) continue;
  out.push(line);
}

const result = out
  .join('\n')
  // 头部改写：指向自己的仓库，避免「检查更新」跳回上游把金融段装回来
  .replace(/^#!name=.*/m, '#!name=广告拦截(已剔金融版)')
  .replace(/^#!desc=.*/m, '#!desc=基于 fmz200/blockAds 裁剪，已移除全部银行/证券/支付类 App（上游对这些域名开 MITM，会致银行 App 无法联网）')
  .replace(/^#!homepage=.*/m, '#!homepage=https://github.com/chaojiman/sr-rules')
  .replace(/^#!raw-url=.*/m, '#!raw-url=https://github.com/chaojiman/sr-rules/raw/main/adblock/blockAds.srmodule');

console.log(`上游 ${(src.length / 1024).toFixed(0)} KB → 输出 ${(result.length / 1024).toFixed(0)} KB`);
console.log(`剔除段落 ${removedSections.length} 个：${[...new Set(removedSections)].join('、') || '（无）'}`);
console.log(`剔除 MITM 域名 ${removedHosts.size} 个：${[...removedHosts].join(', ') || '（无）'}`);

if (removedSections.length === 0 && removedHosts.size === 0) {
  console.error('⚠️ 没有剔除任何内容 —— 上游结构可能已变，请人工检查');
}

if (CHECK_ONLY) {
  console.log('--check 模式，未写文件');
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
if (prev === result) {
  console.log('无变化');
  process.exit(0);
}
fs.writeFileSync(OUT, result);
console.log(`已写入 ${OUT}`);
