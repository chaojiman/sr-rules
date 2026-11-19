/**
 * 把本地落地节点注入「Bettbox 当前运行的覆写脚本」
 *
 * 源脚本优先从 GitHub 拉最新（与 Bettbox 点「同步」拿到的是同一份），
 * 拉不到（无代理/被墙）时自动改用 Bettbox 现有的脚本副本，保证离线可用。
 *
 * 只替换 `const customizeProxies = [...]` 段，其余逻辑原样保留。
 *
 * 用法:
 *   node scripts/inject-local-nodes.mjs [--proxies <file>] [--local]
 *     --proxies  节点文件，默认仓库根目录 proxies.local.json
 *     --local    不联网，直接用 Bettbox 现有脚本
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const REPO_RAW = 'https://raw.githubusercontent.com/chaojiman/sr-rules/main/bettbox/mihomoScript.js';
const BETTBOX_DIR = path.join(process.env.APPDATA || '', 'com.appshub', 'Bettbox');
const argv = process.argv;
const proxiesArg = argv.indexOf('--proxies');
const LOCAL_FILE = path.resolve(proxiesArg > 0 ? argv[proxiesArg + 1] : 'proxies.local.json');
const FORCE_LOCAL = argv.includes('--local');

function fail(msg) {
  console.error(`\n  FAILED: ${msg}`);
  process.exit(1);
}

// ── 1. 本地节点 ──
if (!fs.existsSync(LOCAL_FILE)) fail(`找不到节点文件 ${LOCAL_FILE}`);
let proxies;
try {
  proxies = vm.runInNewContext(`(${fs.readFileSync(LOCAL_FILE, 'utf8')})`, {});
} catch (e) {
  fail(`节点文件语法错误：${e.message}`);
}
if (!Array.isArray(proxies) || proxies.length === 0) fail('节点文件不是非空数组');
console.log(`  本地节点: ${proxies.length} 个`);
for (const p of proxies) console.log(`    - ${p.name}`);

// ── 2. 定位 Bettbox 脚本（写入目标，同时是离线源） ──
const cfgPath = path.join(BETTBOX_DIR, 'config.json');
if (!fs.existsSync(cfgPath)) fail(`找不到 ${cfgPath}`);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const script = (cfg.scriptProps?.scripts || [])[0];
if (!script?.id) fail('config.json 里没有启用中的覆写脚本');
const dst = path.join(BETTBOX_DIR, 'scripts', `${script.id}.js`);
if (!fs.existsSync(dst)) fail(`找不到 Bettbox 脚本副本 ${dst}（先在 Bettbox 里点一次「同步」）`);

// ── 3. 取源脚本：远程优先，失败回落本地副本 ──
let code = null;
if (FORCE_LOCAL) {
  code = fs.readFileSync(dst, 'utf8');
  console.log('  源: Bettbox 现有脚本（--local）');
} else {
  console.log('  拉取 GitHub 最新脚本 ...');
  try {
    const res = await fetch(REPO_RAW, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    code = await res.text();
    console.log(`  源: GitHub 最新（${code.length} 字节）`);
  } catch (e) {
    console.log(`  拉取失败（${e.message}），回落 Bettbox 现有脚本`);
    code = fs.readFileSync(dst, 'utf8');
  }
}

// ── 4. 只替换 customizeProxies 段 ──
const anchor = code.match(/^const customizeProxies = \[/m);
if (!anchor) fail('脚本里找不到 const customizeProxies = [，上游结构可能变了');
const start = anchor.index + anchor[0].length - 1;
let depth = 0;
let end = -1;
for (let i = start; i < code.length; i += 1) {
  if (code[i] === '[') depth += 1;
  else if (code[i] === ']') {
    depth -= 1;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
}
if (end < 0) fail('customizeProxies 数组括号不配对');
const injected = `[\n${proxies.map((p) => `  ${JSON.stringify(p)}`).join(',\n')},\n]`;
code = `${code.slice(0, start)}${injected}${code.slice(end)}`;

// ── 5. 语法校验 ──
try {
  new vm.Script(code, { filename: 'injected.js' });
} catch (e) {
  fail(`注入后语法错误：${e.message}`);
}

// ── 6. 备份 + 写入 ──
const bak = `${dst}.bak-${Date.now()}`;
// 只保留最近 2 个备份
const bakDir = path.dirname(dst);
const olds = fs.readdirSync(bakDir)
  .filter((f) => f.startsWith(path.basename(dst) + '.bak-'))
  .map((f) => ({ f, m: fs.statSync(path.join(bakDir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m);
for (const { f } of olds.slice(1)) fs.unlinkSync(path.join(bakDir, f));
fs.copyFileSync(dst, bak);
fs.writeFileSync(dst, code, 'utf8');
console.log(`  已备份: ${path.basename(bak)}`);
console.log(`  已写入: ${dst}`);
console.log('\n  完成。Bettbox 代理页点「重连」后生效。');
console.log('  组: 链式落地 / 链式落地-<地区>；链式中转 决定前置。');