import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const state = { records: [], statusFilter: 'TODOS', groupFilter: '', search: '', groups: [], groupSearch: '' };

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

async function fetchGroups() {
  const { data, error } = await supabase
    .from('monitored_groups')
    .select('jid, group_name, active')
    .order('group_name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map((g) => ({ ...g, _savedActive: g.active }));
}

function renderGroups() {
  const list = document.getElementById('groupsList');
  const errEl = document.getElementById('groupsError');
  const q = state.groupSearch;
  const shown = state.groups.filter(
    (g) => !q || (g.group_name || '').toLowerCase().includes(q) || g.jid.toLowerCase().includes(q)
  );
  const activeCount = state.groups.filter((g) => g.active).length;
  document.getElementById('groupsCount').textContent = `${activeCount} activos de ${state.groups.length}`;

  if (!shown.length) {
    list.innerHTML = '<p class="text-sm text-gray-400 col-span-full">No hay grupos que coincidan.</p>';
    return;
  }
  list.innerHTML = shown
    .map((g) => {
      const id = `grp_${btoa(g.jid).replace(/[^a-zA-Z0-9]/g, '')}`;
      return `<label for="${id}" class="flex items-start gap-2 p-2 rounded border ${g.active ? 'border-blue-300 bg-blue-50' : 'border-gray-200'} hover:bg-gray-50 cursor-pointer">
        <input type="checkbox" id="${id}" data-jid="${esc(g.jid)}" ${g.active ? 'checked' : ''} class="mt-0.5 h-4 w-4 text-blue-600 rounded" />
        <span class="min-w-0">
          <span class="block text-sm text-gray-700 truncate" title="${esc(g.group_name || g.jid)}">${esc(g.group_name || g.jid)}</span>
          <span class="block text-[10px] text-gray-400 truncate" title="${esc(g.jid)}">${esc(g.jid)}</span>
        </span>
      </label>`;
    })
    .join('');
  errEl.classList.add('hidden');
}

function setDirty(dirty) {
  document.getElementById('groupsDirty').classList.toggle('hidden', !dirty);
  document.getElementById('saveGroupsBtn').disabled = !dirty;
}

// Los cambios de checkbox quedan "pendientes" en memoria hasta presionar Guardar.
function toggleGroup(jid, active) {
  const g = state.groups.find((x) => x.jid === jid);
  if (g) g.active = active;
  setDirty(true);
  // Actualizamos SOLO el estilo del label y el contador, sin re-renderizar
  // (re-renderizar destruiría el checkbox que el usuario acaba de marcar).
  const cb = document.querySelector(`input[data-jid="${CSS.escape(jid)}"]`);
  if (cb) {
    const label = cb.closest('label');
    if (label) {
      label.className = `flex items-start gap-2 p-2 rounded border ${
        active ? 'border-blue-300 bg-blue-50' : 'border-gray-200'
      } hover:bg-gray-50 cursor-pointer`;
    }
  }
  const activeCount = state.groups.filter((x) => x.active).length;
  document.getElementById('groupsCount').textContent = `${activeCount} activos de ${state.groups.length}`;
}

async function saveGroups() {
  const errEl = document.getElementById('groupsError');
  const btn = document.getElementById('saveGroupsBtn');
  btn.disabled = true;
  btn.textContent = 'Guardando...';
  try {
    // Guardamos solo los cambios对比 con lo que hay en DB (estado guardado).
    const changes = state.groups.filter((g) => g.active !== (g._savedActive ?? false));
    for (const g of changes) {
      const { error } = await supabase.from('monitored_groups').update({ active: g.active }).eq('jid', g.jid);
      if (error) throw error;
      g._savedActive = g.active;
    }
    errEl.classList.add('hidden');
    btn.textContent = '✓ Guardado';
    setDirty(false);
    setTimeout(() => { btn.textContent = 'Guardar'; }, 1500);
  } catch (err) {
    errEl.textContent = 'Error al guardar: ' + err.message;
    errEl.classList.remove('hidden');
    btn.textContent = 'Guardar';
    setDirty(true);
  }
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

async function renderGroupsAll() {
  try {
    state.groups = await fetchGroups();
    renderGroups();
  } catch (err) {
    const el = document.getElementById('groupsError');
    el.textContent = 'Error al cargar grupos: ' + err.message;
    el.classList.remove('hidden');
  }
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

  document.getElementById('groupsList').addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"][data-jid]');
    if (cb) toggleGroup(cb.dataset.jid, cb.checked);
  });

  let groupSearchTimer = null;
  document.getElementById('groupSearchInput').addEventListener('input', (e) => {
    clearTimeout(groupSearchTimer);
    groupSearchTimer = setTimeout(() => {
      state.groupSearch = e.target.value.trim().toLowerCase();
      renderGroups();
    }, 100);
  });

  // Guardar con el botón
  document.getElementById('saveGroupsBtn').addEventListener('click', saveGroups);

  // Refrescar los checkboxes solo si no hay cambios pendientes de guardar
  setInterval(() => {
    const dirty = !document.getElementById('saveGroupsBtn').disabled;
    if (!dirty) renderGroupsAll();
  }, 60000);
}

renderAll()
  .then(wireEvents)
  .catch((err) => {
    document.getElementById('emptyState').textContent = 'Error al cargar los datos: ' + err.message;
  });
renderGroupsAll();
