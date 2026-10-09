# dsh-tool-shopify

面向 DeepSeek Harness 的 Shopify Admin GraphQL 只读工具。

## 工具

- `shopify_auth_test`、`shopify_get_shop`
- `shopify_list_products`
- `shopify_list_orders`
- `shopify_list_customers`
- `shopify_list_inventory_levels`
- `shopify_list_collections`

插件使用 Shopify Admin GraphQL API `2026-01` 和固定查询，不提供任意 GraphQL、mutation、结账、退款或其他写操作。

## 配置

```yaml
plugins:
  dsh-tool-shopify:
    storeDomain: your-store.myshopify.com
    accessToken: ${SHOPIFY_ADMIN_ACCESS_TOKEN}
```

请为自定义 Admin API 应用配置所需的只读权限，例如 `read_products`、`read_orders`、`read_customers`、`read_inventory` 和 `read_product_listings`。客户和订单字段可能还需要 Shopify 的受保护客户数据审批。

## 安全边界

- 店铺域名仅允许 HTTPS `*.myshopify.com`。
- 只向 `/admin/api/2026-01/graphql.json` 发送固定查询。
- 客户姓名和邮箱会脱敏；电话、地址、备注、标签、metafield 和原始 GraphQL 响应不会返回。
- 游标和页大小有上限；输出默认不超过 64 KiB，可配置范围为 1 KiB 至 256 KiB。
- Token 只放在 `X-Shopify-Access-Token` 请求头中，不会返回或出现在错误信息里。

## 开发

```bash
npm install
npm test
npm run typecheck
npm run build
npm pack --dry-run
```
