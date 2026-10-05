import type {
  Account,
  Confirmation,
  MeasurePolicy,
  MeasureState,
  MeasureTodo,
  Payment,
  Project,
  RingLedgerEntry,
} from './types'
import { round2 } from './policy'

/** 可切换账号：监理方两个、项目内部两个。只有监理方能签认工程量。 */
export const SEED_ACCOUNTS: Account[] = [
  { id: 'jl-zhang', name: '张监理', role: 'supervisor', org: '铁建监理一标监理部' },
  { id: 'jl-li', name: '李监理', role: 'supervisor', org: '铁建监理一标监理部' },
  { id: 'xm-wang', name: '王工（项目部）', role: 'internal', org: '中铁隧道一标项目部' },
  { id: 'xm-zhao', name: '赵工（合约部）', role: 'internal', org: '中铁隧道一标合约部' },
]

const PROJECTS: Project[] = [
  {
    code: 'TJ-01',
    name: '地铁一号线 盾构区间TJ-01标',
    controlPricePerRing: 42000,
    tiers: [
      { name: '掘进进度款（第一档）', capRatio: 0.7 },
      { name: '管片拼装款（第二档）', capRatio: 0.85 },
      { name: '竣工结算款（第三档）', capRatio: 0.97 },
    ],
  },
  {
    code: 'TJ-02',
    name: '地铁一号线 盾构区间TJ-02标',
    controlPricePerRing: 45000,
    tiers: [
      { name: '掘进进度款（第一档）', capRatio: 0.65 },
      { name: '管片拼装款（第二档）', capRatio: 0.8 },
      { name: '竣工结算款（第三档）', capRatio: 0.95 },
    ],
  },
]

const POLICY_V1: MeasurePolicy = {
  version: 'v1',
  publishedAt: '2026-09-01',
  publishedBy: '系统初始化',
  payableRingStatuses: ['贯通可计'],
  note: '初始核定口径。',
}

function mileageFor(no: number): string {
  const total = 1000 + no * 1.5
  const km = Math.floor(total / 1000)
  const m = round2(total - km * 1000)
  return `DK${km}+${m.toFixed(1).padStart(5, '0')}`
}

/** 生成环次台账：P1 第1..36环贯通，37、38缺环，39、40未贯通；P2 第1..20环贯通。 */
function seedRings(): RingLedgerEntry[] {
  const rings: RingLedgerEntry[] = []
  let id = 1
  for (let no = 1; no <= 36; no += 1) {
    rings.push({
      id: id++,
      projectCode: 'TJ-01',
      ringNo: no,
      mileage: mileageFor(no),
      status: '贯通可计',
      source: '存量环次区间补登',
      claimedByConfirmationId: null,
      registeredAt: '2026-09-02',
      remark: '',
    })
  }
  for (const no of [37, 38]) {
    rings.push({
      id: id++,
      projectCode: 'TJ-01',
      ringNo: no,
      mileage: mileageFor(no),
      status: '缺环待核实',
      source: '存量环次区间补登（缺号自动占位）',
      claimedByConfirmationId: null,
      registeredAt: '2026-09-02',
      remark: '区间内缺环号，待监理翻记录核实',
    })
  }
  for (const no of [39, 40]) {
    rings.push({
      id: id++,
      projectCode: 'TJ-01',
      ringNo: no,
      mileage: mileageFor(no),
      status: '未贯通不计',
      source: '存量环次区间补登',
      claimedByConfirmationId: null,
      registeredAt: '2026-09-02',
      remark: '',
    })
  }
  for (let no = 1; no <= 20; no += 1) {
    rings.push({
      id: id++,
      projectCode: 'TJ-02',
      ringNo: no,
      mileage: mileageFor(no),
      status: '贯通可计',
      source: '存量环次区间补登',
      claimedByConfirmationId: null,
      registeredAt: '2026-09-04',
      remark: '',
    })
  }
  return rings
}

