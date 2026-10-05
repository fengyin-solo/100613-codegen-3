/**
 * 掘进计量支付服务层：所有业务判定集中在此，页面只渲染。
 * 关键约束：
 * - 只有监理方账号能签认工程量；项目内部账号的签认操作一律驳回。
 * - 支付比例超合同分档上限：整笔拦截、不落库，并说明超出的是哪一档、几个点。
 * - 一张确认单只对应一张支付单（幂等 upsert），再交一遍不翻倍。
 * - 口径改版：未支付单按新版重算；已支付单冻结在当版，原样留档。
 * - 待办与结算台账读的是同一批支付单，本期金额只有一份。
 */
import { listRows } from '@/data/local-store'
import { commit, measureState } from './measure-store'
import {
  KIND_LABELS,
  checkPayRatio,
  computePaymentAmount,
  expandRingRange,
  policyAt,
  reviewConfirmation,
  round2,
  today,
} from './policy'
import { SEED_ACCOUNTS } from './seed'
import type {
  Account,
  Confirmation,
  LedgerRow,
  MeasurePolicy,
  MeasureTodo,
  Payment,
  Project,
  RingLedgerEntry,
  ServiceResult,
  TodoKind,
  TodoView,
} from './types'

// ---------- 账号 / 会话 ----------

export function listAccounts(): Account[] {
  return SEED_ACCOUNTS
}

export function accountById(id: string): Account {
  const acc = SEED_ACCOUNTS.find((a) => a.id === id)
  if (!acc) return { id, name: '未知账号', role: 'internal', org: '' }
  return acc
}

function requireSupervisor(acc: Account, action: string) {
  if (acc.role !== 'supervisor') {
    return {
      ok: false as const,
      message: `「${acc.name}」是项目内部账号（${acc.org}），无权${action}——工程量只能由监理方账号签认，操作已驳回`,
    }
  }
  return { ok: true as const, message: '' }
}

function requireInternal(acc: Account, action: string) {
  if (acc.role !== 'internal') {
    return {
      ok: false as const,
      message: `「${acc.name}」是监理方账号，${action}由项目内部（合约）办理，操作已驳回`,
    }
  }
  return { ok: true as const, message: '' }
}

// ---------- 基础读取 ----------

export function listProjects(): Project[] {
  return measureState().projects
}

export function projectByCode(code: string): Project | undefined {
  return measureState().projects.find((p) => p.code === code)
}

export function currentPolicy(): MeasurePolicy {
  const s = measureState()
  return policyAt(s.policyHistory, s.currentVersion)
}

export function policyHistory(): MeasurePolicy[] {
  return [...measureState().policyHistory].reverse()
}

export function listRings(projectCode?: string): RingLedgerEntry[] {
  const rows = measureState().rings
  return projectCode ? rows.filter((r) => r.projectCode === projectCode) : rows
}

export function listConfirmations(): Confirmation[] {
  return [...measureState().confirmations].sort((a, b) => b.id - a.id)
}

export function listPayments(): Payment[] {
  return [...measureState().payments].sort((a, b) => b.id - a.id)
}

// ---------- 工具 ----------

function pad(n: number): string {
  return String(n).padStart(4, '0')
}

export function fmtMoney(n: number): string {
  return `${round2(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 元`
}

export function fmtPct(ratio: number): string {
  return `${round2(ratio * 100)}%`
}

/** 进度节点名取自进度节点模块，两边用同一个节点编号对齐。 */
function nodeNameMap(): Map<string, string> {
  const map = new Map<string, string>()
  for (const row of listRows('progress')) {
    map.set(String(row['节点编号'] ?? ''), String(row['节点名称'] ?? ''))
  }
  return map
}

function mileageFor(no: number, startMileage: number): string {
  const total = startMileage + (no - 1) * 1.5
  const km = Math.floor(total / 1000)
  const m = round2(total - km * 1000)
  return `DK${km}+${m.toFixed(1).padStart(5, '0')}`
}

function addTodo(
  draft: ReturnType<typeof measureState>,
  kind: TodoKind,
  nodeCode: string,
  title: string,
  refCode: string,
  refs: { confirmationId?: number | null; paymentId?: number | null; ringId?: number | null },
): void {
  draft.seq.todo = (draft.seq.todo ?? 0) + 1
  const todo: MeasureTodo = {
    id: draft.seq.todo,
    kind,
    nodeCode,
    title,
    refCode,
    confirmationId: refs.confirmationId ?? null,
    paymentId: refs.paymentId ?? null,
    ringId: refs.ringId ?? null,
    done: false,
    createdAt: today(),
  }
  draft.todos.push(todo)
}

