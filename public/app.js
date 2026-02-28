let config = null;
let entities = [];
let status = null;
let runtimeLogs = [];

const TYPE_CHOICES = ['boolean', 'integer', 'real', 'string', 'enum'];
const LOG_LEVEL_ORDER = ['error', 'warn', 'info', 'debug'];
const LOG_CATEGORY_ORDER = ['ember', 'ha', 'forward', 'system', 'other'];
const LOG_CATEGORY_LABELS = {
  ember: 'Ember+',
  ha: 'Home Assistant',
  forward: 'Forwarding',
  system: 'System',
  other: 'Other'
};

const state = {
  rows: new Map(),
  runtimeTimer: null,
  groupOpen: new Map(),
  advancedOpen: new Map(),
  visibleGroupEntities: new Map(),
  selectedDomains: new Set(),
  logFilters: {
    categories: new Set(),
    levels: new Set(),
    search: '',
    errorsOnly: false,
    paused: false
  }
};

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function tooltipIcon(text) {
  const safe = escapeHtml(text);
  return `<span class="tooltip-chip" tabindex="0" data-tooltip="${safe}" aria-label="${safe}">?</span>`;
}

function syncModalBodyState() {
  const clientsOpen = byId('clients-modal') && !byId('clients-modal').hidden;
  const noticeOpen = byId('notice-modal') && !byId('notice-modal').hidden;
  document.body.classList.toggle('modal-open', clientsOpen || noticeOpen);
}

function padInt(value, width = 2) {
  return String(value).padStart(width, '0');
}

function formatLogTimestamp(value) {
  const d = new Date(value);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    return String(value || '');
  }

  const year = d.getFullYear();
  const month = padInt(d.getMonth() + 1, 2);
  const day = padInt(d.getDate(), 2);
  const hours = padInt(d.getHours(), 2);
  const minutes = padInt(d.getMinutes(), 2);
  const seconds = padInt(d.getSeconds(), 2);
  const millis = padInt(d.getMilliseconds(), 3);
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${millis}`;
}

function stringifyDetails(details) {
  try {
    return JSON.stringify(details);
  } catch (_error) {
    return String(details);
  }
}

function clientIpFromRemoteAddress(remoteAddress) {
  const raw = String(remoteAddress || '').trim();
  if (!raw) {
    return '';
  }

  const ipv4WithPort = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/);
  if (ipv4WithPort) {
    return ipv4WithPort[1];
  }

  const bracketedIpv6 = raw.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketedIpv6) {
    return bracketedIpv6[1];
  }

  return raw;
}

function categoryKey(category) {
  const key = String(category || '').trim().toLowerCase();
  return key || 'other';
}

function categoryDisplayName(category) {
  const key = categoryKey(category);
  return LOG_CATEGORY_LABELS[key] || key;
}

function levelKey(level) {
  const key = String(level || '').trim().toLowerCase();
  return key || 'info';
}

function levelSortWeight(level) {
  const idx = LOG_LEVEL_ORDER.indexOf(levelKey(level));
  return idx === -1 ? LOG_LEVEL_ORDER.length + 1 : idx;
}

function formatLogDetails(details) {
  if (details == null) {
    return '';
  }

  try {
    const pretty = JSON.stringify(details, null, 2);
    if (pretty.length <= 3000) {
      return pretty;
    }
    return `${pretty.slice(0, 3000)}\n... (truncated)`;
  } catch (_error) {
    return String(details);
  }
}

function domainLabel(domain) {
  const text = String(domain || '').trim().toLowerCase();
  return text || 'other';
}

function domainDisplayLabel(domain) {
  return domainLabel(domain).replace(/_/g, ' ');
}

function domainClassName(domain) {
  return `domain-${domainLabel(domain).replace(/[^a-z0-9]+/g, '-')}`;
}

function slugText(value, fallback = 'unassigned') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || fallback;
}

function deviceLabel(entity) {
  const explicit = String(entity.device_name || '').trim();
  if (explicit) {
    return explicit;
  }

  const friendly = String(entity.friendly_name || '').trim();
  if (friendly.includes(' - ')) {
    return friendly.split(' - ')[0].trim();
  }

  if (friendly.includes(':')) {
    return friendly.split(':')[0].trim();
  }

  const objectId = entity.entity_id && entity.entity_id.includes('.')
    ? entity.entity_id.split('.')[1]
    : '';
  const parts = objectId.split('_').filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]} ${parts[1]}`;
  }
  if (parts.length === 1) {
    return parts[0];
  }

  return 'Unassigned';
}

function deviceKey(entity) {
  const explicit = String(entity.device_key || '').trim();
  if (explicit) {
    return explicit;
  }
  return slugText(deviceLabel(entity));
}

function entitySearchText(entity) {
  return [
    entity.entity_id,
    entity.source_entity_id,
    entity.friendly_name,
    entity.description,
    entity.parameter_label,
    entity.parameter_key,
    entity.device_name,
    entity.domain
  ]
    .map((x) => String(x || '').toLowerCase())
    .join(' ');
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body;
}

