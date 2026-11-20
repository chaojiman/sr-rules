/**
 * 把本地落地节点注入「Bettbox 当前运行的覆写脚本」
 *
 * 每次运行都先拉 GitHub 最新脚本（与 Bettbox 点「同步」拿到的是同一份），
 * 再把 proxies.local.json 注入其中；拉取失败直接报错退出，不会用旧脚本糊弄过去。
 *
 * 只替换 `const customizeProxies = [...]` 段，其余逻辑原样保留。
 *
 * 节点文件里可以直接粘贴分享链接（ss / vless / vmess / trojan / hysteria2 / tuic / anytls），
 * 运行时自动转成 mihomo 节点并回写节点文件：每个节点上方带一行「// 链接: …」注释
 * （粘贴的原链接；手写节点则由字段生成，删掉该行再运行即可按当前字段重新生成）。
 *
 * 用法:
 *   node scripts/inject-local-nodes.mjs [--proxies <file>] [--offline]
 *     --proxies  节点文件，默认仓库根目录 proxies.local.json
 *     --offline  不联网，直接用 Bettbox 现有脚本（临时应急用）
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { execSync, spawn } from 'node:child_process';

const REPO_RAW = 'https://raw.githubusercontent.com/chaojiman/sr-rules/main/bettbox/mihomoScript.js';
const BETTBOX_DIR = path.join(process.env.APPDATA || '', 'com.appshub', 'Bettbox');
const argv = process.argv;
const proxiesArg = argv.indexOf('--proxies');
const LOCAL_FILE = path.resolve(proxiesArg > 0 ? argv[proxiesArg + 1] : 'proxies.local.json');
const OFFLINE = argv.includes('--offline') || argv.includes('--local');

function fail(msg) {
  console.error(`\n  FAILED: ${msg}`);
  process.exit(1);
}

// ── 1. 本地节点：读取 → 分享链接转节点 → 回写（每个节点上方带「// 链接:」注释）──
if (!fs.existsSync(LOCAL_FILE)) fail(`找不到节点文件 ${LOCAL_FILE}`);
const localText = fs.readFileSync(LOCAL_FILE, 'utf8');
let items;
try {
  // 末尾换行：文件最后一行是 // 注释时，也不会把补上的右括号注释掉
  items = vm.runInNewContext(`(${localText}\n)`, {});
} catch (e) {
  fail(`节点文件语法错误：${e.message}`);
}
if (!Array.isArray(items) || items.length === 0) fail('节点文件不是非空数组');
let resolved;
try {
  resolved = items.map(resolveLocalItem);
} catch (e) {
  fail(`分享链接转换失败：${e.message}`);
}
const proxies = resolved.map((r) => r.proxy);
console.log(`  本地节点: ${proxies.length} 个`);
for (const r of resolved) {
  const p = r.proxy;
  const tag = [r.converted ? '链接转换' : '', p.direct ? '直连' : '链式'].filter(Boolean).join('·');
  console.log(`    - ${p.name}  [${p.type} ${p.server}:${p.port} ${tag}]`);
}
const rewritten = rewriteLocalFile(localText, resolved);
if (rewritten === null) {
  console.log('  ⚠️ 节点文件结构没认出来，未回写（不影响本次注入）');
} else if (rewritten !== localText) {
  const bak = `${LOCAL_FILE}.bak-${Date.now()}`;
  fs.copyFileSync(LOCAL_FILE, bak);
  const dir = path.dirname(LOCAL_FILE);
  fs.readdirSync(dir)
    // 只清理本脚本生成的毫秒时间戳备份（13 位），手工备份（如 .bak-202611201217）不动
    .filter((f) => f.startsWith(`${path.basename(LOCAL_FILE)}.bak-`) && /^\d{13}$/.test(f.split('.bak-')[1]))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(2)
    .forEach(({ f }) => fs.unlinkSync(path.join(dir, f)));
  fs.writeFileSync(LOCAL_FILE, rewritten, 'utf8');
  console.log(`  已回写节点文件（链接已展开 / 补链接注释），备份: ${path.basename(bak)}`);
}

// ── 2. 定位 Bettbox 脚本（写入目标，同时是离线源） ──
// App 运行时会覆盖 config.json，所以默认要求退出；--restart 时由脚本自己关掉再拉起
const RESTART = argv.includes('--restart');
const appArg = argv.indexOf('--app');
const APP_EXE = appArg > 0 ? argv[appArg + 1] : '';
function bettboxRunning() {
  try {
    return execSync('tasklist /FI "IMAGENAME eq Bettbox.exe" /NH', { encoding: 'utf8' }).includes('Bettbox.exe');
  } catch {
    return false;
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 关闭时机放在写 config.json 之前：拉取还要用 App 提供的 7890 代理
async function shutdownBettbox() {
  console.log('  关闭 Bettbox ...');
  try {
    execSync('taskkill /IM Bettbox.exe /F /T', { stdio: 'ignore' });
  } catch {
    /* 已退出 */
  }
  try {
    execSync('taskkill /IM BettboxCore.exe /F', { stdio: 'ignore' });
  } catch {
    /* 已退出 */
  }
  for (let i = 0; i < 20 && bettboxRunning(); i += 1) await sleep(300);
  if (bettboxRunning()) fail('Bettbox 未能关闭，请用任务管理器结束 Bettbox.exe 后重试');
  console.log('  已关闭');
}