function reviewsFor(
  from: number,
  to: number,
  statusOf: (no: number) => RingLedgerEntry['status'] | null,
  claimed: (no: number) => Confirmation | null,
  selfId: number | null,
  acceptedTotal: number,
  controlTotal: number,
  projectCode: string,
  firstCode?: string,
) {
  const nos: number[] = []
  for (let n = from; n <= to; n += 1) nos.push(n)
  const eligible = nos.filter((no) => {
    const s = statusOf(no)
    return s === '贯通可计' && !(claimed(no) && claimed(no)!.id !== selfId)
  })
  const per = eligible.length ? acceptedTotal / eligible.length : 0
  let allocated = 0
  const reviews = nos.map((no) => {
    const s = statusOf(no)
    const claim = claimed(no)
    if (!s || s === '缺环待核实') {
      return {
        ringNo: no,
        reportedShare: 0,
        result: '核减：缺环待核实' as const,
        confirmedAmount: 0,
        detail: `第${no}环为缺环占位，监理核实前不计量`,
      }
    }
    if (s !== '贯通可计') {
      return {
        ringNo: no,
        reportedShare: 0,
        result: '核减：环不满足条件' as const,
        confirmedAmount: 0,
        detail: `第${no}环状态「${s}」，不在可计状态白名单`,
      }
    }
    if (claim && claim.id !== selfId) {
      return {
        ringNo: no,
        reportedShare: 0,
        result: '核减：重复报量' as const,
        confirmedAmount: 0,
        detail: `第${no}环已由 ${claim.code}（${claim.crew}）首次签认，重复部分只认第一次`,
      }
    }
    const idx = eligible.indexOf(no)
    const value = idx === eligible.length - 1 ? round2(acceptedTotal - allocated) : round2(per)
    allocated = round2(allocated + value)
    return {
      ringNo: no,
      reportedShare: 0,
      result: '核定计入' as const,
      confirmedAmount: value,
      detail: `第${no}环满足核定条件`,
    }
  })
  return { reviews, eligibleRings: eligible.length, controlTotal, projectCode, firstCode }
}

/**
 * 示例确认单/支付单。金额与环数严格按 v1 口径算，打开即可核对：
 * QRD-0001 1..30 环、报量130万 → 控价126万，核减4万；
 * QRD-0002 31..40 环 → 31..36可计、37/38缺环、39/40未贯通；
 * QRD-0003 1..10 环由另一班组重复报量 → 首签为QRD-0001，全额判重核减；
 * QRD-0004 为 TJ-02 首单。
 */
