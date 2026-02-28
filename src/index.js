const path = require('path');
const http = require('http');

const { loadConfig, saveConfig } = require('./config');
const { HomeAssistantClient } = require('./ha-client');
const { EmberBridge } = require('./ember-bridge');
const { createApiServer, accessOptionsForEntity, resolveAccessFromExport } = require('./api-server');
const { parseEntityRef } = require('./entity-ref');

const configPath = process.env.GATEWAY_CONFIG || path.join('/app', 'config', 'config.yaml');
const LOG_LIMIT = 500;

let currentConfig = loadConfig(configPath);
currentConfig = saveConfig(configPath, currentConfig);

const haClient = new HomeAssistantClient();
const emberBridge = new EmberBridge();
const runtimeLogs = [];
let applyQueue = Promise.resolve();
let applySequence = 0;
const writeStateByEntity = new Map();

const status = {
  ha_connected: false,
  ha_authenticated: false,
  ha_reason: 'Not started',
  ember_running: false,
  exported_count: 0,
  last_reload: null,
  errors: []
};

function nonEmptyText(value) {
  const text = String(value || '').trim();
  return text;
}

function slugText(value, fallback = 'unassigned') {
  const raw = nonEmptyText(value).toLowerCase();
  const slug = raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || fallback;
}