const cfgPath = path.join(BETTBOX_DIR, 'config.json');
if (!fs.existsSync(cfgPath)) fail(`找不到 ${cfgPath}`);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const script = (cfg.scriptProps?.scripts || [])[0];
if (!script?.id) fail('config.json 里没有启用中的覆写脚本');
const dst = path.join(BETTBOX_DIR, 'scripts', `${script.id}.js`);
if (!fs.existsSync(dst)) fail(`找不到 Bettbox 脚本副本 ${dst}（先在 Bettbox 里点一次「同步」）`);

// ── 3. 取源脚本：默认强制拉 GitHub 最新，--offline 才用本地副本 ──
let code = null;
if (OFFLINE) {
  code = fs.readFileSync(dst, 'utf8');
  console.log('  源: Bettbox 现有脚本（--offline，未联网）');
} else {
  console.log('  拉取 GitHub 最新脚本 ...');
  try {
    const res = await fetch(REPO_RAW, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    code = await res.text();
  } catch (e) {
    fail(`拉取失败（${e.message}），脚本未改动。\n  先确保 Bettbox 已连接（7890 代理可用），或加 --offline 跳过联网`);
  }
  if (!code) fail('拉取结果为空，脚本未改动');
  const built = code.match(/^\/\/ 生成日期: (.+)$/m)?.[1];
  const upstream = code.match(/^\/\/ 上游版本: (.+)$/m)?.[1];
  console.log(`  源: GitHub 最新（${code.length} 字节）`);
  if (built || upstream) console.log(`  构建: ${built ?? '未知'} / 上游: ${upstream ?? '未知'}`);
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
// ── 7. 写进 config.json：App 重建配置只认这里，缓存脚本会被 URL 覆盖 ──
const backup = (file) => {
  const bak = `${file}.bak-${Date.now()}`;
  fs.copyFileSync(file, bak);
  const dir = path.dirname(file);
  const olds = fs.readdirSync(dir)
    .filter((f) => f.startsWith(path.basename(file) + '.bak-'))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  for (const { f } of olds.slice(1)) fs.unlinkSync(path.join(dir, f));
  return bak;
};

const prevUrl = cfg.scriptProps?.scripts?.[0]?.url || '';
if (!process.env.INJECT_SKIP_RUNNING_CHECK && bettboxRunning()) {
  if (!RESTART) {
    fail('Bettbox 正在运行。双击 sync-nodes.cmd 会自动关闭并重启它；单独运行本脚本请先托盘退出');
  }
  await shutdownBettbox();
}
backup(cfgPath);
cfg.scriptProps.scripts[0].content = code;
// 选择记忆优先：只清掉链式落地组里指向「已删除/改名节点」的记忆（否则 App 一直显示旧名字），有效的照旧保留。
// 这些组只含本地落地节点和「…-自动选择」子组，所以能逐个判断是否还存在；名字前的国旗由脚本自动加，比对时去掉
const localNames = new Set(proxies.filter((p) => p.direct !== true).map((p) => p.name)); // 只有真落地会进链式落地组
const stripFlag = (s) => String(s).replace(/^(?:\p{Regional_Indicator}{2})\s*/u, '');
for (const profile of cfg.profiles || []) {
  if (profile.scriptId !== script.id || !profile.selectedMap) continue;
  const map = profile.selectedMap;
  const stale = Object.keys(map).filter((k) => {
    if (k !== '链式落地' && !k.startsWith('链式落地-')) return false;
    const v = map[k];
    return !(localNames.has(stripFlag(v)) || (v.startsWith('链式落地') && v.endsWith('-自动选择')));
  });
  for (const k of stale) delete map[k];
  if (stale.length) console.log(`  已清理「${profile.label ?? profile.id}」失效的选择记忆: ${stale.join('、')}`);
}
fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
console.log(`  已写入 config.json 脚本内容（原 url: ${prevUrl || '无'}）`);

const optPath = path.join(BETTBOX_DIR, 'scripts', 'opt.json');
if (fs.existsSync(optPath)) {
  const opt = JSON.parse(fs.readFileSync(optPath, 'utf8'));
  if (opt['链式代理'] !== true) {
    backup(optPath);
    opt['链式代理'] = true;
    fs.writeFileSync(optPath, `${JSON.stringify(opt, null, 2)}\n`, 'utf8');
    console.log('  已打开脚本选项「链式代理」');
  }
}

console.log('\n  完成。');
if (RESTART) {
  if (APP_EXE && fs.existsSync(APP_EXE)) {
    spawn(APP_EXE, [], { detached: true, stdio: 'ignore', cwd: path.dirname(APP_EXE) }).unref();
    console.log(`  已启动 ${APP_EXE}`);
  } else {
    console.log('  ⚠️ 没找到 Bettbox.exe，请手动启动');
  }
} else {
  console.log('  启动 Bettbox 会按这份脚本重建配置。');
}
console.log('  组: 链式落地 / 链式落地-<地区>；链式中转 决定前置。');

// ════════════════════ 分享链接 ⇄ mihomo 节点 ════════════════════
// 解析方向的字段映射照搬 mihomo common/convert（converter.go / v.go），结果与机场订阅解析一致；
// 生成方向用于给手写节点补「// 链接:」注释（可复制到小火箭等客户端导入）。

/** 节点文件里的一项 → { proxy, link, converted } */
function resolveLocalItem(item, index) {
  if (typeof item === 'string') {
    if (!item.includes('://')) throw new Error(`第 ${index + 1} 项是字符串但不是分享链接：${item.slice(0, 30)}`);
    return { proxy: parseShareLink(item), link: item.trim(), converted: true };
  }
  if (!item || typeof item !== 'object') throw new Error(`第 ${index + 1} 项既不是节点对象也不是链接`);
  if (typeof item.link === 'string') {
    // { link: 'vless://…', direct: true, name: '改名' }：其余字段覆盖转换结果
    const { link, ...overrides } = item;
    return { proxy: { ...parseShareLink(link), ...overrides }, link: link.trim(), converted: true };
  }
  return { proxy: item, link: null, converted: false };
}

// 注意：本段在文件末尾、却在第 1 步就被调用 —— 只能用 function 声明（会提升），
// 写成 const 会在调用时处于暂时性死区（Cannot access … before initialization）
function dec(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
function truthy(s) {
  return /^(1|t|true)$/i.test(s || '');
}
function b64decode(s) {
  let t = String(s).trim().replace(/-/g, '+').replace(/_/g, '/');
  t += '='.repeat((4 - (t.length % 4)) % 4);
  return Buffer.from(t, 'base64').toString('utf8');
}
function splitOnce(s, sep) {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + sep.length)];
}
/** 去掉空值：undefined / null / '' / false / 空数组 */
function compact(obj) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0)) delete obj[k];
  }
  return obj;
}
function parseUrl(line) {
  let u;
  try {
    u = new URL(line);
  } catch {
    throw new Error(`链接格式错误：${line.slice(0, 50)}…`);
  }
  const host = dec(u.hostname).replace(/^\[|\]$/g, '');
  if (!host) throw new Error(`链接缺少服务器地址：${line.slice(0, 50)}…`);
  return {
    host,
    port: u.port ? Number(u.port) : undefined,
    q: u.searchParams,
    name: dec(u.hash.slice(1)),
    user: dec(u.username),
    pass: u.password === '' ? undefined : dec(u.password),
  };
}
function nameOf(p) {
  return p.name || `${p.host}:${p.port}`;
}

