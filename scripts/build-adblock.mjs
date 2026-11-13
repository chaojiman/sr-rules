/**
 * 拉取 fmz200/wool_scripts 的 blockAds 模块，按「自用 App 白名单」裁剪，
 * 输出到 adblock/blockAds.srmodule 供小火箭安装。
 *
 * 裁剪策略：
 *   1. [Rule]（DNS 层 REJECT，零风险）：全部保留，只剔除金融段
 *   2. 解密段（Header/URL/Body Rewrite、Map Local、Script）：
 *      只保留 adblock/keep-apps.txt 列出的 App 段，其余整段删除
 *   3. [MITM] hostname：只保留白名单 App 段注释里声明、且上游确实开启的域名；
 *      再过一遍金融关键词与 DOMAIN_PATTERNS，命中即剔除
 *   4. Script 超时：普通脚本 10s，binary-body-mode（protobuf 解析）20s
 *   5. 对直连 App 追加 QUIC 拦截，迫使其走 TCP，MITM 才能生效
 *
 * 为什么剔除金融：银行/证券/保险/支付 App 普遍有证书固定，解密即断网。
 * FIN_ALLOW 列出的是用户明确要保留去广告的金融 App（实测可解密）。
 *
 * 末尾有断言：金融域名残留、hostname 粘连等问题直接让构建失败。
 *
 * 用法: node build-adblock.mjs [--check] [--src=<URL|本地文件>]
 */
import fs from 'fs';
import path from 'path';

const DEFAULT_SRC = 'https://raw.githubusercontent.com/fmz200/wool_scripts/main/Shadowrocket/module/blockAds.srmodule';
const SRC = process.argv.find((a) => a.startsWith('--src='))?.slice(6) || DEFAULT_SRC;
const OUT = path.resolve('adblock/blockAds.srmodule');
// 零解密版：只保留 [Rule] 段，不含 MITM / 脚本 / Map Local，装它不产生任何解密开销
const DNS_OUT = path.resolve('adblock/blockAds-dns.srmodule');
const KEEP_FILE = path.resolve('adblock/keep-apps.txt');
const CHECK_ONLY = process.argv.includes('--check');

// ── 白名单 ───────────────────────────────────────────
const KEEP = new Set(
  fs
    .readFileSync(KEEP_FILE, 'utf8')
    .replace(/\r/g, '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#')),
);

// 金融类中用户明确保留的 App（段名需与上游一致，且也要写进 keep-apps.txt）
const FIN_ALLOW = new Set(['雪球', '同花顺', '天天基金']);

// ── 段落名命中即视为金融段 ──────────────────────────────
const FIN_SECTION = /(银行|信用卡|证券|基金|保险|金融|钱包|支付|银联|云闪付|农商|财富|智投|人寿|人保|平安|福享太平|友邦|富途|币安|币世界|拉卡拉|分期|翼支付)/;

// ── 金融域名关键词（MITM 兜底过滤）────────────────────
const FIN_HOST =
  /(bank|pingan|gtja|htsc|cmschina|ecitic|creditcard|95508|95516|95598pay|futunn|yxzq|bestpay|lakala|helipay|binance|bishijie|chinalife|epicc|cntaiping|aia\.com|51credit|cibfintech|hsbc|cgws|chinahxzq|sdb\.com\.cn|spdbccc|z-bank|alipay|tenpay|unionpay|cup\.com\.cn|cmbchina|10jqka|dfcfw|1234567|xueqiu)/i;

