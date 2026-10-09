import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ShopifyClient, ShopifyError, type ShopifyClientOptions } from './client.js'

export { ShopifyClient, ShopifyError }
export type { ShopifyClientOptions, ShopifyCollectionInfo, ShopifyCustomerInfo, ShopifyInventoryLevelInfo, ShopifyOrderInfo, ShopifyPage, ShopifyProductInfo, ShopifyShopInfo } from './client.js'
export const name = 'dsh-tool-shopify'
export const inject = ['tools']
export interface ShopifyPluginConfig extends ShopifyClientOptions {}

function text(value: string) { return [{ type: 'text' as const, text: value }] }
function unavailable(reason: string) { return { found: false, reason } }
function readKind(title: string): ToolCallView { return { card: 'generic', title, kind: 'read' } }
function safeFailure(error: unknown): { found: false; reason: string } {
  return { found: false, reason: error instanceof Error ? error.message.slice(0, 240) : 'Shopify request failed.' }
}
function pageText(value: { hasMore?: boolean; nextCursor?: string; truncated?: boolean }) {
  return 'hasMore=' + Boolean(value.hasMore) + (value.nextCursor ? ' nextCursor=' + value.nextCursor : '') + (value.truncated ? ' truncated=true' : '')
}
function boundedText(value: string) { return text(value.slice(0, 12_000) + (value.length > 12_000 ? '\n(output clipped)' : '')) }
function renderPage(value: any, lines: (item: any) => string[]) {
  if (!value.found) return text(value.reason ?? 'Shopify is not configured.')
  const body = (value.items ?? []).map((item: any) => lines(item).filter(Boolean).join(' ')).join('\n')
  return boundedText(body + (body ? '\n' : '') + pageText(value))
}

const basePageProperties = {
  found: { type: 'boolean' }, reason: { type: 'string' },
  hasMore: { type: 'boolean' }, nextCursor: { type: 'string' }, truncated: { type: 'boolean' },
}
function pageOutput(itemProperties: Record<string, unknown>, render: (_args: any, value: any) => ReturnType<typeof text>) {
  return {
    schema: { type: 'object', additionalProperties: false, properties: { ...basePageProperties, items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: itemProperties } } } } as any,
    render,
  }
}

