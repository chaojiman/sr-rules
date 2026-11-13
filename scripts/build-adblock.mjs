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
const QUIC_BLOCK = ['amemv.com', 'snssdk.com', 'taobao.com', 'cainiao.com', 'goofish.com', 'zhihu.com', 'pinduoduo.com', 'yangkeduo.com', 'bilibili.com', 'biliapi.net', 'hongyibo.com.cn', 'xiaohongshu.com'];

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

// ── 上游缺失的写法兜底（追加到 [URL Rewrite]）──────────
// cn-acs 侧只有 Map Local（batch.show.v2|index）与 Script（m?show.cn）覆盖，
// 菜鸟换接口名（v3 / splash）或改走 acs.m.taobao.com 网关时会全漏。
// 两个域名都已在上游 MITM 列表里，直接按命名空间 reject，不依赖脚本分支。
const URL_REWRITE_EXTRA = [
  {
    name: '菜鸟裹裹',
    hosts: ['cn-acs.m.cainiao.com', 'acs.m.taobao.com'],
    rules: [
      '^https?:\\/\\/(cn-acs\\.m\\.cainiao\\.com|acs\\.m\\.taobao\\.com)\\/gw\\/mtop\\.cainiao\\.guoguo\\.nbnetflow\\.ads - reject',
      '^https?:\\/\\/(cn-acs\\.m\\.cainiao\\.com|acs\\.m\\.taobao\\.com)\\/gw\\/mtop\\.cainiao\\.adx\\. - reject',
    ],
  },
];

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

// ── 精准剔除（按子串匹配，避免正则转义陷阱）──────────────
// 有道的 cdke/course3/recommend/dict/startup 是「课程推荐」启动接口，
// 整体返回 {} 会让 App 启动白屏，风险扫描标为高危。
// 收窄为不拦该启动接口，只保留该 App 的纯广告位（dsp-impr2 / impservice / oral）。
const DROP_LINES = [
  {
    name: '有道不再整包置空课程推荐启动接口',
    match: 'cdke\\.youdao\\.com\\/course3\\/recommend\\/dict\\/startup',
  },
];