// ---------- 环次台账 / 存量补登 ----------

export interface BackfillInput {
  projectCode: string
  from: number
  to: number
  /** 区间内已知缺号（逗号分隔或数组）：建成「缺环待核实」占位环。 */
  missingRings: number[]
  defaultStatus: '贯通可计' | '未贯通不计'
  startMileage: number
  source: string
}

/**
 * 存量工程量按环次区间补登。
 * 规则：区间整数逐环展开；已登记的环一律不覆盖（再交一遍不翻倍）；
 * 申报的缺号建成「缺环待核实」占位环并挂待办，监理核实前不计量；其余按所选状态补登。
 */
export function backfillRings(input: BackfillInput, acc: Account): ServiceResult<{
  created: number
  missing: number
  skipped: number
}> {
  const project = projectByCode(input.projectCode)
  if (!project) return { ok: false, message: `项目 ${input.projectCode} 不存在` }
  const range = expandRingRange(input.from, input.to)
  if (range.length === 0) return { ok: false, message: '环次区间非法：起环、止环须为正整数且止环不小于起环' }

  const missingSet = new Set(input.missingRings.filter((n) => range.includes(n)))
  const idemKey = `backfill:${input.projectCode}:${input.from}-${input.to}:${[...missingSet].sort().join(',') || 'none'}`
  const s = measureState()
  if (s.idempotency.some((r) => r.key === idemKey)) {
    return {
      ok: false,
      message: '同一区间、同一缺环清单已经补登过一次，为避免翻倍本次不再落库',
    }
  }

  let created = 0
  let missing = 0
  let skipped = 0
  try {
    commit((draft) => {
      for (const no of range) {
        if (draft.rings.some((r) => r.projectCode === input.projectCode && r.ringNo === no)) {
          skipped += 1
          continue
        }
        const isMissing = missingSet.has(no)
        const ring: RingLedgerEntry = {
          id: draft.rings.length + 1,
          projectCode: input.projectCode,
          ringNo: no,
          mileage: mileageFor(no, input.startMileage),
          status: isMissing ? '缺环待核实' : input.defaultStatus,
          source: input.source || '存量环次区间补登',
          claimedByConfirmationId: null,
          registeredAt: today(),
          remark: isMissing ? '补登时申报的缺环号，待监理翻记录核实' : '',
        }
        draft.rings.push(ring)
        created += 1
        if (isMissing) {
          missing += 1
          addTodo(
            draft,
            'missing',
            nodeCodeForRange(draft, input.projectCode, no),
            `第${no}环缺环待核实`,
            `RING-${input.projectCode}-${pad(no)}`,
            { ringId: ring.id },
          )
        }
      }
      draft.idempotency.push({ key: idemKey, resultRef: `${created}新建/${skipped}跳过`, at: today() })
    })
  } catch {
    return { ok: false, message: '补登写入失败（浏览器存储不可用或已满），整批未入库' }
  }
  return {
    ok: true,
    message: `补登完成：新建 ${created} 环（其中缺环占位 ${missing} 环），已存在跳过 ${skipped} 环；已有环号一律未覆盖`,
    data: { created, missing, skipped },
  }
}

/** 缺号落待办时挂到能对上的进度节点；对不上先挂空节点，由登记人在确认单上再关联。 */
function nodeCodeForRange(
  draft: ReturnType<typeof measureState>,
  projectCode: string,
  _no: number,
): string {
  const candidate = draft.confirmations
    .filter((c) => c.projectCode === projectCode)
    .map((c) => c.nodeCode)
    .find(Boolean)
  return candidate ?? ''
}