export function createTools(client: ShopifyClient) {
  return [
    defineTool({
      name: 'shopify_auth_test',
      description: 'Verify Shopify Admin API credentials and return safe shop metadata. No token is returned.',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' }, myshopifyDomain: { type: 'string' }, primaryDomain: { type: 'string' }, currencyCode: { type: 'string' }, planName: { type: 'string' } } } as const, render: (_args, value) => value.ok ? text('Shopify auth ok: ' + value.name + ' (' + value.myshopifyDomain + ')') : text('Shopify auth failed: ' + value.reason) },
      presentCall(): ToolCallView { return readKind('Verify Shopify store credentials') },
      async execute(_args, exec) {
        if (!client.hasCredentials()) return { ok: false, reason: 'Shopify store domain and access token are not configured.' }
        try { return { ok: true, ...await client.authTest(exec.signal) } } catch (error) { return { ok: false, reason: safeFailure(error).reason } }
      },
    }),
    defineTool({
      name: 'shopify_get_shop', description: 'Get bounded, non-sensitive Shopify shop metadata.', parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean' }, reason: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' }, myshopifyDomain: { type: 'string' }, primaryDomain: { type: 'string' }, currencyCode: { type: 'string' }, planName: { type: 'string' } } } as const, render: (_args, value) => value.found ? text(value.name + ' (' + value.myshopifyDomain + ') currency=' + value.currencyCode) : text(value.reason ?? 'Shopify is not configured.') },
      presentCall(): ToolCallView { return readKind('Get Shopify shop metadata') },
      async execute(_args, exec) { if (!client.hasCredentials()) return unavailable('Shopify store domain and access token are not configured.'); try { return { found: true, ...await client.getShop(exec.signal) } } catch (error) { return safeFailure(error) } },
    }),
    defineTool({
      name: 'shopify_list_products', description: 'List Shopify products with bounded cursor pagination. Descriptions, metafields, and media are omitted.',
      parameters: { query: { type: 'string', description: 'Optional Shopify product search query.' }, limit: { type: 'integer', description: 'Results, 1-50.' }, after: { type: 'string', description: 'Opaque cursor from a previous page.' } },
      output: pageOutput({ id: { type: 'string' }, title: { type: 'string' }, handle: { type: 'string' }, vendor: { type: 'string' }, productType: { type: 'string' }, status: { type: 'string' }, totalInventory: { type: 'integer' }, updatedAt: { type: 'string' } }, (_args, value) => renderPage(value, item => [item.id, item.title, item.status, 'inventory=' + item.totalInventory])),
      presentCall(): ToolCallView { return readKind('List Shopify products') },
      async execute(args, exec) { if (!client.hasCredentials()) return unavailable('Shopify store domain and access token are not configured.'); try { return { found: true, ...await client.listProducts({ query: args.query, limit: args.limit, after: args.after, signal: exec.signal }) } } catch (error) { return safeFailure(error) } },
    }),
    defineTool({
      name: 'shopify_list_orders', description: 'List Shopify orders with bounded cursor pagination and masked customer identity. Addresses, notes, and line-item details are omitted.',
      parameters: { query: { type: 'string', description: 'Optional Shopify order search query.' }, limit: { type: 'integer', description: 'Results, 1-50.' }, after: { type: 'string', description: 'Opaque cursor from a previous page.' } },
      output: pageOutput({ id: { type: 'string' }, name: { type: 'string' }, createdAt: { type: 'string' }, financialStatus: { type: 'string' }, fulfillmentStatus: { type: 'string' }, totalAmount: { type: 'number' }, currency: { type: 'string' }, customer: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, emailMasked: { type: 'string' }, nameMasked: { type: 'string' } } } }, (_args, value) => renderPage(value, item => [item.id, item.name, item.financialStatus, item.fulfillmentStatus, String(item.totalAmount) + ' ' + item.currency])),
      presentCall(): ToolCallView { return readKind('List Shopify orders') },
      async execute(args, exec) { if (!client.hasCredentials()) return unavailable('Shopify store domain and access token are not configured.'); try { return { found: true, ...await client.listOrders({ query: args.query, limit: args.limit, after: args.after, signal: exec.signal }) } } catch (error) { return safeFailure(error) } },
    }),
    defineTool({
      name: 'shopify_list_customers', description: 'List Shopify customers with cursor pagination and masked email/name fields. Phone, address, tags, and notes are omitted.',
      parameters: { query: { type: 'string', description: 'Optional Shopify customer search query.' }, limit: { type: 'integer', description: 'Results, 1-50.' }, after: { type: 'string', description: 'Opaque cursor from a previous page.' } },
      output: pageOutput({ id: { type: 'string' }, emailMasked: { type: 'string' }, nameMasked: { type: 'string' }, state: { type: 'string' }, createdAt: { type: 'string' } }, (_args, value) => renderPage(value, item => [item.id, item.nameMasked, item.emailMasked, item.state])),
      presentCall(): ToolCallView { return readKind('List Shopify customers') },
      async execute(args, exec) { if (!client.hasCredentials()) return unavailable('Shopify store domain and access token are not configured.'); try { return { found: true, ...await client.listCustomers({ query: args.query, limit: args.limit, after: args.after, signal: exec.signal }) } } catch (error) { return safeFailure(error) } },
    }),
    defineTool({
      name: 'shopify_list_inventory_levels', description: 'List Shopify inventory levels for all locations or one location with bounded pagination. Only SKU and available quantity are returned.',
      parameters: { locationId: { type: 'string', description: 'Optional Shopify location ID.' }, limit: { type: 'integer', description: 'Results, 1-50.' }, after: { type: 'string', description: 'Opaque cursor from a previous page.' } },
      output: pageOutput({ id: { type: 'string' }, locationId: { type: 'string' }, locationName: { type: 'string' }, inventoryItemId: { type: 'string' }, sku: { type: 'string' }, available: { type: 'integer' } }, (_args, value) => renderPage(value, item => [item.locationName, item.sku, 'available=' + item.available])),
      presentCall(): ToolCallView { return readKind('List Shopify inventory levels') },
      async execute(args, exec) { if (!client.hasCredentials()) return unavailable('Shopify store domain and access token are not configured.'); try { return { found: true, ...await client.listInventoryLevels({ locationId: args.locationId, limit: args.limit, after: args.after, signal: exec.signal }) } } catch (error) { return safeFailure(error) } },
    }),
    defineTool({
      name: 'shopify_list_collections', description: 'List Shopify collections with bounded cursor pagination. HTML, metafields, and rule details are omitted.',
      parameters: { query: { type: 'string', description: 'Optional Shopify collection search query.' }, limit: { type: 'integer', description: 'Results, 1-50.' }, after: { type: 'string', description: 'Opaque cursor from a previous page.' } },
      output: pageOutput({ id: { type: 'string' }, title: { type: 'string' }, handle: { type: 'string' }, description: { type: 'string' }, productCount: { type: 'integer' } }, (_args, value) => renderPage(value, item => [item.id, item.title, 'products=' + item.productCount])),
      presentCall(): ToolCallView { return readKind('List Shopify collections') },
      async execute(args, exec) { if (!client.hasCredentials()) return unavailable('Shopify store domain and access token are not configured.'); try { return { found: true, ...await client.listCollections({ query: args.query, limit: args.limit, after: args.after, signal: exec.signal }) } } catch (error) { return safeFailure(error) } },
    }),
  ]
}

export function apply(ctx: Context, config: ShopifyPluginConfig = {}): void {
  const client = new ShopifyClient(config)
  for (const tool of createTools(client)) ctx.tools.register(tool)
}
