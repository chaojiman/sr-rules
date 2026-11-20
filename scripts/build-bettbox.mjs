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
import vm from 'vm';
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
// 凭据不进公开仓库：可用环境变量 BETTBOX_PROXIES_FILE 指向仓库外的本地文件
//（.mjs 导出 default 数组，或 .json 直接是数组），例如 OneDrive 里的私有节点表。
const CUSTOM_FILE = process.env.BETTBOX_PROXIES_FILE
  ? path.resolve(process.env.BETTBOX_PROXIES_FILE)
  : path.resolve('bettbox/custom-proxies.mjs');

/**
 * 从 Bettbox 的脚本缓存中提取落地节点（零手填）。
 * Bettbox 每次拉取覆写脚本后会存到 %APPDATA%\com.appshub\Bettbox\scripts\<id>.js，
 * 其中 const customizeProxies = [ ... ] 就是它实际使用的自建/落地节点。
 */
function readProxiesFromBettboxCache() {
  const dir = path.join(process.env.APPDATA || '', 'com.appshub', 'Bettbox', 'scripts');
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { f } of files) {
    const code = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = code.match(/^const customizeProxies = \[/m);
    if (!m) continue;
    const start = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let k = start; k < code.length; k += 1) {
      if (code[k] === '[') depth += 1;
      else if (code[k] === ']') {
        depth -= 1;
        if (depth === 0) {
          end = k + 1;
          break;
        }
      }
    }
    if (end < 0) continue;
    try {
      // 只求值数组字面量，不执行整段脚本
      const arr = vm.runInNewContext(`(${code.slice(start, end)})`, {});
      if (Array.isArray(arr) && arr.length) {
        console.log(`自建节点：从 Bettbox 缓存 ${f} 提取 ${arr.length} 个`);
        return arr;
      }
    } catch {
      /* 继续找下一个 */
    }
  }
  return [];
}