/** 监理核实缺环：通过转「贯通可计」（可随后续单计量），不通过转「未贯通不计」。 */
export function verifyMissingRing(
  ringId: number,
  pass: boolean,
  note: string,
  acc: Account,
): ServiceResult {
  const guard = requireSupervisor(acc, '核实缺环')
  if (!guard.ok) return guard
  let exists = false
  try {
    commit((draft) => {
      const ring = draft.rings.find((r) => r.id === ringId)
      if (!ring) return
      exists = true
      ring.status = pass ? '贯通可计' : '未贯通不计'
      ring.remark = note
        ? `${pass ? '监理核实通过' : '监理核实不通过，不计量'}：${note}`
        : pass
          ? '监理核实通过，可计入后续确认单'
          : '监理核实不通过，该环不计量'
      draft.todos
        .filter((t) => t.kind === 'missing' && t.ringId === ring.id)
        .forEach((t) => {
          t.title = `${t.title}（${pass ? '已核实通过' : '核实不通过'}）`
        })
    })
  } catch {
    return { ok: false, message: '核实结论写入失败，状态未变更' }
  }
  if (!exists) return { ok: false, message: '没有找到该环次台账记录' }
  return { ok: true, message: pass ? '缺环核实通过，已转为贯通可计' : '缺环核实不通过，已转为未贯通不计' }
}

// ---------- 工程量确认单 ----------

export interface CreateConfirmationInput {
  projectCode: string
  ringFrom: number
  ringTo: number
  crew: string
  nodeCode: string
  reportedAmount: number
  remark: string
}

/** 项目内部/监理都可以登记报量，但只有监理能签认。 */
export function createConfirmation(input: CreateConfirmationInput, acc: Account): ServiceResult<Confirmation> {
  const project = projectByCode(input.projectCode)
  if (!project) return { ok: false, message: `项目 ${input.projectCode} 不存在` }
  const range = expandRingRange(input.ringFrom, input.ringTo)
  if (range.length === 0) return { ok: false, message: '环次区间非法' }
  if (!input.crew.trim()) return { ok: false, message: '报量班组必填（重复报量按班组+首签判定）' }
  if (!input.nodeCode.trim()) return { ok: false, message: '必须关联进度节点编号，计量结论才能落待办' }
  const node = nodeNameMap().get(input.nodeCode)
  if (!node) return { ok: false, message: `进度节点「${input.nodeCode}」在进度节点模块不存在，请先对齐节点编号` }
  if (!Number.isFinite(input.reportedAmount) || input.reportedAmount < 0) {
    return { ok: false, message: '报量金额必须是非负数字' }
  }

  // 同班组同区间已有待签单：防止现场重复点两次产生两张单。
  const s = measureState()
  const duplicateDraft = s.confirmations.find(
    (c) =>
      c.projectCode === input.projectCode &&
      c.crew === input.crew.trim() &&
      c.ringFrom === input.ringFrom &&
      c.ringTo === input.ringTo &&
      c.status === '待监理签认',
  )
  if (duplicateDraft) {
    return { ok: false, message: `同班组同区间已有待签确认单 ${duplicateDraft.code}，勿重复报量` }
  }

  let created: Confirmation | null = null
  try {
    commit((draft) => {
      draft.seq.confirmation = (draft.seq.confirmation ?? 0) + 1
      const id = draft.seq.confirmation
      const code = `QRD-${pad(id)}`
      const row: Confirmation = {
        id,
        code,
        projectCode: input.projectCode,
        ringFrom: input.ringFrom,
        ringTo: input.ringTo,
        crew: input.crew.trim(),
        nodeCode: input.nodeCode.trim(),
        reportedAmount: round2(input.reportedAmount),
        status: '待监理签认',
        createdBy: acc.name,
        createdAt: today(),
        signedBy: null,
        signedAt: null,
        signVersion: null,
        reviews: [],
        eligibleRings: 0,
        controlTotal: 0,
        confirmedAmount: 0,
        deductedAmount: 0,
        capDeduction: 0,
        remark: input.remark,
      }
      draft.confirmations.push(row)
      addTodo(
        draft,
        'sign',
        row.nodeCode,
        `${code} 工程量确认单待监理签认`,
        code,
        { confirmationId: id },
      )
      created = row
    })
  } catch {
    return { ok: false, message: '确认单写入失败，整笔未入库' }
  }
  return { ok: true, message: `确认单 ${created!.code} 已登记，等待监理方签认`, data: created! }
}

/**
 * 监理签认：按当前口径 + 环次台账现场核定。
 * 同一环只认第一次签认：台账环次已被其他已签单占用的，本单一律核减为 0 并注明首签单号。
 * 签认后确认量冻结；已签单不提供任何改动入口。
 */
