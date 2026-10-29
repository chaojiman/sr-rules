/**
 * 拉取 AIsouler/MyClash 的 mihomo 覆写脚本，打上本地补丁，输出到 bettbox/mihomoScript.js
 *
 * 补丁原则：
 *   - 只改「默认值」和「规则顺序」，不重写逻辑
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

// ── 补丁定义 ──────────────────────────────────────────────
// required: 锚点丢失时是否中断构建

const REPLACES = [
  // ── 必需：规则顺序 AdBlock → AI → 其余（antigravity/gemini 必须压过 Google）──
  {
    name: '规则顺序 AI 提前',
    required: true,
    from: `  const orderedServiceConfigs = [
    ...serviceConfigs.filter((svc) => svc.name === 'AdBlock'),
    ...serviceConfigs.filter((svc) => svc.name !== 'AdBlock'),
  ];`,
    to: `  const orderedServiceConfigs = [
    ...serviceConfigs.filter((svc) => svc.name === 'AdBlock'),
    // AI 提到第 2 位：antigravity/gemini 的 *.googleapis.com 必须先于 Google 命中
    ...serviceConfigs.filter((svc) => svc.name === 'AI'),
    ...serviceConfigs.filter((svc) => svc.name !== 'AdBlock' && svc.name !== 'AI'),
  ];`,
  },

  // ── 必需：前置规则区（临时规则 + Copilot 归属）──
  {
    name: 'prefixRules 前置规则',
    required: true,
    from: `const prefixRules = [`,
    to: `// ⚠️ 本文件由 build-bettbox-script.mjs 自动生成，不要手改
// 上游: ${SRC}
const prefixRules = [
  // ===== 临时规则区（改这里，用完删）=====
  'DOMAIN-SUFFIX,morphllm.com,美国',

  // ===== GitHub Copilot 钉回 GitHub 组 =====
  // AI 规则集里含这些域名，AI 已在第 2 位会抢走；前置规则可盖过
  'DOMAIN-SUFFIX,githubcopilot.com,GitHub',
  'DOMAIN-SUFFIX,copilot-proxy.githubusercontent.com,GitHub',
  'DOMAIN-SUFFIX,copilot-workspace.githubnext.com,GitHub',
  'DOMAIN-SUFFIX,copilot-telemetry.githubusercontent.com,GitHub',
  'DOMAIN-SUFFIX,copilot-telemetry-service.githubusercontent.com,GitHub',
  'DOMAIN-SUFFIX,copilot-stg.com,GitHub',
  'DOMAIN-SUFFIX,copilotprodattachments.blob.core.windows.net,GitHub',
`,
  },

  // ── 默认值对齐当前 Bettbox UI 实测状态（非必需，上游删项时不中断）──
  { name: '手动选择=关', required: false, from: /^(\s*)手动选择:\s*true,/m, to: '$1手动选择: false,' },
  { name: '自动选择=关', required: false, from: /^(\s*)自动选择:\s*true,/m, to: '$1自动选择: false,' },
  { name: '负载均衡=关', required: false, from: /^(\s*)负载均衡:\s*true,/m, to: '$1负载均衡: false,' },
  { name: 'FCM=关', required: false, from: /^(\s*)FCM:\s*true,/m, to: '$1FCM: false,' },
  { name: 'Twitter=关', required: false, from: /^(\s*)Twitter:\s*true,/m, to: '$1Twitter: false,' },
  {
    name: '地区自动组=关',
    required: false,
    from: /^(\s*)生成地区自动选择组:\s*true,/m,
    to: '$1生成地区自动选择组: false,',
  },
  { name: '倍率组=关', required: false, from: /^(\s*)生成倍率组:\s*true,/m, to: '$1生成倍率组: false,' },
  { name: 'IPv4优先=开', required: false, from: /^(\s*)代理IPV4优先:\s*false,/m, to: '$1代理IPV4优先: true,' },
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
