/** Аналитика использования и монетизации. */
export interface UsageRecord {
  ts: number
  method: string
  endpoint: string
  apiKey?: string
  payment: number
  status: number
}

export interface ApiKeyEntry {
  key: string
  createdAt: number
  lastUsed?: number
  requestCount: number
}

export interface UsageSummary {
  totalRequests: number
  revenue: number
  activeApiKeys: number
  topEndpoints: Array<{ endpoint: string; count: number; revenue: number }>
}

export class AnalyticsStore {
  private records: UsageRecord[] = []
  private apiKeys: Map<string, ApiKeyEntry> = new Map()
  private requireApiKeys = false
  private maxRecords = 10_000

  initApiKeys(keys: string[]) {
    this.requireApiKeys = keys.length > 0
    for (const k of keys) this.addApiKey(k)
  }

  addApiKey(key: string) {
    this.apiKeys.set(key, { key, createdAt: Date.now(), requestCount: 0 })
  }

  validateApiKey(key: string): boolean {
    if (!this.requireApiKeys) return true
    return this.apiKeys.has(key)
  }

  touchKey(key: string) {
    const entry = this.apiKeys.get(key)
    if (entry) {
      entry.lastUsed = Date.now()
      entry.requestCount++
    }
  }

  record(r: Omit<UsageRecord, "ts">) {
    this.records.push({ ...r, ts: Date.now() })
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords)
    }
  }

  get activeKeys(): number {
    return this.apiKeys.size
  }

  totalRevenue(): number {
    return this.records.reduce((sum, r) => sum + r.payment, 0)
  }

  totalRequests(): number {
    return this.records.length
  }

  topEndpoints(limit = 10): Array<{ endpoint: string; count: number; revenue: number }> {
    const map = new Map<string, { count: number; revenue: number }>()
    for (const r of this.records) {
      const cur = map.get(r.endpoint) ?? { count: 0, revenue: 0 }
      cur.count++
      cur.revenue += r.payment
      map.set(r.endpoint, cur)
    }
    return [...map.entries()]
      .map(([endpoint, v]) => ({ endpoint, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
  }

  getUsageSummary(): UsageSummary {
    return {
      totalRequests: this.totalRequests(),
      revenue: this.totalRevenue(),
      activeApiKeys: this.activeKeys,
      topEndpoints: this.topEndpoints(),
    }
  }

  get recordsSnapshot(): UsageRecord[] {
    return [...this.records]
  }
}