/** vless / vmess(AEAD) 公共部分，对应 mihomo v.go handleVShareLink */
function vShare(p, type) {
  if (!p.port) throw new Error(`${type} 链接缺少端口`);
  const { q } = p;
  const x = { name: nameOf(p), type, server: p.host, port: p.port, uuid: p.user, udp: true };
  const sec = (q.get('security') || '').toLowerCase();
  if (sec.endsWith('tls') || sec === 'reality') {
    x.tls = true;
    x['client-fingerprint'] = q.get('fp') || 'chrome';
    if (q.get('alpn')) x.alpn = q.get('alpn').split(',');
    if (q.get('pcs')) x.fingerprint = q.get('pcs');
  }
  if (q.get('sni')) x.servername = q.get('sni');
  if (q.get('pbk')) x['reality-opts'] = { 'public-key': q.get('pbk'), 'short-id': q.get('sid') || '' };
  const pe = q.get('packetEncoding');
  if (pe === 'packet') x['packet-addr'] = true;
  else if (pe !== 'none') x.xudp = true;
  let net = (q.get('type') || 'tcp').toLowerCase();
  const fake = (q.get('headerType') || '').toLowerCase();
  if (net === 'tcp' && fake === 'http') net = 'http';
  else if (net === 'http') net = 'h2';
  x.network = net;
  const host = q.get('host');
  switch (net) {
    case 'http':
      x['http-opts'] = compact({ method: q.get('method'), path: [q.get('path') || '/'], headers: host ? { Host: [host] } : undefined });
      break;
    case 'h2':
      x['h2-opts'] = compact({ path: q.get('path') || '/', host: host ? [host] : undefined });
      break;
    case 'ws':
    case 'httpupgrade': {
      const ws = compact({ path: q.get('path'), headers: host ? { Host: host } : undefined });
      if (net === 'httpupgrade') {
        x.network = 'ws';
        ws['v2ray-http-upgrade'] = true;
      }
      const ed = q.get('ed');
      if (ed) {
        if (!/^\d+$/.test(ed)) throw new Error(`ws 的 ed 参数非法：${ed}`);
        if (net === 'ws') {
          ws['max-early-data'] = Number(ed);
          ws['early-data-header-name'] = 'Sec-WebSocket-Protocol';
        } else ws['v2ray-http-upgrade-fast-open'] = true;
      }
      if (q.get('eh')) ws['early-data-header-name'] = q.get('eh');
      x['ws-opts'] = ws;
      break;
    }
    case 'grpc':
      x['grpc-opts'] = { 'grpc-service-name': q.get('serviceName') || '' };
      break;
    case 'xhttp':
      x['xhttp-opts'] = compact({ path: q.get('path'), host, mode: q.get('mode') });
      if (q.get('extra')) console.log('    ⚠️ xhttp 的 extra 参数未转换，需要时手动补到 xhttp-opts');
      break;
  }
  return x;
}

