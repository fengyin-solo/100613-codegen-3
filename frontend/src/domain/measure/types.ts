/**
 * 掘进工程量计量支付域的公共类型。
 * 与通用台账（EntryRow）分开存：计量支付是带审批/口径版本的工作流，单独建域。
 */

/** 账号方：只有监理方可以签认工程量；项目内部账号只能登记/报送/合约操作。 */
export type Role = 'supervisor' | 'internal'

export interface Account {
  id: string
  name: string
  role: Role
  org: string
}

/** 支付分档：各项目合同各写一套，档名 + 合同支付比例上限。 */
export interface PayTier {
  name: string
  capRatio: number
}

export interface Project {
  code: string
  name: string
  /** 单环控制价（元/环）：报量金额超过「计入环数 × 控制价」的部分核减。 */
  controlPricePerRing: number
  tiers: PayTier[]
}

/**
 * 核定口径（可复用判定，纯函数见 policy.ts）。
 * 每次改口径都追加一条历史版本；已支付单冻结在签付时版本，未支付单按最新版重算。
 */
export interface MeasurePolicy {
  version: string
  publishedAt: string
  publishedBy: string
  /** 可计环状态白名单元数据（真正判定在 policy.ts，文字只用于留档说明）。 */
  payableRingStatuses: string[]
  note: string
}

/** 环次台账条目：按环次区间补登生成，是"这一环到底算不算"的唯一底账。 */
export interface RingLedgerEntry {
  id: number
  projectCode: string
  ringNo: number
  mileage: string
  status: '贯通可计' | '缺环待核实' | '未贯通不计'
  source: string
  /** 首次签认占用该环的确认单 id；占用后再被别的单报量即判重复。 */
  claimedByConfirmationId: number | null
  registeredAt: string
  remark: string
}

export type ConfirmationStatus = '待监理签认' | '监理已签认'

/** 逐环核定结论。 */
export interface RingReview {
  ringNo: number
  reportedShare: number
  result: '核定计入' | '核减：缺环待核实' | '核减：环不满足条件' | '核减：重复报量'
  confirmedAmount: number
  detail: string
}

/** 工程量确认单：现场按环次区间报一笔，监理翻记录核一遍后签认。 */
export interface Confirmation {
  id: number
  code: string
  projectCode: string
  ringFrom: number
  ringTo: number
  crew: string
  /** 关联进度节点编号：计量结论要落到该节点的待办清单。 */
  nodeCode: string
  reportedAmount: number
  status: ConfirmationStatus
  createdBy: string
  createdAt: string
  signedBy: string | null
  signedAt: string | null
  /** 签认时生效的口径版本。 */
  signVersion: string | null
  reviews: RingReview[]
  eligibleRings: number
  controlTotal: number
  confirmedAmount: number
  deductedAmount: number
  capDeduction: number
  remark: string
}

export type PaymentStatus = '待支付' | '已支付' | '超限拦截'

/**
 * 计量支付单：一张确认单最多一张支付单（幂等 upsert）。
 * 本期金额 = 确认工程量 × 支付比例；basisVersion 记录按哪版口径算的。
 */
export interface Payment {
  id: number
  code: string
  confirmationId: number
  projectCode: string
  tierName: string
  payRatio: number
  tierCapRatio: number
  amount: number
  status: PaymentStatus
  basisVersion: string
  basisPublishedAt: string
  generatedBy: string
  generatedAt: string
  paidAt: string | null
  /** 已支付即冻结留档，口径再改也不重算。 */
  archived: boolean
  blockReason: string | null
}

export type TodoKind = 'sign' | 'missing' | 'payment'

/** 进度节点待办：只存引用，金额一律在选择器里从支付单现取，保证两处读到同一份。 */
export interface MeasureTodo {
  id: number
  kind: TodoKind
  nodeCode: string
  title: string
  refCode: string
  confirmationId: number | null
  paymentId: number | null
  ringId: number | null
  done: boolean
  createdAt: string
}

export interface IdempotencyRecord {
  key: string
  resultRef: string
  at: string
}

export interface MeasureState {
  projects: Project[]
  policyHistory: MeasurePolicy[]
  currentVersion: string
  rings: RingLedgerEntry[]
  confirmations: Confirmation[]
  payments: Payment[]
  todos: MeasureTodo[]
  idempotency: IdempotencyRecord[]
  seq: Record<string, number>
}

export interface ServiceResult<T = undefined> {
  ok: boolean
  message: string
  data?: T
}

/** 结算台账行：纯选择器产物，不另存表（另一个入口与支付单读同一份）。 */
export interface LedgerRow {
  payment: Payment
  confirmationCode: string
  projectName: string
  nodeCode: string
  crew: string
  ringFrom: number
  ringTo: number
  confirmedAmount: number
}

/** 进度节点待办的视图模型：本期金额只可能来自支付单。 */
export interface TodoView {
  id: number
  nodeCode: string
  nodeName: string
  kind: TodoKind
  kindLabel: string
  title: string
  refCode: string
  statusText: string
  amount: number | null
  abnormal: boolean
  done: boolean
  createdAt: string
}