let customProxies = [];
const useBettboxCache = process.env.BETTBOX_PROXIES_FILE === 'auto';
if (useBettboxCache) {
  customProxies = readProxiesFromBettboxCache();
  if (!customProxies.length) console.log('自建节点：Bettbox 缓存中未找到节点，按 0 个处理');
} else if (fs.existsSync(CUSTOM_FILE)) {
  if (CUSTOM_FILE.toLowerCase().endsWith('.json')) {
    // 允许 JSON 与 JS 对象字面量（单引号/无引号键）两种写法
    customProxies = vm.runInNewContext(`(${fs.readFileSync(CUSTOM_FILE, 'utf8')})`, {});
  } else {
    const mod = await import(pathToFileURL(CUSTOM_FILE).href);
    customProxies = mod.default;
  }
  if (!Array.isArray(customProxies)) customProxies = [];
  console.log(`自建节点：${customProxies.length} 个（来源 ${CUSTOM_FILE}）`);
} else {
  console.log(`自建节点：未找到 ${CUSTOM_FILE}，按 0 个处理`);
}
const customProxiesBlock = customProxies.length
  ? `// 来自 bettbox/custom-proxies.mjs，由 build-bettbox.mjs 注入\nconst customizeProxies = ${JSON.stringify(customProxies, null, 2)};`
  : `// ← 把你的落地节点贴进下面这个方括号（形如 [{ name:'…', type:'vless', … }]）；\n//   链式代理开关会跟随节点数量自动开/关，无需再改别的行。\nconst customizeProxies = [];`;

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
    to: `// DNS 配置说明：
// - defaultDNS：纯 IP 引导，只解析 DoH 服务器自身域名
// - chinaDNS：system 与 DoH 并发竞速，system 通常最快返回
// - proxyServerDNS：节点域名解析保持全加密，防止运营商污染
const defaultDNS = ['223.5.5.5', '119.29.29.29'];
const chinaDNS = ['system', 'https://223.5.5.5/dns-query#DIRECT'];
const foreignDNS = ['https://cloudflare-dns.com/dns-query#默认代理', 'https://dns.google/dns-query#默认代理'];
const proxyServerDNS = ['https://223.5.5.5/dns-query#DIRECT', 'https://120.53.53.53/dns-query#DIRECT'];`,
  },

  // ── 必需：DNS 关闭 IPv6（应用流量锁 v4，避免视频等连接被慢 v6 抢先建立）──
  {
    name: 'DNS 关闭 IPv6',
    required: true,
    from: `    enable: true,\n    ipv6: true,`,
    to: `    enable: true,\n    ipv6: false,`,
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

  // ── 必需：健康检查 / 自动测速 URL 不用 Apple ──
  // Apple 测试页在大陆有 CDN：同一美国节点实测 apple 33ms vs gstatic 190ms（2026-11-18，5/5 成功），
  // 会把所有节点压成 30ms 级，url-test / 健康检查失去区分度。改用无国内边缘的 gstatic。
  // 注：Bettbox 节点列表显示的延迟来自 UI 设置里的 testUrl，不受本脚本控制。
  {
    name: '健康检查 URL 改 gstatic',
    required: true,
    from: `  url: 'https://www.apple.com/library/test/success.html',`,
    to: `  // Apple 测试页命中大陆 CDN，会把所有节点压成 30ms 级，失去区分度
  url: 'https://www.gstatic.com/generate_204',`,
  },

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
  { name: '过滤低倍率节点=开', required: false, from: /^(\s*)过滤低倍率节点:\s*false,/m, to: '$1过滤低倍率节点: true,' },
  { name: 'PayPal=开', required: false, from: /^(\s*)PayPal:\s*false,/m, to: '$1PayPal: true,' },
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
  // 链式代理默认开启，空数组时不生成链式分组（不抛错）
  { name: '链式代理=开', required: false, from: /^(\s*)链式代理:\s*false,/m, to: '$1链式代理: true,' },

  // ── 自建落地节点不参与地区分组（否则会混进「美国」「香港」等地区组，被误选成出口）──
  {
    name: '落地节点不进地区组',
    required: false,
    from: `  for (const proxy of [...filteredProxies, ...customProxies]) {`,
    to: `  // 自建/落地节点只出现在「链式落地」组：它们自带 dialer-proxy，
  // 若被塞进地区组，选「美国」时可能选中「落地-美国」，导致请求全部走链式而失效。
  for (const proxy of [...filteredProxies]) {`,
  },

  // ── 链式开关跟随本地节点数量（贴了节点自动开，空则自动关，不用手改 62 行）──
  {
    name: '链式开关跟随节点',
    required: false,
    from: `const dialerProxyName = '链式中转';`,
    to: `const dialerProxyName = '链式中转';
// 链式开关由脚本决定：有「非直连」节点自动开，全直连或空则自动关（覆盖界面设置）
ruleOptionsEnable.链式代理 = customizeProxies.some((p) => p.direct !== true);`,
  },

  // ── 直连节点：direct: true 跳过 dialer-proxy 注入，并从产物里剥掉该标记 ──
  {
    name: '直连节点免链式',
    required: false,
    from: `    let customProxy = name === normalized.name ? normalized : { ...normalized, name };
    if (chainEnabled && customProxy['dialer-proxy'] !== dialerProxyName) {
      customProxy = { ...customProxy, 'dialer-proxy': dialerProxyName };
    }`,
    to: `    let customProxy = name === normalized.name ? normalized : { ...normalized, name };
    // direct: true = 直连节点，不注入链式中转；该标记只用于构建，必须从产物剥掉
    const isDirectNode = customProxy.direct === true;
    if ('direct' in customProxy) {
      const { direct, ...rest } = customProxy;
      customProxy = rest;
    }
    // relay: true（仅对 direct 节点生效）= 中转出口，如 HK realm 透传：不进地区组（地区自动组是链式中转候选，
    // 会形成嵌套中转）、不进链式中转、不进链式落地；直接列进默认代理/分流组/漏网之鱼，各组可单独选。同样从产物剥掉
    const isRelayNode = isDirectNode && customProxy.relay === true;
    if ('relay' in customProxy) {
      const { relay, ...rest } = customProxy;
      customProxy = rest;
    }
    // 未手写 ip-version 时补默认：写死的 IPv6 地址 → ipv6；其余（IPv4 地址/域名）→ ipv4-prefer。
    // ipv4-prefer 下域名只有 AAAA 时仍会直接走 v6，双栈域名才优先 v4（v6 仅作 300ms 兜底）
    if (!customProxy['ip-version']) {
      const isV6Literal = String(customProxy.server ?? '').includes(':');
      customProxy = { ...customProxy, 'ip-version': isV6Literal ? 'ipv6' : 'ipv4-prefer' };
    }
    if (chainEnabled && !isDirectNode && customProxy['dialer-proxy'] !== dialerProxyName) {
      customProxy = { ...customProxy, 'dialer-proxy': dialerProxyName };
    }`,
  },
  // 链式开启时「链式落地」只收带 dialer-proxy 的真落地（direct 前置/直连出口/中转出口不进）
  {
    name: '链式落地只收真落地',
    required: true,
    from: `    ...selectBaseOption,
    name: chainEnabled ? '链式落地' : '自建节点',
    proxies: customProxyNames,`,
    to: `    ...selectBaseOption,
    // 名字只跟链式开关走：开着就叫「链式落地」，关着叫「自建节点」
    name: chainEnabled ? '链式落地' : '自建节点',
    proxies: chainEnabled ? chainLandingNames : customProxyNames,`,
  },

  // ── 必需：链式中转接入地区自动组（前置可自动切换）──
  // 上游只平铺固定节点：某个入口抖动/限速时整条链失速，只能手动换入口。
  // 把 url-test 地区自动组排最前（顺序同地区定义，香港在前 → 默认前置=香港-自动选择），
  // 后面保留平铺节点，需要钉死某个具体入口时仍可选。
  {
    name: '链式中转接入地区自动组',
    required: true,
    from: `          name: dialerProxyName,
          proxies: filteredProxyNames,`,
    to: `          name: dialerProxyName,
          // 地区自动组在前：前置抖动时自动换入口；平铺节点在后：可手动钉死
          proxies: [
            ...generatedRegionGroups.filter((g) => g.type === 'url-test').map((g) => g.name),
            ...filteredProxyNames,
          ],`,
  },

  // ── 链式默认开启时，空数组不抛错（只返回空分组）──
  {
    name: '空节点不抛错',
    required: false,
    from: `  if (!customizeList.length) {
    if (chainEnabled) {
      throw new Error('启用失败，请在脚本中添加自定义节点后尝试');
    }
    return { customProxies: [], customProxyNames: [], customGroup: null };
  }`,
    to: `  if (!customizeList.length) {
    return { customProxies: [], customProxyNames: [], customGroup: null };
  }`,
  },



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

  // ── 漏网之鱼补齐候选：与其他服务组一致 ──
  // 上游 漏网之鱼 只有 默认代理/直连/地区组，缺 链式落地(-地区) 与 手动选择，
  // 导致 MATCH 兜底流量选不到自建链式落地节点。
  {
    name: '漏网之鱼补链式落地+基础组',
    required: false,
    from: `    proxies: ['默认代理', '直连', ...groupNamesOfSelect],
    icon: \`\${iconBaseUrl}Stack.svg\`,`,
    to: `    proxies: ['默认代理', '直连', ...customGroupNames, ...relayProxyNames, ...baseGroupNames, ...groupNamesOfSelect],
    icon: \`\${iconBaseUrl}Stack.svg\`,`,
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

  // ── 链式落地按地区自动分组（L2）──
  // 落地节点名带地区时，额外生成「链式落地-<地区>」select 组，
  // 让默认代理 / 各分流组能直接选某地区的落地，而不必在明细节点里翻找。
  // 不改变上游行为：地区组仍不含落地节点，「链式落地」组照旧存在。
  {
    name: '链式落地按地区生成子组',
    required: true,
    from: `  return {
    customProxies,
    customProxyNames,
    customGroup,
  };
}`,
    to: `  // 按落地节点名字里的地区自动生成子组（链式落地-日本 / 链式落地-美国 …）
  const regionBuckets = {};
  if (chainEnabled) {
    for (const proxy of customProxies) {
      // 只按真落地分组：direct 节点不进「链式落地-地区」
      if (!chainLandingNames.includes(proxy.name)) continue;
      for (const region of getMatchedRegions(proxy.name)) {
        (regionBuckets[region.name] ||= []).push(proxy.name);
      }
    }
  }
  const customRegionGroups = Object.entries(regionBuckets).map(([region, proxies]) => ({
    ...selectBaseOption,
    name: \`链式落地-\${region}\`,
    proxies,
    icon: \`\${iconBaseUrl}Server.svg\`,
  }));

  return {
    customProxies,
    customProxyNames,
    customGroup,
    customRegionGroups,
  };
}`,
  },
  {
    name: '分流组接收地区落地子组',
    required: true,
    from: `  const { customProxyNames = [], customGroup = null } = customizeInfo || {};`,
    to: `  const { customProxyNames = [], customGroup = null, customRegionGroups = [] } = customizeInfo || {};`,
  },
  {
    name: 'customGroupNames 含地区落地子组',
    required: true,
    from: `  const customGroupNames = customGroup ? [customGroup.name] : [];`,
    to: `  const customGroupNames = [
    ...(customGroup ? [customGroup.name] : []),
    ...customRegionGroups.map((g) => g.name),
  ];`,
  },
  {
    name: '主流程接收地区落地子组',
    required: true,
    from: `  const { customProxies, customProxyNames, customGroup } = buildCustomizeGroups(filteredProxies);`,
    to: `  const { customProxies, customProxyNames, customGroup, customRegionGroups = [] } = buildCustomizeGroups(filteredProxies);`,
  },
  {
    name: '分流组构建接收地区落地子组',
    required: true,
    from: `} = buildFunctionalGroups(filteredProxies, generatedRegionGroups, { customProxyNames, customGroup });`,
    to: `} = buildFunctionalGroups(filteredProxies, generatedRegionGroups, { customProxyNames, customGroup, customRegionGroups });`,
  },
  {
    name: '输出地区落地子组',
    required: true,
    from: `    ...(customGroup ? [customGroup] : []),
    ...(chainGroup ? [chainGroup] : []),`,
    to: `    ...(customGroup ? [customGroup] : []),
    ...customRegionGroups,
    ...(chainGroup ? [chainGroup] : []),`,
  },

  // ── direct 自建节点接入地区组与链式中转 ──
  // 落地节点自带 dialer-proxy，进地区组会「落地 → 链式中转 → 落地」自环，必须继续排除；
  // direct 节点没有 dialer-proxy，选中只是直连出口，可同时作为链式中转的前置入口。
  {
    name: 'direct 节点名单',
    required: true,
    from: `  const usedNames = new Set(filteredProxies.map((p) => p.name));
  const customPrefix = '自建-';
  const customProxies = [];`,
    to: `  const usedNames = new Set(filteredProxies.map((p) => p.name));
  const customPrefix = '自建-';
  const customProxies = [];
  // 无 dialer-proxy 的自建节点：链式开启时只有 direct 节点（不含 relay），链式关闭时全部
  const directProxyNames = [];
  // 链式开启时带 dialer-proxy 的落地节点
  const chainLandingNames = [];
  // relay 中转出口：直接列进默认代理/分流组/漏网之鱼
  const relayProxyNames = [];`,
  },
  {
    name: '记录 direct 节点',
    required: true,
    from: `    if (chainEnabled && !isDirectNode && customProxy['dialer-proxy'] !== dialerProxyName) {
      customProxy = { ...customProxy, 'dialer-proxy': dialerProxyName };
    }
    customProxies.push(customProxy);`,
    to: `    if (chainEnabled && !isDirectNode && customProxy['dialer-proxy'] !== dialerProxyName) {
      customProxy = { ...customProxy, 'dialer-proxy': dialerProxyName };
    }
    if (chainEnabled && !isDirectNode) chainLandingNames.push(customProxy.name);
    else if (isRelayNode) relayProxyNames.push(customProxy.name);
    else directProxyNames.push(customProxy.name);
    customProxies.push(customProxy);`,
  },
  {
    name: '返回 direct 节点名单',
    required: true,
    from: `  return {
    customProxies,
    customProxyNames,
    customGroup,
    customRegionGroups,
  };
}`,
    to: `  return {
    customProxies,
    customProxyNames,
    customGroup,
    customRegionGroups,
    directProxyNames,
    relayProxyNames,
  };
}`,
  },
  {
    name: '地区组接收 direct 节点',
    required: true,
    from: `function buildRegionGroups(filteredProxies, customProxies) {`,
    to: `function buildRegionGroups(filteredProxies, customProxies, directProxyNames = []) {`,
  },
  {
    name: '地区分组并入 direct 节点',
    required: true,
    from: `  // 自建/落地节点只出现在「链式落地」组：它们自带 dialer-proxy，
  // 若被塞进地区组，选「美国」时可能选中「落地-美国」，导致请求全部走链式而失效。
  for (const proxy of [...filteredProxies]) {`,
    to: `  // 落地节点自带 dialer-proxy，进地区组会形成「落地 → 链式中转 → 落地」自环，永远排除；
  // direct 节点无 dialer-proxy，可安全进入地区组，选中它即直连出口。
  const regionSourceProxies = [
    ...filteredProxies,
    ...customProxies.filter((proxy) => directProxyNames.includes(proxy.name)),
  ];
  for (const proxy of regionSourceProxies) {`,
  },
  {
    name: '主流程传入 direct 节点名单',
    required: true,
    from: `  const { customProxies, customProxyNames, customGroup, customRegionGroups = [] } = buildCustomizeGroups(filteredProxies);`,
    to: `  const { customProxies, customProxyNames, customGroup, customRegionGroups = [], directProxyNames = [], relayProxyNames = [] } = buildCustomizeGroups(filteredProxies);`,
  },
  {
    name: '地区组构建接收 direct 节点名单',
    required: true,
    from: `    : buildRegionGroups(filteredProxies, customProxies);`,
    to: `    : buildRegionGroups(filteredProxies, customProxies, directProxyNames);`,
  },
  {
    name: '分流组接收 direct 节点名单',
    required: true,
    from: `  const { customProxyNames = [], customGroup = null, customRegionGroups = [] } = customizeInfo || {};`,
    to: `  const { customProxyNames = [], customGroup = null, customRegionGroups = [], directProxyNames = [], relayProxyNames = [] } = customizeInfo || {};`,
  },
  {
    name: '链式中转接入 direct 节点',
    required: true,
    from: `          proxies: [
            ...generatedRegionGroups.filter((g) => g.type === 'url-test').map((g) => g.name),
            ...filteredProxyNames,
          ],`,
    to: `          proxies: [
            ...generatedRegionGroups.filter((g) => g.type === 'url-test').map((g) => g.name),
            ...filteredProxyNames,
            ...directProxyNames,
          ],`,
  },
  {
    name: '分流组构建传入 direct 节点名单',
    required: true,
    from: `} = buildFunctionalGroups(filteredProxies, generatedRegionGroups, { customProxyNames, customGroup, customRegionGroups });`,
    to: `} = buildFunctionalGroups(filteredProxies, generatedRegionGroups, { customProxyNames, customGroup, customRegionGroups, directProxyNames, relayProxyNames });`,
  },
  {
    name: '分流组接入 relay 中转出口',
    required: true,
    from: `            '默认代理',
            ...customGroupNames,
            ...baseGroupNames,`,
    to: `            '默认代理',
            ...customGroupNames,
            ...relayProxyNames,
            ...baseGroupNames,`,
  },

  // ── 香港地区手动组默认选「香港-自动选择」──
  {
    name: '香港组默认自动选择',
    required: true,
    from: `        proxies: [...proxies, urlTestName],
        hidden: hideManualSelectGroupEnabled,`,
    to: `        proxies: [...proxies, urlTestName],
        ...(name === '香港' ? { 'default-selected': urlTestName } : {}),
        hidden: hideManualSelectGroupEnabled,`,
  },

  // ── 默认出口：按当前实际选择固化 ──
  // 链式关闭时「链式落地-美国」不存在，selected 会被 includes 检查剔除，自动回退首项。
  {
    name: 'AI 默认出口 = 链式落地-美国',
    required: true,
    from: `  {
    name: 'AI',
    baseOption: selectBaseOption,
    defaultSelected: '美国',`,
    to: `  {
    name: 'AI',
    baseOption: selectBaseOption,
    defaultSelected: '链式落地-美国',`,
  },
  {
    name: '默认代理默认选手动选择',
    required: true,
    from: `  functionalGroups.push({
    ...selectBaseOption,
    name: '默认代理',
    proxies: [...groupNamesOfSelect, ...baseGroupNames, ...customGroupNames],
    icon: \`\${iconBaseUrl}Proxy.svg\`,
  });`,
    to: `  functionalGroups.push({
    ...selectBaseOption,
    name: '默认代理',
    proxies: [...groupNamesOfSelect, ...baseGroupNames, ...customGroupNames, ...relayProxyNames],
    icon: \`\${iconBaseUrl}Proxy.svg\`,
    // 手动选择组存在时才写；关掉该组时回退首项
    ...(baseGroupNames.includes('手动选择') ? { 'default-selected': '手动选择' } : {}),
  });`,
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
