/** Small, fixed-query Shopify Admin GraphQL client.
 *
 * The client intentionally has no escape hatch for arbitrary GraphQL or
 * mutations. Every request is one of the read-only queries below, and every
 * response is mapped to an allowlisted shape before it leaves this module.
 */

export interface ShopifyClientOptions {
  storeDomain?: string
  accessToken?: string
  apiVersion?: string
  timeoutMs?: number
  maxOutputBytes?: number
  fetchImpl?: typeof fetch
}

export interface ShopifyPage<T> {
  items: T[]
  hasMore: boolean
  nextCursor: string
  truncated: boolean
}

export interface ShopifyShopInfo {
  id: string
  name: string
  myshopifyDomain: string
  primaryDomain: string
  currencyCode: string
  planName: string
}

export interface ShopifyProductInfo {
  id: string
  title: string
  handle: string
  vendor: string
  productType: string
  status: string
  totalInventory: number
  updatedAt: string
}

export interface ShopifyCustomerInfo {
  id: string
  emailMasked: string
  nameMasked: string
  state: string
  createdAt: string
}

export interface ShopifyOrderInfo {
  id: string
  name: string
  createdAt: string
  financialStatus: string
  fulfillmentStatus: string
  totalAmount: number
  currency: string
  customer: { id: string; emailMasked: string; nameMasked: string } | null
}

export interface ShopifyInventoryLevelInfo {
  id: string
  locationId: string
  locationName: string
  inventoryItemId: string
  sku: string
  available: number
}

export interface ShopifyCollectionInfo {
  id: string
  title: string
  handle: string
  description: string
  productCount: number
}

export class ShopifyError extends Error {
  constructor(message: string, public readonly status = 0) {
    super(message)
    this.name = 'ShopifyError'
  }
}

const DEFAULT_API_VERSION = '2026-01'
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
const MIN_MAX_OUTPUT_BYTES = 1024
const MAX_MAX_OUTPUT_BYTES = 256 * 1024

