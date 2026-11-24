import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const state = { records: [], statusFilter: 'TODOS', groupFilter: '', search: '' };

const COLORS = {
  ABIERTO: 'bg-red-100 text-red-700',
  CERRADO: 'bg-green-100 text-green-700',
  REABIERTO: 'bg-yellow-100 text-yellow-700',
};

const esc = (v) => {
  const d = document.createElement('div');
  d.textContent = v ?? '';
  return d.innerHTML;
};

const fmtDate = (iso) =>
  iso
    ? new Date(iso).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '';

const fmtDuration = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
};

async function fetchRecords() {
  const { data, error } = await supabase.from('incidents').select('*').order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

function filteredRecords() {
  return state.records.filter(
    (r) =>
      (state.statusFilter === 'TODOS' || r.status === state.statusFilter) &&
      (!state.groupFilter || r.source_group_jid === state.groupFilter) &&
      (r.code?.toLowerCase().includes(state.search) || (r.problem_summary || '').toLowerCase().includes(state.search))
  );
}

function renderKPIs(records) {
  const count = (s) => records.filter((r) => r.status === s).length;
  const closedAvg = (() => {
    const closed = records.filter((r) => r.status === 'CERRADO' && r.closed_at && r.created_at);
    if (!closed.length) return null;
    const total = closed.reduce((s, r) => s + new Date(r.closed_at).getTime() - new Date(r.created_at).getTime(), 0);
    return total / closed.length;
  })();
  const kpi = (label, value, cls = 'text-2xl font-bold text-gray-800') =>
    `<div class="border border-gray-200 rounded-lg p-4"><p class="text-xs uppercase tracking-wide text-gray-500">${label}</p><p class="${cls}">${value}</p></div>`;
  document.getElementById('kpis').innerHTML = [
    kpi('Abiertos', count('ABIERTO')),
    kpi('Cerrados', count('CERRADO')),
    kpi('Reabiertos', count('REABIERTO')),
    kpi('Resolución promedio', closedAvg === null ? '-' : fmtDuration(closedAvg), 'text-xl font-bold text-gray-800'),
  ].join('');
}

function renderTable(records) {
  const badge = (s) =>
    `<span class="px-2 py-0.5 rounded text-xs font-medium ${COLORS[s] || 'bg-gray-100 text-gray-700'}">${s}</span>`;
  const rows = records.map(
    (r) => `<tr class="border-b last:border-0 hover:bg-gray-50">
      <td class="px-4 py-2 text-gray-700">${r.code || ''}</td>
      <td class="px-4 py-2">${badge(r.status)}</td>
      <td class="px-4 py-2 text-gray-700">${esc(r.source_group_name || '')}</td>
      <td class="px-4 py-2 text-gray-700">${esc(r.involved_user || '')}</td>
      <td class="px-4 py-2 text-gray-700">${esc(r.problem_summary || '')}</td>
      <td class="px-4 py-2 text-gray-500">${fmtDate(r.created_at)}</td>
      <td class="px-4 py-2 text-gray-500">${r.closed_at ? fmtDate(r.closed_at) : '-'}</td>
    </tr>`
  );
  document.getElementById('tableBody').innerHTML = rows.join('');
  document.getElementById('emptyState').classList.toggle('hidden', rows.length > 0);
}

function renderStatusFilters() {
  const opts = [['TODOS', 'TODOS'], ['ABIERTO', 'ABIERTO'], ['CERRADO', 'CERRADO'], ['REABIERTO', 'REABIERTO']];
  document.getElementById('statusFilters').innerHTML = opts
    .map(
      ([label, value]) =>
        `<button data-status="${value}" class="px-3 py-1.5 rounded text-sm border transition-colors ${
          state.statusFilter === value
            ? 'bg-blue-600 text-white border-blue-600'
            : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
        }">${label}</button>`
    )
    .join('');
}

function renderGroupFilter(records) {
  const groups = [...new Set(records.map((r) => r.source_group_jid))];
  const byId = new Map(records.map((r) => [r.source_group_jid, r.source_group_name || r.source_group_jid]));
  document.getElementById('groupFilter').innerHTML = ['Todos'].concat(groups.map((gid) => `<option value="${esc(gid)}">${esc(byId.get(gid) || gid)}</option>`)).join('');
  const sel = document.getElementById('groupFilter');
  sel.value = state.groupFilter || '';
}

function exportCSV() {
  const rows = filteredRecords();
  const header = 'codigo,estado,grupo,involucrado,problema,fecha_creacion,fecha_cierre';
  const body = rows
    .map((r) =>
      [r.code, r.status, r.source_group_name, r.involved_user, r.problem_summary, fmtDate(r.created_at), r.closed_at ? fmtDate(r.closed_at) : '']
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(',')
    )
    .join('\n');
  const blob = new Blob([header + '\n' + body], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pendientes-dashboard.csv';
  a.click();
  URL.revokeObjectURL(url);
}

async function renderAll() {
  const records = await fetchRecords();
  state.records = records;
  renderKPIs(filteredRecords());
  renderTable(filteredRecords());
  renderGroupFilter(records);
  renderStatusFilters();
}

function wireEvents() {
  document.getElementById('statusFilters').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-status]');
    if (btn) {
      state.statusFilter = btn.dataset.status;
      renderAll();
    }
  });
  document.getElementById('groupFilter').addEventListener('change', (e) => {
    state.groupFilter = e.target.value;
    renderAll();
  });
  let searchTimer = null;
  document.getElementById('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = e.target.value.trim().toLowerCase();
      renderAll();
    }, 100);
  });
  document.getElementById('exportBtn').addEventListener('click', exportCSV);
}

renderAll()
  .then(wireEvents)
  .catch((err) => {
    document.getElementById('emptyState').textContent = 'Error al cargar los datos: ' + err.message;
  });