export function signConfirmation(id: number, acc: Account): ServiceResult<Confirmation> {
  const guard = requireSupervisor(acc, '签认工程量')
  if (!guard.ok) return guard
  const s = measureState()
  const target = s.confirmations.find((c) => c.id === id)
  if (!target) return { ok: false, message: '没有找到该工程量确认单' }
  if (target.status === '监理已签认') {
    return { ok: false, message: `${target.code} 已由 ${target.signedBy} 签认，签认结论不可改动` }
  }

  const project = projectByCode(target.projectCode)!
  // 首次签认归属以台账环次上的占用标记为准；键必须带项目，跨项目同环号不能互相判重。
  const claimants = new Map<string, Confirmation>()
  for (const ring of s.rings) {
    if (ring.claimedByConfirmationId != null) {
      const owner = s.confirmations.find((c) => c.id === ring.claimedByConfirmationId)
      if (owner && owner.status === '监理已签认') claimants.set(`${ring.projectCode}:${ring.ringNo}`, owner)
    }
  }
  const ringRows = s.rings.filter(
    (r) =>
      r.projectCode === target.projectCode &&
      r.ringNo >= target.ringFrom &&
      r.ringNo <= target.ringTo,
  )
  const result = reviewConfirmation({
    project,
    rings: ringRows,
    from: target.ringFrom,
    to: target.ringTo,
    reportedAmount: target.reportedAmount,
    claimants,
    selfConfirmationId: target.id,
  })
  const policy = currentPolicy()

  let signed: Confirmation | null = null
  try {
    commit((draft) => {
      const row = draft.confirmations.find((c) => c.id === id)!
      row.status = '监理已签认'
      row.signedBy = acc.name
      row.signedAt = today()
      row.signVersion = policy.version
      row.reviews = result.reviews
      row.eligibleRings = result.eligibleRings
      row.controlTotal = result.controlTotal
      row.confirmedAmount = result.confirmedAmount
      row.deductedAmount = result.deductedAmount
      row.capDeduction = result.capDeduction
      // 占用本单实际计入的环；后到的重复报量单签认时即判重。
      for (const review of result.reviews.filter((x) => x.result === '核定计入')) {
        const ring = draft.rings.find(
          (r) => r.projectCode === row.projectCode && r.ringNo === review.ringNo,
        )
        if (ring) ring.claimedByConfirmationId = row.id
      }
      signed = row
    })
  } catch {
    return { ok: false, message: '签认结论写入失败，签认未生效' }
  }

  const dup = result.reviews.filter((r) => r.result === '核减：重复报量').length
  const missing = result.reviews.filter((r) => r.result === '核减：缺环待核实').length
  const parts = [
    `${target.code} 已由 ${acc.name} 按口径 ${policy.version} 签认`,
    `可计 ${result.eligibleRings} 环，确认 ${fmtMoney(result.confirmedAmount)}，核减 ${fmtMoney(result.deductedAmount)}`,
  ]
  if (dup) parts.push(`其中 ${dup} 环重复报量只认首签`)
  if (missing) parts.push(`${missing} 环缺环待核实未计`)
  return { ok: true, message: parts.join('；'), data: signed! }
}

// ---------- 计量支付单 ----------

export interface GeneratePaymentInput {
  confirmationId: number
  tierName: string
  ratio: number
}

/**
 * 生成/重报计量支付单。
 * - 前置：确认单已监理签认，且确认量大于 0。
 * - 比例超合同分档上限：直接拦下、不落库，并报出档名、上限、超出点数。
 * - 幂等：一张确认单只有一张支付单，同 code upsert；已支付留档单禁止再动。
 */
