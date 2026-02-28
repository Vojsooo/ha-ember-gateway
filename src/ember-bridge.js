const EventEmitter = require('events');
const { EmberServer, EmberServerEvent } = require('node-emberplus');
const { parseEntityRef } = require('./entity-ref');

function dedupeStrings(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const text = String(v || '').trim();
    if (!text) {
      continue;
    }
    if (seen.has(text)) {
      continue;
    }
    seen.add(text);
    out.push(text);
  }
  return out;
}

function extractEnumOptionsFromState(stateObj, ref = null) {
  const attrs = stateObj && stateObj.attributes ? stateObj.attributes : {};
  const domain = stateObj && stateObj.entity_id && stateObj.entity_id.includes('.')
    ? stateObj.entity_id.split('.')[0]
    : '';
  let keys = [
    'options',
    'hvac_modes',
    'preset_modes',
    'fan_modes',
    'swing_modes',
    'swing_horizontal_modes',
    'effect_list',
    'operation_list'
  ];
  let raw = stateObj ? String(stateObj.state ?? '').trim() : '';

  if (ref && ref.isVirtual && domain === 'climate') {
    if (ref.parameter_key === 'fan_mode') {
      keys = ['fan_modes'];
      raw = attrs.fan_mode != null ? String(attrs.fan_mode).trim() : '';
    } else if (ref.parameter_key === 'preset_mode') {
      keys = ['preset_modes'];
      raw = attrs.preset_mode != null ? String(attrs.preset_mode).trim() : '';
    } else if (ref.parameter_key === 'swing_mode') {
      keys = ['swing_modes'];
      raw = attrs.swing_mode != null ? String(attrs.swing_mode).trim() : '';
    } else {
      keys = [];
      raw = '';
    }
  } else if (!ref || !ref.isVirtual) {
    if (domain === 'climate') {
      keys = ['hvac_modes'];
    }
  }

  const options = [];
  for (const key of keys) {
    if (Array.isArray(attrs[key])) {
      options.push(...attrs[key]);
    }
  }

  if (options.length > 0 && raw && raw !== 'unknown' && raw !== 'unavailable') {
    options.push(raw);
  }

  return dedupeStrings(options);
}

function normalizeEnumMap(enumMap, stateObj, ref = null) {
  if (Array.isArray(enumMap) && enumMap.length > 0) {
    return enumMap
      .map((entry) => ({
        key: String(entry && entry.key != null ? entry.key : '').trim(),
        value: Number(entry && entry.value != null ? entry.value : NaN)
      }))
      .filter((entry) => entry.key && Number.isInteger(entry.value))
      .sort((a, b) => a.value - b.value);
  }

  const options = extractEnumOptionsFromState(stateObj, ref);
  return options.map((key, idx) => ({ key, value: idx }));
}

function mapStateToEnumValue(rawState, enumMap) {
  if (!Array.isArray(enumMap) || enumMap.length === 0) {
    return 0;
  }

  const exact = enumMap.find((entry) => entry.key === rawState);
  if (exact) {
    return exact.value;
  }

  const lower = rawState.toLowerCase();
  const caseInsensitive = enumMap.find((entry) => entry.key.toLowerCase() === lower);
  if (caseInsensitive) {
    return caseInsensitive.value;
  }

  return enumMap[0].value;
}

