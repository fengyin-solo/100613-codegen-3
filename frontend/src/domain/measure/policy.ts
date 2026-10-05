/**
 * 掘进计量支付的「核定口径」——全部写成无副作用的纯函数，供服务层与页面复用。
 * 改口径时只改这里并发布新版本；判定结果随口径版本号一起留档。
 */
import type {
  Confirmation,
  MeasurePolicy,
  PayTier,
  Project,
  RingLedgerEntry,
  RingReview,
} from './types'

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** 展开闭区间环号。 */
export function expandRingRange(from: number, to: number): number[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from) {
    return []
  }
  const out: number[] = []
  for (let n = from; n <= to; n += 1) out.push(n)
  return out
}

export function ringsInRange(rings: RingLedgerEntry[], projectCode: string, from: number, to: number) {
  return rings.filter((r) => r.projectCode === projectCode && r.ringNo >= from && r.ringNo <= to)
}

/**
 * 逐环核定。顺序固定：缺环/不满足条件先核减，重复报量再核减，剩下才是可计环。
 * @param claimants 环号 -> 已首次签认占用该环的确认单（本单自己占用的不算重复）
 * @param reportShares 本单对每环的报量分摊；合计必须等于报量金额
 */
export interface ReviewInput {
  project: Project
  rings: RingLedgerEntry[]
  from: number
  to: number
  reportedAmount: number
  claimants: Map<number | string, Confirmation>
  selfConfirmationId: number | null
}

export function reviewConfirmation(input: ReviewInput): {
  reviews: RingReview[]
  eligibleRings: number
  controlTotal: number
  confirmedAmount: number
  deductedAmount: number
  capDeduction: number
} {
  const range = expandRingRange(input.from, input.to)
  const byNo = new Map(input.rings.map((r) => [r.ringNo, r]))

  // 先把可计环挑出来；其余每环给一条核减结论。
  const eligible: number[] = []
  const reviews: RingReview[] = range.map((ringNo) => {
    const ring = byNo.get(ringNo)
    if (!ring || ring.status === '缺环待核实') {
      return {
        ringNo,
        reportedShare: 0,
        result: '核减：缺环待核实' as const,
        confirmedAmount: 0,
        detail: ring
          ? `第${ringNo}环为缺环占位，监理核实前不计量`
          : `第${ringNo}环尚未补登，按缺环待核实处理`,
      }
    }
    if (ring.status !== '贯通可计') {
      return {
        ringNo,
        reportedShare: 0,
        result: '核减：环不满足条件' as const,
        confirmedAmount: 0,
        detail: `第${ringNo}环状态「${ring.status}」，不在可计状态白名单`,
      }
    }
    const first = input.claimants.get(`${input.project.code}:${ringNo}`) ?? input.claimants.get(ringNo)
    if (first && first.id !== input.selfConfirmationId) {
      return {
        ringNo,
        reportedShare: 0,
        result: '核减：重复报量' as const,
        confirmedAmount: 0,
        detail: `第${ringNo}环已由 ${first.code}（${first.crew}）首次签认，重复部分只认第一次`,
      }
    }
    eligible.push(ringNo)
    return {
      ringNo,
      reportedShare: 0,
      result: '核定计入' as const,
      confirmedAmount: 0,
      detail: `第${ringNo}环满足核定条件`,
    }
  })

  const eligibleCount = eligible.length
  const controlTotal = round2(eligibleCount * input.project.controlPricePerRing)
  const acceptedReported = round2(Math.min(input.reportedAmount, controlTotal))

  // 把确认金额摊到每个可计环上（按控制价均摊；报量低于控制总额时按报量等比摊）。
  const reportedSharePerRing = range.length > 0 ? round2(input.reportedAmount / range.length) : 0
  reviews.forEach((r) => {
    r.reportedShare = reportedSharePerRing
  })
  if (eligibleCount > 0) {
    const perRing = acceptedReported / eligibleCount
    let allocated = 0
    reviews
      .filter((r) => r.result === '核定计入')
      .forEach((r, idx, arr) => {
        const value = idx === arr.length - 1 ? round2(acceptedReported - allocated) : round2(perRing)
        allocated = round2(allocated + value)
        r.confirmedAmount = value
      })
  }

  const capDeduction = round2(Math.max(0, input.reportedAmount - controlTotal))
  return {
    reviews,
    eligibleRings: eligibleCount,
    controlTotal,
    confirmedAmount: acceptedReported,
    deductedAmount: round2(input.reportedAmount - acceptedReported),
    capDeduction,
  }
}

/**
 * 支付分档校验：比例超出合同上限的条目整笔拦下。
 * 返回通过/拦截以及"超出的是哪一档"。
 */
export interface PayCheck {
  pass: boolean
  tier: PayTier
  excessPoints: number
  reason: string
}

export function checkPayRatio(project: Project, tierName: string, ratio: number): PayCheck {
  const tier = project.tiers.find((t) => t.name === tierName) ?? project.tiers[0]
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return { pass: false, tier, excessPoints: 0, reason: '支付比例必须是大于 0 的数字' }
  }
  if (ratio > tier.capRatio) {
    return {
      pass: false,
      tier,
      excessPoints: round2((ratio - tier.capRatio) * 100),
      reason: `${project.name}「${tier.name}」合同上限 ${round2(tier.capRatio * 100)}%，申报 ${round2(
        ratio * 100,
      )}%，超出上限 ${round2((ratio - tier.capRatio) * 100)} 个点，按口径整笔拦截、不予保存`,
    }
  }
  return { pass: true, tier, excessPoints: 0, reason: '' }
}

export function computePaymentAmount(confirmedAmount: number, ratio: number): number {
  return round2(confirmedAmount * ratio)
}

export function policyAt(history: MeasurePolicy[], version: string): MeasurePolicy {
  return history.find((p) => p.version === version) ?? history[history.length - 1]
}

export const KIND_LABELS: Record<string, string> = {
  sign: '待监理签认',
  missing: '缺环待核实',
  payment: '计量支付',
}

/** 口径文字说明（留档 + 页面展示）。 */
export function describePolicy(p: MeasurePolicy, projects: Project[]): string {
  const tiers = projects
    .flatMap((proj) =>
      proj.tiers.map(
        (t) => `${proj.code} ${t.name}≤${round2(t.capRatio * 100)}%（控价 ${proj.controlPricePerRing} 元/环）`,
      ),
    )
    .join('；')
  return [
    `版本 ${p.version}（${p.publishedAt} 发布）`,
    `可计环状态：${p.payableRingStatuses.join('、')}`,
    `确认金额=min(报量金额, 可计环数×单环控制价)；支付=确认金额×比例；分档上限：${tiers}`,
    `缺环按区间逐环补位、监理核实前不计；重复报量只认首次签认；已支付单按当时口径留档。`,
    p.note ? `修订说明：${p.note}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}