export function generatePayment(input: GeneratePaymentInput, acc: Account): ServiceResult<Payment> {
  const s = measureState()
  const confirmation = s.confirmations.find((c) => c.id === input.confirmationId)
  if (!confirmation) return { ok: false, message: '没有找到该工程量确认单' }
  if (confirmation.status !== '监理已签认') {
    return { ok: false, message: `${confirmation.code} 尚未经监理签认，不允许生成计量支付单` }
  }
  if (confirmation.confirmedAmount <= 0) {
    return {
      ok: false,
      message: `${confirmation.code} 核定确认量为 0（全部核减），不生成计量支付单`,
    }
  }
  const project = projectByCode(confirmation.projectCode)!
  const check = checkPayRatio(project, input.tierName, input.ratio)
  if (!check.pass) {
    // 硬拦截：明确不落库；已有单也保持原样不动。
    return { ok: false, message: check.reason }
  }
  const existing = s.payments.find((p) => p.confirmationId === confirmation.id)
  if (existing?.archived) {
    return {
      ok: false,
      message: `${existing.code} 已支付并按口径 ${existing.basisVersion} 留档，不能重新生成或覆盖`,
    }
  }

  const idemKey = `pay:${confirmation.id}:${check.tier.name}:${input.ratio}`
  if (
    existing &&
    s.idempotency.some((r) => r.key === idemKey) &&
    existing.tierName === check.tier.name &&
    existing.payRatio === input.ratio &&
    existing.status === '待支付'
  ) {
    return { ok: false, message: `相同内容刚已提交过，支付单 ${existing.code} 未重复生成（幂等拦截）` }
  }

  const amount = computePaymentAmount(confirmation.confirmedAmount, input.ratio)
  const policy = currentPolicy()
  let saved: Payment | null = null
  try {
    commit((draft) => {
      const row = draft.payments.find((p) => p.confirmationId === confirmation.id)
      if (row) {
        row.tierName = check.tier.name
        row.payRatio = input.ratio
        row.tierCapRatio = check.tier.capRatio
        row.amount = amount
        row.status = '待支付'
        row.basisVersion = policy.version
        row.basisPublishedAt = policy.publishedAt
        row.generatedBy = acc.name
        row.generatedAt = today()
        row.blockReason = null
        draft.idempotency.push({ key: idemKey, resultRef: row.code, at: today() })
        saved = row
        return
      }
      draft.seq.payment = (draft.seq.payment ?? 0) + 1
      const id = draft.seq.payment
      const created: Payment = {
        id,
        code: `JLF-${pad(id)}`,
        confirmationId: confirmation.id,
        projectCode: confirmation.projectCode,
        tierName: check.tier.name,
        payRatio: input.ratio,
        tierCapRatio: check.tier.capRatio,
        amount,
        status: '待支付',
        basisVersion: policy.version,
        basisPublishedAt: policy.publishedAt,
        generatedBy: acc.name,
        generatedAt: today(),
        paidAt: null,
        archived: false,
        blockReason: null,
      }
      draft.payments.push(created)
      draft.idempotency.push({ key: idemKey, resultRef: created.code, at: today() })
      addTodo(
        draft,
        'payment',
        confirmation.nodeCode,
        `${created.code} 计量支付单待支付`,
        created.code,
        { confirmationId: confirmation.id, paymentId: id },
      )
      saved = created
    })
  } catch {
    return { ok: false, message: '支付单写入失败，整笔未入库' }
  }
  return {
    ok: true,
    message: `${saved!.code} 本期金额 ${fmtMoney(amount)}（确认 ${fmtMoney(confirmation.confirmedAmount)} × ${fmtPct(input.ratio)}，${check.tier.name}）`,
    data: saved!,
  }
}

/** 登记已支付：支付后即冻结，以后口径怎么改都按当版留档。 */
export function markPaymentPaid(id: number, acc: Account): ServiceResult {
  const guard = requireInternal(acc, '支付登记')
  if (!guard.ok) return guard
  const s = measureState()
  const payment = s.payments.find((p) => p.id === id)
  if (!payment) return { ok: false, message: '没有找到该计量支付单' }
  if (payment.archived) return { ok: false, message: `${payment.code} 已支付留档` }
  if (payment.status === '超限拦截') {
    return { ok: false, message: `${payment.code} 当前被口径拦截，不能登记支付` }
  }
  try {
    commit((draft) => {
      const row = draft.payments.find((p) => p.id === id)!
      row.status = '已支付'
      row.archived = true
      row.paidAt = today()
    })
  } catch {
    return { ok: false, message: '支付登记写入失败，状态未变更' }
  }
  return { ok: true, message: `${payment.code} 已登记支付 ${fmtMoney(payment.amount)}，按口径 ${payment.basisVersion} 冻结留档` }
}

// ---------- 核定口径改版 ----------

export interface PublishPolicyInput {
  note: string
  /** 本次同时调整的合同分档/控制价（可选）；不传则只发布文字口径修订。 */
  projects?: Project[]
}

/**
 * 发布新口径并整体重算。
 * 重算范围：所有未支付（未冻结）支付单——确认量不变，按最新分档上限重新校验：
 * 未超限的按新比例口径刷新金额；超限的置「超限拦截」并写明超出哪一档。
 * 已支付单一行不动，按当时版本留档。
 */