function parseShareLink(raw) {
  const line = String(raw).trim();
  const scheme = line.slice(0, line.indexOf('://')).toLowerCase();
  switch (scheme) {
    case 'vless': {
      const p = parseUrl(line);
      const x = vShare(p, 'vless');
      if (p.q.get('flow')) x.flow = p.q.get('flow').toLowerCase();
      if (p.q.get('encryption') && p.q.get('encryption') !== 'none') x.encryption = p.q.get('encryption');
      return compact(x);
    }
    case 'vmess': {
      const body = splitOnce(line.slice('vmess://'.length), '#')[0];
      if (!body.includes('@')) return parseVmessV2rayN(body);
      const p = parseUrl(line);
      const x = vShare(p, 'vmess');
      x.alterId = 0;
      x.cipher = p.q.get('encryption') || 'auto';
      return compact(x);
    }
    case 'trojan': {
      const p = parseUrl(line);
      if (!p.port) throw new Error('trojan 链接缺少端口');
      const { q } = p;
      const x = { name: nameOf(p), type: 'trojan', server: p.host, port: p.port, password: p.user, udp: true };
      x['skip-cert-verify'] = truthy(q.get('allowInsecure'));
      if (q.get('sni')) x.sni = q.get('sni');
      if (q.get('alpn')) x.alpn = q.get('alpn').split(',');
      const net = (q.get('type') || '').toLowerCase();
      if (net) x.network = net;
      if (net === 'ws' || net === 'httpupgrade') {
        const ws = compact({ path: q.get('path'), headers: q.get('host') ? { Host: q.get('host') } : undefined });
        if (net === 'httpupgrade') {
          x.network = 'ws';
          ws['v2ray-http-upgrade'] = true;
        }
        x['ws-opts'] = ws;
      } else if (net === 'grpc') {
        x['grpc-opts'] = { 'grpc-service-name': q.get('serviceName') || '' };
      }
      x['client-fingerprint'] = q.get('fp') || 'chrome';
      if (q.get('pcs')) x.fingerprint = q.get('pcs');
      return compact(x);
    }
    case 'hysteria2':
    case 'hy2': {
      const [hopLine, ports] = splitHysteria2Ports(line);
      const p = parseUrl(hopLine);
      const { q } = p;
      const x = { name: nameOf({ ...p, port: p.port || 443 }), type: 'hysteria2', server: p.host, port: p.port || 443 };
      if (ports) x.ports = ports;
      x['password'] = p.pass === undefined ? p.user : `${p.user}:${p.pass}`;
      Object.assign(x, {
        obfs: q.get('obfs'),
        'obfs-password': q.get('obfs-password'),
        sni: q.get('sni'),
        'skip-cert-verify': truthy(q.get('insecure')),
        alpn: q.get('alpn') ? q.get('alpn').split(',') : undefined,
        fingerprint: q.get('pinSHA256'),
        down: q.get('down'),
        up: q.get('up'),
      });
      return compact(x);
    }
    case 'tuic': {
      const p = parseUrl(line);
      if (!p.port) throw new Error('tuic 链接缺少端口');
      const { q } = p;
      const x = { name: nameOf(p), type: 'tuic', server: p.host, port: p.port, udp: true };
      if (p.pass !== undefined) {
        x.uuid = p.user;
        x['password'] = p.pass;
      } else x.token = p.user;
      Object.assign(x, {
        'congestion-controller': q.get('congestion_control'),
        alpn: q.get('alpn') ? q.get('alpn').split(',') : undefined,
        sni: q.get('sni'),
        'disable-sni': q.get('disable_sni') === '1',
        'udp-relay-mode': q.get('udp_relay_mode'),
      });
      return compact(x);
    }
    case 'anytls': {
      const p = parseUrl(line);
      if (!p.port) throw new Error('anytls 链接缺少端口');
      const { q } = p;
      return compact({
        name: nameOf(p),
        type: 'anytls',
        server: p.host,
        port: p.port,
        password: p.pass ?? p.user,
        sni: q.get('sni'),
        fingerprint: q.get('hpkp'),
        'skip-cert-verify': q.get('insecure') === '1',
        udp: true,
      });
    }
    case 'ss':
      return parseSS(line);
    default:
      throw new Error(`暂不支持 ${scheme || '未知'}:// 链接，请改用节点对象写法`);
  }
}