// ── 域名黑名单（精确豁免，不随白名单变化）──────────────
const DOMAIN_PATTERNS = [
  /(^|\.)ccb\.com(\.cn)?$/,
  /(^|\.)icbc\.com\.cn$/,
  /(^|\.)abchina\.com(\.cn)?$/,
  /(^|\.)boc\.cn$/,
  /(^|\.)bankofchina\.com$/,
  /(^|\.)psbc\.com$/,
  /(^|\.)bankcomm\.(com|cn)$/,
  /(^|\.)spdb\.com\.cn$/,
  /(^|\.)citicbank\.com$/,
  /(^|\.)cmbc\.com\.cn$/,
  /(^|\.)hxb\.com\.cn$/,
  /(^|\.)cebbank\.com$/,
  /(^|\.)cib\.com\.cn$/,
  /(^|\.)cgbchina\.com\.cn$/,
  /(^|\.)qianbao\.qq\.com$/, // QQ 钱包
  /(^|\.)1qianbao\.com$/, // 平安壹钱包
  /(^|\.)payapp\.weixin\.qq\.com$/, // 微信支付
  /(^|\.)dns\.jd\.com$/, // 已在 DNS 层 REJECT，无需解密

  // 速度优先：京东主 API 承载搜索/详情/订单，解密 + requires-body 会明显变卡
  /(^|\.)api\.m\.jd\.com$/,

  // 可用性豁免：山姆主 API 被 Map Local 返回 {} 会导致 App 无法使用
  /(^|\.)api-sams\.walmartmobile\.cn$/,
];

// ── 直连 App 的 QUIC 拦截 ─────────────────────────────
// 配置里 block-quic = all-proxy 只拦代理流量；这些国内 App 直连走 QUIC 时
// 绕过 MITM，开屏/信息流去不掉。只拦这几个域名，不动全局。
const QUIC_BLOCK = ['amemv.com', 'snssdk.com', 'taobao.com', 'cainiao.com', 'goofish.com', 'zhihu.com', 'pinduoduo.com', 'yangkeduo.com', 'bilibili.com', 'biliapi.net', 'hongyibo.com.cn'];

// ── 上游缺失的 App，自补规则（追加到 [Map Local]）──────────
// 酷狗概念版：来源 luestr「酷狗概念版去广告」，只取广告/开屏接口；
// 未取 user/v1/init、experiment/get_params 等（返回 {} 可能致 App 异常）
const EXTRA = [
  {
    name: '酷狗概念版',
    hosts: ['gateway.kugou.com'],
    mapLocal: [
      '^https:\\/\\/gateway\\.kugou\\.com\\/youth\\/v1\\/start_img\\/last\\?',
      '^https:\\/\\/gateway\\.kugou\\.com\\/ads\\.service\\/',
      '^https:\\/\\/gateway\\.kugou\\.com\\/ads\\.gateway\\/',
    ],
  },
];
const JSON_EMPTY = ' data-type=text data="{}" status-code=200 header="Content-Type:application/json"';

// ── 规则改写（在剔除之后应用）──────────────────────────
const REPLACES = [
  {
    // 京东脚本只保留启动与欢迎页两个接口（开屏广告就在这两个里）
    name: '京东脚本收窄到启动接口',
    required: false,
    from: /pattern=\^https:\\\/\\\/api\\\.m\\\.jd\\\.com\\\/client\\\.action\\\?functionId=\([^)]*\)/,
    to: 'pattern=^https:\\/\\/api\\.m\\.jd\\.com\\/client\\.action\\?functionId=(start|welcomeHome)',
  },
];

const MITM_SECS = new Set(['Header Rewrite', 'URL Rewrite', 'Body Rewrite', 'Map Local', 'Script']);
const cleanHost = (h) => h.trim().replace(/hostname$/i, '');
// [Rule] 段里出现银联/云闪付域名的段，即使段名不含金融字样也按金融段处理（段名被上游改掉时的兜底）
const FIN_RULE_HOST = /(^|\.)(95516\.com|cup\.com\.cn|unionpay\.com)$/i;
const finByRuleHost = new Set();
const isFinSection = (n) => (FIN_SECTION.test(n) || finByRuleHost.has(n)) && !FIN_ALLOW.has(n);
const isBlockedHost = (h) => DOMAIN_PATTERNS.some((re) => re.test(h));

