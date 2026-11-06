/**
 * 静态校验小火箭配置，并实际执行 Bettbox main() 校验生成结果。
 * 只使用 Node.js 内置模块，不访问网络。
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';

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

check(
  /^YouTube = select,.*policy-select-name=PROXY$/m.test(srConfig),
  '小火箭 YouTube 默认出口必须是 PROXY（默认代理）',
);
check(srRuleLines.at(-1)?.startsWith('FINAL,'), '小火箭 FINAL 必须是最后一条规则');

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

for (const file of fs.readdirSync(resolveInside('shadowrocket/rules')).filter((name) => name.endsWith('.list')).sort()) {
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

  for (const name of ['Emby', 'PikPak', 'Patreon', 'EHentai', 'Line']) {
    check(options[name] === false, `Bettbox ${name} 必须关闭`);
    check(!groupsByName.has(name), `Bettbox 不应再生成 ${name} 策略组`);
  }
  check(options.生成高低倍率组 === false, 'Bettbox 高低倍率组必须关闭（防止上游字段漂移）');

  for (const provider of ['emby', 'emos', 'pikpak', 'patreon', 'ehentai', 'line']) {
    check(!providers[provider], `Bettbox 不应再生成 ${provider} 规则源`);
  }

  const expectedDefaults = {
    YouTube: '默认代理',
    TikTok: '默认代理',
    PayPal: '直连',
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