function showStatusLine() {
  if (!status) {
    byId('status-line').textContent = 'Status unavailable';
    byId('clients-link').textContent = 'Clients: 0';
    return;
  }

  const haOk = status.ha_connected && status.ha_authenticated;
  const emberOk = status.ember_running;
  const connectedClients = Array.isArray(status.connected_clients) ? status.connected_clients.length : 0;

  const summary = [
    `HA: ${haOk ? 'connected' : 'disconnected'}`,
    `Ember: ${emberOk ? 'running' : 'stopped'}`,
    `Exports: ${status.exported_count || 0}`
  ];

  byId('clients-link').textContent = `Clients: ${connectedClients}`;
  byId('clients-link').classList.toggle('inactive', connectedClients === 0);

  byId('status-line').textContent = `${summary.join(' | ')}${status.ha_reason ? ` | ${status.ha_reason}` : ''}`;
  byId('status-line').className = haOk && emberOk ? 'status-ok' : 'status-bad';
}

function renderErrors() {
  const list = byId('errors-list');
  list.innerHTML = '';

  const errs = status && Array.isArray(status.errors) ? status.errors : [];
  if (errs.length === 0) {
    list.innerHTML = '<li>No recent errors</li>';
    return;
  }

  for (const err of errs) {
    const li = document.createElement('li');
    li.textContent = `${err.at}: ${err.message}`;
    list.appendChild(li);
  }
}

function renderClients() {
  const rows = byId('client-rows');
  const emptyLine = byId('clients-empty');
  rows.innerHTML = '';

  const clients = status && Array.isArray(status.connected_clients) ? status.connected_clients : [];
  if (clients.length === 0) {
    emptyLine.style.display = 'block';
    return;
  }

  emptyLine.style.display = 'none';
  const html = clients.map((client) => {
    const stats = stringifyDetails(client.stats || {});
    return `
      <tr>
        <td>${escapeHtml(client.remoteAddress || '-')}</td>
        <td><code>${escapeHtml(stats)}</code></td>
      </tr>
    `;
  });

  rows.innerHTML = html.join('');
}

function renderClientsModal() {
  const list = byId('clients-modal-list');
  const emptyLine = byId('clients-modal-empty');
  if (!list || !emptyLine) {
    return;
  }

  const clients = status && Array.isArray(status.connected_clients) ? status.connected_clients : [];
  list.innerHTML = '';

  if (clients.length === 0) {
    emptyLine.style.display = 'block';
    return;
  }

  emptyLine.style.display = 'none';
  const html = clients.map((client) => {
    const remote = String(client.remoteAddress || '').trim();
    const ip = clientIpFromRemoteAddress(remote) || '-';
    const showRemote = remote && remote !== ip ? `<div class="client-remote">${escapeHtml(remote)}</div>` : '';

    return `
      <li>
        <div class="client-ip">${escapeHtml(ip)}</div>
        ${showRemote}
      </li>
    `;
  });

  list.innerHTML = html.join('');
}

function renderLogs() {
  const rows = byId('log-rows');
  const emptyLine = byId('logs-empty');
  const summary = byId('logs-summary');
  const searchText = String(state.logFilters.search || '').trim().toLowerCase();
  rows.innerHTML = '';

  const allLogs = Array.isArray(runtimeLogs) ? runtimeLogs : [];
  const categoryCounts = new Map();
  const levelCounts = new Map();
  for (const entry of allLogs) {
    const category = categoryKey(entry && entry.category);
    const level = levelKey(entry && entry.level);
    categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    levelCounts.set(level, (levelCounts.get(level) || 0) + 1);
  }

  renderLogCategoryFilters(categoryCounts);
  renderLogLevelFilters(levelCounts);

  const filteredLogs = allLogs.filter((entry) => {
    const category = categoryKey(entry && entry.category);
    const level = levelKey(entry && entry.level);
    const message = String(entry && entry.message ? entry.message : '').toLowerCase();
    const details = entry && entry.details ? stringifyDetails(entry.details).toLowerCase() : '';
    const searchable = `${message} ${details} ${category} ${level}`;

    if (state.logFilters.errorsOnly && level !== 'warn' && level !== 'error') {
      return false;
    }

    if (state.logFilters.categories.size > 0 && !state.logFilters.categories.has(category)) {
      return false;
    }

    if (state.logFilters.levels.size > 0 && !state.logFilters.levels.has(level)) {
      return false;
    }

    if (searchText && !searchable.includes(searchText)) {
      return false;
    }

    return true;
  });

  const pauseText = state.logFilters.paused ? ' (paused)' : '';
  summary.textContent = `Showing ${filteredLogs.length}/${allLogs.length}${pauseText}`;

  if (filteredLogs.length === 0) {
    emptyLine.style.display = 'block';
    return;
  }

  emptyLine.style.display = 'none';
  const html = filteredLogs.map((entry) => {
    const category = categoryKey(entry.category);
    const level = levelKey(entry.level);
    const detailsText = formatLogDetails(entry.details);
    const detailsHtml = detailsText
      ? `<pre class="log-details">${escapeHtml(detailsText)}</pre>`
      : '<span class="log-details-empty">-</span>';

    return `
      <tr class="log-level-${escapeHtml(level)}">
        <td>${escapeHtml(formatLogTimestamp(entry.at || ''))}</td>
        <td><span class="log-badge log-level-badge ${escapeHtml(`log-level-${level}`)}">${escapeHtml(level)}</span></td>
        <td><span class="log-badge log-category-badge ${escapeHtml(`log-cat-${category}`)}">${escapeHtml(categoryDisplayName(category))}</span></td>
        <td class="log-message">${escapeHtml(entry.message || '')}</td>
        <td>${detailsHtml}</td>
      </tr>
    `;
  });

  rows.innerHTML = html.join('');
}