// ── 脚本锁定到 commit SHA ──────────────────────────
// script-path 指向 raw.githubusercontent.com/{owner}/{repo}/{branch}/...
// 小火箭每次拉脚本都走分支头，上游半夜改坏脚本会立刻在手机上执行，
// 而模块要等次日 CI 才重建。锁定 SHA 后，脚本只在「模块重建 + 手机更新模块」时变化。
// 覆盖 fmz200 与 8 个第三方仓库；查询失败时回退原 URL 并告警，不阻断构建
// （阻断会导致模块停在旧版，旧脚本仍在跑，反而更差）。
const SHA_CACHE = new Map();
async function resolveSha(owner, repo, branch) {
  const key = `${owner}/${repo}@${branch}`;
  if (SHA_CACHE.has(key)) return SHA_CACHE.get(key);
  let sha = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${branch}`, {
      headers: { 'User-Agent': 'sr-rules-build', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) sha = (await res.json()).sha || null;
  } catch {
    sha = null;
  }
  SHA_CACHE.set(key, sha);
  return sha;
}

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
// 上游 [Rule] 完整内容（剔金融后），只给 blockAds-dns.srmodule 用。
// 完整模块的 [Rule] 只留 QUIC——域名规则已并入 config 的 ads.list（DOMAIN-SET 哈希查表），
// 留在模块里等于每个请求先线性扫 2,961 条。
const ruleLines = [];
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
      if (sec === 'Rule') {
        ruleLines.push(line, '# > QUIC 拦截（sr-rules 追加：直连 App 回退 TCP，MITM 才能生效）');
        out.push(line, '# > QUIC 拦截（sr-rules 追加：直连 App 回退 TCP，MITM 才能生效）');
        for (const d of QUIC_BLOCK) {
          const q = `AND,((PROTOCOL,QUIC),(DOMAIN-SUFFIX,${d})),REJECT`;
          out.push(q);
          ruleLines.push(q);
        }
        out.push('');
        continue;
      }
      out.push(line);
      if (sec === 'Map Local') {
        for (const e of EXTRA) {
          out.push(`# > ${e.name}（sr-rules 自补）`, `# hostname = ${e.hosts.join(', ')}`);
          for (const p of e.mapLocal) out.push(p + JSON_EMPTY);
          out.push('');
        }
      }
      if (sec === 'URL Rewrite') {
        for (const e of URL_REWRITE_EXTRA) {
          out.push(`# > ${e.name}（sr-rules 自补）`, `# hostname = ${e.hosts.join(', ')}`);
          for (const r of e.rules) out.push(r);
          out.push('');
        }
      }
      continue;
    }
    if (/^# >>>/.test(line)) { name = ''; (sec === 'Rule' ? ruleLines : out).push(line); continue; }
    if ((m = line.match(/^# > (.+)/))) name = m[1].trim();

    const inMitm = MITM_SECS.has(sec);
    if (name) seenSections.add(name);

    // 金融段：所有分区一律删除（FIN_ALLOW 除外）
    if (name && isFinSection(name)) { droppedFin.add(name); continue; }
    // [Rule] 段只收集不输出（完整模块只留 QUIC + MITM 专属类型）
    if (sec === 'Rule') {
      ruleLines.push(line);
      const t = line.trim();
      // URL-REGEX / USER-AGENT（含嵌在 AND 里的）依赖 MITM 明文，dns 版会过滤掉，
      // 只能留在模块里；数量 17 条，线性扫描开销可忽略。
      if (t && !t.startsWith('#') && /\b(USER-AGENT|URL-REGEX)\b/i.test(t)) out.push(line);
      continue;
    }

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
for (const h of URL_REWRITE_EXTRA.flatMap((e) => e.hosts)) if (!keptHosts.includes(h)) keptHosts.push(h);
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

// ── 精准剔除高危接口（在改写之后应用）──────────────
for (const d of DROP_LINES) {
  const before = result.split('\n');
  const kept = before.filter((l) => l.trim().startsWith('#') || !l.includes(d.match));
  const n = before.length - kept.length;
  result = kept.join('\n');
  repReport.push(`${n ? '✅' : '⚠️ '} ${d.name} —— 剔除 ${n} 条`);
}

// ── 脚本锁定 SHA ─────────────────────────────────
const pinStats = { total: 0, pinned: 0, already: 0, failed: [] };
// 两种写法都要认：raw.githubusercontent.com/{o}/{r}/{ref}/...
// 以及 github.com/{o}/{r}/raw/{ref}/...（上游混用）
const parseScriptUrl = (url) => {
  let m = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(?:refs\/heads\/)?([^/]+)\/(.+)$/);
  if (m) return { host: 'raw', owner: m[1], repo: m[2], ref: m[3], rest: m[4] };
  m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\/(?:refs\/heads\/)?([^/]+)\/(.+)$/);
  if (m) return { host: 'gh', owner: m[1], repo: m[2], ref: m[3], rest: m[4] };
  return null;
};
const pinTargets = [...new Set(result.match(/script-path=\S+?(?=[,\s]|$)/g) || [])];
for (const decl of pinTargets) {
  const url = decl.slice('script-path='.length);
  const parsed = parseScriptUrl(url);
  if (!parsed) {
    pinStats.failed.push(url);
    continue;
  }
  const { host, owner, repo, ref, rest } = parsed;
  pinStats.total++;
  if (/^[0-9a-f]{40}$/.test(ref)) {
    pinStats.already++;
    continue;
  }
  const sha = await resolveSha(owner, repo, ref);
  if (!sha) {
    pinStats.failed.push(url);
    continue;
  }
  const base =
    host === 'gh'
      ? `https://github.com/${owner}/${repo}/raw`
      : `https://raw.githubusercontent.com/${owner}/${repo}`;
  result = result.split(decl).join(`script-path=${base}/${sha}/${rest}`);
  pinStats.pinned++;
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
console.log(
  `脚本锁定：${pinStats.pinned} 个 → SHA，已锁定 ${pinStats.already}，失败 ${pinStats.failed.length}`,
);
if (pinStats.failed.length) console.log(`⚠️  未能锁定的脚本（回落分支头）：\n  ${pinStats.failed.join('\n  ')}`);
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
// 完整模块的 [Rule] 只剩 QUIC（域名规则已交给 config），所以要保证上游自带的 QUIC
// 域名全部在 QUIC_BLOCK 里，否则会静默丢失
const upstreamQuic = [
  ...new Set(
    lines
      .filter((l) => /^AND,\(\(PROTOCOL,QUIC\)/i.test(l.trim()))
      .map((l) => (l.match(/DOMAIN-SUFFIX,([^)]+)/) || [])[1])
      .filter(Boolean),
  ),
];
const missingQuic = upstreamQuic.filter((d) => !QUIC_BLOCK.includes(d));
if (missingQuic.length) errors.push(`上游 QUIC 域名未纳入 QUIC_BLOCK：${missingQuic.join(', ')}`);
// URL-REGEX / USER-AGENT 依赖 MITM 明文，dns 版会丢，必须留在模块 [Rule] 里
const upstreamMitmOnly = lines.filter((l) => /^[^#\n]/.test(l.trim()) && /\b(USER-AGENT|URL-REGEX)\b/i.test(l)).length;
const keptMitmOnly = result
  .split('\n')
  .filter((l) => /^[^#\n]/.test(l.trim()) && /\b(USER-AGENT|URL-REGEX)\b/i.test(l)).length;
if (keptMitmOnly < upstreamMitmOnly) {
  errors.push(`URL-REGEX/USER-AGENT 规则丢失：上游 ${upstreamMitmOnly} 条 → 模块 ${keptMitmOnly} 条`);
}
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
function buildDnsOnly(full, ruleLines) {
  const fl = full.split('\n');
  const firstSec = fl.findIndex((l) => /^\[.+\]$/.test(l.trim()));
  const header = fl.slice(0, firstSec < 0 ? 0 : firstSec);
  if (!ruleLines.length) throw new Error('未收集到 [Rule] 段，无法生成零解密版');
  const isStruct = (t) => !t || t.startsWith('#') || /^\[.+\]$/.test(t);
  const raw = ruleLines;

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

const { text: dnsResult, stats: dnsStats } = buildDnsOnly(result, ruleLines);
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
