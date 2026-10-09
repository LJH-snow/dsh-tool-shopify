import { describe, expect, it, vi } from 'vitest'
import { ShopifyClient, ShopifyError } from '../src/client.js'
import { createTools } from '../src/index.js'

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function exec() { return { signal: new AbortController().signal } as never }

describe('ShopifyClient', () => {
  it('uses the Shopify Admin GraphQL endpoint and maps a paginated product page', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('x-shopify-access-token')).toBe('shpat_secret')
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> }
      expect(body.query).toContain('products')
      expect(body.query).not.toContain('mutation')
      expect(body.variables).toMatchObject({ first: 2, after: null })
      return response({ data: { products: { edges: [{ cursor: 'cursor-1', node: { id: 'gid://shopify/Product/1', title: 'Widget', handle: 'widget', vendor: 'Acme', productType: 'Gadget', status: 'ACTIVE', totalInventory: 4, updatedAt: '2026-10-08T00:00:00Z', descriptionHtml: '<secret>' } }], pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } } } })
    })
    const client = new ShopifyClient({ storeDomain: 'acme.myshopify.com', accessToken: 'shpat_secret', fetchImpl })
    await expect(client.listProducts({ limit: 2 })).resolves.toEqual({
      items: [{ id: 'gid://shopify/Product/1', title: 'Widget', handle: 'widget', vendor: 'Acme', productType: 'Gadget', status: 'ACTIVE', totalInventory: 4, updatedAt: '2026-10-08T00:00:00Z' }],
      hasMore: true, nextCursor: 'cursor-1', truncated: false,
    })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://acme.myshopify.com/admin/api/2026-01/graphql.json')
  })

  it('masks customer and order PII while preserving operational fields', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ data: { customers: { edges: [{ node: { id: 'gid://shopify/Customer/1', displayName: 'Alice Example', email: 'alice@example.com', phone: '+1 555 0100', state: 'ENABLED', createdAt: '2026-10-08T00:00:00Z' } }], pageInfo: { hasNextPage: false, endCursor: null } } } }))
      .mockResolvedValueOnce(response({ data: { orders: { edges: [{ node: { id: 'gid://shopify/Order/1', name: '#1001', createdAt: '2026-10-08T00:00:00Z', displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED', totalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'USD' } }, customer: { id: 'gid://shopify/Customer/1', displayName: 'Alice Example', email: 'alice@example.com' } } }], pageInfo: { hasNextPage: false, endCursor: null } } } }))
    const client = new ShopifyClient({ storeDomain: 'acme.myshopify.com', accessToken: 'shpat_secret', fetchImpl })
    const customers = await client.listCustomers()
    const orders = await client.listOrders()
    expect(customers.items[0]).toMatchObject({ id: 'gid://shopify/Customer/1', emailMasked: 'a***@example.com', nameMasked: 'A***' })
    expect(orders.items[0]).toMatchObject({ customer: { id: 'gid://shopify/Customer/1', emailMasked: 'a***@example.com', nameMasked: 'A***' }, totalAmount: 10, currency: 'USD' })
    const serialized = JSON.stringify({ customers, orders })
    expect(serialized).not.toContain('alice@example.com')
    expect(serialized).not.toContain('Alice Example')
    expect(serialized).not.toContain('+1 555 0100')
  })

  it('bounds page output even when Shopify returns large strings and many edges', async () => {
    const fetchImpl = vi.fn(async () => response({ data: { collections: { edges: Array.from({ length: 20 }, (_, index) => ({ node: { id: String(index), title: 'x'.repeat(1000), handle: 'handle-' + index, description: 'y'.repeat(1000), productsCount: { count: 1 } } })), pageInfo: { hasNextPage: true, endCursor: 'next' } } } }))
    const client = new ShopifyClient({ storeDomain: 'acme.myshopify.com', accessToken: 'shpat_secret', maxOutputBytes: 2200, fetchImpl })
    const result = await client.listCollections({ limit: 20 })
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(2200)
    expect(result.truncated).toBe(true)
    expect(result.hasMore).toBe(true)
  })

  it('fails closed for invalid store domains and never puts the token in errors', async () => {
    for (const storeDomain of ['evil.example.com', 'https://user:pass@acme.myshopify.com', 'acme.myshopify.com/path', '127.0.0.1']) {
      expect(() => new ShopifyClient({ storeDomain, accessToken: 'shpat_secret' })).toThrow(ShopifyError)
    }
    const fetchImpl = vi.fn(async () => response({ errors: [{ message: 'bad token shpat_secret' }] }, 200))
    const client = new ShopifyClient({ storeDomain: 'acme.myshopify.com', accessToken: 'shpat_secret', fetchImpl })
    await expect(client.getShop()).rejects.toThrow(ShopifyError)
    await expect(client.getShop()).rejects.not.toThrow('shpat_secret')
  })
})

describe('Shopify tools', () => {
  it('registers the seven bounded read-only tools and reports missing credentials safely', async () => {
    const tools = Object.fromEntries(createTools(new ShopifyClient()).map(tool => [tool.name, tool])) as Record<string, any>
    expect(Object.keys(tools).sort()).toEqual(['shopify_auth_test', 'shopify_get_shop', 'shopify_list_collections', 'shopify_list_customers', 'shopify_list_inventory_levels', 'shopify_list_orders', 'shopify_list_products'])
    for (const tool of Object.values(tools)) expect(tool.presentCall!({})).toMatchObject({ card: 'generic', kind: 'read' })
    expect(await tools.shopify_auth_test.execute({}, exec())).toMatchObject({ ok: false, reason: expect.stringContaining('configured') })
    expect(await tools.shopify_list_products.execute({}, exec())).toMatchObject({ found: false, reason: expect.stringContaining('configured') })
  })
})
