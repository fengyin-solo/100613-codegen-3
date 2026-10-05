<template>
  <section class="page" data-module="ledger">
    <header class="page-head">
      <div>
        <h2>计量结算台账</h2>
        <p class="page-desc">
          本台账是计量支付单的只读投影，不另存一份：每一行就是一张计量支付单，本期金额与「掘进计量支付」及进度节点待办完全一致。
          已支付行按当时口径版本冻结留档。
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/measure">前往计量支付办理</RouterLink>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">本期应付合计（待支付）</span>
        <strong class="stat-value">{{ fmtMoney(totalPending) }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">累计已支付（留档）</span>
        <strong class="stat-value">{{ fmtMoney(totalPaid) }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">超口径拦截</span>
        <strong class="stat-value">{{ rows.filter((r) => r.payment.status === '超限拦截').length }} 笔</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">台账行数（=支付单数）</span>
        <strong class="stat-value">{{ rows.length }} 行</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent>
      <label class="filter-item">
        <span>项目</span>
        <select v-model="projectFilter">
          <option value="">全部项目</option>
          <option v-for="p in projects" :key="p.code" :value="p.code">{{ p.code }} {{ p.name }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>状态</span>
        <select v-model="statusFilter">
          <option value="">全部</option>
          <option value="待支付">待支付</option>
          <option value="已支付">已支付</option>
          <option value="超限拦截">超限拦截</option>
        </select>
      </label>
      <button class="btn ghost" type="button" @click="projectFilter = ''; statusFilter = ''">重置</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>支付单号</th>
          <th>确认单号</th>
          <th>项目</th>
          <th>进度节点</th>
          <th>班组</th>
          <th>环次区间</th>
          <th>确认工程量</th>
          <th>支付分档</th>
          <th>比例</th>
          <th>本期金额</th>
          <th>口径版本</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in filteredRows" :key="r.payment.id">
          <td>{{ r.payment.code }}</td>
          <td>{{ r.confirmationCode }}</td>
          <td>{{ r.projectName }}</td>
          <td>{{ r.nodeCode }}</td>
          <td>{{ r.crew }}</td>
          <td>{{ r.ringFrom }}–{{ r.ringTo }}</td>
          <td>{{ fmtMoney(r.confirmedAmount) }}</td>
          <td>{{ r.payment.tierName }}</td>
          <td>{{ fmtPct(r.payment.payRatio) }}</td>
          <td><strong>{{ fmtMoney(r.payment.amount) }}</strong></td>
          <td>{{ r.payment.basisVersion }}{{ r.payment.archived ? '（留档）' : '' }}</td>
          <td :class="{ 'cell-warn': r.payment.status === '超限拦截' }">{{ r.payment.status }}</td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td colspan="12" class="empty-state">台账暂无支付单，先到「掘进计量支付」由监理签认后生成</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>两处入口（本页 / 掘进计量支付 / 进度节点待办）读的是同一张支付单，不存在两份台账</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  fmtMoney,
  fmtPct,
  ledgerRows,
  listProjects,
} from '@/domain/measure/measure-service'
import type { Project } from '@/domain/measure/types'

const projects = ref<Project[]>([])
const rows = ref(ledgerRows())
const projectFilter = ref('')
const statusFilter = ref('')

const filteredRows = computed(() =>
  rows.value.filter(
    (r) =>
      (!projectFilter.value || r.payment.projectCode === projectFilter.value) &&
      (!statusFilter.value || r.payment.status === statusFilter.value),
  ),
)
const totalPending = computed(() =>
  rows.value.filter((r) => r.payment.status === '待支付').reduce((sum, r) => sum + r.payment.amount, 0),
)
const totalPaid = computed(() =>
  rows.value.filter((r) => r.payment.status === '已支付').reduce((sum, r) => sum + r.payment.amount, 0),
)

onMounted(() => {
  projects.value = listProjects()
  rows.value = ledgerRows()
})
</script>
