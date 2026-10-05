import { buildSeedState } from './seed'
import type { MeasureState } from './types'

// 计量支付域独立存放（通用台账仍走 local-store.ts），同一浏览器内两边互不干扰。
const STORAGE_KEY = 'shield-tunnel-construction:measure'
const SESSION_KEY = 'shield-tunnel-construction:measure-session'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readState(): MeasureState {
  const fallback = buildSeedState()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MeasureState>
    // 老存档缺集合时按空补齐，不会因为版本升级读到半截数据。
    return {
      ...fallback,
      ...parsed,
      projects: parsed.projects ?? fallback.projects,
      policyHistory: parsed.policyHistory ?? fallback.policyHistory,
      rings: parsed.rings ?? fallback.rings,
      confirmations: parsed.confirmations ?? [],
      payments: parsed.payments ?? [],
      todos: parsed.todos ?? [],
      idempotency: parsed.idempotency ?? [],
      seq: { ...fallback.seq, ...(parsed.seq ?? {}) },
    }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: MeasureState | null = null

export function measureState(): MeasureState {
  if (cache === null) {
    cache = readState()
  }
  return cache
}

/**
 * 事务提交：所有改动先在 draft（深拷贝）上完成，最后只做一次 setItem。
 * localStorage 抛错（配额满/被禁）时保留旧缓存、不写入任何半截状态——入库失败一律不落。
 */
export function commit(mutate: (draft: MeasureState) => void): void {
  const current = measureState()
  const draft = clone(current)
  mutate(draft)
  const serialized = JSON.stringify(draft)
  if (typeof window !== 'undefined' && window.localStorage) {
    // 先写临时键做一次真实落盘探测也可以，但单键语义下直接写即可：
    // 写失败会抛异常，调用方统一回滚，当前缓存仍指向旧值。
    window.localStorage.setItem(STORAGE_KEY, serialized)
  }
  cache = draft
}

/** 重置计量域（演示/回到示例数据用）。 */
export function resetMeasure(): MeasureState {
  const fresh = buildSeedState()
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh))
  }
  cache = fresh
  return fresh
}

export function readSessionAccountId(): string | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  return window.localStorage.getItem(SESSION_KEY)
}

export function writeSessionAccountId(id: string): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(SESSION_KEY, id)
  }
}

export function measureStorageKey(): string {
  return STORAGE_KEY
}
