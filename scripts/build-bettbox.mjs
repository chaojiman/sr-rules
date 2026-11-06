/**
 * 拉取 AIsouler/MyClash 的 mihomo 覆写脚本，打上本地补丁，输出到 bettbox/mihomoScript.js
 *
 * 补丁原则：
 *   - 只改「默认值」「规则顺序」和「去分组后的出口映射」，不重写核心逻辑
 *   - 上游新增的开关/功能自动保留（不整份替换）
 *   - 必需补丁锚点找不到 → 直接报错退出，不产出坏脚本
 *
 * 用法: node build-bettbox-script.mjs [--check]
 *   --check  只校验上游 + 锚点，不写文件
 */
import fs from 'fs';
import path from 'path';

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

// ── 补丁定义 ──────────────────────────────────────────────
// required: 锚点丢失时是否中断构建

const REPLACES = [
  // ── 必需：规则顺序 AdBlock → GitHub → AI → 其余 ──
  // GitHub 在 AI 前：Copilot 全系自然归 GitHub，无需逐条钉规则
  // AI 在 Google 前：antigravity/gemini 的 *.googleapis.com 不会被 Google 抢走
  {
    name: '规则顺序 GitHub→AI',
    required: true,
    from: `  const orderedServiceConfigs = [
    ...serviceConfigs.filter((svc) => svc.name === 'AdBlock'),
    ...serviceConfigs.filter((svc) => svc.name !== 'AdBlock'),
  ];`,
    to: `  const orderedServiceConfigs = [
    ...serviceConfigs.filter((svc) => svc.name === 'AdBlock'),
    // GitHub 提前：Copilot 的 copilot* 域名在 AI 规则集里也有，GitHub 先命中即归 GitHub
    ...serviceConfigs.filter((svc) => svc.name === 'GitHub'),
    // AI 提前：antigravity/gemini 的 *.googleapis.com 必须先于 Google 命中
    ...serviceConfigs.filter((svc) => svc.name === 'AI'),
    ...serviceConfigs.filter((svc) => svc.name !== 'AdBlock' && svc.name !== 'GitHub' && svc.name !== 'AI'),
  ];`,
  },

  // ── 必需：额外规则注入 ──
  {
    name: 'prefixRules 额外规则',
    required: true,
    from: `const prefixRules = [`,
    to: `// ⚠️ 本文件由 build-bettbox-script.mjs 自动生成，不要手改
// 上游: ${SRC}
// 额外规则: bettbox/rules-extra.txt
//
// ⚠️ Bettbox 会用界面设置覆盖本脚本的同名键（源码 lib/state.dart buildPatchParams）：
//    find-process-mode / tun 整块 / mixed-port / ipv6 / external-controller / log-level
//    → 这些在脚本里写了也不生效，必须在界面改
//    dns 只在界面「覆写 DNS」开启时被覆盖；rules / proxy-groups 以脚本为准
const prefixRules = [
${extraBlock}`,
  },

  // ── 必需：.cn 兜底放在 AdBlock/GitHub/AI 后、其余服务前 ──
  // geolocation-cn 等国内基础直连仍留在 prefixRules，避免误伤推送等功能域。
  {
    name: '.cn 后缀直连（广告/GitHub/AI 优先）',
    required: true,
    from: `  for (const svc of orderedServiceConfigs) {
    if (!ruleOptionsEnable[svc.name]) continue;

    functionalRules.push(...(svc.rules || []));
    functionalIpRules.push(...(svc.ipRules || []));
    Object.assign(finalRuleProviders, svc.providers || {});
  }`,
    to: `  let cnFallbackInserted = false;
  for (const svc of orderedServiceConfigs) {
    // .cn 不能放在 prefixRules：否则会抢在 AdBlock 前放行 .cn 广告域名。
    // 在首个非优先服务前插入，确保 AdBlock → GitHub → AI → .cn → 其余服务。
    if (!['AdBlock', 'GitHub', 'AI'].includes(svc.name) && !cnFallbackInserted) {
      functionalRules.push(
        // geolocation-cn 覆盖不到企业/地方 .cn 站点；域名匹配无需 DNS 解析
        'DOMAIN-SUFFIX,cn,直连',
      );
      cnFallbackInserted = true;
    }
    // 去分组服务始终保留规则，出口已直接改写为默认代理或直连。
    if (!INLINE_SERVICE_POLICIES[svc.name] && !ruleOptionsEnable[svc.name]) continue;

    functionalRules.push(...(svc.rules || []));
    functionalIpRules.push(...(svc.ipRules || []));
    Object.assign(finalRuleProviders, svc.providers || {});
  }
  // 极端情况下上游只剩优先服务，也不能丢失 .cn 兜底。
  if (!cnFallbackInserted) functionalRules.push('DOMAIN-SUFFIX,cn,直连');`,
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

    let groupProxies = [];`,
    to: `  for (const svc of serviceConfigs) {
    if (INLINE_SERVICE_POLICIES[svc.name] || !ruleOptionsEnable[svc.name]) continue;

    let groupProxies = [];`,
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
];

// ── 执行 ─────────────────────────────────────────────────

const res = await fetch(SRC, { signal: AbortSignal.timeout(60000) });
if (!res.ok) throw new Error(`${SRC} → HTTP ${res.status}`);
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

// 与已存在文件比对，无变化则不写（避免无意义提交）
const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
if (prev === code) {
  console.log('无变化');
  process.exit(0);
}

fs.writeFileSync(OUT, code);
console.log(`已写入 ${OUT}`);