/** hy2://auth@host:443,20000-30000/?… → [把端口段换成首个端口的链接, '443,20000-30000']，同 mihomo splitHysteria2Ports */
function splitHysteria2Ports(line) {
  const i = line.indexOf('://');
  const head = line.slice(0, i + 3);
  const rest = line.slice(i + 3);
  const j = rest.search(/[/?#]/);
  let auth = j < 0 ? rest : rest.slice(0, j);
  const tail = j < 0 ? '' : rest.slice(j);
  const at = auth.lastIndexOf('@');
  const userinfo = at < 0 ? '' : auth.slice(0, at + 1);
  auth = auth.slice(at + 1);
  if (auth.includes(']')) return [line, ''];
  const colon = auth.lastIndexOf(':');
  if (colon < 0) return [line, ''];
  const host = auth.slice(0, colon);
  const ports = auth.slice(colon + 1);
  if (!/[,-]/.test(ports)) return [line, ''];
  const first = ports.split(/[,-]/)[0];
  return [`${head}${userinfo}${host}:${first}${tail}`, ports];
}

/** v2rayN 格式：vmess://base64(JSON) */
function parseVmessV2rayN(body) {
  let v;
  try {
    v = JSON.parse(b64decode(body));
  } catch {
    throw new Error('vmess 链接 base64/JSON 解析失败');
  }
  const x = {
    name: v.ps || `${v.add}:${v.port}`,
    type: 'vmess',
    server: v.add,
    port: Number(v.port),
    uuid: v.id,
    alterId: Number(v.aid || 0),
    udp: true,
    xudp: true,
    cipher: v.scy || 'auto',
    servername: v.sni,
  };
  let net = typeof v.net === 'string' ? v.net.toLowerCase() : undefined;
  if (net) {
    if (v.type === 'http') net = 'http';
    else if (net === 'http') net = 'h2';
    x.network = net;
  }
  if (typeof v.tls === 'string') {
    if (v.tls.toLowerCase().endsWith('tls')) x.tls = true;
    // fp：v2rayN 扩展字段，mihomo 解析器不读；这里读进来，保证生成 → 解析往返不丢指纹
    if (x.tls && v.fp) x['client-fingerprint'] = v.fp;
    if (typeof v.alpn === 'string' && v.alpn) x.alpn = v.alpn.split(',');
  }
  switch (net) {
    case 'http':
      x['http-opts'] = compact({ path: [v.path || '/'], headers: v.host ? { Host: [v.host] } : undefined });
      break;
    case 'h2':
      x['h2-opts'] = compact({ path: v.path || '/', host: v.host ? [v.host] : undefined });
      break;
    case 'ws':
    case 'httpupgrade': {
      const ws = { path: '/' };
      if (net === 'httpupgrade') {
        x.network = 'ws';
        ws['v2ray-http-upgrade'] = true;
      }
      if (v.host) ws.headers = { Host: v.host };
      if (v.path) {
        let pathStr = v.path;
        const m = pathStr.match(/[?&]ed=(\d+)/);
        if (m) {
          if (net === 'ws') {
            ws['max-early-data'] = Number(m[1]);
            ws['early-data-header-name'] = 'Sec-WebSocket-Protocol';
          } else ws['v2ray-http-upgrade-fast-open'] = true;
          pathStr = pathStr.replace(/([?&])ed=\d+&?/, '$1').replace(/[?&]$/, '');
        }
        ws.path = pathStr;
      }
      x['ws-opts'] = ws;
      break;
    }
    case 'grpc':
      x['grpc-opts'] = { 'grpc-service-name': v.path || '' };
      break;
  }
  return compact(x);
}

/** ss://：SIP002（userinfo 明文或 base64）与整段 base64 的旧格式，同 mihomo converter ss 分支 */
function parseSS(line) {
  const [main, frag] = splitOnce(line.slice('ss://'.length), '#');
  let [hostPart, query] = splitOnce(main, '?');
  hostPart = hostPart.replace(/\/$/, '');
  const legacy = !hostPart.includes('@');
  if (legacy) hostPart = b64decode(hostPart);
  const at = hostPart.lastIndexOf('@');
  if (at < 0) throw new Error('ss 链接缺少 @服务器');
  const userinfo = hostPart.slice(0, at);
  const hostport = hostPart.slice(at + 1);
  let cipher;
  let password;
  if (legacy) [cipher, password] = splitOnce(userinfo, ':');
  else if (userinfo.includes(':')) [cipher, password] = splitOnce(userinfo, ':').map(dec);
  else [cipher, password] = splitOnce(b64decode(dec(userinfo)), ':');
  if (!cipher || password === '') throw new Error('ss 链接的加密方式/密码解析失败');
  const m = hostport.match(/^\[(.+)\]:(\d+)$/) || hostport.match(/^(.+):(\d+)$/);
  if (!m) throw new Error(`ss 链接的服务器端口解析失败：${hostport}`);
  const q = new URLSearchParams(query);
  const x = { name: dec(frag) || `${m[1]}:${m[2]}`, type: 'ss', server: m[1], port: Number(m[2]), cipher, password, udp: true };
  if (q.get('udp-over-tcp') === 'true' || q.get('uot') === '1') x['udp-over-tcp'] = true;
  const plugin = q.get('plugin') || '';
  if (plugin.includes(';')) {
    const info = new URLSearchParams(`pluginName=${plugin.replace(/;/g, '&')}`);
    const pluginName = info.get('pluginName') || '';
    if (pluginName.includes('obfs')) {
      x.plugin = 'obfs';
      x['plugin-opts'] = compact({ mode: info.get('obfs'), host: info.get('obfs-host') });
    } else if (pluginName.includes('v2ray-plugin')) {
      x.plugin = 'v2ray-plugin';
      x['plugin-opts'] = compact({
        mode: info.get('mode') || info.get('obfs'),
        host: info.get('host') || info.get('obfs-host'),
        path: info.get('path'),
        tls: plugin.includes('tls'),
      });
    }
  }
  return x;
}

// ── 生成方向：节点 → 分享链接（不支持的协议/插件返回 null）──
function hostFmt(h) {
  return String(h).includes(':') ? `[${h}]` : String(h);
}
function qs(obj) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '' && v !== false) s.set(k, String(v));
  const t = s.toString();
  return t ? `?${t}` : '';
}
function fragOf(n) {
  return n ? `#${encodeURIComponent(n)}` : '';
}
function transportParams(p) {
  const ws = p['ws-opts'] || {};
  switch (p.network) {
    case 'ws':
      return { type: ws['v2ray-http-upgrade'] ? 'httpupgrade' : 'ws', host: ws.headers?.Host, path: ws.path, ed: ws['max-early-data'] };
    case 'h2':
      return { type: 'http', host: p['h2-opts']?.host?.[0], path: p['h2-opts']?.path };
    case 'http':
      return { type: 'tcp', headerType: 'http', host: p['http-opts']?.headers?.Host?.[0], path: p['http-opts']?.path?.[0], method: p['http-opts']?.method };
    case 'grpc':
      return { type: 'grpc', serviceName: p['grpc-opts']?.['grpc-service-name'] };
    case 'xhttp':
      return { type: 'xhttp', host: p['xhttp-opts']?.host, path: p['xhttp-opts']?.path, mode: p['xhttp-opts']?.mode };
    default:
      return { type: 'tcp' };
  }
}
function toShareLink(p) {
  const enc = encodeURIComponent;
  const hp = `${hostFmt(p.server)}:${p.port}`;
  const alpn = Array.isArray(p.alpn) ? p.alpn.join(',') : p.alpn;
  switch (p.type) {
    case 'ss': {
      const userinfo = String(p.cipher).startsWith('2022-')
        ? `${enc(p.cipher)}:${enc(p['password'])}`
        : Buffer.from(`${p.cipher}:${p['password']}`, 'utf8').toString('base64url');
      const o = p['plugin-opts'] || {};
      let plugin;
      if (p.plugin === 'obfs') plugin = ['obfs-local', o.mode && `obfs=${o.mode}`, o.host && `obfs-host=${o.host}`];
      else if (p.plugin === 'v2ray-plugin') plugin = ['v2ray-plugin', o.mode && `mode=${o.mode}`, o.host && `host=${o.host}`, o.path && `path=${o.path}`, o.tls && 'tls'];
      else if (p.plugin) return null;
      const q = qs({ plugin: plugin?.filter(Boolean).join(';'), uot: p['udp-over-tcp'] ? 1 : undefined });
      return `ss://${userinfo}@${hp}${q ? `/${q}` : ''}${fragOf(p.name)}`;
    }
    case 'vless': {
      const r = p['reality-opts'];
      return `vless://${enc(p.uuid)}@${hp}${qs({
        encryption: p.encryption || 'none',
        flow: p.flow,
        security: r ? 'reality' : p.tls ? 'tls' : undefined,
        sni: p.servername,
        fp: p.tls ? p['client-fingerprint'] : undefined,
        alpn,
        pcs: p.fingerprint,
        pbk: r?.['public-key'],
        sid: r?.['short-id'],
        ...transportParams(p),
      })}${fragOf(p.name)}`;
    }
    case 'vmess': {
      const t = transportParams(p);
      const v = {
        v: '2',
        ps: p.name,
        add: p.server,
        port: String(p.port),
        id: p.uuid,
        aid: String(p.alterId ?? 0),
        scy: p.cipher || 'auto',
        net: t.type === 'tcp' && t.headerType === 'http' ? 'tcp' : t.type,
        type: t.headerType || 'none',
        host: t.host || '',
        path: t.type === 'grpc' ? t.serviceName || '' : t.ed ? `${t.path || '/'}?ed=${t.ed}` : t.path || '',
        tls: p.tls ? 'tls' : '',
        sni: p.servername || '',
        alpn: alpn || '',
        fp: p.tls ? p['client-fingerprint'] || '' : '',
      };
      return `vmess://${Buffer.from(JSON.stringify(v), 'utf8').toString('base64')}`;
    }
    case 'trojan': {
      const t = p.network ? transportParams(p) : {};
      return `trojan://${enc(p['password'])}@${hp}${qs({
        sni: p.sni,
        allowInsecure: p['skip-cert-verify'] ? 1 : undefined,
        fp: p['client-fingerprint'],
        alpn,
        pcs: p.fingerprint,
        ...t,
      })}${fragOf(p.name)}`;
    }
    case 'hysteria2':
      return `hysteria2://${enc(p['password'] || '')}@${hostFmt(p.server)}:${p.ports || p.port}/${qs({
        sni: p.sni,
        insecure: p['skip-cert-verify'] ? 1 : undefined,
        obfs: p.obfs,
        'obfs-password': p['obfs-password'],
        alpn,
        pinSHA256: p.fingerprint,
        up: p.up,
        down: p.down,
      })}${fragOf(p.name)}`;
    case 'tuic':
      return `tuic://${p.token ? enc(p.token) : `${enc(p.uuid)}:${enc(p['password'])}`}@${hp}${qs({
        congestion_control: p['congestion-controller'],
        alpn,
        sni: p.sni,
        udp_relay_mode: p['udp-relay-mode'],
        disable_sni: p['disable-sni'] ? 1 : undefined,
      })}${fragOf(p.name)}`;
    case 'anytls':
      return `anytls://${enc(p['password'])}@${hp}/${qs({
        sni: p.sni,
        insecure: p['skip-cert-verify'] ? 1 : undefined,
        hpkp: p.fingerprint,
      })}${fragOf(p.name)}`;
    default:
      return null;
  }
}