const SHOP_QUERY = `query ShopifyShop { shop { id name myshopifyDomain primaryDomain { host } currencyCode plan { displayName } } }`
const PRODUCTS_QUERY = `query ShopifyProducts($first: Int!, $after: String, $query: String) {
  products(first: $first, after: $after, query: $query) {
    edges { cursor node { id title handle vendor productType status totalInventory updatedAt } }
    pageInfo { hasNextPage endCursor }
  }
}`
const ORDERS_QUERY = `query ShopifyOrders($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query) {
    edges { cursor node {
      id name createdAt displayFinancialStatus displayFulfillmentStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      customer { id displayName email }
    } }
    pageInfo { hasNextPage endCursor }
  }
}`
const CUSTOMERS_QUERY = `query ShopifyCustomers($first: Int!, $after: String, $query: String) {
  customers(first: $first, after: $after, query: $query) {
    edges { cursor node { id displayName email state createdAt } }
    pageInfo { hasNextPage endCursor }
  }
}`
const COLLECTIONS_QUERY = `query ShopifyCollections($first: Int!, $after: String, $query: String) {
  collections(first: $first, after: $after, query: $query) {
    edges { cursor node { id title handle description productsCount { count } } }
    pageInfo { hasNextPage endCursor }
  }
}`
const LOCATIONS_QUERY = `query ShopifyInventoryLocations($first: Int!, $after: String) {
  locations(first: $first, after: $after) {
    edges { node {
      id name
      inventoryLevels(first: 50) {
        edges { node { id item { id sku } quantities(names: ["available"]) { name quantity } } }
        pageInfo { hasNextPage }
      }
    } }
    pageInfo { hasNextPage endCursor }
  }
}`
const LOCATION_INVENTORY_QUERY = `query ShopifyLocationInventory($id: ID!, $first: Int!, $after: String) {
  location(id: $id) {
    id name
    inventoryLevels(first: $first, after: $after) {
      edges { node { id item { id sku } quantities(names: ["available"]) { name quantity } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
}

function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function stringValue(value: unknown): string { return typeof value === 'string' ? value : value == null ? '' : String(value) }
function numberValue(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : Number(value ?? 0) || 0 }
function booleanValue(value: unknown): boolean { return value === true }
function clip(value: unknown, max: number): string { return stringValue(value).slice(0, max) }
function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value as number))) : fallback
}

function normalizeStoreDomain(value: string | undefined): string {
  if (!value) return ''
  if (typeof value !== 'string' || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) throw new ShopifyError('Shopify store domain is invalid.', 400)
  let host = value
  if (value.includes('://')) {
    let parsed: URL
    try { parsed = new URL(value) } catch { throw new ShopifyError('Shopify store domain is invalid.', 400) }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) throw new ShopifyError('Shopify store domain is invalid.', 400)
    host = parsed.hostname
  } else if (value.includes('/') || value.includes('?') || value.includes('#') || value.includes('@') || value.includes(':')) {
    throw new ShopifyError('Shopify store domain is invalid.', 400)
  }
  host = host.toLowerCase().replace(/\.$/, '')
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/.test(host)) throw new ShopifyError('Shopify store domain is invalid.', 400)
  return host
}

function maskEmail(value: unknown): string {
  const email = stringValue(value).trim()
  const at = email.indexOf('@')
  if (at <= 0 || at === email.length - 1) return email ? '***' : ''
  return email[0] + '***@' + email.slice(at + 1, at + 65)
}

function maskName(value: unknown): string {
  const name = stringValue(value).trim()
  return name ? name[0] + '***' : ''
}

function pageInfo(value: unknown): { hasMore: boolean; nextCursor: string } {
  const info = record(value)
  return { hasMore: booleanValue(info.hasNextPage), nextCursor: clip(info.endCursor, 256) }
}

function bytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') } catch { return Number.MAX_SAFE_INTEGER }
}

function boundPage<T>(items: T[], hasMore: boolean, nextCursor: string, maxOutputBytes: number): ShopifyPage<T> {
  let count = items.length
  let result: ShopifyPage<T> = { items: items.slice(), hasMore, nextCursor, truncated: false }
  while (count > 0 && bytes(result) > maxOutputBytes) {
    count -= 1
    result = { items: items.slice(0, count), hasMore, nextCursor, truncated: true }
  }
  if (bytes(result) > maxOutputBytes) return { items: [], hasMore, nextCursor: clip(nextCursor, 64), truncated: true }
  return result
}

function mapShop(value: unknown): ShopifyShopInfo {
  const shop = record(value)
  return {
    id: clip(shop.id, 256), name: clip(shop.name, 160), myshopifyDomain: clip(shop.myshopifyDomain, 160),
    primaryDomain: clip(record(shop.primaryDomain).host, 160), currencyCode: clip(shop.currencyCode, 16), planName: clip(record(shop.plan).displayName, 80),
  }
}

function mapProduct(value: unknown): ShopifyProductInfo {
  const product = record(value)
  return { id: clip(product.id, 256), title: clip(product.title, 200), handle: clip(product.handle, 200), vendor: clip(product.vendor, 160), productType: clip(product.productType, 160), status: clip(product.status, 40), totalInventory: numberValue(product.totalInventory), updatedAt: clip(product.updatedAt, 64) }
}

function mapCustomer(value: unknown): ShopifyCustomerInfo {
  const customer = record(value)
  return { id: clip(customer.id, 256), emailMasked: maskEmail(customer.email), nameMasked: maskName(customer.displayName), state: clip(customer.state, 40), createdAt: clip(customer.createdAt, 64) }
}

function mapOrder(value: unknown): ShopifyOrderInfo {
  const order = record(value)
  const money = record(record(order.totalPriceSet).shopMoney)
  const customer = order.customer == null ? null : record(order.customer)
  return {
    id: clip(order.id, 256), name: clip(order.name, 80), createdAt: clip(order.createdAt, 64), financialStatus: clip(order.displayFinancialStatus, 40), fulfillmentStatus: clip(order.displayFulfillmentStatus, 40),
    totalAmount: numberValue(money.amount), currency: clip(money.currencyCode, 16),
    customer: customer ? { id: clip(customer.id, 256), emailMasked: maskEmail(customer.email), nameMasked: maskName(customer.displayName) } : null,
  }
}

function mapCollection(value: unknown): ShopifyCollectionInfo {
  const collection = record(value)
  return { id: clip(collection.id, 256), title: clip(collection.title, 200), handle: clip(collection.handle, 200), description: clip(collection.description, 400), productCount: numberValue(record(collection.productsCount).count) }
}

function mapInventory(value: unknown, locationId: string, locationName: string): ShopifyInventoryLevelInfo {
  const level = record(value)
  const item = record(level.item)
  const available = array(level.quantities).find(entry => stringValue(record(entry).name) === 'available')
  return { id: clip(level.id, 256), locationId: clip(locationId, 256), locationName: clip(locationName, 160), inventoryItemId: clip(item.id, 256), sku: clip(item.sku, 160), available: numberValue(record(available).quantity) }
}

export class ShopifyClient {
  private readonly storeDomain: string
  private readonly accessToken: string
  private readonly apiVersion: string
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number
  private readonly fetchImpl: typeof fetch

  constructor(options: ShopifyClientOptions = {}) {
    this.storeDomain = normalizeStoreDomain(options.storeDomain)
    this.accessToken = typeof options.accessToken === 'string' ? options.accessToken : ''
    this.apiVersion = options.apiVersion ?? DEFAULT_API_VERSION
    if (!/^\d{4}-\d{2}$/.test(this.apiVersion)) throw new ShopifyError('Shopify API version is invalid.', 400)
    this.timeoutMs = options.timeoutMs ?? 15_000
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new ShopifyError('Shopify timeoutMs must be a positive finite number.', 400)
    this.maxOutputBytes = clamp(options.maxOutputBytes, MIN_MAX_OUTPUT_BYTES, MAX_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES)
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  hasCredentials(): boolean { return this.storeDomain.length > 0 && this.accessToken.length > 0 }
  getOutputLimit(): number { return this.maxOutputBytes }

  async authTest(signal?: AbortSignal): Promise<ShopifyShopInfo> { return this.getShop(signal) }

  async getShop(signal?: AbortSignal): Promise<ShopifyShopInfo> {
    const data = await this.request<{ shop: unknown }>(SHOP_QUERY, {}, signal)
    return mapShop(data.shop)
  }

  async listProducts(options: { query?: string; limit?: number; after?: string; signal?: AbortSignal } = {}): Promise<ShopifyPage<ShopifyProductInfo>> {
    const raw = await this.request<{ products: unknown }>(PRODUCTS_QUERY, this.connectionVariables(options), options.signal)
    const connection = record(raw.products)
    const page = pageInfo(connection.pageInfo)
    return boundPage(array(connection.edges).map(edge => mapProduct(record(edge).node)), page.hasMore, page.nextCursor, this.maxOutputBytes)
  }

  async listOrders(options: { query?: string; limit?: number; after?: string; signal?: AbortSignal } = {}): Promise<ShopifyPage<ShopifyOrderInfo>> {
    const raw = await this.request<{ orders: unknown }>(ORDERS_QUERY, this.connectionVariables(options), options.signal)
    const connection = record(raw.orders)
    const page = pageInfo(connection.pageInfo)
    return boundPage(array(connection.edges).map(edge => mapOrder(record(edge).node)), page.hasMore, page.nextCursor, this.maxOutputBytes)
  }

  async listCustomers(options: { query?: string; limit?: number; after?: string; signal?: AbortSignal } = {}): Promise<ShopifyPage<ShopifyCustomerInfo>> {
    const raw = await this.request<{ customers: unknown }>(CUSTOMERS_QUERY, this.connectionVariables(options), options.signal)
    const connection = record(raw.customers)
    const page = pageInfo(connection.pageInfo)
    return boundPage(array(connection.edges).map(edge => mapCustomer(record(edge).node)), page.hasMore, page.nextCursor, this.maxOutputBytes)
  }

  async listCollections(options: { query?: string; limit?: number; after?: string; signal?: AbortSignal } = {}): Promise<ShopifyPage<ShopifyCollectionInfo>> {
    const raw = await this.request<{ collections: unknown }>(COLLECTIONS_QUERY, this.connectionVariables(options), options.signal)
    const connection = record(raw.collections)
    const page = pageInfo(connection.pageInfo)
    return boundPage(array(connection.edges).map(edge => mapCollection(record(edge).node)), page.hasMore, page.nextCursor, this.maxOutputBytes)
  }

  async listInventoryLevels(options: { locationId?: string; limit?: number; after?: string; signal?: AbortSignal } = {}): Promise<ShopifyPage<ShopifyInventoryLevelInfo>> {
    const first = clamp(options.limit, 1, 50, 20)
    if (options.locationId) {
      const raw = await this.request<{ location: unknown }>(LOCATION_INVENTORY_QUERY, { id: clip(options.locationId, 256), first, after: options.after ?? null }, options.signal)
      const location = record(raw.location)
      const levels = record(location.inventoryLevels)
      const page = pageInfo(levels.pageInfo)
      return boundPage(array(levels.edges).map(edge => mapInventory(record(edge).node, stringValue(location.id), stringValue(location.name))), page.hasMore, page.nextCursor, this.maxOutputBytes)
    }
    const raw = await this.request<{ locations: unknown }>(LOCATIONS_QUERY, { first, after: options.after ?? null }, options.signal)
    const locations = record(raw.locations)
    const outerPage = pageInfo(locations.pageInfo)
    const items: ShopifyInventoryLevelInfo[] = []
    let nestedHasMore = false
    for (const edge of array(locations.edges)) {
      const location = record(record(edge).node)
      const levels = record(location.inventoryLevels)
      const levelPage = pageInfo(levels.pageInfo)
      nestedHasMore ||= levelPage.hasMore
      for (const level of array(levels.edges)) items.push(mapInventory(record(level).node, stringValue(location.id), stringValue(location.name)))
    }
    return boundPage(items, outerPage.hasMore || nestedHasMore, outerPage.nextCursor, this.maxOutputBytes)
  }

  private connectionVariables(options: { query?: string; limit?: number; after?: string }): Record<string, unknown> {
    return { first: clamp(options.limit, 1, 50, 20), after: options.after ?? null, query: options.query ? clip(options.query, 200) : null }
  }

  private async request<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (!this.hasCredentials()) throw new ShopifyError('Shopify store domain and access token are not configured.', 0)
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    if (signal) { if (signal.aborted) controller.abort(signal.reason); else signal.addEventListener('abort', onAbort, { once: true }) }
    const timer = setTimeout(() => controller.abort(new Error('Shopify request timed out.')), this.timeoutMs)
    try {
      const url = 'https://' + this.storeDomain + '/admin/api/' + this.apiVersion + '/graphql.json'
      let response: Response
      try {
        response = await this.fetchImpl(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'x-shopify-access-token': this.accessToken }, body: JSON.stringify({ query, variables }), signal: controller.signal })
      } catch (error) {
        throw new ShopifyError(error instanceof Error ? clip(error.message.replace(this.accessToken, '[redacted]'), 240) : 'Shopify request failed.', 0)
      }
      let body: unknown
      try { body = await response.json() } catch { body = undefined }
      if (!response.ok) throw new ShopifyError('Shopify API request failed with status ' + response.status + '.', response.status)
      const envelope = record(body)
      const errors = array(envelope.errors)
      if (errors.length) {
        const message = clip(record(errors[0]).message, 240).replace(this.accessToken, '[redacted]')
        throw new ShopifyError(message ? 'Shopify GraphQL request failed: ' + message : 'Shopify GraphQL request failed.', response.status)
      }
      return record(envelope.data) as T
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }
}