function seedConfirmationsAndPayments(): {
  confirmations: Confirmation[]
  payments: Payment[]
  todos: MeasureTodo[]
  rings: RingLedgerEntry[]
} {
  const rings = seedRings()
  const statusOf = (projectCode: string) => (no: number) =>
    rings.find((r) => r.projectCode === projectCode && r.ringNo === no)?.status ?? null

  const confirmations: Confirmation[] = []
  const payments: Payment[] = []
  const todos: MeasureTodo[] = []
  let cId = 0
  let pId = 0
  let tId = 0

  // QRD-0001：1..30 已签认
  const q1Id = ++cId
  let r = reviewsFor(1, 30, statusOf('TJ-01'), () => null, q1Id, 1260000, 1260000, 'TJ-01')
  const q1: Confirmation = {
    id: q1Id,
    code: 'QRD-0001',
    projectCode: 'TJ-01',
    ringFrom: 1,
    ringTo: 30,
    crew: '掘进一班',
    nodeCode: 'PROG-0001',
    reportedAmount: 1300000,
    status: '监理已签认',
    createdBy: '王工（项目部）',
    createdAt: '2026-09-20',
    signedBy: '张监理',
    signedAt: '2026-09-22',
    signVersion: 'v1',
    reviews: r.reviews,
    eligibleRings: 30,
    controlTotal: 1260000,
    confirmedAmount: 1260000,
    deductedAmount: 40000,
    capDeduction: 40000,
    remark: '报量高于30环控制价，差额4万核减',
  }
  confirmations.push(q1)

  // QRD-0002：31..40 已签认（37/38缺环、39/40未贯通）
  const q2Id = ++cId
  r = reviewsFor(31, 40, statusOf('TJ-01'), () => null, q2Id, 252000, 252000, 'TJ-01')
  const q2: Confirmation = {
    id: q2Id,
    code: 'QRD-0002',
    projectCode: 'TJ-01',
    ringFrom: 31,
    ringTo: 40,
    crew: '掘进二班',
    nodeCode: 'PROG-0002',
    reportedAmount: 420000,
    status: '监理已签认',
    createdBy: '王工（项目部）',
    createdAt: '2026-09-24',
    signedBy: '张监理',
    signedAt: '2026-09-25',
    signVersion: 'v1',
    reviews: r.reviews,
    eligibleRings: 6,
    controlTotal: 252000,
    confirmedAmount: 252000,
    deductedAmount: 168000,
    capDeduction: 168000,
    remark: '37、38环缺环待核实；39、40环未贯通；仅6环计入',
  }
  confirmations.push(q2)

  // QRD-0003：1..10 掘进三班重复报量，首签 QRD-0001 → 全额判重
  const q3Id = ++cId
  r = reviewsFor(
    1,
    10,
    statusOf('TJ-01'),
    (no) => (q1.ringFrom <= no && no <= q1.ringTo ? q1 : null),
    q3Id,
    0,
    0,
    'TJ-01',
  )
  const q3: Confirmation = {
    id: q3Id,
    code: 'QRD-0003',
    projectCode: 'TJ-01',
    ringFrom: 1,
    ringTo: 10,
    crew: '掘进三班',
    nodeCode: 'PROG-0001',
    reportedAmount: 450000,
    status: '监理已签认',
    createdBy: '王工（项目部）',
    createdAt: '2026-09-25',
    signedBy: '李监理',
    signedAt: '2026-09-26',
    signVersion: 'v1',
    reviews: r.reviews,
    eligibleRings: 0,
    controlTotal: 0,
    confirmedAmount: 0,
    deductedAmount: 450000,
    capDeduction: 0,
    remark: '与QRD-0001同环重复报量，只认第一次签认的量，本单不支付',
  }
  confirmations.push(q3)

  // QRD-0004：TJ-02 1..20 已签认
  const q4Id = ++cId
  r = reviewsFor(1, 20, statusOf('TJ-02'), () => null, q4Id, 900000, 900000, 'TJ-02')
  const q4: Confirmation = {
    id: q4Id,
    code: 'QRD-0004',
    projectCode: 'TJ-02',
    ringFrom: 1,
    ringTo: 20,
    crew: 'TJ-02掘进一班',
    nodeCode: 'PROG-0003',
    reportedAmount: 900000,
    status: '监理已签认',
    createdBy: '赵工（合约部）',
    createdAt: '2026-09-26',
    signedBy: '张监理',
    signedAt: '2026-09-27',
    signVersion: 'v1',
    reviews: r.reviews,
    eligibleRings: 20,
    controlTotal: 900000,
    confirmedAmount: 900000,
    deductedAmount: 0,
    capDeduction: 0,
    remark: '',
  }
  confirmations.push(q4)

  // 占用台账环次（首次签认归属）
  const claim = (c: Confirmation) => {
    rings
      .filter(
        (ring) =>
          ring.projectCode === c.projectCode &&
          ring.ringNo >= c.ringFrom &&
          ring.ringNo <= c.ringTo &&
          ring.status === '贯通可计',
      )
      .forEach((ring) => {
        ring.claimedByConfirmationId = c.id
      })
  }
  claim(q1)
  claim(q2)
  claim(q4)

  // 支付单：Q1 已支付冻结；Q2 待支付；Q3 确认量0无支付单；Q4 待支付
  const p1: Payment = {
    id: ++pId,
    code: 'JLF-0001',
    confirmationId: q1.id,
    projectCode: 'TJ-01',
    tierName: '掘进进度款（第一档）',
    payRatio: 0.7,
    tierCapRatio: 0.7,
    amount: 882000,
    status: '已支付',
    basisVersion: 'v1',
    basisPublishedAt: '2026-09-01',
    generatedBy: '赵工（合约部）',
    generatedAt: '2026-09-23',
    paidAt: '2026-09-30',
    archived: true,
    blockReason: null,
  }
  const p2: Payment = {
    id: ++pId,
    code: 'JLF-0002',
    confirmationId: q2.id,
    projectCode: 'TJ-01',
    tierName: '掘进进度款（第一档）',
    payRatio: 0.7,
    tierCapRatio: 0.7,
    amount: 176400,
    status: '待支付',
    basisVersion: 'v1',
    basisPublishedAt: '2026-09-01',
    generatedBy: '赵工（合约部）',
    generatedAt: '2026-09-26',
    paidAt: null,
    archived: false,
    blockReason: null,
  }
  payments.push(p1, p2)
  // 说明：TJ-02 的 QRD-0004 暂无支付单——按第二档 85% 申报会超 80% 上限，
  // 超档条目按口径"直接拦下、不允许保存"，因此库里本就不该有拦截态的单；
  // 拦截态只会在口径改版、对未支付单重算后出现。

  // QRD-0005：待签认草稿（5..12 与 Q1 重叠 → 签认时会判重，供演示）
  const q5Id = ++cId
  r = reviewsFor(5, 12, () => null, () => null, null, 0, 0, 'TJ-01')
  const q5: Confirmation = {
    id: q5Id,
    code: 'QRD-0005',
    projectCode: 'TJ-01',
    ringFrom: 5,
    ringTo: 12,
    crew: '掘进二班',
    nodeCode: 'PROG-0001',
    reportedAmount: 350000,
    status: '待监理签认',
    createdBy: '王工（项目部）',
    createdAt: '2026-09-29',
    signedBy: null,
    signedAt: null,
    signVersion: null,
    reviews: [],
    eligibleRings: 0,
    controlTotal: 0,
    confirmedAmount: 0,
    deductedAmount: 0,
    capDeduction: 0,
    remark: '签认时按当时口径核定：5..12环已被QRD-0001首签占用，预计全部判重',
  }
  confirmations.push(q5)

  // 待办（金额在选择器里从支付单现取；这里只存引用）
  todos.push({
    id: ++tId,
    kind: 'missing',
    nodeCode: 'PROG-0002',
    title: '第37环缺环待核实',
    refCode: 'RING-TJ01-037',
    confirmationId: null,
    paymentId: null,
    ringId: rings.find((x) => x.projectCode === 'TJ-01' && x.ringNo === 37)!.id,
    done: false,
    createdAt: '2026-09-25',
  })
  todos.push({
    id: ++tId,
    kind: 'missing',
    nodeCode: 'PROG-0002',
    title: '第38环缺环待核实',
    refCode: 'RING-TJ01-038',
    confirmationId: null,
    paymentId: null,
    ringId: rings.find((x) => x.projectCode === 'TJ-01' && x.ringNo === 38)!.id,
    done: false,
    createdAt: '2026-09-25',
  })
  todos.push({
    id: ++tId,
    kind: 'sign',
    nodeCode: 'PROG-0001',
    title: 'QRD-0005 工程量确认单待监理签认',
    refCode: 'QRD-0005',
    confirmationId: q5.id,
    paymentId: null,
    ringId: null,
    done: false,
    createdAt: '2026-09-29',
  })
  todos.push({
    id: ++tId,
    kind: 'payment',
    nodeCode: 'PROG-0002',
    title: 'JLF-0002 计量支付单待支付',
    refCode: 'JLF-0002',
    confirmationId: q2.id,
    paymentId: p2.id,
    ringId: null,
    done: false,
    createdAt: '2026-09-26',
  })
  todos.push({
    id: ++tId,
    kind: 'payment',
    nodeCode: 'PROG-0001',
    title: 'JLF-0001 计量支付单已支付（按v1口径留档）',
    refCode: 'JLF-0001',
    confirmationId: q1.id,
    paymentId: p1.id,
    ringId: null,
    done: true,
    createdAt: '2026-09-23',
  })

  return { confirmations, payments, todos, rings }
}

export function buildSeedState(): MeasureState {
  const { confirmations, payments, todos, rings } = seedConfirmationsAndPayments()
  return {
    projects: PROJECTS,
    policyHistory: [POLICY_V1],
    currentVersion: 'v1',
    rings,
    confirmations,
    payments,
    todos,
    idempotency: [],
    seq: { confirmation: 5, payment: 2, todo: todos.length },
  }
}