function renderLogCategoryFilters(categoryCounts) {
  const container = byId('logs-category-filters');
  if (!container) {
    return;
  }

  const keys = Array.from(categoryCounts.keys()).sort((a, b) => {
    const ia = LOG_CATEGORY_ORDER.indexOf(a);
    const ib = LOG_CATEGORY_ORDER.indexOf(b);
    const wa = ia === -1 ? LOG_CATEGORY_ORDER.length + 1 : ia;
    const wb = ib === -1 ? LOG_CATEGORY_ORDER.length + 1 : ib;
    if (wa !== wb) {
      return wa - wb;
    }
    return a.localeCompare(b);
  });

  const total = keys.reduce((sum, key) => sum + (categoryCounts.get(key) || 0), 0);
  const allActive = state.logFilters.categories.size === 0;

  const parts = [
    `<button type="button" class="domain-chip log-chip ${allActive ? 'active' : ''}" data-role="log-category-filter" data-value="__all__">all (${total})</button>`
  ];

  for (const key of keys) {
    const active = state.logFilters.categories.has(key);
    parts.push(
      `<button type="button" class="domain-chip log-chip ${active ? 'active' : ''}" data-role="log-category-filter" data-value="${escapeHtml(key)}">${escapeHtml(categoryDisplayName(key))} (${categoryCounts.get(key)})</button>`
    );
  }

  container.innerHTML = parts.join('');
}

function renderLogLevelFilters(levelCounts) {
  const container = byId('logs-level-filters');
  if (!container) {
    return;
  }

  const keys = Array.from(levelCounts.keys()).sort((a, b) => {
    const wa = levelSortWeight(a);
    const wb = levelSortWeight(b);
    if (wa !== wb) {
      return wa - wb;
    }
    return a.localeCompare(b);
  });

  const total = keys.reduce((sum, key) => sum + (levelCounts.get(key) || 0), 0);
  const allActive = state.logFilters.levels.size === 0;

  const parts = [
    `<button type="button" class="domain-chip log-chip ${allActive ? 'active' : ''}" data-role="log-level-filter" data-value="__all__">all (${total})</button>`
  ];

  for (const key of keys) {
    const active = state.logFilters.levels.has(key);
    parts.push(
      `<button type="button" class="domain-chip log-chip ${active ? 'active' : ''}" data-role="log-level-filter" data-value="${escapeHtml(key)}">${escapeHtml(key)} (${levelCounts.get(key)})</button>`
    );
  }

  container.innerHTML = parts.join('');
}

function fillConfig() {
  byId('ha-url').value = config.home_assistant.url || '';
  byId('ha-token').value = config.home_assistant.token || '';
  byId('ember-port').value = config.ember.port || 9000;
  byId('ember-root').value = config.ember.root_identifier || 'homeassistant';
  byId('write-cooldown').value = config.write_control && Number.isFinite(Number(config.write_control.cooldown_ms))
    ? Number(config.write_control.cooldown_ms)
    : 400;
  byId('write-debounce').value = config.write_control && Number.isFinite(Number(config.write_control.debounce_ms))
    ? Number(config.write_control.debounce_ms)
    : 150;
}

function defaultAccessForOptions(accessOptions) {
  const safeOptions = Array.isArray(accessOptions) && accessOptions.length > 0
    ? accessOptions
    : ['read'];
  return safeOptions.includes('readWrite') ? 'readWrite' : safeOptions[0];
}

function resolveRowAccess(access, accessOptions, accessUserSet = false) {
  const safeOptions = Array.isArray(accessOptions) && accessOptions.length > 0
    ? accessOptions
    : ['read'];
  const currentAccess = String(access || '').trim();
  const preferred = defaultAccessForOptions(safeOptions);

  if (accessUserSet && safeOptions.includes(currentAccess)) {
    return currentAccess;
  }

  if (!accessUserSet && safeOptions.includes(preferred)) {
    return preferred;
  }

  return safeOptions.includes(currentAccess) ? currentAccess : safeOptions[0];
}

function hydrateRows() {
  state.rows.clear();
  for (const entity of entities) {
    const accessOptions = Array.isArray(entity.access_options) && entity.access_options.length > 0
      ? entity.access_options.slice()
      : ['read', 'readWrite'];
    const accessUserSet = entity && entity.access_user_set === true;
    const access = resolveRowAccess(entity.access, accessOptions, accessUserSet);

    state.rows.set(entity.entity_id, {
      selected: Boolean(entity.selected),
      type: entity.type || entity.suggested_type || 'string',
      access,
      access_options: accessOptions,
      access_user_set: accessUserSet,
      identifier: entity.identifier || entity.entity_id.replace(/[^a-zA-Z0-9_]/g, '_'),
      description: entity.description || entity.friendly_name || entity.entity_id,
      write_cooldown_ms: Number.isFinite(Number(entity.write_cooldown_ms)) ? Number(entity.write_cooldown_ms) : '',
      write_debounce_ms: Number.isFinite(Number(entity.write_debounce_ms)) ? Number(entity.write_debounce_ms) : '',
      enum_options: Array.isArray(entity.enum_options) ? entity.enum_options : [],
      enum_map: Array.isArray(entity.enum_map) ? entity.enum_map : []
    });
  }
}