function normalizeNonNegativeInt(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function fallbackDeviceName(sourceEntityId, stateObj = null) {
  const friendlyName = stateObj && stateObj.attributes && stateObj.attributes.friendly_name
    ? nonEmptyText(stateObj.attributes.friendly_name)
    : '';

  if (friendlyName) {
    const dashParts = friendlyName.split(' - ');
    if (dashParts.length > 1) {
      return nonEmptyText(dashParts[0]) || friendlyName;
    }

    const colonParts = friendlyName.split(':');
    if (colonParts.length > 1) {
      return nonEmptyText(colonParts[0]) || friendlyName;
    }
  }

  const objectId = sourceEntityId && sourceEntityId.includes('.') ? sourceEntityId.split('.')[1] : '';
  const parts = objectId ? objectId.split('_').filter(Boolean) : [];
  if (parts.length >= 2) {
    return `${parts[0]} ${parts[1]}`;
  }
  if (parts.length === 1) {
    return parts[0];
  }

  return 'Unassigned';
}

function enrichExportsForRuntime(exportsList) {
  return exportsList.map((item) => {
    const ref = parseEntityRef(item.entity_id);
    const sourceEntityId = ref.base_entity_id;
    const stateObj = haClient.getState(sourceEntityId);
    const meta = haClient.getEntityMeta(sourceEntityId, stateObj);
    const domain = sourceEntityId && sourceEntityId.includes('.') ? sourceEntityId.split('.')[0] : 'other';
    const accessOptions = accessOptionsForEntity(domain, ref.isVirtual, ref.parameter_key);
    const defaultAccess = accessOptions.includes('readWrite') ? 'readWrite' : 'read';
    const accessResolved = resolveAccessFromExport(item, accessOptions, defaultAccess);

    const deviceName = nonEmptyText(meta && meta.device_name) || fallbackDeviceName(sourceEntityId, stateObj);
    const deviceKey = nonEmptyText(meta && meta.device_key) || slugText(deviceName);

    return {
      ...item,
      access: accessResolved.access,
      source_entity_id: sourceEntityId,
      domain,
      device_name: deviceName,
      device_key: deviceKey
    };
  });
}

function getWriteControlForEntity(entityId, evt = null) {
  const defaults = currentConfig && currentConfig.write_control ? currentConfig.write_control : {};
  const exportsList = currentConfig && Array.isArray(currentConfig.exports) ? currentConfig.exports : [];
  const exportDef = exportsList.find((item) => item.entity_id === entityId) || null;

  const cooldownMs = normalizeNonNegativeInt(
    evt && evt.write_cooldown_ms != null
      ? evt.write_cooldown_ms
      : (exportDef && exportDef.write_cooldown_ms != null ? exportDef.write_cooldown_ms : defaults.cooldown_ms),
    0
  );

  const debounceMs = normalizeNonNegativeInt(
    evt && evt.write_debounce_ms != null
      ? evt.write_debounce_ms
      : (exportDef && exportDef.write_debounce_ms != null ? exportDef.write_debounce_ms : defaults.debounce_ms),
    0
  );

  return {
    cooldown_ms: cooldownMs,
    debounce_ms: debounceMs
  };
}

function getWriteState(entityId) {
  if (!writeStateByEntity.has(entityId)) {
    writeStateByEntity.set(entityId, {
      pending_evt: null,
      timer: null,
      in_flight: false,
      last_forward_at: 0,
      last_forward_value: null
    });
  }
  return writeStateByEntity.get(entityId);
}

function scheduleWriteFlush(entityId, delayMs) {
  const state = getWriteState(entityId);
  if (state.timer) {
    clearTimeout(state.timer);
  }

  const waitMs = Math.max(0, normalizeNonNegativeInt(delayMs, 0));
  state.timer = setTimeout(() => {
    state.timer = null;
    flushPendingWrite(entityId).catch((error) => {
      pushError(`Write flush failed for ${entityId}: ${error.message}`);
    });
  }, waitMs);
}

async function flushPendingWrite(entityId) {
  const state = writeStateByEntity.get(entityId);
  if (!state || !state.pending_evt) {
    return;
  }

  if (state.in_flight) {
    scheduleWriteFlush(entityId, 20);
    return;
  }

  const evt = state.pending_evt;
  const writeControl = getWriteControlForEntity(entityId, evt);
  const now = Date.now();
  const elapsed = state.last_forward_at > 0 ? (now - state.last_forward_at) : Number.MAX_SAFE_INTEGER;

  if (elapsed < writeControl.cooldown_ms) {
    const delayMs = writeControl.cooldown_ms - elapsed;
    addLog('info', 'forward', `Cooldown active for ${entityId}; delaying forward by ${delayMs}ms`, {
      cooldown_ms: writeControl.cooldown_ms
    });
    scheduleWriteFlush(entityId, delayMs);
    return;
  }

  state.pending_evt = null;
  state.in_flight = true;
  try {
    const forward = await haClient.forwardEntityUpdate(
      entityId,
      evt.value,
      evt.value_type || 'string',
      Array.isArray(evt.enum_map) ? evt.enum_map : []
    );
    if (!forward.forwarded) {
      addLog('warn', 'forward', `Not forwarded for ${entityId}: ${forward.reason || 'unsupported mapping'}`);
      return;
    }

    state.last_forward_at = Date.now();
    state.last_forward_value = evt.value;
    addLog('info', 'forward', `Forwarded ${entityId} to HA via ${forward.service}`, {
      service_data: forward.service_data
    });
  } catch (error) {
    pushError(`Forward to HA failed for ${entityId}: ${error.message}`);
  } finally {
    state.in_flight = false;
    if (state.pending_evt) {
      const nextWriteControl = getWriteControlForEntity(entityId, state.pending_evt);
      scheduleWriteFlush(entityId, nextWriteControl.debounce_ms);
    }
  }
}

function queueRemoteWrite(evt) {
  const entityId = evt.entity_id;
  const state = getWriteState(entityId);
  const writeControl = getWriteControlForEntity(entityId, evt);
  const now = Date.now();
  const elapsed = state.last_forward_at > 0 ? (now - state.last_forward_at) : Number.MAX_SAFE_INTEGER;

  if (state.last_forward_at > 0 && state.last_forward_value === evt.value && elapsed < writeControl.cooldown_ms) {
    addLog('info', 'forward', `Skipped duplicate write for ${entityId} within cooldown window`, {
      value: evt.value,
      cooldown_ms: writeControl.cooldown_ms
    });
    return;
  }

  state.pending_evt = evt;
  addLog('info', 'forward', `Queued write for ${entityId}`, {
    value: evt.value,
    debounce_ms: writeControl.debounce_ms,
    cooldown_ms: writeControl.cooldown_ms
  });
  scheduleWriteFlush(entityId, writeControl.debounce_ms);
}

function addLog(level, category, message, details = null) {
  const item = {
    at: new Date().toISOString(),
    level,
    category,
    message
  };

  if (details && typeof details === 'object') {
    item.details = details;
  }

  runtimeLogs.unshift(item);
  if (runtimeLogs.length > LOG_LIMIT) {
    runtimeLogs.length = LOG_LIMIT;
  }
}

function pushError(message, details = null) {
  status.errors.unshift({
    at: new Date().toISOString(),
    message
  });
  status.errors = status.errors.slice(0, 20);

  addLog('error', 'system', message, details);
}

function getLogs() {
  return runtimeLogs.slice();
}

function getStatusSnapshot() {
  return {
    ...status,
    connected_clients: emberBridge.getConnectedClients()
  };
}

function getTreeMapSnapshot() {
  const entries = [];
  for (const [entityId, path] of emberBridge.pathByEntity.entries()) {
    const exportDef = emberBridge.exportByEntity.get(entityId) || null;
    entries.push({
      entity_id: entityId,
      path,
      domain: exportDef ? exportDef.domain : null,
      device_name: exportDef ? exportDef.device_name : null,
      identifier: exportDef ? exportDef.identifier : null
    });
  }

  return entries.sort((a, b) => String(a.entity_id).localeCompare(String(b.entity_id)));
}

async function applyConfigNow(reason = 'manual') {
  const cfg = currentConfig;

  addLog('info', 'system', `Applying configuration (${reason})`);

  try {
    haClient.configure(cfg.home_assistant.url, cfg.home_assistant.token);

    if (cfg.home_assistant.url && cfg.home_assistant.token) {
      await haClient.start();
      if (haClient.authenticated) {
        await haClient.refreshStates();
      }
    } else {
      await haClient.stop();
      status.ha_reason = 'Configure Home Assistant URL and token';
      addLog('warn', 'ha', 'Home Assistant URL or token is missing');
    }
  } catch (error) {
    pushError(`HA apply failed: ${error.message}`);
  }

  try {
    emberBridge.configure({
      host: cfg.ember.host,
      port: cfg.ember.port,
      rootIdentifier: cfg.ember.root_identifier
    });

    const runtimeExports = enrichExportsForRuntime(cfg.exports);
    await emberBridge.restart(runtimeExports, new Map(haClient.stateCache));
  } catch (error) {
    pushError(`Ember apply failed: ${error.message}`);
  }

  for (const state of writeStateByEntity.values()) {
    if (state.timer) {
      clearTimeout(state.timer);
    }
  }
  writeStateByEntity.clear();

  status.ember_running = emberBridge.running;
  status.exported_count = cfg.exports.length;
  status.last_reload = new Date().toISOString();
  addLog('info', 'system', `Configuration applied (exports: ${cfg.exports.length}, ember_running: ${status.ember_running})`);
}

function applyConfig(reason = 'manual') {
  const seq = ++applySequence;
  const queuedBase = applyQueue.catch(() => {
    // keep queue alive after a failed apply
  });

  applyQueue = queuedBase.then(async () => {
    addLog('info', 'system', `Apply request #${seq} queued (${reason})`);
    await applyConfigNow(reason);
  });

  return applyQueue;
}

haClient.on('status', (s) => {
  status.ha_connected = Boolean(s.connected);
  status.ha_authenticated = Boolean(s.authenticated);
  status.ha_reason = s.reason || '';
});

haClient.on('state_changed', async ({ entity_id, new_state }) => {
  try {
    const result = await emberBridge.updateEntity(entity_id, new_state);
    if (result.updated) {
      const updates = Array.isArray(result.updates) ? result.updates : [];
      if (updates.length === 1) {
        const item = updates[0];
        addLog(
          'info',
          'ha',
          `HA update for ${item.entity_id}: sent to Ember path ${item.path}`,
          {
            value: item.value,
            clients_connected: result.clients_connected
          }
        );
      } else {
        addLog(
          'info',
          'ha',
          `HA update for ${entity_id}: sent ${updates.length} Ember values`,
          {
            updates: updates.slice(0, 6),
            clients_connected: result.clients_connected
          }
        );
      }
    }
  } catch (error) {
    pushError(`State update failed for ${entity_id}: ${error.message}`);
  }
});

emberBridge.on('request', (info) => {
  addLog(
    'info',
    'ember',
    `Client request from ${info.client || 'unknown'} on path ${info.path || '-'}`,
    {
      client: info.client || null,
      path: info.path || null
    }
  );
});

emberBridge.on('ember_event', (evt) => {
  if (!evt || evt.type === 'UNKNOWN') {
    return;
  }

  if (evt.type === 'SETVALUE' && evt.source === 'local') {
    return;
  }

  addLog('info', 'ember', evt.text, {
    type: evt.type,
    source: evt.source || null,
    path: evt.path || null
  });
});

emberBridge.on('remote_set', async (evt) => {
  const entityId = evt.entity_id;

  addLog('info', 'ember', `Remote SETVALUE from ${evt.source || 'unknown'} on path ${evt.path || '-'}`, {
    entity_id: entityId,
    value: evt.value,
    value_type: evt.value_type,
    access: evt.access
  });

  if (!entityId) {
    addLog('warn', 'forward', `No mapped entity for path ${evt.path || '-'}; not forwarded to HA`);
    return;
  }

  if (evt.access !== 'readWrite') {
    addLog('warn', 'forward', `Entity ${entityId} is ${evt.access || 'read'}; not forwarded to HA`);
    return;
  }

  queueRemoteWrite(evt);
});

async function boot() {
  const app = createApiServer({
    getConfig: () => currentConfig,
    setConfig: (cfg) => {
      currentConfig = saveConfig(configPath, cfg);
    },
    applyConfig: () => applyConfig('api'),
    getStatus: getStatusSnapshot,
    getTreeMap: getTreeMapSnapshot,
    getStates: () => haClient.getStatesArray(),
    getEntityMeta: (entityId, stateObj) => haClient.getEntityMeta(entityId, stateObj),
    getLogs,
    configFilePath: configPath
  });

  const server = http.createServer(app);
  server.listen(currentConfig.web.port, currentConfig.web.host, () => {
    console.log(`[web] UI listening on ${currentConfig.web.host}:${currentConfig.web.port}`);
    addLog('info', 'system', `Web UI listening on ${currentConfig.web.host}:${currentConfig.web.port}`);
  });

  await applyConfig('boot');

  setInterval(async () => {
    if (haClient.authenticated) {
      try {
        await haClient.refreshStates();
      } catch (error) {
        pushError(`Periodic refresh failed: ${error.message}`);
      }
    }
  }, 60000);

  const shutdown = async () => {
    console.log('[app] Shutting down');
    addLog('info', 'system', 'Gateway shutting down');

    try {
      await haClient.stop();
    } catch (error) {
      // ignore
    }

    try {
      await emberBridge.stop();
    } catch (error) {
      // ignore
    }

    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

boot().catch((error) => {
  console.error('[app] Fatal error:', error);
  process.exit(1);
});
