<template>
  <section class="page" data-module="payment">
    <header class="page-head">
      <div>
        <h2>计量支付单</h2>
        <p class="page-desc">本期金额 = 确认工程量 × 支付比例；比例超出合同分档上限的条目直接拦下不允许保存；已支付单按当时口径留档。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出支付单清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待支付支付单</span>
        <strong class="stat-value">{{ summary.pendingPayCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">本期金额合计</span>
        <strong class="stat-value">{{ summary.currentPeriodAmount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已支付归档合计</span>
        <strong class="stat-value">{{ summary.paidArchiveAmount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">现行核定口径</span>
        <strong class="stat-value">{{ summary.policyVersion }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="switchPolicyVersion">
      <label class="filter-item">
        <span>核定口径（切换后待支付单按新口径重算，已支付留档不动）</span>
        <select v-model="policyDraft">
          <option v-for="policy in policies" :key="policy.version" :value="policy.version">
            {{ policy.version }} · {{ policy.name }}
          </option>
        </select>
      </label>
      <button class="btn" type="submit">切换口径</button>
    </form>

    <form class="filter-bar" @submit.prevent="submitGenerate">
      <label class="filter-item">
        <span>已签认确认单</span>
        <select v-model="generateDraft.quantityId">
          <option value="" disabled>选择确认单</option>
          <option v-for="sheet in signedSheets" :key="String(sheet.id)" :value="String(sheet.id)">
            {{ sheet['确认单号'] }}（环 {{ sheet['起始环号'] }}–{{ sheet['结束环号'] }}，确认 {{ sheet['确认工程量'] }}）
          </option>
        </select>
      </label>
      <label class="filter-item">
        <span>计量档位</span>
        <select v-model="generateDraft.tierKey">
          <option v-for="tier in currentTiers" :key="tier.key" :value="tier.key">
            {{ tier.label }}（上限 {{ tier.cap }}%）
          </option>
        </select>
      </label>
      <label class="filter-item">
        <span>支付比例（%）</span>
        <input v-model="generateDraft.ratio" type="number" step="0.01" min="0" placeholder="80" />
      </label>
      <button class="btn primary" type="submit">生成支付单</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>支付单号</th>
          <th>关联确认单</th>
          <th>环次区间</th>
          <th>确认工程量</th>
          <th>计量档位</th>
          <th>支付比例</th>
          <th>本期金额</th>
          <th>口径版本</th>
          <th>支付日期</th>
          <th>归档金额</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>{{ row['支付单号'] }}</td>
          <td>{{ row['关联确认单'] }}</td>
          <td>{{ row['环次区间'] }}</td>
          <td>{{ row['确认工程量'] }}</td>
          <td>{{ row['计量档位'] }}</td>
          <td>{{ row['支付比例'] }}%</td>
          <td>{{ row['本期金额'] }}</td>
          <td>{{ row['口径版本'] }}</td>
          <td>{{ row['支付日期'] || '—' }}</td>
          <td>{{ row['归档金额'] === '' ? '—' : row['归档金额'] }}</td>
          <td>{{ row.status }}<span v-if="row.abnormal" class="error-text">（超限）</span></td>
          <td class="row-actions">
            <template v-if="row.status === '待支付'">
              <template v-if="row.abnormal">
                <select v-model="adjustDraft[row.id].tierKey" class="inline-input">
                  <option v-for="tier in currentTiers" :key="tier.key" :value="tier.key">
                    {{ tier.label }}
                  </option>
                </select>
                <input v-model="adjustDraft[row.id].ratio" class="inline-input" type="number" step="0.01" min="0" />
                <button class="link" type="button" @click="adjust(row)">调整保存</button>
              </template>
              <button v-else class="link" type="button" @click="pay(row)">确认支付</button>
            </template>
            <span v-else class="cell-note">按口径 {{ row['归档口径'] }} 留档</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="12" class="empty-state">暂无计量支付单，先由已签认确认单生成</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 张计量支付单 · 结算台账与本页读同一份数据</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  adjustPayment,
  currentPolicy,
  generatePayment,
  listPaymentOrders,
  listQuantitySheets,
  measureSummary,
  payOrder,
  policyVersions,
  switchPolicy,
  type MeasureSummary,
} from '@/api/measure-service'
import type { EntryRow } from '@/data/types'

const rows = ref<EntryRow[]>([])
const signedSheets = ref<EntryRow[]>([])
const summary = ref<MeasureSummary>(measureSummary())
const message = ref('')
const messageOk = ref(false)
const policies = policyVersions()
const policyDraft = ref(currentPolicy().version)
const generateDraft = reactive({ quantityId: '', tierKey: 'monthly', ratio: '' })
const adjustDraft = reactive<Record<number, { tierKey: string; ratio: string }>>({})

const currentTiers = computed(() => currentPolicy().tiers)

function show(result: { ok: boolean; message: string }) {
  message.value = result.message
  messageOk.value = result.ok
}

function submitGenerate() {
  if (!generateDraft.quantityId) {
    show({ ok: false, message: '请先选择一张已签认的确认单' })
    return
  }
  show(generatePayment(Number(generateDraft.quantityId), generateDraft.tierKey, Number(generateDraft.ratio)))
  reload()
}

function switchPolicyVersion() {
  show(switchPolicy(policyDraft.value))
  reload()
}

function pay(row: EntryRow) {
  show(payOrder(Number(row.id)))
  reload()
}

function adjust(row: EntryRow) {
  const draft = adjustDraft[Number(row.id)]
  show(adjustPayment(Number(row.id), draft.tierKey, Number(draft.ratio)))
  reload()
}

function exportRows() {
  downloadEntries('payment')
}

function reload() {
  rows.value = listPaymentOrders()
  signedSheets.value = listQuantitySheets().filter((row) => row.status === '已签认')
  summary.value = measureSummary()
  policyDraft.value = currentPolicy().version
  for (const row of rows.value) {
    if (row.status === '待支付' && row.abnormal && !adjustDraft[Number(row.id)]) {
      adjustDraft[Number(row.id)] = { tierKey: String(row['计量档位键']), ratio: String(row['支付比例']) }
    }
  }
}

onMounted(reload)
</script>
