/**
 * 静态校验小火箭配置，并实际执行 Bettbox main() 校验生成结果。
 * 只使用 Node.js 内置模块，不访问网络。
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { pathToFileURL } from 'url';

const ROOT = process.cwd();
const errors = [];
const check = (condition, message) => {
  if (!condition && errors.length < 100) errors.push(message);
};
function resolveInside(...parts) {
  const resolved = path.resolve(ROOT, ...parts);
  if (resolved === ROOT || !resolved.startsWith(ROOT + path.sep)) {
    throw new Error(`路径越出仓库：${parts.join('/')}`);
  }
  return resolved;
}
const read = (file) => fs.readFileSync(resolveInside(file), 'utf8');

function sectionLines(text, wanted) {
  const out = [];
  let active = false;
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^\[(.+)\]$/);
    if (match) {
      active = match[1] === wanted;
      continue;
    }
    if (active) out.push(line);
  }
  return out;
}

// ── 小火箭：配置、策略和本地规则文件 ─────────────────────
const srConfig = read('shadowrocket/config.conf');
const srGroups = new Set();
for (const line of sectionLines(srConfig, 'Proxy Group')) {
  const match = line.match(/^([^=]+?)\s*=\s*(?:select|url-test|load-balance),/);
  if (match) srGroups.add(match[1].trim());
}

const srBuiltins = new Set([
  'DIRECT',
  'PROXY',
  'REJECT',
  'REJECT-DICT',
  'REJECT-ARRAY',
  'REJECT-200',
  'REJECT-IMG',
  'REJECT-TINYGIF',
  'REJECT-DROP',
  'REJECT-NO-DROP',
  'TAILSCALE',
]);
const srRuleLines = sectionLines(srConfig, 'Rule')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));
const srPrefix = 'https://raw.githubusercontent.com/chaojiman/sr-rules/main/shadowrocket/rules/';
const domainSetFiles = new Set();
// 只校验 config.conf 实际引用的文件；未被引用的孤儿文件（例如做 A/B 时注释掉的规则集）不参与
const localRuleFiles = new Set();

check(
  /^YouTube = select,.*policy-select-name=PROXY$/m.test(srConfig),
  '小火箭 YouTube 默认出口必须是 PROXY（默认代理）',
);
check(srRuleLines.at(-1)?.startsWith('FINAL,'), '小火箭 FINAL 必须是最后一条规则');

// block-quic 默认值就是 all-proxy：注释掉等于没改，必须显式写出取值
const blockQuic = srConfig
  .split('\n')
  .map((line) => line.trim())
  .find((line) => /^block-quic\s*=/i.test(line));
check(blockQuic, 'config.conf 未显式设置 block-quic（默认值 all-proxy，注释掉等于仍在拦 QUIC）');
if (blockQuic) {
  check(
    /^block-quic\s*=\s*(all-proxy|all|always-allow)$/i.test(blockQuic),
    `block-quic 取值不合法：${blockQuic}`,
  );
}

for (const line of srRuleLines) {
  const parts = line.split(',').map((part) => part.trim());
  const type = parts[0];
  let policy;
  if (type === 'RULE-SET' || type === 'DOMAIN-SET') {
    const url = parts[1];
    policy = parts[2];
    if (url?.startsWith(srPrefix)) {
      const file = url.slice(srPrefix.length);
      check(file === path.basename(file), `小火箭规则文件名异常：${file}`);
      check(fs.existsSync(resolveInside('shadowrocket/rules', file)), `小火箭缺少本地规则：${file}`);
      // 同一规则集被引用两次会让构建把它裁剪两遍（第二遍会把已裁剪的内容再裁一次）
      check(!localRuleFiles.has(file), `规则集重复引用：${file}（构建会裁剪两遍）`);
      localRuleFiles.add(file);
      if (type === 'DOMAIN-SET') domainSetFiles.add(file);
    }
  } else if (type === 'FINAL') {
    policy = parts[1];
  } else {
    policy = parts[2];
  }
  check(srBuiltins.has(policy) || srGroups.has(policy), `小火箭规则引用不存在的策略「${policy}」：${line}`);
}

const srAllowedTypes = new Set([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'USER-AGENT',
  'URL-REGEX',
  'IP-CIDR',
  'IP-CIDR6',
  'IP-ASN',
  'AND',
  'OR',
  'NOT',
  'DST-PORT',
  'GEOIP',
  'SCRIPT',
  'PROTOCOL',
]);
const bareDomain = /^\.?[\p{L}\p{N}*_-]+(?:\.[\p{L}\p{N}*_-]+)*$/u;
let srRuleCount = 0;

for (const file of [...localRuleFiles].sort()) {
  const lines = read(`shadowrocket/rules/${file}`).split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    srRuleCount++;
    if (domainSetFiles.has(file)) {
      check(!line.includes(',') && bareDomain.test(line), `${file}:${index + 1} 不是合法 DOMAIN-SET 域名：${line}`);
      continue;
    }
    const type = line.split(',', 1)[0].trim().toUpperCase();
    check(srAllowedTypes.has(type), `${file}:${index + 1} 出现未登记的规则类型「${type}」`);
  }
}

// 逐条扇描型规则是线性开销，需要控量
let keywordCount = 0;
let ipPrefixKeyword = 0;
let mitmOnlyRules = 0;
for (const file of [...localRuleFiles].sort()) {
  for (const raw of read(`shadowrocket/rules/${file}`).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^DOMAIN-KEYWORD,/i.test(line)) {
      keywordCount++;
      if (/^DOMAIN-KEYWORD,\d{1,3}\.\d{1,3}\.\d{1,3}\.$/i.test(line)) ipPrefixKeyword++;
    }
    if (file === 'ads-pattern.list' && /USER-AGENT|URL-REGEX/i.test(line)) mitmOnlyRules++;
  }
}
check(ipPrefixKeyword === 0, `仍有 ${ipPrefixKeyword} 条 IP 前缀型 DOMAIN-KEYWORD（应转成 IP-CIDR）`);
check(keywordCount <= 40, `DOMAIN-KEYWORD 过多（${keywordCount} 条），每请求都要逐条子串扫描`);
check(mitmOnlyRules === 0, `ads-pattern.list 仍有 ${mitmOnlyRules} 条依赖 MITM 的 USER-AGENT/URL-REGEX 规则`);

// DOMAIN-SET 里不得有被更宽后缀罩住的条目（纯内存浪费）
function countShadowedDomainSet(lines) {
  const sfx = new Set(lines.filter((l) => l.startsWith('.')).map((l) => l.slice(1).toLowerCase()));
  let shadowed = 0;
  for (const line of lines) {
    const isSuffix = line.startsWith('.');
    const d = (isSuffix ? line.slice(1) : line).toLowerCase();
    if (!isSuffix && sfx.has(d)) {
      shadowed++;
      continue;
    }
    const parts = d.split('.');
    for (let i = 1; i < parts.length; i++) {
      if (sfx.has(parts.slice(i).join('.'))) {
        shadowed++;
        break;
      }
    }
  }
  return shadowed;
}

for (const file of domainSetFiles) {
  const lines = read(`shadowrocket/rules/${file}`)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const shadowed = countShadowedDomainSet(lines);
  check(shadowed === 0, `${file} 仍有 ${shadowed} 条被更宽后缀遮蔽的域名`);
}

// 去广告 DNS 模块的产物卫生
const dnsModulePath = 'adblock/blockAds-dns.srmodule';
if (fs.existsSync(resolveInside(dnsModulePath))) {
  const modRules = read(dnsModulePath)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !/^\[.+\]$/.test(l));
  const seenRule = new Set();
  let dupRules = 0;
  let deadRules = 0;
  for (const line of modRules) {
    if (seenRule.has(line)) dupRules++;
    seenRule.add(line);
    if (/\b(USER-AGENT|URL-REGEX)\b/i.test(line)) deadRules++;
  }
  const modDomains = modRules
    .map((l) => l.match(/^(?:DOMAIN|DOMAIN-SUFFIX),([^,\s]+)/i)?.[1])
    .filter(Boolean);
  const modSfx = new Set(
    modRules.map((l) => l.match(/^DOMAIN-SUFFIX,([^,\s]+)/i)?.[1].toLowerCase()).filter(Boolean),
  );
  let modShadowed = 0;
  for (const d of modDomains) {
    const parts = d.toLowerCase().split('.');
    for (let i = 1; i < parts.length; i++) {
      if (modSfx.has(parts.slice(i).join('.'))) {
        modShadowed++;
        break;
      }
    }
  }
  check(deadRules === 0, `DNS 模块仍有 ${deadRules} 条依赖 MITM 的 USER-AGENT/URL-REGEX 规则`);
  check(dupRules === 0, `DNS 模块仍有 ${dupRules} 条完全重复的规则`);
  check(modShadowed === 0, `DNS 模块仍有 ${modShadowed} 条被更宽后缀遮蔽的规则`);
}

// ── Bettbox：执行 main()，校验真实生成结果 ─────────────────
const bettboxCode = read('bettbox/mihomoScript.js');
const proxy = (name) => ({
  name,
  type: 'ss',
  server: '192.0.2.1',
  port: 443,
  cipher: 'aes-128-gcm',
  password: 'validation-only',
});
const input = {
  proxies: [proxy('🇭🇰 香港 01'), proxy('🇺🇸 美国 01'), proxy('🇯🇵 日本 01')],
  dns: {
    nameserver: ['223.5.5.5'],
    'proxy-server-nameserver': ['223.5.5.5'],
  },
};

let result;
let options;
try {
  new vm.Script(bettboxCode, { filename: 'bettbox/mihomoScript.js' });
  const context = vm.createContext({ __input: input, console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(
    `${bettboxCode}\nthis.__result = main(this.__input);\nthis.__options = ruleOptionsEnable;`,
    context,
    { timeout: 10000 },
  );
  result = context.__result;
  options = context.__options;
} catch (error) {
  check(false, `Bettbox main() 执行失败：${error.message}`);
}

if (result && options) {
  const rules = result.rules || [];
  const providers = result['rule-providers'] || {};
  const groups = result['proxy-groups'] || [];
  const groupsByName = new Map(groups.map((group) => [group.name, group]));
  const indexOfRule = (rule) => rules.indexOf(rule);

  // 构建指纹：出问题时必须能一眼确认「哪天的产物、上游哪个版本」
  check(/^\/\/ ═+ sr-rules 构建标记/.test(bettboxCode), 'Bettbox 产物缺少 sr-rules 构建标记横幅');
  check(/^\/\/ 生成日期: \d{4}-\d{2}-\d{2}$/m.test(bettboxCode), 'Bettbox 构建横幅缺少生成日期');
  check(/^\/\/ 上游版本: \S/m.test(bettboxCode), 'Bettbox 构建横幅缺少上游版本（ETag）');

  const disabledServiceProviders = {
    Line: ['line'],
    PikPak: ['pikpak'],
    Spotify: ['spotify', 'spotify_ip'],
    Crypto: ['cryptocurrency'],
    Patreon: ['patreon'],
    EHentai: ['ehentai'],
  };
  const inlineServices = {
    Emby: ['emby', '直连'],
    PayPal: ['paypal', '直连'],
  };
  for (const name of [...Object.keys(disabledServiceProviders), ...Object.keys(inlineServices)]) {
    check(options[name] === false, `Bettbox ${name} 的独立开关必须关闭`);
    check(!groupsByName.has(name), `Bettbox 不应再生成 ${name} 策略组`);
  }
  for (const [name, serviceProviders] of Object.entries(disabledServiceProviders)) {
    for (const provider of serviceProviders) {
      check(!providers[provider], `Bettbox ${name} 已由默认代理兜底，不应保留 ${provider} 规则源`);
    }
  }
  for (const [name, [provider, policy]] of Object.entries(inlineServices)) {
    check(rules.includes(`RULE-SET,${provider},${policy}`), `Bettbox ${name} 规则必须直接归入 ${policy}`);
  }
  // Netflix 保留独立分组，可单独指定地区（流媒体常需按区切换）
  check(options.Netflix === true, 'Bettbox Netflix 开关必须开启');
  const netflixGroup = groupsByName.get('Netflix');
  check(netflixGroup, 'Bettbox 应生成 Netflix 策略组');
  check(netflixGroup?.['default-selected'] === '默认代理', 'Bettbox Netflix 默认出口必须是默认代理');
  check(rules.includes('RULE-SET,netflix,Netflix'), 'Bettbox Netflix 规则必须归入 Netflix 组');
  check(rules.includes('RULE-SET,netflix_ip,Netflix'), 'Bettbox Netflix IP 规则必须归入 Netflix 组');
  // Emby：按策略校验，不写死上游的附加规则源名（emos 已被上游删除）
  check(rules.includes('RULE-SET,emby,直连'), 'Bettbox Emby 主规则源必须归入直连');
  check(!rules.some((rule) => rule.endsWith(',Emby')), 'Bettbox 不应有规则指向已移除的 Emby 分组');
  check(options.生成高低倍率组 === false, 'Bettbox 高低倍率组必须关闭（防止上游字段漂移）');
  check(options.生成地区自动选择组 === true, 'Bettbox 地区自动选择组必须开启');
  check(options.生成家宽节点组 === false, 'Bettbox 家宽节点组必须关闭');
  check(options.屏蔽代理QUIC流量 === true, 'Bettbox 屏蔽代理 QUIC 必须开启');
  check(options.过滤非地区节点 === true, 'Bettbox 过滤非地区节点必须开启');
  check(options.代理IPV4优先 === true, 'Bettbox 代理 IPv4 优先必须开启');

  const autoGroups = groups.filter((group) => group.type === 'url-test' && group.name.endsWith('-自动选择'));
  check(autoGroups.length > 0, 'Bettbox 开启地区自动选择后应生成 -自动选择 测速组');
  for (const auto of autoGroups) {
    const manual = groupsByName.get(auto.name.replace(/-自动选择$/, ''));
    check(manual?.proxies?.includes(auto.name), `Bettbox 地区组 ${manual?.name || '?'} 应包含 ${auto.name}`);
  }

  const expectedDefaults = {
    YouTube: '默认代理',
    TikTok: '默认代理',
    AI: '美国',
  };
  for (const [name, selected] of Object.entries(expectedDefaults)) {
    const group = groupsByName.get(name);
    check(group?.['default-selected'] === selected, `Bettbox ${name} 默认出口必须是 ${selected}`);
    check(group?.proxies?.includes(selected), `Bettbox ${name} 策略组缺少选项 ${selected}`);
  }

  const ads = indexOfRule('RULE-SET,category-ads,AdBlock');
  const github = indexOfRule('RULE-SET,github,GitHub');
  const ai = indexOfRule('RULE-SET,ai,AI');
  const cn = indexOfRule('DOMAIN-SUFFIX,cn,直连');
  const youtube = indexOfRule('RULE-SET,youtube,YouTube');
  const google = indexOfRule('RULE-SET,google,Google');
  for (const [name, index] of Object.entries({ ads, github, ai, cn, youtube, google })) {
    check(index >= 0, `Bettbox 缺少规则：${name}`);
  }
  if ([ads, github, ai, cn, youtube, google].every((index) => index >= 0)) {
    check(ads < github && github < ai, 'Bettbox 顺序必须是 AdBlock → GitHub → AI');
    check(ai < cn, 'Bettbox .cn 必须位于 AdBlock/GitHub/AI 之后');
    check(cn < youtube, 'Bettbox .cn 必须位于后续服务规则之前');
    check(ai < google, 'Bettbox AI 必须位于 Google 之前');
  }
  check(rules.at(-1) === 'MATCH,漏网之鱼', 'Bettbox MATCH,漏网之鱼 必须是最后一条规则');

  // 自建节点必须来自 bettbox/custom-proxies.mjs（否则每日同步会丢）
  const customMod = await import(pathToFileURL(resolveInside('bettbox/custom-proxies.mjs')).href);
  const expectedCustom = Array.isArray(customMod.default) ? customMod.default : [];
  const generatedNames = new Set((result.proxies || []).map((item) => item.name));
  for (const node of expectedCustom) {
    check(node?.name && generatedNames.has(node.name), `Bettbox 自建节点未被注入：${node?.name || '(缺 name)'}`);
  }
  if (options.链式代理) {
    for (const node of expectedCustom) {
      const built = (result.proxies || []).find((item) => item.name === node.name);
      check(built?.['dialer-proxy'] === '链式中转', `链式代理已开，但 ${node.name} 缺少 dialer-proxy`);
    }
  }

  for (const rule of rules) {
    if (rule.startsWith('RULE-SET,')) {
      const provider = rule.split(',')[1];
      check(providers[provider], `Bettbox 规则引用不存在的 provider「${provider}」：${rule}`);
    }
    const parts = rule.split(',');
    const type = parts[0];
    let policy;
    if (type === 'MATCH') policy = parts[1];
    else if (['AND', 'OR', 'NOT'].includes(type)) policy = parts.at(-1);
    else policy = parts[2];
    check(
      groupsByName.has(policy) || ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS'].includes(policy),
      `Bettbox 规则引用不存在的策略「${policy}」：${rule}`,
    );
  }

  const dnsRuleSets = new Set();
  for (const item of result.dns?.['fake-ip-filter'] || []) {
    if (item.startsWith('rule-set:')) dnsRuleSets.add(item.slice(9));
  }
  for (const key of Object.keys(result.dns?.['nameserver-policy'] || {})) {
    if (key.startsWith('rule-set:')) dnsRuleSets.add(key.slice(9));
  }
  for (const provider of dnsRuleSets) {
    check(providers[provider], `Bettbox DNS 引用不存在的 provider「${provider}」`);
  }

  for (const group of groups) {
    const selected = group['default-selected'];
    if (selected) check(group.proxies?.includes(selected), `Bettbox ${group.name} 默认选项不在 proxies 中：${selected}`);
  }

  console.log(`Bettbox main()：${rules.length} 条顶层规则 / ${Object.keys(providers).length} 个规则源 / ${groups.length} 个策略组`);
}

if (errors.length) {
  console.error(`\n❌ 配置校验失败（${errors.length} 项）：`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`小火箭：${srRuleLines.length} 条顶层规则 / ${srRuleCount} 条本地规则，引用完整`);
console.log('✅ 配置、默认出口、规则顺序及 provider/策略引用校验通过');
console.log('ℹ️ USER-AGENT / IP-ASN 当前保留；其在 Shadowrocket 中的真机兼容性仍需单独验证');