// ── 读取上游 ─────────────────────────────────────────
let src;
if (/^https?:/.test(SRC)) {
  const res = await fetch(SRC, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${SRC} → HTTP ${res.status}`);
  src = await res.text();
} else {
  src = fs.readFileSync(SRC, 'utf8');
}
src = src.replace(/\r\n/g, '\n');
const lines = src.split('\n');

// ── 第一遍：段名 → 声明的 hostname；上游 MITM 列表 ─────
const hostOwner = new Map(); // host → Set<段名>
let upstreamHosts = [];
{
  let sec = '';
  let name = '';
  for (const l of lines) {
    let m;
    if ((m = l.match(/^\[(.+)\]$/))) { sec = m[1]; name = ''; continue; }
    if (/^# >>>/.test(l)) { name = ''; continue; }
    if ((m = l.match(/^# > (.+)/))) { name = m[1].trim(); continue; }
    if (sec === 'MITM' && /^hostname\s*=/.test(l)) {
      upstreamHosts = l.replace(/^hostname\s*=\s*(%APPEND%)?\s*/, '').split(',').map(cleanHost).filter(Boolean);
      continue;
    }
    if (sec === 'Rule' && name && (m = l.match(/^(?:DOMAIN|DOMAIN-SUFFIX),([^,\s]+),/)) && FIN_RULE_HOST.test(m[1])) {
      finByRuleHost.add(name);
      continue;
    }
    if (name && (m = l.match(/^#\s*hostname\s*=\s*(.+)/))) {
      for (const h of m[1].split(',').map(cleanHost).filter(Boolean)) {
        if (!hostOwner.has(h)) hostOwner.set(h, new Set());
        hostOwner.get(h).add(name);
      }
    }
  }
}

// ── 第二遍：按段裁剪 ─────────────────────────────────
const out = [];
const seenSections = new Set();
const keptMitmSections = new Set();
const droppedFin = new Set();
let droppedMitmRules = 0;
let orphanRules = 0;
const timeoutStat = { 10: 0, 20: 0 };
{
  let sec = '';
  let name = '';
  for (let line of lines) {
    let m;
    if ((m = line.match(/^\[(.+)\]$/))) {
      sec = m[1];
      name = '';
      if (sec === 'MITM') break; // MITM 段末尾单独重建
      out.push(line);
      if (sec === 'Rule') {
        out.push('# > QUIC 拦截（sr-rules 追加：直连 App 回退 TCP，MITM 才能生效）');
        for (const d of QUIC_BLOCK) out.push(`AND,((PROTOCOL,QUIC),(DOMAIN-SUFFIX,${d})),REJECT`);
        out.push('');
      }
      if (sec === 'Map Local') {
        for (const e of EXTRA) {
          out.push(`# > ${e.name}（sr-rules 自补）`, `# hostname = ${e.hosts.join(', ')}`);
          for (const p of e.mapLocal) out.push(p + JSON_EMPTY);
          out.push('');
        }
      }
      continue;
    }
    if (/^# >>>/.test(line)) { name = ''; out.push(line); continue; }
    if ((m = line.match(/^# > (.+)/))) name = m[1].trim();

    const inMitm = MITM_SECS.has(sec);
    if (name) seenSections.add(name);

    // 金融段：所有分区一律删除（FIN_ALLOW 除外）
    if (name && isFinSection(name)) { droppedFin.add(name); continue; }

    if (inMitm) {
      const isRule = line.trim() && !line.startsWith('#');
      if (!name) {
        if (isRule) { orphanRules++; continue; } // 无归属规则：不认识的 App，删除
        out.push(line);
        continue;
      }
      if (!KEEP.has(name)) { if (isRule) droppedMitmRules++; continue; }
      if (isRule) keptMitmSections.add(name);

      if (sec === 'Script' && isRule) {
        const t = /binary-body-mode\s*=\s*(true|1)/.test(line) ? 20 : 10;
        line = /timeout\s*=\s*\d+/.test(line) ? line.replace(/timeout\s*=\s*\d+/, `timeout=${t}`) : `${line}, timeout=${t}`;
        timeoutStat[t]++;
      }
    }
    out.push(line);
  }
}

// ── 重建 MITM hostname ───────────────────────────────
const keptHosts = [];
const removed = { notKept: 0, fin: new Set(), blocked: new Set() };
for (const h of [...new Set(upstreamHosts)]) {
  const owners = [...(hostOwner.get(h) || [])].filter((n) => KEEP.has(n) && !isFinSection(n));
  if (owners.length === 0) { removed.notKept++; continue; }
  if (isBlockedHost(h)) { removed.blocked.add(h); continue; }
  if (FIN_HOST.test(h) && !owners.some((n) => FIN_ALLOW.has(n))) { removed.fin.add(h); continue; }
  keptHosts.push(h);
}
for (const h of EXTRA.flatMap((e) => e.hosts)) if (!keptHosts.includes(h)) keptHosts.push(h);
out.push('[MITM]', `hostname = %APPEND% ${keptHosts.join(', ')}`, '');

let result = out.join('\n');

const repReport = [];
for (const p of REPLACES) {
  if (!p.from.test(result)) {
    repReport.push(`${p.required ? '❌' : '⚠️ '} ${p.name} —— 锚点未命中`);
    continue;
  }
  result = result.replace(p.from, p.to);
  repReport.push(`✅ ${p.name}`);
}

// 头部改写：指向自己的仓库，避免「检查更新」跳回上游
result = result
  .replace(/^#!name=.*/m, '#!name=广告拦截(自用白名单版)')
  .replace(/^#!desc=.*/m, `#!desc=基于 fmz200/blockAds 裁剪：仅对 ${keptMitmSections.size} 款自用 App 做 MITM 去广告，已剔除金融类（雪球/同花顺/天天基金除外）；其余 App 仅 DNS 层拦截`)
  .replace(/^#!homepage=.*/m, '#!homepage=https://github.com/chaojiman/sr-rules')
  .replace(/^#!raw-url=.*/m, '#!raw-url=https://github.com/chaojiman/sr-rules/raw/main/adblock/blockAds.srmodule');

// ── 报告 ─────────────────────────────────────────────
const missing = [...KEEP].filter((n) => !seenSections.has(n));
console.log(`上游 ${(src.length / 1024).toFixed(0)} KB → 输出 ${(result.length / 1024).toFixed(0)} KB`);
console.log(`白名单 ${KEEP.size} 个，实际保留解密规则的 App ${keptMitmSections.size} 个`);
console.log(`剔除段落（金融）${droppedFin.size} 个：${[...droppedFin].join('、') || '（无）'}`);
console.log(`剔除非白名单解密规则 ${droppedMitmRules} 条，无归属规则 ${orphanRules} 条`);
console.log(`MITM 域名 ${upstreamHosts.length} → ${keptHosts.length}（非白名单 ${removed.notKept}，金融 ${removed.fin.size}，豁免 ${removed.blocked.size}）`);
if (removed.fin.size) console.log(`  金融域名：${[...removed.fin].join(', ')}`);
console.log(`Script 超时：10s × ${timeoutStat[10]}，20s × ${timeoutStat[20]}`);
console.log(repReport.join('\n'));
if (missing.length) console.log(`⚠️  白名单中上游不存在的段名：${missing.join('、')}`);

// ── 断言 ─────────────────────────────────────────────
const errors = [];
const finLeft = keptHosts.filter((h) => FIN_HOST.test(h) && ![...(hostOwner.get(h) || [])].some((n) => FIN_ALLOW.has(n)));
if (finLeft.length) errors.push(`金融域名残留：${finLeft.join(', ')}`);
const glued = keptHosts.filter((h) => /hostname|\s/i.test(h));
if (glued.length) errors.push(`hostname 粘连：${glued.join(', ')}`);
const blockedLeft = keptHosts.filter(isBlockedHost);
if (blockedLeft.length) errors.push(`豁免域名残留：${blockedLeft.join(', ')}`);
if (keptHosts.length < 50) errors.push(`MITM 域名只剩 ${keptHosts.length} 个，上游结构可能已变`);
if (/^[^#\n].*timeout=60\b/m.test(result)) errors.push('仍有 timeout=60 的脚本');
if (errors.length) {
  console.error('❌ 断言失败：\n  ' + errors.join('\n  '));
  process.exit(1);
}

if (CHECK_ONLY) {
  console.log('--check 模式，未写文件');
  process.exit(0);
}

// ── 生成零解密版（仅 [Rule] 段）──────────────────────
// 背景：MITM 191 个域名 + 94 条 requires-body 脚本会让日常高频站（百度/知乎/小红书/
// 微信/携程…）每次请求都经历「解密 → 缓冲整个响应体 → 跑 JS → 重加密」，实测明显卡顿。
// 这个版本只保留 DNS 层 REJECT，零解密、零脚本，性能开销等同于没有模块。
function buildDnsOnly(full) {
  const fl = full.split('\n');
  const firstSec = fl.findIndex((l) => /^\[.+\]$/.test(l.trim()));
  const header = fl.slice(0, firstSec < 0 ? 0 : firstSec);
  const s = fl.findIndex((l) => l.trim() === '[Rule]');
  if (s < 0) throw new Error('未找到 [Rule] 段，无法生成零解密版');
  const e = fl.findIndex((l, i) => i > s && /^\[.+\]$/.test(l.trim()));
  const isStruct = (t) => !t || t.startsWith('#') || /^\[.+\]$/.test(t);
  const raw = fl.slice(s, e < 0 ? fl.length : e);

  // 1) 无 MITM 时永远不命中：
  //  - AND,((PROTOCOL,QUIC),...) 原本是「迫使走 TCP 才能 MITM」，没有 MITM 就只剩降速
  //  - USER-AGENT / URL-REGEX 在 HTTPS 不解密时看不到 UA 和 path，包括嵌在 AND 里的
  const alive = raw.filter((l) => {
    const t = l.trim();
    if (isStruct(t)) return true;
    if (/^AND,\(\(PROTOCOL,QUIC\)/i.test(t)) return false;
    if (/\b(USER-AGENT|URL-REGEX)\b/i.test(t)) return false;
    return true;
  });

  // 2) 完全重复的规则行
  const seen = new Set();
  const deduped = alive.filter((l) => {
    const t = l.trim();
    if (isStruct(t)) return true;
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  });

  // 3) 被同集合更宽 DOMAIN-SUFFIX 覆盖的条目。模块里全部是 REJECT，
  //    剪掉不改变拦截结果，只少占内存。
  const suffixes = new Set();
  for (const l of deduped) {
    const m = l.trim().match(/^DOMAIN-SUFFIX,([^,\s]+)/i);
    if (m) suffixes.add(m[1].toLowerCase());
  }
  const covered = (d) => {
    const p = d.toLowerCase().split('.');
    for (let i = 1; i < p.length; i++) if (suffixes.has(p.slice(i).join('.'))) return true;
    return false;
  };
  const ruleSec = deduped.filter((l) => {
    const t = l.trim();
    const m = t.match(/^(?:DOMAIN|DOMAIN-SUFFIX),([^,\s]+)/i);
    return !m || !covered(m[1]);
  });

  const stats = {
    dead: raw.length - alive.length,
    dup: alive.length - deduped.length,
    shadowed: deduped.length - ruleSec.length,
  };
  const text = [
    ...header.map((l) =>
      l
        .replace(/^#!name=.*/, '#!name=广告拦截 DNS 版（零解密）')
        .replace(/^#!desc=.*/, '#!desc=仅 DNS 层拦截广告域名，不开 HTTPS 解密、不含脚本，零性能开销；要 App 内去开屏请改用 blockAds.srmodule')
        .replace(/^#!raw-url=.*/, '#!raw-url=https://github.com/chaojiman/sr-rules/raw/main/adblock/blockAds-dns.srmodule'),
    ),
    '',
    ...ruleSec,
    '',
  ].join('\n');
  return { text, stats };
}

const { text: dnsResult, stats: dnsStats } = buildDnsOnly(result);
const dnsRuleCount = dnsResult.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#') && !/^\[.+\]$/.test(l.trim())).length;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
const prevDns = fs.existsSync(DNS_OUT) ? fs.readFileSync(DNS_OUT, 'utf8') : null;
if (prev === result && prevDns === dnsResult) {
  console.log('无变化');
  process.exit(0);
}
if (prev !== result) {
  fs.writeFileSync(OUT, result);
  console.log(`已写入 ${OUT}`);
}
if (prevDns !== dnsResult) {
  fs.writeFileSync(DNS_OUT, dnsResult);
  console.log(
    `已写入 ${DNS_OUT}（${dnsRuleCount} 条 REJECT，无 MITM/脚本；` +
      `剔死规则 ${dnsStats.dead}、去重 ${dnsStats.dup}、剪遮蔽 ${dnsStats.shadowed}）`,
  );
}
