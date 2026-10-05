<template>
  <section class="page" data-module="measure">
    <header class="page-head">
      <div>
        <h2>掘进工程量计量支付</h2>
        <p class="page-desc">
          按环次区间归集工程量 → 监理签认确认单 → 生成计量支付单。同一环重复报量只认第一次签认；支付比例超合同分档上限整笔拦截。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="resetAll">回到示例数据</button>
      </div>
    </header>

    <div class="role-banner" :class="store.isSupervisor ? 'role-supervisor' : 'role-internal'">
      当前账号：<strong>{{ store.account.name }}</strong>（{{ store.roleLabel }} · {{ store.account.org }}）
      <span v-if="store.isSupervisor">可签认工程量、核实缺环；支付登记/口径发布由项目内部办理。</span>
      <span v-else>可登记报量、补登环次、生成支付单、发布口径；<strong>无权签认工程量</strong>。</span>
    </div>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">环次台账</span>
        <strong class="stat-value">{{ rings.length }} 环</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">缺环待核实</span>
        <strong class="stat-value">{{ missingRingCount }} 环</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待监理签认</span>
        <strong class="stat-value">{{ pendingSignCount }} 单</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待支付 / 被拦截</span>
        <strong class="stat-value">{{ pendingPayCount }} / {{ blockedPayCount }} 单</strong>
      </article>
    </div>

    <nav class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        class="tab"
        :class="{ active: activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
      </button>
    </nav>

    <p v-if="message" class="result-banner" :class="messageOk ? 'ok' : 'error-text'">{{ message }}</p>

    <!-- 环次台账 / 存量补登 -->
    <div v-if="activeTab === 'rings'">
      <form class="editor-card" @submit.prevent="doBackfill">
        <h3>存量工程量按环次区间补登</h3>
        <p class="card-hint">区间整数逐环展开；已登记环号一律不覆盖；缺号建成「缺环待核实」占位环，监理核实前不计量。</p>
        <div class="form-grid">
          <label>
            <span>项目</span>
            <select v-model="backfill.projectCode">
              <option v-for="p in projects" :key="p.code" :value="p.code">{{ p.code }} {{ p.name }}</option>
            </select>
          </label>
          <label>
            <span>起环号</span>
            <input v-model.number="backfill.from" type="number" min="1" />
          </label>
          <label>
            <span>止环号</span>
            <input v-model.number="backfill.to" type="number" min="1" />
          </label>
          <label>
            <span>缺环号（逗号分隔）</span>
            <input v-model="backfill.missingText" placeholder="如 37,38" />
          </label>
          <label>
            <span>非缺环默认状态</span>
            <select v-model="backfill.defaultStatus">
              <option value="贯通可计">贯通可计</option>
              <option value="未贯通不计">未贯通不计</option>
            </select>
          </label>
          <label>
            <span>起始里程（米）</span>
            <input v-model.number="backfill.startMileage" type="number" />
          </label>
          <label class="wide">
            <span>数据来源</span>
            <input v-model="backfill.source" placeholder="如 10月存量环次补登" />
          </label>
        </div>
        <button class="btn primary" type="submit">按区间补登</button>
      </form>

      <form class="filter-bar" @submit.prevent>
        <label class="filter-item">
          <span>项目</span>
          <select v-model="ringProjectFilter">
            <option value="">全部项目</option>
            <option v-for="p in projects" :key="p.code" :value="p.code">{{ p.code }} {{ p.name }}</option>
          </select>
        </label>
      </form>

      <table class="data-table">
        <thead>
          <tr>
            <th>项目</th><th>环号</th><th>里程</th><th>状态</th><th>首签占用</th><th>来源</th><th>备注</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in filteredRings" :key="r.id">
            <td>{{ r.projectCode }}</td>
            <td>{{ r.ringNo }}</td>
            <td>{{ r.mileage }}</td>
            <td :class="{ 'cell-warn': r.status === '缺环待核实' }">{{ r.status }}</td>
            <td>{{ claimCode(r.claimedByConfirmationId) || '—' }}</td>
            <td>{{ r.source }}</td>
            <td>{{ r.remark || '—' }}</td>
            <td class="row-actions">
              <template v-if="r.status === '缺环待核实'">
                <button class="link" type="button" @click="verifyRing(r.id, true)">监理核实通过</button>
                <button class="link danger" type="button" @click="verifyRing(r.id, false)">核实不通过</button>
              </template>
              <span v-else class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 工程量确认单 -->
    <div v-if="activeTab === 'confirmations'">
      <form class="editor-card" @submit.prevent="doCreate">
        <h3>按环次区间登记工程量确认单（现场报量）</h3>
        <div class="form-grid">
          <label>
            <span>项目</span>
            <select v-model="createForm.projectCode">
              <option v-for="p in projects" :key="p.code" :value="p.code">{{ p.code }} {{ p.name }}</option>
            </select>
          </label>
          <label><span>起环号</span><input v-model.number="createForm.ringFrom" type="number" min="1" /></label>
          <label><span>止环号</span><input v-model.number="createForm.ringTo" type="number" min="1" /></label>
          <label><span>报量班组</span><input v-model="createForm.crew" placeholder="如 掘进一班" /></label>
          <label>
            <span>关联进度节点编号</span>
            <input v-model="createForm.nodeCode" placeholder="如 PROG-0001" list="node-codes" />
            <datalist id="node-codes">
              <option v-for="n in progressNodes" :key="n.code" :value="n.code">{{ n.name }}</option>
            </datalist>
          </label>
          <label><span>报量金额（元）</span><input v-model.number="createForm.reportedAmount" type="number" min="0" /></label>
          <label class="wide"><span>说明</span><input v-model="createForm.remark" /></label>
        </div>
        <button class="btn primary" type="submit">登记确认单</button>
      </form>

      <table class="data-table">
        <thead>
          <tr>
            <th>单号</th><th>项目</th><th>环次区间</th><th>班组</th><th>节点</th>
            <th>报量金额</th><th>可计环</th><th>确认金额</th><th>核减</th><th>状态/签认</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in confirmations" :key="c.id">
            <td>{{ c.code }}</td>
            <td>{{ c.projectCode }}</td>
            <td>{{ c.ringFrom }}–{{ c.ringTo }}</td>
            <td>{{ c.crew }}</td>
            <td>{{ c.nodeCode }}</td>
            <td>{{ fmtMoney(c.reportedAmount) }}</td>
            <td>{{ c.status === '监理已签认' ? c.eligibleRings : '—' }}</td>
            <td>{{ c.status === '监理已签认' ? fmtMoney(c.confirmedAmount) : '—' }}</td>
            <td :class="{ 'cell-warn': c.deductedAmount > 0 }">
              {{ c.status === '监理已签认' ? fmtMoney(c.deductedAmount) : '—' }}
            </td>
            <td>
              {{ c.status }}
              <div class="muted" v-if="c.signedBy">{{ c.signedBy }} · {{ c.signedAt }} · {{ c.signVersion }}</div>
            </td>
            <td class="row-actions">
              <button v-if="c.status === '待监理签认'" class="link" type="button" @click="doSign(c.id)">
                监理签认
              </button>
              <button
                v-if="c.status === '监理已签认' && c.confirmedAmount > 0 && !paidOf(c.id)"
                class="link"
                type="button"
                @click="openPayment(c.id)"
              >
                生成/重报支付单
              </button>
              <button class="link" type="button" @click="expanded = expanded === c.id ? null : c.id">
                {{ expanded === c.id ? '收起核定' : '查看核定' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="expandedConf" class="editor-card">
        <h3>{{ expandedConf.code }} 逐环核定（口径 {{ expandedConf.signVersion }}）</h3>
        <p class="card-hint">{{ expandedConf.remark }}</p>
        <table class="data-table inner">
          <thead><tr><th>环号</th><th>结论</th><th>确认金额</th><th>说明</th></tr></thead>
          <tbody>
            <tr v-for="rv in expandedConf.reviews" :key="rv.ringNo">
              <td>{{ rv.ringNo }}</td>
              <td :class="{ 'cell-warn': rv.result !== '核定计入' }">{{ rv.result }}</td>
              <td>{{ fmtMoney(rv.confirmedAmount) }}</td>
              <td>{{ rv.detail }}</td>
            </tr>
            <tr v-if="!expandedConf.reviews.length"><td colspan="4" class="empty-state">待签认：签认时按当时口径逐环核定</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 计量支付单 -->
    <div v-if="activeTab === 'payments'">
      <table class="data-table">
        <thead>
          <tr>
            <th>支付单号</th><th>确认单</th><th>项目</th><th>支付分档</th><th>比例/上限</th>
            <th>本期金额</th><th>口径版本</th><th>状态</th><th>说明</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in payments" :key="p.id">
            <td>{{ p.code }}</td>
            <td>{{ confirmationCode(p.confirmationId) }}</td>
            <td>{{ p.projectCode }}</td>
            <td>{{ p.tierName }}</td>
            <td :class="{ 'cell-warn': p.status === '超限拦截' }">{{ fmtPct(p.payRatio) }} / {{ fmtPct(p.tierCapRatio) }}</td>
            <td><strong>{{ fmtMoney(p.amount) }}</strong></td>
            <td>{{ p.basisVersion }}</td>
            <td :class="{ 'cell-warn': p.status === '超限拦截' }">{{ p.status }}{{ p.paidAt ? `（${p.paidAt}）` : '' }}</td>
            <td>{{ p.blockReason || '—' }}</td>
            <td class="row-actions">
              <button v-if="p.status === '待支付'" class="link" type="button" @click="doPay(p.id)">登记已支付</button>
              <span v-else class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 核定口径 -->
    <div v-if="activeTab === 'policy'">
      <form class="editor-card" @submit.prevent="doPublish">
        <h3>核定口径（可复用判定）</h3>
        <p class="card-hint">
          判定集中在 domain/measure/policy.ts：确认金额 = min(报量, 可计环数×单环控制价)；支付 = 确认金额×比例，超分档上限整笔拦截。
          发布新版后，未支付单按新口径重算；已支付单按当时版本冻结留档。
        </p>
        <div v-for="p in projects" :key="p.code" class="tier-edit">
          <h4>{{ p.code }} {{ p.name }}</h4>
          <div class="form-grid">
            <label>
              <span>单环控制价（元/环）</span>
              <input v-model.number="priceDraft[p.code]" type="number" min="0" />
            </label>
            <label v-for="(t, i) in tiersDraft[p.code]" :key="t.name" class="tier-line">
              <span>{{ t.name }} 上限（%）</span>
              <input v-model.number="tiersDraft[p.code][i].capPct" type="number" min="0" max="100" step="0.5" />
            </label>
          </div>
        </div>
        <label class="wide-block">
          <span>本次修订说明（必填）</span>
          <textarea v-model="policyNote" rows="2" placeholder="如：接监理月度例会通知，TJ-02 第二档支付上限由80%调整为82%"></textarea>
        </label>
        <button class="btn primary" type="submit">发布新口径并重算未支付单</button>
      </form>

      <h3>历史版本（已支付留档口径）</h3>
      <table class="data-table">
        <thead><tr><th>版本</th><th>发布日期</th><th>发布人</th><th>修订说明</th></tr></thead>
        <tbody>
          <tr v-for="p in policyHistoryList" :key="p.version">
            <td>{{ p.version }}</td><td>{{ p.publishedAt }}</td><td>{{ p.publishedBy }}</td><td>{{ p.note }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 支付单生成弹层 -->
    <div v-if="payTarget" class="modal-mask" @click.self="payTarget = null">
      <form class="modal-card" @submit.prevent="doGenerate">
        <h3>生成计量支付单 · {{ payTarget.code }}</h3>
        <p class="card-hint">
          确认工程量（已签认冻结）：<strong>{{ fmtMoney(payTarget.confirmedAmount) }}</strong>
          ，区间 {{ payTarget.ringFrom }}–{{ payTarget.ringTo }} 环，节点 {{ payTarget.nodeCode }}
        </p>
        <label class="wide-block">
          <span>支付分档（合同上限随档走）</span>
          <select v-model="payTierName">
            <option v-for="t in payProject.tiers" :key="t.name" :value="t.name">
              {{ t.name }}（合同上限 {{ fmtPct(t.capRatio) }}）
            </option>
          </select>
        </label>
        <label class="wide-block">
          <span>本期支付比例（%）</span>
          <input v-model.number="payRatioPct" type="number" min="0" max="100" step="0.5" />
        </label>
        <p class="preview">
          试算本期金额：<strong>{{ fmtMoney(previewAmount) }}</strong>
          <span v-if="ratioOver" class="error-text">
            超出「{{ payTier.name }}」上限 {{ fmtPct(payTier.capRatio) }}，超出
            {{ Math.round((payRatioPct / 100 - payTier.capRatio) * 1000) / 10 }} 个点，保存会被整笔拦下
          </span>
        </p>
        <div class="row-actions end">
          <button class="btn" type="button" @click="payTarget = null">取消</button>
          <button class="btn primary" type="submit">提交</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'

import { listRows } from '@/data/local-store'
import { resetMeasure } from '@/domain/measure/measure-store'
import {
  backfillRings,
  createConfirmation,
  fmtMoney,
  fmtPct,
  generatePayment,
  ledgerRows,
  listConfirmations,
  listPayments,
  listProjects,
  listRings,
  markPaymentPaid,
  policyHistory,
  publishPolicy,
  signConfirmation,
  todoViews,
  verifyMissingRing,
} from '@/domain/measure/measure-service'
import { checkPayRatio, round2 } from '@/domain/measure/policy'
import type { Confirmation } from '@/domain/measure/types'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const tabs = [
  { key: 'rings', label: '环次台账/补登' },
  { key: 'confirmations', label: '工程量确认单' },
  { key: 'payments', label: '计量支付单' },
  { key: 'policy', label: '核定口径' },
]
const activeTab = ref('rings')
const message = ref('')
const messageOk = ref(true)

function notify(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

const projects = ref(listProjects())
const rings = ref(listRings())
const confirmations = ref(listConfirmations())
const payments = ref(listPayments())
const policyHistoryList = ref(policyHistory())
const expanded = ref<number | null>(null)

const progressNodes = computed(() =>
  listRows('progress').map((r) => ({ code: String(r['节点编号']), name: String(r['节点名称']) })),
)

const ringProjectFilter = ref('')
const filteredRings = computed(() =>
  ringProjectFilter.value ? rings.value.filter((r) => r.projectCode === ringProjectFilter.value) : rings.value,
)
const missingRingCount = computed(() => rings.value.filter((r) => r.status === '缺环待核实').length)
const pendingSignCount = computed(() => confirmations.value.filter((c) => c.status === '待监理签认').length)
const pendingPayCount = computed(() => payments.value.filter((p) => p.status === '待支付').length)
const blockedPayCount = computed(() => payments.value.filter((p) => p.status === '超限拦截').length)

const expandedConf = computed(() => confirmations.value.find((c) => c.id === expanded.value) ?? null)

function claimCode(id: number | null): string {
  if (id == null) return ''
  return confirmations.value.find((c) => c.id === id)?.code ?? ''
}
function paidOf(confirmationId: number): boolean {
  return payments.value.some((p) => p.confirmationId === confirmationId && p.archived)
}
function confirmationCodeById(id: number): string {
  return confirmations.value.find((c) => c.id === id)?.code ?? `#${id}`
}
// 模板用：支付单表中的确认单号始终与确认单列表同源。
function confirmationCode(id: number): string {
  return confirmationCodeById(id)
}

function refresh() {
  projects.value = listProjects()
  rings.value = listRings()
  confirmations.value = listConfirmations()
  payments.value = listPayments()
  policyHistoryList.value = policyHistory()
  // 选择器随数据刷新，保证进度页与台账两处读到的金额同步变化。
  todoViews()
  ledgerRows()
}

// 补登
const backfill = reactive({
  projectCode: projects.value[0]?.code ?? '',
  from: 41,
  to: 45,
  missingText: '42',
  defaultStatus: '贯通可计' as '贯通可计' | '未贯通不计',
  startMileage: 1000,
  source: '',
})
function doBackfill() {
  const missing = backfill.missingText
    .split(/[,，\s]+/)
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n))
  const result = backfillRings(
    {
      projectCode: backfill.projectCode,
      from: Number(backfill.from),
      to: Number(backfill.to),
      missingRings: missing,
      defaultStatus: backfill.defaultStatus,
      startMileage: Number(backfill.startMileage) || 1000,
      source: backfill.source.trim(),
    },
    store.account,
  )
  notify(result.ok, result.message)
  if (result.ok) refresh()
}
function verifyRing(id: number, pass: boolean) {
  const result = verifyMissingRing(id, pass, '', store.account)
  notify(result.ok, result.message)
  refresh()
}

// 确认单
const createForm = reactive({
  projectCode: projects.value[0]?.code ?? '',
  ringFrom: 13,
  ringTo: 16,
  crew: '',
  nodeCode: 'PROG-0001',
  reportedAmount: 180000,
  remark: '',
})
function doCreate() {
  const result = createConfirmation(
    {
      projectCode: createForm.projectCode,
      ringFrom: Number(createForm.ringFrom),
      ringTo: Number(createForm.ringTo),
      crew: createForm.crew,
      nodeCode: createForm.nodeCode,
      reportedAmount: Number(createForm.reportedAmount),
      remark: createForm.remark.trim(),
    },
    store.account,
  )
  notify(result.ok, result.message)
  if (result.ok) {
    refresh()
    activeTab.value = 'confirmations'
  }
}
function doSign(id: number) {
  const result = signConfirmation(id, store.account)
  notify(result.ok, result.message)
  refresh()
}

// 支付单
const payTarget = ref<Confirmation | null>(null)
const payTierName = ref('')
const payRatioPct = ref(70)
function openPayment(id: number) {
  const target = confirmations.value.find((c) => c.id === id)
  if (!target) return
  payTarget.value = target
  const project = projects.value.find((p) => p.code === target.projectCode)!
  payTierName.value = project.tiers[0].name
  payRatioPct.value = Math.round(project.tiers[0].capRatio * 100)
}
const payProject = computed(() => projects.value.find((p) => p.code === payTarget.value?.projectCode)!)
const payTier = computed(
  () => payProject.value.tiers.find((t) => t.name === payTierName.value) ?? payProject.value.tiers[0],
)
const ratioOver = computed(() => payRatioPct.value / 100 > payTier.value.capRatio)
const previewAmount = computed(() =>
  payTarget.value ? round2(payTarget.value.confirmedAmount * (Number(payRatioPct.value) / 100)) : 0,
)
function doGenerate() {
  if (!payTarget.value) return
  const project = payProject.value
  const ratio = Number(payRatioPct.value) / 100
  const check = checkPayRatio(project, payTierName.value, ratio)
  if (!check.pass) {
    // 页面不替 service 做决定，但提前把同一判定结果展示出来；提交仍会被服务层硬拦。
    notify(false, check.reason)
    return
  }
  const result = generatePayment(
    { confirmationId: payTarget.value.id, tierName: payTierName.value, ratio },
    store.account,
  )
  notify(result.ok, result.message)
  if (result.ok) {
    payTarget.value = null
    refresh()
    activeTab.value = 'payments'
  }
}
function doPay(id: number) {
  const result = markPaymentPaid(id, store.account)
  notify(result.ok, result.message)
  refresh()
}

// 口径
const priceDraft = reactive<Record<string, number>>(
  Object.fromEntries(projects.value.map((p) => [p.code, p.controlPricePerRing])),
)
const tiersDraft = reactive<Record<string, { name: string; capPct: number }[]>>(
  Object.fromEntries(
    projects.value.map((p) => [p.code, p.tiers.map((t) => ({ name: t.name, capPct: t.capRatio * 100 }))]),
  ),
)
const policyNote = ref('')
function doPublish() {
  if (!policyNote.value.trim()) {
    notify(false, '修订说明必填')
    return
  }
  const nextProjects = projects.value.map((p) => ({
    code: p.code,
    name: p.name,
    controlPricePerRing: Number(priceDraft[p.code]),
    tiers: tiersDraft[p.code].map((t) => ({ name: t.name, capRatio: round2(Number(t.capPct) / 100) })),
  }))
  const result = publishPolicy({ note: policyNote.value, projects: nextProjects }, store.account)
  notify(result.ok, result.message)
  if (result.ok) {
    policyNote.value = ''
    refresh()
  }
}

function resetAll() {
  resetMeasure()
  refresh()
  notify(true, '计量支付域已回到示例数据')
}
</script>
