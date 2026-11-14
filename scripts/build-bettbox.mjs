/**
 * 拉取 AIsouler/MyClash 的 mihomo 覆写脚本，打上本地补丁，输出到 bettbox/mihomoScript.js
 *
 * 补丁原则：
 *   - 只改「默认值」「规则顺序」和「去分组后的出口映射」，不重写核心逻辑
 *   - 上游新增的开关/功能自动保留（不整份替换）
 *   - 必需补丁锚点找不到 → 直接报错退出，不产出坏脚本
 *
 * 用法: node scripts/build-bettbox.mjs [--check]
 *   --check  只校验上游 + 锚点，不写文件
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const SRC = 'https://raw.githubusercontent.com/AIsouler/MyClash/main/Script/mihomoScript.js';
const OUT = path.resolve('bettbox/mihomoScript.js');
const CHECK_ONLY = process.argv.includes('--check');

// ── 额外规则：从 bettbox/rules-extra.txt 读取，注入 prefixRules 最前面 ──
const EXTRA_FILE = path.resolve('bettbox/rules-extra.txt');
const extraRules = fs.existsSync(EXTRA_FILE)
  ? fs
      .readFileSync(EXTRA_FILE, 'utf8')
      .replace(/\r/g, '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
  : [];

const extraBlock = extraRules.length
  ? `  // ===== 额外规则（来自 bettbox/rules-extra.txt，勿直接改本文件）=====\n` +
    // 转义顺序：先反斜杠再单引号（PROCESS-PATH-REGEX 含 \\，不转义会被 JS 字符串吞掉）
    extraRules.map((l) => `  '${l.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}',`).join('\n') +
    '\n'
  : '';

// ── 自建节点：从 bettbox/custom-proxies.mjs 读取，注入 customizeProxies ──
// 放在仓库里而不是手改生成文件，否则每日同步会覆盖。
const CUSTOM_FILE = path.resolve('bettbox/custom-proxies.mjs');
let customProxies = [];
if (fs.existsSync(CUSTOM_FILE)) {
  const mod = await import(pathToFileURL(CUSTOM_FILE).href);
  customProxies = Array.isArray(mod.default) ? mod.default : [];
}
const customProxiesBlock = customProxies.length
  ? `// 来自 bettbox/custom-proxies.mjs，由 build-bettbox.mjs 注入\nconst customizeProxies = ${JSON.stringify(customProxies, null, 2)};`
  : `const customizeProxies = [];`;

// ── 补丁定义 ──────────────────────────────────────────────
// required: 锚点丢失时是否中断构建

const REPLACES = [
  // ── 必需：规则顺序 AdBlock → GitHub → AI → 其余 ──
  // GitHub 在 AI 前：Copilot 全系自然归 GitHub，无需逐条钉规则
  // AI 在 Google 前：antigravity/gemini 的 *.googleapis.com 不会被 Google 抢走
  // 上游 2026-11-12 起：AdBlock 标了 priority，规则走 priorityRules（插在 prefixRules 之前），
  // 循环体改为 (svc.priority ? priorityRules : functionalRules).push(...)，原先的
  // orderedServiceConfigs 已被上游删除。这里在同一循环里重建顺序并插入 .cn 兜底。
  {
    name: '规则顺序 GitHub→AI + .cn 兜底',
    required: true,
    from: `  for (const svc of serviceConfigs) {
    if (!ruleOptionsEnable[svc.name]) continue;

    (svc.priority ? priorityRules : functionalRules).push(...(svc.rules || []));
    functionalIpRules.push(...(svc.ipRules || []));
    Object.assign(finalRuleProviders, svc.providers || {});
  }`,
    to: `  // GitHub 在 AI 前：Copilot 全系自然归 GitHub，无需逐条钉规则
  // AI 在 Google 前：antigravity/gemini 的 *.googleapis.com 不被 Google 抢走
  const orderedServiceConfigs = [
    ...serviceConfigs.filter((svc) => svc.name === 'AdBlock'),
    ...serviceConfigs.filter((svc) => svc.name === 'GitHub'),
    ...serviceConfigs.filter((svc) => svc.name === 'AI'),
    ...serviceConfigs.filter((svc) => !['AdBlock', 'GitHub', 'AI'].includes(svc.name)),
  ];
  let cnFallbackInserted = false;
  for (const svc of orderedServiceConfigs) {
    // 去分组服务始终保留规则，出口已直接改写为默认代理或直连。
    if (!INLINE_SERVICE_POLICIES[svc.name] && !ruleOptionsEnable[svc.name]) continue;

    // .cn 不能放 prefixRules：否则会抢在 AdBlock 前放行 .cn 广告域名。
    // 在首个非优先服务前插入，确保 AdBlock → GitHub → AI → .cn → 其余服务。
    if (!['AdBlock', 'GitHub', 'AI'].includes(svc.name) && !cnFallbackInserted) {
      // geolocation-cn 覆盖不到企业/地方 .cn 站点；域名匹配无需 DNS 解析
      functionalRules.push('DOMAIN-SUFFIX,cn,直连');
      cnFallbackInserted = true;
    }
    (svc.priority ? priorityRules : functionalRules).push(...(svc.rules || []));
    functionalIpRules.push(...(svc.ipRules || []));
    Object.assign(finalRuleProviders, svc.providers || {});
  }
  // 极端情况下上游只剩优先服务，也不能丢失 .cn 兜底。
  if (!cnFallbackInserted) functionalRules.push('DOMAIN-SUFFIX,cn,直连');`,
  },

  // ── 必需：额外规则注入 ──
  {
    name: 'prefixRules 额外规则',
    required: true,
    from: `const prefixRules = [`,
    to: `// ⚠️ Bettbox 会用界面设置覆盖本脚本的同名键（源码 lib/state.dart buildPatchParams）：
//    find-process-mode / tun 整块 / mixed-port / ipv6 / external-controller / log-level
//    → 这些在脚本里写了也不生效，必须在界面改
//    dns 只在界面「覆写 DNS」开启时被覆盖；rules / proxy-groups 以脚本为准
const prefixRules = [
${extraBlock}`,
  },

  // ── 必需：指定服务只保留规则，不生成独立 Selector / Bettbox 开关 ──
  {
    name: '指定服务去分组并内联出口',
    required: true,
    from: `Compatible_With_Bettbox.policyGroupOptions = serviceConfigs.map((svc) => svc.name);`,
    to: `const INLINE_SERVICE_POLICIES = {
  Emby: '直连',
  PayPal: '直连',
};
const NO_GROUP_SERVICES = new Set([
  'Line',
  'Emby',
  'PikPak',
  'Spotify',
  'Crypto',
  'PayPal',
  'Patreon',
  'EHentai',
]);

// 仅直连服务需要保留显式规则；默认代理服务直接由 geolocation-!cn / MATCH 兜底。
for (const svc of serviceConfigs) {
  const target = INLINE_SERVICE_POLICIES[svc.name];
  if (!target) continue;
  const suffix = \`,\${svc.name}\`;
  const retarget = (rule) => (rule.endsWith(suffix) ? \`\${rule.slice(0, -suffix.length)},\${target}\` : rule);
  svc.rules = (svc.rules || []).map(retarget);
  svc.ipRules = (svc.ipRules || []).map(retarget);
}

Compatible_With_Bettbox.policyGroupOptions = serviceConfigs
  .filter((svc) => !NO_GROUP_SERVICES.has(svc.name))
  .map((svc) => svc.name);`,
  },
  {
    name: '去分组服务不生成 Selector',
    required: true,
    from: `  for (const svc of serviceConfigs) {
    if (!ruleOptionsEnable[svc.name]) continue;

    const groupProxies = svc.includeAll`,
    to: `  for (const svc of serviceConfigs) {
    if (INLINE_SERVICE_POLICIES[svc.name] || !ruleOptionsEnable[svc.name]) continue;

    const groupProxies = svc.includeAll`,
  },

  // ── 必需：自建节点注入（来自 bettbox/custom-proxies.mjs）──
  {
    name: 'customizeProxies 注入',
    required: true,
    from: `const customizeProxies = [];`,
    to: customProxiesBlock,
  },

  // ── 必需：DNS 常量（IP 引导 + system 竞速 + 节点组全加密）──
  // 职责严格对齐 mihomo 内核：
  //   default-nameserver  引导 DNS，只解析加密 DNS 自身域名，禁放 system/URL
  //   nameserver          杂鱼域名本地解析（system 与 DoH 同组并发竞速，system 恒抢先）
  //   proxy-server-nameserver  节点域名解析，全加密，避免运营商 UDP 抢答污染
  {
    name: 'DNS 常量：IP 引导 + system 竞速',
    required: true,
    from: `const chinaDNS = ['223.5.5.5#DIRECT', '119.29.29.29#DIRECT'];
const foreignDNS = ['https://cloudflare-dns.com/dns-query#默认代理', 'https://dns.google/dns-query#默认代理'];
const defaultDNS = ['114.114.114.114#DIRECT', 'tls://223.5.5.5#DIRECT', 'https://1.12.12.12/dns-query#DIRECT'];
const proxyServerDNS = ['114.114.114.114#DIRECT', 'tls://223.5.5.5#DIRECT', 'https://doh.pub/dns-query#DIRECT'];`,
    to: `// 对齐小火箭实测结论 + mihomo 字段职责：
// - defaultDNS=default-nameserver：纯 IP 引导，仅解析 DoH 服务器自身域名，禁放 system/URL
// - chinaDNS=nameserver：system 与 DoH 同组并发竞速（mihomo 无主备，system 恒抢先=明文换速度的既定取舍）
// - proxyServerDNS 节点域名解析保持全加密，杜绝运营商 UDP 抢答污染
const defaultDNS = ['223.5.5.5', '119.29.29.29'];
const chinaDNS = ['system', 'https://223.5.5.5/dns-query#h3=true&DIRECT', 'https://120.53.53.53/dns-query#DIRECT'];
const foreignDNS = ['https://cloudflare-dns.com/dns-query#默认代理', 'https://dns.google/dns-query#默认代理'];
const proxyServerDNS = ['https://223.5.5.5/dns-query#h3=true&DIRECT', 'https://doh.pub/dns-query#DIRECT'];`,
  },

  // ── 必需：DNS 对象（Fake-IP 过滤 + 国内优先解析 + Tailscale MagicDNS）──
  {
    name: 'DNS 对象：geolocation-cn 全家 + ts.net MagicDNS',
    required: true,
    from: `    'fake-ip-filter': [
      'rule-set:private',
      'rule-set:fakeip_filter',
      'rule-set:cn',
      ...(minimalModeEnabled ? [] : ruleOptionsEnable['FCM'] ? ['rule-set:googlefcm'] : []),
      ...proxyFakeIpFilter,
    ],
    'default-nameserver': defaultDNS,
    'proxy-server-nameserver': proxyServerDNS,
    ...(Object.keys(proxyServerPolicy).length > 0 && {
      'proxy-server-nameserver-policy': proxyServerPolicy,
    }),
    nameserver: foreignDNS,
    'nameserver-policy': {
      'rule-set:private': 'system',
      'rule-set:douyin': ['180.184.1.1#DIRECT', '180.184.2.2#DIRECT'],
      'rule-set:cn': chinaDNS,
    },
    'direct-nameserver': chinaDNS,
    'direct-nameserver-follow-policy': true,`,
    to: `    'fake-ip-filter': [
      // Tailscale MagicDNS：不进 Fake-IP，否则短主机名解析失败
      '+.ts.net',
      'rule-set:private',
      'rule-set:fakeip_filter',
      // 用分流实际使用的 geolocation-cn 全家替换与规则集重复的 cn，
      // 否则 apple_cn / games_cn 等国内域名会漏进 Fake-IP
      'rule-set:geolocation-cn',
      'rule-set:apple_cn',
      'rule-set:microsoft_cn',
      'rule-set:games_cn',
      'rule-set:synology',
      ...(minimalModeEnabled ? [] : ruleOptionsEnable['FCM'] ? ['rule-set:googlefcm'] : []),
      ...proxyFakeIpFilter,
    ],
    'default-nameserver': defaultDNS,
    'proxy-server-nameserver': proxyServerDNS,
    ...(Object.keys(proxyServerPolicy).length > 0 && {
      'proxy-server-nameserver-policy': proxyServerPolicy,
    }),
    // 杂鱼域名由国内组本地毫秒级解析供 cn_ip 判定；已知国内外分别走策略组，杜绝绕道与泄露
    nameserver: chinaDNS,
    'nameserver-policy': {
      '+.ts.net': '100.100.100.100',
      'rule-set:private': 'system',
      'rule-set:geolocation-!cn': foreignDNS,
      'rule-set:geolocation-cn': chinaDNS,
      'rule-set:apple_cn': chinaDNS,
      'rule-set:microsoft_cn': chinaDNS,
      'rule-set:games_cn': chinaDNS,
      'rule-set:synology': chinaDNS,
    },
    'direct-nameserver': chinaDNS,
    'direct-nameserver-follow-policy': true,`,
  },

  // ── 必需：屏蔽代理 QUIC 的规则改指 geolocation-cn（cn 规则集已精简移除）──
  {
    name: 'QUIC 拦截改指 geolocation-cn',
    required: true,
    from: `(NOT,((OR,((RULE-SET,cn),(RULE-SET,cn_ip,no-resolve)))))`,
    to: `(NOT,((OR,((RULE-SET,geolocation-cn),(RULE-SET,cn_ip,no-resolve)))))`,
  },

  // ── 必需：规则集精简（cn 与 geolocation-cn 重复；douyin 为明文 UDP 定向）──
  // 用正则匹配，避免在模板字符串里出现反引号与 ${} 插值
  {
    name: '规则集精简：移除 cn / douyin',
    required: true,
    from: /  cn: \{\n    \.\.\.ruleProviderCommonDomain,\n    url: `[^`]*geosite\/cn\.mrs`,\n    path: '\.\/ruleset\/cn\.mrs',\n    'path-in-bundle': 'geo\/geosite\/cn\.mrs',\n  \},\n  douyin: \{\n    \.\.\.ruleProviderCommonDomain,\n    url: `[^`]*geosite\/douyin\.mrs`,\n    path: '\.\/ruleset\/douyin\.mrs',\n    'path-in-bundle': 'geo\/geosite\/douyin\.mrs',\n  \},\n/,
    to: '',
  },

  // 注：上游 cn_ip / private_ip 本来就不带 no-resolve，无需补丁。
  //     加 no-resolve 会让 IP 规则对域名请求直接跳过，国内 IP 兜底形同失效。

  // ── 默认值对齐当前 Bettbox UI 实测状态（非必需，上游删项时不中断）──
  { name: '手动选择=关', required: false, from: /^(\s*)手动选择:\s*true,/m, to: '$1手动选择: false,' },
  { name: '自动选择=关', required: false, from: /^(\s*)自动选择:\s*true,/m, to: '$1自动选择: false,' },
  { name: '负载均衡=关', required: false, from: /^(\s*)负载均衡:\s*true,/m, to: '$1负载均衡: false,' },
  { name: 'FCM=关', required: false, from: /^(\s*)FCM:\s*true,/m, to: '$1FCM: false,' },
  { name: 'Twitter=关', required: false, from: /^(\s*)Twitter:\s*true,/m, to: '$1Twitter: false,' },
  { name: 'Line=关', required: false, from: /^(\s*)Line:\s*true,/m, to: '$1Line: false,' },
  { name: 'Emby=关', required: false, from: /^(\s*)Emby:\s*true,/m, to: '$1Emby: false,' },
  { name: 'PikPak=关', required: false, from: /^(\s*)PikPak:\s*true,/m, to: '$1PikPak: false,' },
  { name: 'Spotify=关', required: false, from: /^(\s*)Spotify:\s*true,/m, to: '$1Spotify: false,' },
  { name: 'Crypto=关', required: false, from: /^(\s*)Crypto:\s*true,/m, to: '$1Crypto: false,' },
  { name: 'PayPal=关', required: false, from: /^(\s*)PayPal:\s*true,/m, to: '$1PayPal: false,' },
  { name: 'Patreon=关', required: false, from: /^(\s*)Patreon:\s*true,/m, to: '$1Patreon: false,' },
  { name: 'EHentai=关', required: false, from: /^(\s*)EHentai:\s*true,/m, to: '$1EHentai: false,' },
  // 地区组附带「-自动选择」（url-test），同地区内自动挑最快节点
  {
    name: '地区自动组=开',
    required: false,
    from: /^(\s*)生成地区自动选择组:\s*(?:true|false),/m,
    to: '$1生成地区自动选择组: true,',
  },
  { name: '家宽组=关', required: false, from: /^(\s*)生成家宽节点组:\s*(?:true|false),/m, to: '$1生成家宽节点组: false,' },
  { name: '倍率组=关', required: false, from: /^(\s*)生成高低倍率组:\s*true,/m, to: '$1生成高低倍率组: false,' },
  // 与小火箭的 block-quic = all-proxy 保持一致：非国内流量禁 QUIC，回退 TCP
  {
    name: '屏蔽代理QUIC=开',
    required: false,
    from: /^(\s*)屏蔽代理QUIC流量:\s*(?:true|false),/m,
    to: '$1屏蔽代理QUIC流量: true,',
  },
  { name: 'IPv4优先=开', required: false, from: /^(\s*)代理IPV4优先:\s*false,/m, to: '$1代理IPV4优先: true,' },
  // 链式：自定义节点作为落地，经「链式中转」组（=订阅节点）中转；dialer-proxy 由上游自动补
  { name: '链式代理=开', required: false, from: /^(\s*)链式代理:\s*false,/m, to: '$1链式代理: true,' },

  // ── 服务默认出口：Bettbox 的「默认代理」对应小火箭的 PROXY ──
  {
    name: 'YouTube=默认代理',
    required: false,
    from: `    name: 'YouTube',
    baseOption: selectBaseOption,`,
    to: `    name: 'YouTube',
    baseOption: selectBaseOption,
    defaultSelected: '默认代理',`,
  },
  {
    name: 'Netflix=默认代理',
    required: false,
    from: `    name: 'Netflix',
    baseOption: selectBaseOption,`,
    to: `    name: 'Netflix',
    baseOption: selectBaseOption,
    defaultSelected: '默认代理',`,
  },
  {
    name: 'TikTok=默认代理',
    required: false,
    from: `    name: 'TikTok',
    baseOption: selectBaseOption,
    defaultSelected: '日本',`,
    to: `    name: 'TikTok',
    baseOption: selectBaseOption,
    defaultSelected: '默认代理',`,
  },

  // ── AI 组只保留真正的 AI 服务 ──
  // 上游把 OpenAI 用到的通用第三方（Intercom 客服、Fathom 统计）也划给了 AI 组，
  // 导致所有接入这些服务的站点都被固定走 AI 组（默认美国）。
  // 剔除后它们落回 MATCH,漏网之鱼，与小火箭 ai-extra 的处理一致。
  {
    name: 'AI 组剔除通用第三方服务',
    required: false,
    from: `    rules: [
      'RULE-SET,ai,AI',
      'DOMAIN,cdn.usefathom.com,AI',
      'DOMAIN-SUFFIX,intercom.io,AI',
      'DOMAIN-SUFFIX,intercomcdn.com,AI',
    ],`,
    to: `    // 通用第三方（Intercom 客服 / Fathom 统计）已剔除，落回 MATCH,漏网之鱼
    rules: ['RULE-SET,ai,AI'],`,
  },

  // ── 地区组补「韩国」──
  // 上游只有港/日/美/新/台。开着「过滤非地区节点」时，韩国节点会被当成
  // 非地区节点直接丢掉，在任何策略组里都选不到。
  // 补上后所有服务组自动获得该选项（groupProxies 用的是全量地区组）。
  {
    name: '地区组补韩国',
    required: false,
    from: `  {
    name: '新加坡',
    flag: '🇸🇬',`,
    to: `  {
    name: '韩国',
    flag: '🇰🇷',
    regex: /🇰🇷|韩国|首尔|韓|春川|(?<![A-Za-z])(?:KOR|KR)(?![A-Za-z])|korea/i,
    // 上游 Icons 目录没有 Korea.svg（实测 404），不填 icon 用默认图标
  },
  {
    name: '新加坡',
    flag: '🇸🇬',`,
  },
];

// ── 执行 ─────────────────────────────────────────────────

const res = await fetch(SRC, { signal: AbortSignal.timeout(60000) });
if (!res.ok) throw new Error(`${SRC} → HTTP ${res.status}`);

// 上游版本指纹：raw.githubusercontent 的 ETag 是内容 sha256，上游一改就变。
// 不额外发请求，也不受 API 限流影响。
const upstreamEtag = (res.headers.get('etag') || '').replace(/^W\//, '').replace(/"/g, '');

// 上游 commit（含日期）：尽力而为，失败只省略这一行，不影响构建。
// CI 会传 GITHUB_TOKEN 避开未认证限流。
let upstreamCommit = '';
try {
  const api = await fetch('https://api.github.com/repos/AIsouler/MyClash/commits/main', {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'sr-rules-build',
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (api.ok) {
    const j = await api.json();
    if (j?.sha && j?.commit?.committer?.date) {
      upstreamCommit = `${j.sha.slice(0, 7)} @ ${j.commit.committer.date}`;
    }
  }
} catch {
  // 忽略：有 ETag 就能定位上游版本
}

let code = (await res.text()).replace(/\r\n/g, '\n');

const report = [];
const fatal = [];

for (const p of REPLACES) {
  const hit = typeof p.from === 'string' ? code.includes(p.from) : p.from.test(code);
  if (!hit) {
    report.push(`${p.required ? '❌' : '⚠️ '} ${p.name} —— 锚点未命中`);
    if (p.required) fatal.push(p.name);
    continue;
  }
  code = typeof p.from === 'string' ? code.replace(p.from, p.to) : code.replace(p.from, p.to);
  report.push(`✅ ${p.name}`);
}

console.log(report.join('\n'));
console.log(`\n上游 ${(code.length / 1024).toFixed(1)} KB`);

if (fatal.length) {
  console.error(`\n必需补丁失败: ${fatal.join(', ')} —— 上游脚本结构已变，需人工检查`);
  process.exit(1);
}

if (CHECK_ONLY) {
  console.log('--check 模式，未写文件');
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });

// ── 构建指纹横幅 ──────────────────────────────────────
// 放在文件最顶端，便于出问题时一眼确认「这份是谁、哪天的、上游哪个版本」。
// 关键：横幅里的生成日期只在内容真正变化时才刷新 —— 否则每日定时构建都会改文件，
// 把「无意义提交」和「真实变更」混在一起。比对时先剥掉横幅再比正文。
const BANNER_OPEN = '// ══════════ sr-rules 构建标记（自动生成，勿手改）══════════\n';
const BANNER_CLOSE = '// ══════════ sr-rules 构建标记结束 ══════════\n';

const stripBanner = (s) => {
  if (!s.startsWith(BANNER_OPEN)) return s;
  const end = s.indexOf(BANNER_CLOSE);
  return end === -1 ? s : s.slice(end + BANNER_CLOSE.length);
};

const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
if (prev !== null && stripBanner(prev) === code) {
  console.log('无变化（上游与本地补丁均未变）');
  process.exit(0);
}

const banner =
  BANNER_OPEN +
  `// 生成日期: ${new Date().toISOString().slice(0, 10)}\n` +
  `// 上游脚本: ${SRC}\n` +
  `// 上游版本: ${upstreamEtag ? `etag ${upstreamEtag.slice(0, 12)}…` : '未知'}\n` +
  (upstreamCommit ? `// 上游提交: ${upstreamCommit}\n` : '') +
  `// 本地输入: bettbox/rules-extra.txt, bettbox/custom-proxies.mjs\n` +
  `// 重新生成: node scripts/build-bettbox.mjs\n` +
  BANNER_CLOSE;

fs.writeFileSync(OUT, banner + code);
console.log(`已写入 ${OUT}`);