export function publishPolicy(input: PublishPolicyInput, acc: Account): ServiceResult<MeasurePolicy> {
  const guard = requireInternal(acc, '发布核定口径')
  if (!guard.ok) return guard
  if (!input.note.trim()) return { ok: false, message: '改口径必须写修订说明，便于追溯' }

  const s = measureState()
  const nextVersion = `v${s.policyHistory.length + 1}`
  const policy: MeasurePolicy = {
    version: nextVersion,
    publishedAt: today(),
    publishedBy: acc.name,
    payableRingStatuses: ['贯通可计'],
    note: input.note.trim(),
  }

  let recalced = 0
  let blocked = 0
  try {
    commit((draft) => {
      draft.policyHistory.push(policy)
      draft.currentVersion = nextVersion
      if (input.projects) draft.projects = input.projects
      for (const row of draft.payments) {
        if (row.archived) continue // 已支付留档，不重算
        const project = draft.projects.find((p) => p.code === row.projectCode)!
        const confirmation = draft.confirmations.find((c) => c.id === row.confirmationId)!
        const check = checkPayRatio(project, row.tierName, row.payRatio)
        recalced += 1
        row.basisVersion = nextVersion
        row.basisPublishedAt = policy.publishedAt
        if (check.pass) {
          row.status = '待支付'
          row.tierCapRatio = check.tier.capRatio
          row.amount = computePaymentAmount(confirmation.confirmedAmount, row.payRatio)
          row.blockReason = null
        } else {
          row.status = '超限拦截'
          row.tierCapRatio = check.tier.capRatio
          row.blockReason = check.reason
          blocked += 1
        }
      }
    })
  } catch {
    return { ok: false, message: '口径发布写入失败，旧口径仍然有效，未产生半截数据' }
  }
  return {
    ok: true,
    message: `口径 ${nextVersion} 已发布：重算 ${recalced} 张未支付单，其中 ${blocked} 张超新合同上限被拦截；已支付单按原口径留档未动`,
    data: policy,
  }
}

// ---------- 待办 / 结算台账（选择器，不另存表） ----------

/**
 * 进度节点待办视图。完成态、金额全部从实体实时派生：
 * payment 类待办的本期金额 = 支付单 amount；结算台账也读同一个字段，物理上只有一份。
 */
export function todoViews(nodeCode?: string): TodoView[] {
  const s = measureState()
  const names = nodeNameMap()
  return s.todos
    .filter((t) => !nodeCode || t.nodeCode === nodeCode)
    .map((t) => {
      let statusText = ''
      let done = false
      let abnormal = false
      let amount: number | null = null
      if (t.kind === 'sign') {
        const c = s.confirmations.find((x) => x.id === t.confirmationId)
        done = c?.status === '监理已签认'
        statusText = done ? `已由 ${c?.signedBy} 签认（口径 ${c?.signVersion}）` : '待监理签认'
      } else if (t.kind === 'missing') {
        const ring = s.rings.find((x) => x.id === t.ringId)
        done = ring ? ring.status !== '缺环待核实' : false
        statusText = ring ? ring.status : '环次记录缺失'
        abnormal = ring?.status === '缺环待核实'
      } else {
        const p = s.payments.find((x) => x.id === t.paymentId)
        done = p?.status === '已支付'
        statusText = p ? `${p.status}（口径 ${p.basisVersion}）` : '支付单缺失'
        abnormal = p?.status === '超限拦截'
        if (p) amount = p.amount
      }
      return {
        id: t.id,
        nodeCode: t.nodeCode,
        nodeName: t.nodeCode ? names.get(t.nodeCode) ?? t.nodeCode : '未关联节点',
        kind: t.kind,
        kindLabel: KIND_LABELS[t.kind],
        title: t.title,
        refCode: t.refCode,
        statusText,
        amount,
        abnormal,
        done,
        createdAt: t.createdAt,
      }
    })
}

/** 结算台账：支付单一行一笔，与进度节点待办、支付单列表同出一源。 */
export function ledgerRows(projectCode?: string): LedgerRow[] {
  const s = measureState()
  return s.payments
    .filter((p) => !projectCode || p.projectCode === projectCode)
    .map((p) => {
      const c = s.confirmations.find((x) => x.id === p.confirmationId)!
      const project = s.projects.find((x) => x.code === p.projectCode)!
      return {
        payment: p,
        confirmationCode: c.code,
        projectName: project.name,
        nodeCode: c.nodeCode,
        crew: c.crew,
        ringFrom: c.ringFrom,
        ringTo: c.ringTo,
        confirmedAmount: c.confirmedAmount,
      }
    })
}
