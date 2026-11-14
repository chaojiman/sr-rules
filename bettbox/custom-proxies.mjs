/**
 * 自建节点（Bettbox 的 customizeProxies）
 *
 * build-bettbox.mjs 会把这里的数组注入生成脚本，所以每天自动同步不会覆盖你的节点。
 * 留空数组 = 不使用自建节点，也不会生成「自建节点」/「链式落地」分组。
 *
 * 链式代理用法：
 *   1. 在下面填入落地节点（开关不用改：生成脚本里会自动执行
 *      `ruleOptionsEnable.链式代理 = customizeProxies.length > 0`）
 *   2. 推送 → Bettbox 点「更新」→ 重连
 *   3. Bettbox 代理页：`链式中转` 选机场节点；再把真正要用的出口（默认代理/具体服务组）
 *      选成 `落地-…` 节点本身——只在该组里选不会生效，那组没有被规则引用。
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
 *   - 落地节点不参与节点过滤、地区分组和 hosts 改写，也不受「代理IPV4优先」影响；
 *     只有 IPv6 的落地节点请自己加 'ip-version': 'ipv6'
 *   - 名字里带「香港/美国/日本」也不会被塞进地区组（buildRegionGroups 只遍历订阅节点），
 *     所以取名只要方便自己辨认即可
 *   - 落地节点必须至少 1 个，否则链式关闭、不生成任何链式分组
 */
export default [
  // ⚠️ 节点凭据不进公开仓库：真实节点写在私有仓库 chaojiman/sr-rules-private，
  //    由 .github/workflows/sync-bettbox-private.yml 构建后供 Bettbox 订阅。
  //    这里保持空数组 → 公开产物不生成链式分组，也不含任何凭据。
];
