/** Lumen — метрики узла: блок-тайм, пропускная способность, пиры, память. */
export interface Metrics {
  blockTime: number // среднее время блока, мс
  txThroughput: number // tx/сек
  peerCount: number
  memoryUsage: number // MB heap
  blocksProduced: number
  txsProcessed: number
}

export class MetricsCollector {
  private blocksProduced = 0
  private txsProcessed = 0
  private lastBlockTime = 0
  private startTime = 0
  private peerCount = 0
  private blockTimes: number[] = []
  private readonly maxBlockTimes = 100

  recordBlock(txCount: number) {
    const now = performance.now()
    if (this.startTime === 0) this.startTime = now
    if (this.lastBlockTime > 0) {
      this.blockTimes.push(now - this.lastBlockTime)
      if (this.blockTimes.length > this.maxBlockTimes) {
        this.blockTimes.shift()
      }
    }
    this.lastBlockTime = now
    this.blocksProduced++
    this.txsProcessed += txCount
  }

  setPeerCount(count: number) {
    this.peerCount = count
  }

  snapshot(): Metrics {
    const avgBlockTime = this.blockTimes.length > 0
      ? this.blockTimes.reduce((a: number, b: number) => a + b, 0) / this.blockTimes.length
      : 0
    const elapsedSec = this.startTime > 0 ? (performance.now() - this.startTime) / 1000 : 0
    const txThroughput = elapsedSec > 0 ? this.txsProcessed / elapsedSec : 0

    return {
      blockTime: Number(avgBlockTime.toFixed(2)),
      txThroughput: Number(txThroughput.toFixed(2)),
      peerCount: this.peerCount,
      memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      blocksProduced: this.blocksProduced,
      txsProcessed: this.txsProcessed,
    }
  }

  toJson(): string {
    return JSON.stringify(this.snapshot(), null, 2)
  }
}