// ── 回写：链接展开成节点对象；每个节点上方保证有一行「// 链接: …」；其余注释与格式原样保留 ──
function isLinkComment(line) {
  return /^\/\/\s*链接[:：]/.test(line);
}

/** 切出顶层数组的每一项：{ segStart, start, end }（segStart = 上一个逗号之后，含前置注释） */
function splitArrayItems(text) {
  const n = text.length;
  const commentEnd = (j) => {
    if (text.startsWith('//', j)) {
      const e = text.indexOf('\n', j);
      return e < 0 ? n : e;
    }
    if (text.startsWith('/*', j)) {
      const e = text.indexOf('*/', j + 2);
      return e < 0 ? n : e + 2;
    }
    return -1;
  };
  const stringEnd = (j) => {
    const quote = text[j];
    for (j += 1; j < n && text[j] !== quote; j += 1) if (text[j] === '\\') j += 1;
    return j + 1;
  };
  let i = 0;
  while (i < n && text[i] !== '[') {
    const c = commentEnd(i);
    i = c >= 0 ? c : i + 1;
  }
  if (i >= n) return null;
  const open = i;
  const list = [];
  let segStart = open + 1;
  for (;;) {
    let j = segStart;
    while (j < n) {
      if (/\s/.test(text[j])) j += 1;
      else if (commentEnd(j) >= 0) j = commentEnd(j);
      else break;
    }
    if (j >= n) return null;
    if (text[j] === ']') return { open, list };
    const start = j;
    let end = j;
    let depth = 0;
    while (j < n) {
      const ch = text[j];
      const c = commentEnd(j);
      if (c >= 0) j = c;
      else if (ch === '"' || ch === "'" || ch === '`') end = j = stringEnd(j);
      else if (/\s/.test(ch)) j += 1;
      else if (depth === 0 && (ch === ',' || ch === ']')) break;
      else {
        if ('[{('.includes(ch)) depth += 1;
        else if (']})'.includes(ch)) depth -= 1;
        end = j += 1;
      }
    }
    if (j >= n) return null;
    list.push({ segStart, start, end });
    if (text[j] === ']') return { open, list };
    segStart = j + 1;
  }
}

