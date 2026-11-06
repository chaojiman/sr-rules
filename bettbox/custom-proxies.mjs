/**
 * 自建节点（Bettbox 的 customizeProxies）
 *
 * build-bettbox.mjs 会把这里的数组注入生成脚本，所以每天自动同步不会覆盖你的节点。
 * 留空数组 = 不使用自建节点，也不会生成「自建节点」/「链式落地」分组。
 *
 * 链式代理用法：
 *   1. 在下面填入落地节点
 *   2. 把 scripts/build-bettbox.mjs 里的「链式代理=开」补丁取消注释（或直接改生成文件的开关）
 *   3. 推送后 Bettbox 点「更新」→ 重连
 *   4. 在 Bettbox 里选：链式中转 = 机场节点，链式落地 = 你的自建节点
 *
 * 字段参考 mihomo 的 proxies 配置，常见协议示例：
 *
 *   ss:
 *     { name: '自建-落地-01', type: 'ss', server: '203.0.113.9', port: 443,
 *       cipher: 'aes-128-gcm', password: 'PASSWORD' }
 *
 *   vmess:
 *     { name: '自建-落地-02', type: 'vmess', server: '203.0.113.10', port: 443,
 *       uuid: 'UUID', alterId: 0, cipher: 'auto', tls: true, servername: 'example.com',
 *       network: 'ws', 'ws-opts': { path: '/path', headers: { Host: 'example.com' } } }
 *
 *   trojan:
 *     { name: '自建-落地-03', type: 'trojan', server: '203.0.113.11', port: 443,
 *       password: 'PASSWORD', sni: 'example.com' }
 *
 * 注意：
 *   - 自定义节点不参与节点过滤和 hosts 改写，也不受「代理IPV4优先」影响；
 *     只有 IPv6 的落地节点请自己加 'ip-version': 'ipv6'
 *   - 节点名建议带地区关键字（如「日本」「美国」），否则不会归入地区组
 */
export default [
  // {
  //   name: '自建-落地-01',
  //   type: 'ss',
  //   server: '203.0.113.9',
  //   port: 443,
  //   cipher: 'aes-128-gcm',
  //   password: 'REPLACE_ME',
  // },
];
