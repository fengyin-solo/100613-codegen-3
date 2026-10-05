<template>
  <section class="page" data-module="ledger">
    <header class="page-head">
      <div>
        <h2>结算台账</h2>
        <p class="page-desc">计量结论的台账出口：与计量支付单读同一份数据，不另立台账；本期金额合计与进度节点待办清单是同一份数。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="reload">刷新台账</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">本期金额合计（待支付）</span>
        <strong class="stat-value">{{ summary.currentPeriodAmount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已支付归档合计</span>
        <strong class="stat-value">{{ summary.paidArchiveAmount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待支付支付单</span>
        <strong class="stat-value">{{ summary.pendingPayCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">现行核定口径</span>
        <strong class="stat-value">{{ summary.policyVersion }}</strong>
      </article>
    </div>

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
          <th>当前状态</th>
          <th>支付日期</th>
          <th>归档金额</th>
          <th>归档口径</th>
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
          <td>{{ row.status }}<span v-if="row.abnormal" class="error-text">（超限）</span></td>
          <td>{{ row['支付日期'] || '—' }}</td>
          <td>{{ row['归档金额'] === '' ? '—' : row['归档金额'] }}</td>
          <td>{{ row['归档口径'] || '—' }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="12" class="empty-state">暂无计量支付记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>台账行数 {{ rows.length }} · 已支付行按支付当时口径留档，口径切换不影响归档金额</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { listPaymentOrders, measureSummary, type MeasureSummary } from '@/api/measure-service'
import type { EntryRow } from '@/data/types'

const rows = ref<EntryRow[]>([])
const summary = ref<MeasureSummary>(measureSummary())

function reload() {
  rows.value = listPaymentOrders()
  summary.value = measureSummary()
}

onMounted(reload)
</script>
