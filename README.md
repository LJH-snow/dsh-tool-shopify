# dsh-tool-shopify

Read-only Shopify Admin GraphQL tools for DeepSeek Harness.

## Tools

- `shopify_auth_test` and `shopify_get_shop`
- `shopify_list_products`
- `shopify_list_orders`
- `shopify_list_customers`
- `shopify_list_inventory_levels`
- `shopify_list_collections`

The package uses Shopify Admin GraphQL API `2026-01` with fixed queries. It does not expose arbitrary GraphQL, mutations, checkout actions, refunds, or other write operations.

## Configuration

```yaml
plugins:
  dsh-tool-shopify:
    storeDomain: your-store.myshopify.com
    accessToken: ${SHOPIFY_ADMIN_ACCESS_TOKEN}
```

Create an Admin API custom app with read-only scopes such as `read_products`, `read_orders`, `read_customers`, `read_inventory`, and `read_product_listings` as required by the selected tools. Shopify may require protected customer data approval for customer and order fields.

## Safety boundaries

- Store domains are restricted to HTTPS `*.myshopify.com` hosts.
- Only fixed allowlisted queries are sent to `/admin/api/2026-01/graphql.json`.
- Customer names and emails are masked; phone numbers, addresses, notes, tags, metafields, and raw GraphQL responses are omitted.
- Cursors and page sizes are bounded; output defaults to 64 KiB and can be configured between 1 KiB and 256 KiB.
- Access tokens are sent only in `X-Shopify-Access-Token` and are never returned or included in errors.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

See [README.zh.md](README.zh.md) for Chinese documentation.