function valueFromRaw(rawInput, type, enumMap = []) {
  const rawText = rawInput == null ? '' : String(rawInput);
  const normalized = rawText.trim().toLowerCase();

  if (normalized === 'unknown' || normalized === 'unavailable' || rawText === '') {
    if (type === 'enum') {
      return Array.isArray(enumMap) && enumMap.length > 0 ? enumMap[0].value : 0;
    }
    if (type === 'boolean') {
      return false;
    }
    if (type === 'integer' || type === 'real') {
      return 0;
    }
    return '';
  }

  if (type === 'boolean') {
    if (typeof rawInput === 'boolean') {
      return rawInput;
    }
    if (typeof rawInput === 'number') {
      return rawInput !== 0;
    }
    return normalized === 'on' || normalized === 'true' || normalized === '1';
  }

  if (type === 'integer') {
    const parsed = parseInt(rawText, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  if (type === 'real') {
    const parsed = parseFloat(rawText);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  if (type === 'enum') {
    return mapStateToEnumValue(rawText, enumMap);
  }

  return rawText;
}

function getVirtualRawValue(stateObj, parameterKey) {
  const attrs = stateObj && stateObj.attributes ? stateObj.attributes : {};
  if (parameterKey === 'target_temperature' || parameterKey === 'temperature') {
    return attrs.temperature;
  }
  if (parameterKey === 'current_temperature') {
    return attrs.current_temperature;
  }
  if (parameterKey === 'fan_mode') {
    return attrs.fan_mode;
  }
  if (parameterKey === 'preset_mode') {
    return attrs.preset_mode;
  }
  if (parameterKey === 'swing_mode') {
    return attrs.swing_mode;
  }
  if (Object.prototype.hasOwnProperty.call(attrs, parameterKey)) {
    return attrs[parameterKey];
  }
  return null;
}

function valueFromExport(stateObj, exportDef, enumMap = []) {
  if (!exportDef) {
    return '';
  }

  const ref = parseEntityRef(exportDef.entity_id);
  const rawValue = ref.isVirtual
    ? getVirtualRawValue(stateObj, ref.parameter_key)
    : (stateObj ? stateObj.state : null);

  return valueFromRaw(rawValue, exportDef.type, enumMap);
}

function valueFromState(stateObj, type, enumMap = []) {
  const rawValue = stateObj ? stateObj.state : null;
  return valueFromRaw(rawValue, type, enumMap);
}

function normalizeNodeIdentifier(value, fallback = 'node') {
  const raw = String(value || '').trim().toLowerCase();
  let out = raw.replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!out) {
    out = fallback;
  }
  if (!/^[a-z_]/.test(out)) {
    out = `_${out}`;
  }
  return out;
}

function guessDeviceName(sourceEntityId, stateObj = null) {
  const friendlyName = stateObj && stateObj.attributes && stateObj.attributes.friendly_name
    ? String(stateObj.attributes.friendly_name).trim()
    : '';

  if (friendlyName) {
    const dashParts = friendlyName.split(' - ');
    if (dashParts.length > 1) {
      return String(dashParts[0] || '').trim() || friendlyName;
    }

    const colonParts = friendlyName.split(':');
    if (colonParts.length > 1) {
      return String(colonParts[0] || '').trim() || friendlyName;
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

  return 'unassigned';
}

function parseServerEvent(serverEvent) {
  const text = serverEvent ? String(serverEvent.toString ? serverEvent.toString() : serverEvent) : '';
  const typeNum = typeof (serverEvent && serverEvent.type) === 'number' ? serverEvent.type : 0;
  const eventTypeMap = {
    1: 'SETVALUE',
    2: 'GETDIRECTORY',
    3: 'SUBSCRIBE',
    4: 'UNSUBSCRIBE',
    5: 'INVOKE',
    6: 'MATRIX_CONNECTION'
  };

  const parsed = {
    type: eventTypeMap[typeNum] || 'UNKNOWN',
    text,
    timestamp: serverEvent && serverEvent.timestamp ? new Date(serverEvent.timestamp).toISOString() : new Date().toISOString(),
    path: null,
    source: null,
    identifier: null
  };

  const match = text.match(/\(path:\s*([^)]+)\)\s*from\s*(.+)$/i);
  if (match) {
    parsed.path = match[1].trim();
    parsed.source = match[2].trim();
  }

  const idMatch = text.match(/(?:for|to)\s+(.+?)\(path:/i);
  if (idMatch) {
    parsed.identifier = idMatch[1].trim();
  }

  return parsed;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTimeout(promise, timeoutMs) {
  let timer = null;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });

  try {
    const result = await Promise.race([
      promise.then(() => ({ timedOut: false })).catch((error) => ({ timedOut: false, error })),
      timeoutPromise
    ]);
    return result;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

class EmberBridge extends EventEmitter {
  constructor() {
    super();
    this.host = '0.0.0.0';
    this.port = 9000;
    this.rootIdentifier = 'homeassistant';

    this.server = null;
    this.pathByEntity = new Map();
    this.exportByEntity = new Map();
    this.exportByPath = new Map();
    this.exportIdsBySourceEntity = new Map();
    this.running = false;
    this.restartPromise = Promise.resolve();
  }

  configure(options) {
    this.host = options.host;
    this.port = options.port;
    this.rootIdentifier = options.rootIdentifier;
  }

  buildTreeJson(exportsList, stateByEntity) {
    const rootChildren = [];
    this.pathByEntity.clear();
    this.exportByEntity.clear();
    this.exportByPath.clear();
    this.exportIdsBySourceEntity.clear();

    const devices = new Map();

    for (const item of exportsList) {
      if (!item || !item.entity_id) {
        continue;
      }

      const ref = parseEntityRef(item.entity_id);
      const sourceEntityId = item.source_entity_id || ref.base_entity_id;
      const stateObj = stateByEntity.get(sourceEntityId) || null;
      const enumMap = item.type === 'enum' ? normalizeEnumMap(item.enum_map, stateObj, ref) : [];
      const value = valueFromExport(stateObj, item, enumMap);
      const access = item.access === 'readWrite' ? 'readWrite' : 'read';

      const domain = String(
        item.domain || (sourceEntityId && sourceEntityId.includes('.') ? sourceEntityId.split('.')[0] : 'other')
      ).trim().toLowerCase() || 'other';

      const deviceName = String(item.device_name || '').trim() || guessDeviceName(sourceEntityId, stateObj);
      const deviceKey = String(item.device_key || '').trim() || normalizeNodeIdentifier(deviceName, 'unassigned');
      const deviceIdentifier = normalizeNodeIdentifier(deviceKey, 'device');

      if (!devices.has(deviceKey)) {
        devices.set(deviceKey, {
          key: deviceKey,
          name: deviceName,
          identifier: deviceIdentifier,
          domains: new Map()
        });
      }

      const deviceGroup = devices.get(deviceKey);
      if (!deviceGroup.domains.has(domain)) {
        deviceGroup.domains.set(domain, {
          key: domain,
          identifier: normalizeNodeIdentifier(domain, 'type'),
          params: []
        });
      }

      deviceGroup.domains.get(domain).params.push({
        item,
        ref,
        sourceEntityId,
        enumMap,
        value,
        access
      });

      if (!this.exportIdsBySourceEntity.has(sourceEntityId)) {
        this.exportIdsBySourceEntity.set(sourceEntityId, new Set());
      }
      this.exportIdsBySourceEntity.get(sourceEntityId).add(item.entity_id);
    }

    const sortedDevices = Array.from(devices.values()).sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) {
        return byName;
      }
      return a.key.localeCompare(b.key);
    });

    for (let deviceIndex = 0; deviceIndex < sortedDevices.length; deviceIndex += 1) {
      const deviceGroup = sortedDevices[deviceIndex];
      const domainChildren = [];

      const sortedDomains = Array.from(deviceGroup.domains.values()).sort((a, b) => a.key.localeCompare(b.key));
      let domainNodeIndex = 0;

      for (let domainIndex = 0; domainIndex < sortedDomains.length; domainIndex += 1) {
        const domainGroup = sortedDomains[domainIndex];

        const sortedParams = domainGroup.params
          .slice()
          .sort((a, b) => {
            const byIdentifier = String(a.item.identifier || '').localeCompare(String(b.item.identifier || ''));
            if (byIdentifier !== 0) {
              return byIdentifier;
            }
            return String(a.item.entity_id || '').localeCompare(String(b.item.entity_id || ''));
          });

        const createParamNode = (entry, path, number, effectiveDomain = domainGroup.key) => {
          const description = String(
            entry.item.description || entry.item.friendly_name || entry.item.parameter_label || entry.item.entity_id
          ).trim() || entry.item.entity_id;

          const storedItem = {
            ...entry.item,
            source_entity_id: entry.sourceEntityId,
            domain: effectiveDomain,
            device_name: deviceGroup.name,
            device_key: deviceGroup.key,
            description,
            ...(entry.item.type === 'enum' ? { enum_map: entry.enumMap } : {})
          };

          this.pathByEntity.set(entry.item.entity_id, path);
          this.exportByEntity.set(entry.item.entity_id, storedItem);
          this.exportByPath.set(path, storedItem);

          return {
            number,
            identifier: entry.item.identifier,
            value: entry.value,
            type: entry.item.type,
            access: entry.access,
            description,
            ...(entry.item.type === 'enum' ? { enumMap: entry.enumMap } : {})
          };
        };

        if (domainGroup.key === 'climate') {
          const sections = new Map();
          for (const entry of sortedParams) {
            const inferredSection = entry.ref && entry.ref.isVirtual
              ? (entry.ref.parameter_key === 'fan_mode'
                || entry.ref.parameter_key === 'preset_mode'
                || entry.ref.parameter_key === 'swing_mode'
                || entry.ref.parameter_key === 'mode'
                || entry.ref.parameter_key === 'hvac_mode'
                ? 'mode'
                : 'attributes')
              : 'mode';

            const sectionKey = String(entry.item.climate_section || inferredSection).trim().toLowerCase() || 'attributes';
            if (!sections.has(sectionKey)) {
              sections.set(sectionKey, []);
            }
            sections.get(sectionKey).push(entry);
          }

          const sectionKeys = Array.from(sections.keys()).sort((a, b) => {
            if (a === 'mode' && b !== 'mode') {
              return -1;
            }
            if (a !== 'mode' && b === 'mode') {
              return 1;
            }
            return a.localeCompare(b);
          });

          for (let sectionIndex = 0; sectionIndex < sectionKeys.length; sectionIndex += 1) {
            const sectionKey = sectionKeys[sectionIndex];
            const entries = sections.get(sectionKey) || [];
            const paramChildren = [];

            for (let paramIndex = 0; paramIndex < entries.length; paramIndex += 1) {
              const entry = entries[paramIndex];
              const path = `0.${deviceIndex}.${domainNodeIndex}.${paramIndex}`;
              paramChildren.push(createParamNode(entry, path, paramIndex, 'climate'));
            }

            if (paramChildren.length > 0) {
              const climateNodeName = sectionKey === 'mode' ? 'climate_mode' : `climate_${sectionKey}`;
              const climateNodeDesc = sectionKey === 'mode' ? 'climate mode' : `climate ${sectionKey}`;

              domainChildren.push({
                number: domainNodeIndex,
                identifier: normalizeNodeIdentifier(climateNodeName, 'climate'),
                description: climateNodeDesc,
                children: paramChildren
              });
              domainNodeIndex += 1;
            }
          }

          continue;
        }

        const paramChildren = [];
        for (let paramIndex = 0; paramIndex < sortedParams.length; paramIndex += 1) {
          const entry = sortedParams[paramIndex];
          const path = `0.${deviceIndex}.${domainNodeIndex}.${paramIndex}`;
          paramChildren.push(createParamNode(entry, path, paramIndex));
        }

        if (paramChildren.length > 0) {
          domainChildren.push({
            number: domainNodeIndex,
            identifier: domainGroup.identifier,
            description: domainGroup.key,
            children: paramChildren
          });
          domainNodeIndex += 1;
        }
      }

      if (domainChildren.length > 0) {
        rootChildren.push({
          number: deviceIndex,
          identifier: deviceGroup.identifier,
          description: deviceGroup.name,
          children: domainChildren
        });
      }
    }

    return [
      {
        identifier: this.rootIdentifier,
        children: rootChildren
      }
    ];
  }

  attachServerListeners(serverInstance = this.server) {
    if (!serverInstance) {
      return;
    }

    serverInstance.on(EmberServerEvent.REQUEST, (info) => {
      this.emit('request', info || {});
    });

    serverInstance.on(EmberServerEvent.EVENT, (evt) => {
      const parsed = parseServerEvent(evt);
      this.emit('ember_event', parsed);

      if (parsed.type === 'SETVALUE' && parsed.source && parsed.source !== 'local' && parsed.path) {
        const exportDef = this.exportByPath.get(parsed.path) || null;
        const parameter = serverInstance.tree.getElementByPath(parsed.path);
        const value = parameter ? parameter.value : null;

        this.emit('remote_set', {
          source: parsed.source,
          path: parsed.path,
          identifier: parsed.identifier,
          entity_id: exportDef ? exportDef.entity_id : null,
          access: exportDef ? exportDef.access : null,
          value_type: exportDef ? exportDef.type : null,
          enum_map: exportDef && Array.isArray(exportDef.enum_map) ? exportDef.enum_map : [],
          write_cooldown_ms: exportDef && exportDef.write_cooldown_ms != null ? Number(exportDef.write_cooldown_ms) : null,
          write_debounce_ms: exportDef && exportDef.write_debounce_ms != null ? Number(exportDef.write_debounce_ms) : null,
          value
        });
      }
    });
  }

  getConnectedClients() {
    if (!this.server || typeof this.server.getConnectedClients !== 'function') {
      return [];
    }

    const clients = this.server.getConnectedClients();
    if (!Array.isArray(clients)) {
      return [];
    }

    return clients.map((client) => ({
      remoteAddress: client.remoteAddress || '',
      stats: client.stats || {}
    }));
  }

  async restart(exportsList, stateByEntity) {
    const queueBase = this.restartPromise.catch(() => {
      // keep queue alive after failure
    });
    this.restartPromise = queueBase.then(() => this.performRestart(exportsList, stateByEntity));
    return this.restartPromise;
  }

  async performRestart(exportsList, stateByEntity) {
    const treeJson = this.buildTreeJson(exportsList, stateByEntity);
    const tree = EmberServer.createTreeFromJSON(treeJson);

    const previousServer = this.server;
    this.server = null;
    this.running = false;

    if (previousServer) {
      try {
        const clients = previousServer.clients && typeof previousServer.clients[Symbol.iterator] === 'function'
          ? Array.from(previousServer.clients)
          : [];

        if (clients.length > 0) {
          await Promise.all(
            clients.map(async (client) => {
              if (client && typeof client.disconnectAsync === 'function') {
                try {
                  await withTimeout(client.disconnectAsync(10), 1200);
                } catch (_error) {
                  // ignore client disconnect error
                }
              }
            })
          );
        }

        const closeResult = await withTimeout(previousServer.closeAsync(), 1500);
        if (closeResult && closeResult.timedOut) {
          console.warn('[ember] Previous server close timed out; continuing restart');
        } else if (closeResult && closeResult.error) {
          console.warn('[ember] Previous server close failed:', closeResult.error.message || closeResult.error);
        }
      } catch (error) {
        console.error('[ember] Failed to close existing server:', error.message);
      }
    }

    await delay(120);

    const nextServer = new EmberServer({
      host: this.host,
      port: this.port,
      tree
    });

    nextServer.on('error', (error) => {
      console.error('[ember] Server error:', error.message || error);
    });

    nextServer.on('clientError', (info) => {
      console.error('[ember] Client error:', info);
    });

    this.attachServerListeners(nextServer);

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await nextServer.listen();
        this.server = nextServer;
        this.running = true;
        console.log(`[ember] Listening on ${this.host}:${this.port} with ${exportsList.length} exported entities`);
        return;
      } catch (error) {
        lastError = error;
        const errorText = String((error && error.code) || (error && error.message) || error || '');
        const addressInUse = errorText.includes('EADDRINUSE');

        if (!addressInUse || attempt >= 3) {
          break;
        }

        console.warn(`[ember] Port ${this.port} busy (attempt ${attempt}/3), retrying restart`);
        await delay(200 * attempt);
      }
    }

    this.server = null;
    this.running = false;
    throw lastError || new Error('Ember server restart failed');
  }

  async stop() {
    if (!this.server) {
      return;
    }

    try {
      await this.server.closeAsync();
    } catch (error) {
      console.error('[ember] Close failed:', error.message);
    }

    this.server = null;
    this.running = false;
  }

  async updateEntity(entityId, newState) {
    if (!this.server) {
      return {
        updated: false,
        reason: 'server_not_running'
      };
    }

    const exportIds = this.exportIdsBySourceEntity.get(entityId);
    if (!exportIds || exportIds.size === 0) {
      return {
        updated: false,
        reason: 'not_exported'
      };
    }

    const updates = [];
    for (const exportEntityId of exportIds) {
      const path = this.pathByEntity.get(exportEntityId);
      const exportDef = this.exportByEntity.get(exportEntityId);
      if (!path || !exportDef) {
        continue;
      }

      const element = this.server.tree.getElementByPath(path);
      if (!element) {
        continue;
      }

      const value = valueFromExport(newState, exportDef, exportDef.enum_map || []);
      this.server.setValue(element, value, null);
      updates.push({
        entity_id: exportEntityId,
        source_entity_id: entityId,
        path,
        value
      });
    }

    if (updates.length === 0) {
      return {
        updated: false,
        reason: 'missing_tree_element'
      };
    }

    return {
      updated: true,
      entity_id: entityId,
      updates,
      clients_connected: this.getConnectedClients().length
    };
  }
}

module.exports = {
  EmberBridge,
  valueFromState
};