function rewriteLocalFile(text, resolvedItems) {
  const parsed = splitArrayItems(text);
  if (!parsed || parsed.list.length !== resolvedItems.length) return null;
  let out = text.slice(0, parsed.open + 1);
  parsed.list.forEach((seg, k) => {
    const r = resolvedItems[k];
    const lines = text
      .slice(seg.segStart, seg.start)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const oldLink = lines.find(isLinkComment);
    const kept = lines.filter((l) => !isLinkComment(l));
    let linkLine;
    if (r.link) linkLine = `// 链接: ${r.link}`;
    else if (oldLink) linkLine = oldLink;
    else {
      const gen = toShareLink(r.proxy);
      linkLine = gen ? `// 链接: ${gen}` : `// 链接: 无（${r.proxy.type} 暂不支持生成）`;
    }
    const body = r.converted
      ? JSON.stringify(r.proxy, null, 2).replace(/\n/g, '\n  ')
      : text.slice(seg.start, seg.end);
    out += `\n${[...kept, linkLine].map((l) => `  ${l}`).join('\n')}\n  ${body},`;
  });
  // 最后一项之后的内容（模板注释、右括号）原样保留；原来的逗号已由上面统一补上
  out += text.slice(parsed.list[parsed.list.length - 1].end).replace(/^\s*,/, '');
  return out;
}