function renderDomainFilters(domainCounts) {
  const container = byId('domain-filters');
  if (!container) {
    return;
  }

  const domains = Array.from(domainCounts.keys()).sort((a, b) => a.localeCompare(b));
  const total = domains.reduce((sum, domain) => sum + (domainCounts.get(domain) || 0), 0);

  if (domains.length === 0) {
    state.selectedDomains.clear();
    container.innerHTML = '';
    return;
  }

  for (const domain of Array.from(state.selectedDomains)) {
    if (!domainCounts.has(domain)) {
      state.selectedDomains.delete(domain);
    }
  }

  const allActive = state.selectedDomains.size === 0;

  const parts = [
    `<button type="button" class="domain-chip all ${allActive ? 'active' : ''}" data-domain="__all__">all (${total})</button>`
  ];

  for (const domain of domains) {
    const active = state.selectedDomains.has(domain);
    const cls = `${domainClassName(domain)} ${active ? 'active' : ''}`.trim();
    parts.push(
      `<button type="button" class="domain-chip ${cls}" data-domain="${escapeHtml(domain)}">${escapeHtml(domainDisplayLabel(domain))} (${domainCounts.get(domain)})</button>`
    );
  }

  container.innerHTML = parts.join('');
}

function renderEntityRow(item) {
  const { entity, row, domain } = item;
  const rowClass = `${domainClassName(domain)} entity-row`;
  const advancedRowClass = `${domainClassName(domain)} entity-advanced-row`;
  const advancedOpen = state.advancedOpen.get(entity.entity_id) === true;
  const suggestedType = entity.suggested_type || row.type || 'string';
  const accessOptions = Array.isArray(row.access_options) && row.access_options.length > 0
    ? row.access_options
    : ['read', 'readWrite'];
  const accessLocked = accessOptions.length === 1;
  const virtualInfo = entity.is_virtual
    ? `
      <div class="entity-virtual">parameter: ${escapeHtml(entity.parameter_label || entity.parameter_key || 'virtual')}</div>
      <div class="entity-virtual-src">source: ${escapeHtml(entity.source_entity_id || '')}</div>
    `
    : '';

  return `
    <tr class="${escapeHtml(rowClass)}">
      <td><input type="checkbox" data-role="selected" data-id="${escapeHtml(entity.entity_id)}" ${row.selected ? 'checked' : ''}></td>
      <td>
        <div class="entity-name">${escapeHtml(entity.friendly_name)}</div>
        <div class="entity-id">${escapeHtml(entity.entity_id)}</div>
        ${virtualInfo}
      </td>
      <td><span class="domain-tag ${escapeHtml(domainClassName(domain))}">${escapeHtml(domainDisplayLabel(domain))}</span></td>
      <td>
        <select data-role="type" data-id="${escapeHtml(entity.entity_id)}">
          ${TYPE_CHOICES.map((t) => `<option value="${t}" ${row.type === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </td>
      <td><input type="text" data-role="description" data-id="${escapeHtml(entity.entity_id)}" value="${escapeHtml(row.description || '')}"></td>
      <td>
        <select data-role="access" data-id="${escapeHtml(entity.entity_id)}" ${accessLocked ? 'disabled' : ''}>
          ${accessOptions.map((opt) => `<option value="${escapeHtml(opt)}" ${row.access === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('')}
        </select>
        ${accessLocked ? '<div class="access-lock-note">forced read only</div>' : ''}
      </td>
      <td>${escapeHtml(entity.state)}</td>
      <td>
        <button type="button" class="secondary adv-toggle" data-role="advanced_toggle" data-id="${escapeHtml(entity.entity_id)}">
          ${advancedOpen ? 'Hide' : 'Advanced'}
        </button>
      </td>
    </tr>
    <tr class="${escapeHtml(advancedRowClass)}" ${advancedOpen ? '' : 'hidden'}>
      <td colspan="8">
        <div class="advanced-grid">
          <label>
            <span class="advanced-label">
              Identifier
              ${tooltipIcon('Ember+ parameter identifier. Keep it stable and unique inside the node.')}
            </span>
            <input
              type="text"
              data-role="identifier"
              data-id="${escapeHtml(entity.entity_id)}"
              value="${escapeHtml(row.identifier)}"
              title="Ember+ parameter identifier. Keep it stable and unique inside the node."
            >
          </label>
          <label>
            <span class="advanced-label">
              Cooldown (ms)
              ${tooltipIcon('Minimum time between forwarded writes for this parameter. 0 disables cooldown.')}
            </span>
            <input
              type="number"
              min="0"
              step="1"
              data-role="write_cooldown_ms"
              data-id="${escapeHtml(entity.entity_id)}"
              value="${escapeHtml(row.write_cooldown_ms)}"
              title="Minimum time between forwarded writes for this parameter. 0 disables cooldown."
            >
          </label>
          <label>
            <span class="advanced-label">
              Debounce (ms)
              ${tooltipIcon('Delay before forwarding the latest write. Multiple quick writes collapse into one.')}
            </span>
            <input
              type="number"
              min="0"
              step="1"
              data-role="write_debounce_ms"
              data-id="${escapeHtml(entity.entity_id)}"
              value="${escapeHtml(row.write_debounce_ms)}"
              title="Delay before forwarding the latest write. Multiple quick writes collapse into one."
            >
          </label>
        </div>
        <div class="advanced-actions">
          <button
            type="button"
            class="secondary"
            data-role="apply_suggested_single"
            data-id="${escapeHtml(entity.entity_id)}"
            title="Apply suggested type only for this parameter."
          >
            Apply Suggested Type
          </button>
          <span class="advanced-hint">Suggested: <strong>${escapeHtml(suggestedType)}</strong></span>
        </div>
      </td>
    </tr>
  `;
}

function renderDeviceGroup(group) {
  const items = group.items.slice().sort((a, b) => {
    if (a.domain !== b.domain) {
      return a.domain.localeCompare(b.domain);
    }
    return a.entity.entity_id.localeCompare(b.entity.entity_id);
  });

  const rowsHtml = items.map(renderEntityRow).join('');
  const selectedInGroup = items.reduce((acc, item) => acc + (item.row.selected ? 1 : 0), 0);
  const allSelected = items.length > 0 && selectedInGroup === items.length;
  const partiallySelected = selectedInGroup > 0 && selectedInGroup < items.length;
  const isOpen = state.groupOpen.has(group.key) ? state.groupOpen.get(group.key) : false;

  const domainNames = Array.from(new Set(items.map((item) => item.domain))).sort((a, b) => a.localeCompare(b));
  const domainPreview = domainNames.slice(0, 4);
  const domainTags = domainPreview
    .map((domain) => `<span class="domain-tag ${escapeHtml(domainClassName(domain))}">${escapeHtml(domainDisplayLabel(domain))}</span>`)
    .join('');
  const remainder = domainNames.length > 4
    ? `<span class="more-domains">+${domainNames.length - 4}</span>`
    : '';

  return `
    <details class="entity-group device-group" data-group-key="${escapeHtml(group.key)}" ${isOpen ? 'open' : ''}>
      <summary>
        <span class="group-head-left">
          <input
            type="checkbox"
            class="group-check"
            data-role="group_selected"
            data-group-key="${escapeHtml(group.key)}"
            data-indeterminate="${partiallySelected ? '1' : '0'}"
            aria-label="Enable visible entities in ${escapeHtml(group.name)}"
            ${allSelected ? 'checked' : ''}
          >
          <span class="group-title">${escapeHtml(group.name)}</span>
        </span>
        <span class="group-meta">${selectedInGroup}/${items.length} selected</span>
      </summary>
      <div class="group-types">${domainTags}${remainder}</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Use</th>
              <th>Entity</th>
              <th>Domain</th>
              <th>Type</th>
              <th>Description</th>
              <th>Access</th>
              <th>State</th>
              <th>Advanced</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    </details>
  `;
}

function applyGroupCheckboxStates() {
  const boxes = document.querySelectorAll('input[data-role="group_selected"][data-indeterminate]');
  for (const box of boxes) {
    box.indeterminate = box.getAttribute('data-indeterminate') === '1';
  }
}

function renderEntities() {
  const filter = byId('search').value.trim().toLowerCase();
  const showEnabledOnly = byId('show-enabled-only').checked;
  const groupsContainer = byId('entity-groups');
  const emptyLine = byId('entities-empty');

  let selectedCount = 0;
  for (const row of state.rows.values()) {
    if (row.selected) {
      selectedCount += 1;
    }
  }
  byId('selected-count').textContent = `${selectedCount} selected`;

  const baseItems = [];
  const domainCounts = new Map();

  for (const entity of entities) {
    const row = state.rows.get(entity.entity_id);
    if (!row) {
      continue;
    }

    if (showEnabledOnly && !row.selected) {
      continue;
    }

    const text = entitySearchText(entity);
    if (filter && !text.includes(filter)) {
      continue;
    }

    const domain = domainLabel(entity.domain);
    baseItems.push({ entity, row, domain });
    domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
  }

  renderDomainFilters(domainCounts);

  const items = state.selectedDomains.size === 0
    ? baseItems
    : baseItems.filter((item) => state.selectedDomains.has(item.domain));

  if (items.length === 0) {
    state.visibleGroupEntities.clear();
    groupsContainer.innerHTML = '';
    emptyLine.style.display = 'block';
    return;
  }

  emptyLine.style.display = 'none';

  const grouped = new Map();
  for (const item of items) {
    const key = deviceKey(item.entity);
    const name = deviceLabel(item.entity);

    if (!grouped.has(key)) {
      grouped.set(key, { key, name, items: [] });
    }
    grouped.get(key).items.push(item);
  }

  const groups = Array.from(grouped.values()).sort((a, b) => a.name.localeCompare(b.name));
  state.visibleGroupEntities.clear();
  for (const group of groups) {
    state.visibleGroupEntities.set(group.key, group.items.map((item) => item.entity.entity_id));
  }
  groupsContainer.innerHTML = groups.map(renderDeviceGroup).join('');
  applyGroupCheckboxStates();
}

function applySuggestedTypeForEntity(entityId) {
  if (!entityId || !state.rows.has(entityId)) {
    return;
  }

  const entity = entities.find((item) => item.entity_id === entityId);
  if (!entity) {
    return;
  }

  const row = state.rows.get(entityId);
  row.type = entity.suggested_type || row.type || 'string';
  row.enum_options = Array.isArray(entity.enum_options) ? entity.enum_options : [];
  row.enum_map = Array.isArray(entity.enum_map) ? entity.enum_map : [];
  renderEntities();
}

function showNotice(message, title = 'Saved', variant = 'info') {
  return new Promise((resolve) => {
    const modal = byId('notice-modal');
    const panel = byId('notice-panel');
    const titleEl = byId('notice-title');
    const msgEl = byId('notice-message');
    const okBtn = byId('notice-ok');

    titleEl.textContent = title;
    msgEl.textContent = message;
    modal.hidden = false;
    panel.classList.remove('notice-info', 'notice-success', 'notice-error');
    panel.classList.add(`notice-${variant}`);
    panel.classList.remove('closing');
    syncModalBodyState();

    let closed = false;
    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      panel.classList.add('closing');
      setTimeout(() => {
        modal.hidden = true;
        panel.classList.remove('closing');
        syncModalBodyState();
        resolve();
      }, 240);
    };

    const onBackdrop = (event) => {
      const closeHit = event.target && event.target.getAttribute('data-role') === 'notice-modal-close';
      if (!closeHit) {
        return;
      }
      modal.removeEventListener('click', onBackdrop);
      close();
    };

    modal.addEventListener('click', onBackdrop);
    okBtn.onclick = () => {
      modal.removeEventListener('click', onBackdrop);
      close();
    };
  });
}

function wireEntityHandlers() {
  const groups = byId('entity-groups');

  groups.addEventListener('click', (event) => {
    const groupCheckbox = event.target.closest('input[data-role="group_selected"]');
    if (groupCheckbox) {
      event.stopPropagation();
      return;
    }

    const target = event.target.closest('button[data-role="advanced_toggle"]');
    if (!target) {
      return;
    }

    const entityId = target.getAttribute('data-id');
    if (!entityId) {
      return;
    }

    const currentlyOpen = state.advancedOpen.get(entityId) === true;
    state.advancedOpen.set(entityId, !currentlyOpen);
    renderEntities();
  });

  groups.addEventListener('click', (event) => {
    const target = event.target.closest('button[data-role="apply_suggested_single"]');
    if (!target) {
      return;
    }

    const entityId = target.getAttribute('data-id');
    applySuggestedTypeForEntity(entityId);
  });

  groups.addEventListener('change', (event) => {
    const target = event.target;
    const role = target.getAttribute('data-role');
    if (!role) {
      return;
    }

    if (role === 'group_selected') {
      const groupKey = target.getAttribute('data-group-key');
      if (!groupKey || !state.visibleGroupEntities.has(groupKey)) {
        return;
      }

      const checked = target.checked;
      const visibleIds = state.visibleGroupEntities.get(groupKey) || [];
      for (const entityId of visibleIds) {
        if (state.rows.has(entityId)) {
          state.rows.get(entityId).selected = checked;
        }
      }

      renderEntities();
      return;
    }

    const entityId = target.getAttribute('data-id');
    if (!entityId || !state.rows.has(entityId)) {
      return;
    }

    const row = state.rows.get(entityId);
    if (role === 'selected') {
      row.selected = target.checked;
    } else if (role === 'type') {
      row.type = target.value;
      if (row.type !== 'enum') {
        row.enum_map = [];
      }
    } else if (role === 'access') {
      const allowedAccess = Array.isArray(row.access_options) && row.access_options.length > 0
        ? row.access_options
        : ['read', 'readWrite'];
      if (!allowedAccess.includes(target.value)) {
        row.access = defaultAccessForOptions(allowedAccess);
      } else {
        row.access = target.value;
      }
      row.access_user_set = true;
    } else if (role === 'identifier') {
      row.identifier = target.value;
    } else if (role === 'description') {
      row.description = target.value;
    } else if (role === 'write_cooldown_ms') {
      row.write_cooldown_ms = target.value;
    } else if (role === 'write_debounce_ms') {
      row.write_debounce_ms = target.value;
    }

    renderEntities();
  });

  groups.addEventListener('input', (event) => {
    const target = event.target;
    const role = target.getAttribute('data-role');
    if (role !== 'identifier' && role !== 'description') {
      return;
    }

    const entityId = target.getAttribute('data-id');
    if (!entityId || !state.rows.has(entityId)) {
      return;
    }

    if (role === 'identifier') {
      state.rows.get(entityId).identifier = target.value;
    } else if (role === 'description') {
      state.rows.get(entityId).description = target.value;
    }
  });

  groups.addEventListener('toggle', (event) => {
    const details = event.target;
    if (!details || !details.classList || !details.classList.contains('entity-group')) {
      return;
    }

    const key = details.getAttribute('data-group-key');
    if (!key) {
      return;
    }

    state.groupOpen.set(key, details.open);
  }, true);
}

function buildConfigPayload() {
  const exportsList = [];
  for (const [entityId, row] of state.rows.entries()) {
    if (!row.selected) {
      continue;
    }

    exportsList.push({
      entity_id: entityId,
      type: row.type,
      access: row.access,
      ...(row.access_user_set ? { access_user_set: true } : {}),
      identifier: row.identifier,
      description: String(row.description || '').trim(),
      ...(row.write_cooldown_ms !== '' && Number.isFinite(Number(row.write_cooldown_ms)) && Number(row.write_cooldown_ms) >= 0
        ? { write_cooldown_ms: Math.floor(Number(row.write_cooldown_ms)) }
        : {}),
      ...(row.write_debounce_ms !== '' && Number.isFinite(Number(row.write_debounce_ms)) && Number(row.write_debounce_ms) >= 0
        ? { write_debounce_ms: Math.floor(Number(row.write_debounce_ms)) }
        : {}),
      ...(row.type === 'enum'
        ? {
          enum_map: Array.isArray(row.enum_map) && row.enum_map.length > 0
            ? row.enum_map
            : (Array.isArray(row.enum_options)
              ? row.enum_options.map((key, idx) => ({ key, value: idx }))
              : [])
        }
        : {})
    });
  }

  return {
    ...config,
    home_assistant: {
      ...config.home_assistant,
      url: byId('ha-url').value.trim(),
      token: byId('ha-token').value.trim()
    },
    ember: {
      ...config.ember,
      host: (config.ember && config.ember.host) ? config.ember.host : '0.0.0.0',
      port: Number(byId('ember-port').value),
      root_identifier: byId('ember-root').value.trim()
    },
    write_control: {
      ...(config.write_control || {}),
      cooldown_ms: Math.max(0, Number(byId('write-cooldown').value) || 0),
      debounce_ms: Math.max(0, Number(byId('write-debounce').value) || 0)
    },
    exports: exportsList
  };
}

async function refreshRuntimeData() {
  const [st, logsResponse] = await Promise.all([
    api('/api/status'),
    api('/api/logs')
  ]);

  status = st;
  if (!state.logFilters.paused) {
    runtimeLogs = Array.isArray(logsResponse.logs) ? logsResponse.logs : [];
  }

  showStatusLine();
  renderErrors();
  renderClients();
  renderClientsModal();
  renderLogs();
}

async function loadBaseData() {
  const [cfg, entitiesResponse] = await Promise.all([
    api('/api/config'),
    api('/api/entities')
  ]);

  config = cfg;
  entities = entitiesResponse.entities || [];

  fillConfig();
  hydrateRows();
  renderEntities();
}

async function saveAndApply() {
  const button = byId('save-btn');
  button.disabled = true;
  button.textContent = 'Saving...';

  try {
    const payload = buildConfigPayload();
    const response = await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    config = response.config;
    await loadBaseData();
    await refreshRuntimeData();
    await showNotice('Configuration saved and applied.', 'Saved', 'success');
  } catch (error) {
    await showNotice(`Save failed: ${error.message}`, 'Save Failed', 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Save and Apply';
  }
}

async function reloadOnly() {
  try {
    await api('/api/reload', { method: 'POST' });
    await loadBaseData();
    await refreshRuntimeData();
    await showNotice('Reload complete.', 'Reload', 'success');
  } catch (error) {
    await showNotice(`Reload failed: ${error.message}`, 'Reload Failed', 'error');
  }
}

async function refreshEntities() {
  try {
    const entitiesResponse = await api('/api/entities');
    entities = entitiesResponse.entities || [];

    for (const entity of entities) {
      if (!state.rows.has(entity.entity_id)) {
        const accessOptions = Array.isArray(entity.access_options) && entity.access_options.length > 0
          ? entity.access_options.slice()
          : ['read', 'readWrite'];
        const accessUserSet = entity && entity.access_user_set === true;
        const access = resolveRowAccess(entity.access, accessOptions, accessUserSet);

        state.rows.set(entity.entity_id, {
          selected: Boolean(entity.selected),
          type: entity.type || entity.suggested_type || 'string',
          access,
          access_options: accessOptions,
          access_user_set: accessUserSet,
          identifier: entity.identifier || entity.entity_id.replace(/[^a-zA-Z0-9_]/g, '_'),
          description: entity.description || entity.friendly_name || entity.entity_id,
          write_cooldown_ms: Number.isFinite(Number(entity.write_cooldown_ms)) ? Number(entity.write_cooldown_ms) : '',
          write_debounce_ms: Number.isFinite(Number(entity.write_debounce_ms)) ? Number(entity.write_debounce_ms) : '',
          enum_options: Array.isArray(entity.enum_options) ? entity.enum_options : [],
          enum_map: Array.isArray(entity.enum_map) ? entity.enum_map : []
        });
      } else {
        const row = state.rows.get(entity.entity_id);
        const nextAccessOptions = Array.isArray(entity.access_options) && entity.access_options.length > 0
          ? entity.access_options.slice()
          : ['read', 'readWrite'];
        const backendAccessUserSet = entity && entity.access_user_set === true;

        row.access_options = nextAccessOptions;
        if (row.access_user_set !== true) {
          row.access_user_set = backendAccessUserSet;
          row.access = resolveRowAccess(entity.access, nextAccessOptions, backendAccessUserSet);
        } else if (!nextAccessOptions.includes(row.access)) {
          row.access = defaultAccessForOptions(nextAccessOptions);
          row.access_user_set = false;
        }

        row.enum_options = Array.isArray(entity.enum_options) ? entity.enum_options : [];
        row.enum_map = Array.isArray(entity.enum_map) ? entity.enum_map : [];
        if (!row.description) {
          row.description = entity.description || entity.friendly_name || entity.entity_id;
        }
      }
    }

    renderEntities();
  } catch (error) {
    await showNotice(`Refresh failed: ${error.message}`, 'Refresh Failed', 'error');
  }
}

function wirePageHandlers() {
  byId('save-btn').addEventListener('click', saveAndApply);
  byId('reload-btn').addEventListener('click', reloadOnly);
  byId('refresh-btn').addEventListener('click', refreshEntities);
  byId('search').addEventListener('input', renderEntities);
  byId('show-enabled-only').addEventListener('change', renderEntities);
  byId('logs-search').addEventListener('input', (event) => {
    state.logFilters.search = String(event.target.value || '');
    renderLogs();
  });
  byId('logs-pause').addEventListener('change', (event) => {
    state.logFilters.paused = Boolean(event.target.checked);
    renderLogs();
    if (!state.logFilters.paused) {
      refreshRuntimeData().catch(() => {
        // ignore refresh error on resume
      });
    }
  });
  byId('logs-errors-only').addEventListener('change', (event) => {
    state.logFilters.errorsOnly = Boolean(event.target.checked);
    renderLogs();
  });
  byId('logs-clear-filters').addEventListener('click', () => {
    state.logFilters.categories.clear();
    state.logFilters.levels.clear();
    state.logFilters.search = '';
    state.logFilters.errorsOnly = false;
    byId('logs-search').value = '';
    byId('logs-errors-only').checked = false;
    renderLogs();
  });
  byId('logs-category-filters').addEventListener('click', (event) => {
    const target = event.target.closest('button[data-role="log-category-filter"]');
    if (!target) {
      return;
    }

    const value = target.getAttribute('data-value');
    if (!value) {
      return;
    }

    if (value === '__all__') {
      state.logFilters.categories.clear();
    } else if (state.logFilters.categories.has(value)) {
      state.logFilters.categories.delete(value);
    } else {
      state.logFilters.categories.add(value);
    }

    renderLogs();
  });
  byId('logs-level-filters').addEventListener('click', (event) => {
    const target = event.target.closest('button[data-role="log-level-filter"]');
    if (!target) {
      return;
    }

    const value = target.getAttribute('data-value');
    if (!value) {
      return;
    }

    if (value === '__all__') {
      state.logFilters.levels.clear();
    } else if (state.logFilters.levels.has(value)) {
      state.logFilters.levels.delete(value);
    } else {
      state.logFilters.levels.add(value);
    }

    renderLogs();
  });
  byId('clients-link').addEventListener('click', () => {
    byId('clients-modal').hidden = false;
    syncModalBodyState();
    renderClientsModal();
  });
  byId('clients-modal-close').addEventListener('click', () => {
    byId('clients-modal').hidden = true;
    syncModalBodyState();
  });
  byId('clients-modal').addEventListener('click', (event) => {
    const closeHit = event.target && event.target.getAttribute('data-role') === 'clients-modal-close';
    if (!closeHit) {
      return;
    }
    byId('clients-modal').hidden = true;
    syncModalBodyState();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }
    if (!byId('notice-modal').hidden) {
      byId('notice-ok').click();
      return;
    }
    if (!byId('clients-modal').hidden) {
      byId('clients-modal').hidden = true;
      syncModalBodyState();
    }
  });

  byId('domain-filters').addEventListener('click', (event) => {
    const target = event.target.closest('button[data-domain]');
    if (!target) {
      return;
    }

    const domain = target.getAttribute('data-domain');
    if (!domain) {
      return;
    }

    if (domain === '__all__') {
      state.selectedDomains.clear();
    } else if (state.selectedDomains.has(domain)) {
      state.selectedDomains.delete(domain);
    } else {
      state.selectedDomains.add(domain);
    }

    renderEntities();
  });

  wireEntityHandlers();
}

function startRuntimePolling() {
  if (state.runtimeTimer) {
    clearInterval(state.runtimeTimer);
  }

  state.runtimeTimer = setInterval(() => {
    refreshRuntimeData().catch(() => {
      // keep polling on transient failures
    });
  }, 3000);
}

(async function init() {
  wirePageHandlers();

  try {
    await loadBaseData();
    await refreshRuntimeData();
    startRuntimePolling();
  } catch (error) {
    byId('status-line').textContent = `Failed to load UI data: ${error.message}`;
    byId('status-line').className = 'status-bad';
  }
})();
