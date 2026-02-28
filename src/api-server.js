const express = require('express');
const path = require('path');
const { slugIdentifier, normalizeConfig } = require('./config');
const { buildVirtualEntityId, parseEntityRef } = require('./entity-ref');

const BOOLEAN_DOMAINS = new Set([
  'switch',
  'input_boolean',
  'binary_sensor',
  'light',
  'automation',
  'script',
  'person',
  'device_tracker',
  'remote',
  'media_player',
  'fan',
  'cover',
  'lock'
]);

const NUMERIC_DOMAINS = new Set([
  'number',
  'input_number'
]);

const ENUM_ATTRIBUTE_KEYS = [
  'options',
  'hvac_modes',
  'preset_modes',
  'fan_modes',
  'swing_modes',
  'swing_horizontal_modes',
  'effect_list',
  'operation_list'
];

const CLIMATE_MODE_PARAMETER_KEYS = new Set([
  'mode',
  'hvac_mode',
  'fan_mode',
  'preset_mode',
  'swing_mode'
]);

const CLIMATE_WRITABLE_VIRTUAL_KEYS = new Set([
  'target_temperature',
  'temperature',
  'fan_mode',
  'preset_mode',
  'swing_mode'
]);

const DEFINITELY_READ_ONLY_DOMAINS = new Set([
  'sensor',
  'binary_sensor'
]);

function isUnavailableValue(raw) {
  const normalized = String(raw || '').trim().toLowerCase();
  return normalized === '' || normalized === 'unknown' || normalized === 'unavailable' || normalized === 'none';
}

function domainOfEntity(entityId) {
  return entityId && entityId.includes('.') ? entityId.split('.')[0] : '';
}

function fallbackDeviceName(stateObj) {
  const friendly = stateObj && stateObj.attributes && stateObj.attributes.friendly_name
    ? String(stateObj.attributes.friendly_name).trim()
    : '';

  if (friendly) {
    const dashParts = friendly.split(' - ');
    if (dashParts.length > 1) {
      return String(dashParts[0] || '').trim();
    }
  }

  const objectId = stateObj && stateObj.entity_id && stateObj.entity_id.includes('.')
    ? stateObj.entity_id.split('.')[1]
    : '';

  if (objectId) {
    const parts = objectId.split('_').filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]} ${parts[1]}`;
    }
    if (parts.length === 1) {
      return parts[0];
    }
  }

  return 'Unassigned';
}

function deviceKeyFromName(deviceName) {
  const text = String(deviceName || '').trim().toLowerCase();
  const slug = text.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || 'unassigned';
}

function numberTypeFromValue(raw, attrs) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return 'real';
  }

  const step = attrs && attrs.step != null ? Number(attrs.step) : NaN;
  if (Number.isFinite(step) && Number.isInteger(step) && step >= 1 && Number.isInteger(parsed)) {
    return 'integer';
  }

  return Number.isInteger(parsed) ? 'integer' : 'real';
}

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

function extractEnumOptions(attrs, rawState, keys = ENUM_ATTRIBUTE_KEYS) {
  const all = [];

  for (const key of keys) {
    const value = attrs ? attrs[key] : null;
    if (Array.isArray(value)) {
      all.push(...value);
    }
  }

  if (all.length > 0 && !isUnavailableValue(rawState)) {
    all.push(String(rawState));
  }

  return dedupeStrings(all);
}

function inferTypeInfo(stateObj) {
  if (!stateObj) {
    return {
      suggested_type: 'string',
      enum_options: []
    };
  }

  const raw = String(stateObj.state ?? '').trim();
  const attrs = stateObj.attributes || {};
  const domain = domainOfEntity(stateObj.entity_id || '');
  const enumOptions = extractEnumOptions(attrs, raw);

  if (domain === 'button') {
    return {
      suggested_type: 'boolean',
      enum_options: []
    };
  }

  if (domain === 'climate') {
    const climateModes = extractEnumOptions(attrs, raw, ['hvac_modes']);
    if (climateModes.length > 0) {
      return {
        suggested_type: 'enum',
        enum_options: climateModes
      };
    }

    return {
      suggested_type: 'string',
      enum_options: []
    };
  }

  if (domain === 'select' || domain === 'input_select') {
    return {
      suggested_type: 'enum',
      enum_options: enumOptions
    };
  }

  if (NUMERIC_DOMAINS.has(domain)) {
    return {
      suggested_type: numberTypeFromValue(raw, attrs),
      enum_options: []
    };
  }

  if (BOOLEAN_DOMAINS.has(domain)) {
    return {
      suggested_type: 'boolean',
      enum_options: []
    };
  }

  if (!isUnavailableValue(raw)) {
    const normalized = raw.toLowerCase();
    if (normalized === 'on' || normalized === 'off' || normalized === 'true' || normalized === 'false') {
      return {
        suggested_type: 'boolean',
        enum_options: []
      };
    }

    const n = Number(raw);
    if (!Number.isNaN(n) && Number.isFinite(n)) {
      return {
        suggested_type: Number.isInteger(n) ? 'integer' : 'real',
        enum_options: []
      };
    }
  }

  if (enumOptions.length > 0) {
    return {
      suggested_type: 'enum',
      enum_options: enumOptions
    };
  }

  return {
    suggested_type: 'string',
    enum_options: []
  };
}

function inferType(stateObj) {
  return inferTypeInfo(stateObj).suggested_type;
}

function climateSectionForParameter(parameterKey) {
  return CLIMATE_MODE_PARAMETER_KEYS.has(String(parameterKey || '').trim()) ? 'mode' : 'attributes';
}

function accessOptionsForEntity(domain, isVirtual = false, parameterKey = null) {
  const normalizedDomain = String(domain || '').trim().toLowerCase();
  const normalizedKey = String(parameterKey || '').trim();

  if (normalizedDomain === 'climate' && isVirtual) {
    if (!CLIMATE_WRITABLE_VIRTUAL_KEYS.has(normalizedKey)) {
      return ['read'];
    }
    return ['read', 'readWrite'];
  }

  if (DEFINITELY_READ_ONLY_DOMAINS.has(normalizedDomain)) {
    return ['read'];
  }

  return ['read', 'readWrite'];
}

function resolveAccessFromExport(exportDef, accessOptions, defaultAccess = 'read') {
  const safeOptions = Array.isArray(accessOptions) && accessOptions.length > 0 ? accessOptions : ['read'];
  const fallback = safeOptions.includes(defaultAccess) ? defaultAccess : safeOptions[0];
  const hasExport = Boolean(exportDef);
  const hasUserOverride = Boolean(hasExport && exportDef.access_user_set === true);
  const currentAccess = hasExport && exportDef.access ? String(exportDef.access) : null;

  if (hasUserOverride && currentAccess && safeOptions.includes(currentAccess)) {
    return {
      access: currentAccess,
      access_user_set: true
    };
  }

  return {
    access: fallback,
    access_user_set: hasUserOverride
  };
}

function stateValueToText(value) {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function buildClimateVirtualEntities(stateObj, exportMap, meta) {
  const attrs = stateObj && stateObj.attributes ? stateObj.attributes : {};
  const baseEntityId = stateObj.entity_id;
  const baseFriendlyName = attrs.friendly_name ? String(attrs.friendly_name) : baseEntityId;
  const out = [];

  const pushNumeric = (parameterKey, label, rawValue, access, attrsForTyping = {}, extras = {}) => {
    if (rawValue == null || rawValue === '') {
      return;
    }

    const virtualId = buildVirtualEntityId(baseEntityId, parameterKey);
    const exportDef = exportMap.get(virtualId);
    const suggestedType = numberTypeFromValue(String(rawValue), attrsForTyping);
    const accessOptions = accessOptionsForEntity('climate', true, parameterKey);
    const accessResolved = resolveAccessFromExport(exportDef, accessOptions, String(access || 'read'));

    out.push({
      entity_id: virtualId,
      source_entity_id: baseEntityId,
      is_virtual: true,
      parameter_key: parameterKey,
      parameter_label: label,
      climate_section: climateSectionForParameter(parameterKey),
      friendly_name: `${baseFriendlyName} - ${label}`,
      state: stateValueToText(rawValue),
      domain: 'climate',
      device_name: meta.device_name,
      device_key: meta.device_key,
      device_id: meta.device_id,
      selected: Boolean(exportDef),
      type: exportDef ? exportDef.type : suggestedType,
      access: accessResolved.access,
      access_options: accessOptions,
      access_user_set: accessResolved.access_user_set,
      identifier: exportDef ? exportDef.identifier : slugIdentifier(virtualId),
      description: exportDef && exportDef.description ? String(exportDef.description) : `${baseFriendlyName} - ${label}`,
      write_cooldown_ms: exportDef && exportDef.write_cooldown_ms != null ? Number(exportDef.write_cooldown_ms) : null,
      write_debounce_ms: exportDef && exportDef.write_debounce_ms != null ? Number(exportDef.write_debounce_ms) : null,
      suggested_type: suggestedType,
      enum_options: [],
      enum_map: [],
      ...extras
    });
  };

  const pushEnum = (parameterKey, label, valueKey, optionsKey, access) => {
    const options = Array.isArray(attrs[optionsKey]) ? dedupeStrings(attrs[optionsKey]) : [];
    const rawValue = attrs[valueKey] != null ? String(attrs[valueKey]) : '';
    const enumOptions = dedupeStrings(options.concat(rawValue ? [rawValue] : []));
    if (enumOptions.length === 0 && !rawValue) {
      return;
    }

    const virtualId = buildVirtualEntityId(baseEntityId, parameterKey);
    const exportDef = exportMap.get(virtualId);
    const accessOptions = accessOptionsForEntity('climate', true, parameterKey);
    const accessResolved = resolveAccessFromExport(exportDef, accessOptions, String(access || 'read'));
    const enumMap = Array.isArray(exportDef && exportDef.enum_map)
      ? exportDef.enum_map
      : enumOptions.map((key, idx) => ({ key, value: idx }));

    out.push({
      entity_id: virtualId,
      source_entity_id: baseEntityId,
      is_virtual: true,
      parameter_key: parameterKey,
      parameter_label: label,
      climate_section: climateSectionForParameter(parameterKey),
      friendly_name: `${baseFriendlyName} - ${label}`,
      state: rawValue,
      domain: 'climate',
      device_name: meta.device_name,
      device_key: meta.device_key,
      device_id: meta.device_id,
      selected: Boolean(exportDef),
      type: exportDef ? exportDef.type : 'enum',
      access: accessResolved.access,
      access_options: accessOptions,
      access_user_set: accessResolved.access_user_set,
      identifier: exportDef ? exportDef.identifier : slugIdentifier(virtualId),
      description: exportDef && exportDef.description ? String(exportDef.description) : `${baseFriendlyName} - ${label}`,
      write_cooldown_ms: exportDef && exportDef.write_cooldown_ms != null ? Number(exportDef.write_cooldown_ms) : null,
      write_debounce_ms: exportDef && exportDef.write_debounce_ms != null ? Number(exportDef.write_debounce_ms) : null,
      suggested_type: 'enum',
      enum_options: enumOptions,
      enum_map: enumMap
    });
  };

  pushNumeric(
    'target_temperature',
    'Target Temperature',
    attrs.temperature,
    'readWrite',
    { step: attrs.target_temp_step },
    {
      min: Number.isFinite(Number(attrs.min_temp)) ? Number(attrs.min_temp) : null,
      max: Number.isFinite(Number(attrs.max_temp)) ? Number(attrs.max_temp) : null,
      step: Number.isFinite(Number(attrs.target_temp_step)) ? Number(attrs.target_temp_step) : null
    }
  );

  pushNumeric('current_temperature', 'Current Temperature', attrs.current_temperature, 'read');
  pushEnum('fan_mode', 'Fan Mode', 'fan_mode', 'fan_modes', 'readWrite');
  pushEnum('preset_mode', 'Preset Mode', 'preset_mode', 'preset_modes', 'readWrite');
  pushEnum('swing_mode', 'Swing Mode', 'swing_mode', 'swing_modes', 'readWrite');

  return out;
}

function entitiesFromStates(states, exportsList, getEntityMeta = null) {
  const exportMap = new Map(exportsList.map((x) => [x.entity_id, x]));
  const entities = [];

  states
    .slice()
    .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
    .forEach((stateObj) => {
      const domain = stateObj.entity_id.includes('.') ? stateObj.entity_id.split('.')[0] : '';
      const exportDef = exportMap.get(stateObj.entity_id);
      const inferred = inferTypeInfo(stateObj);
      const suggestedType = inferred.suggested_type;
      const friendlyName = stateObj.attributes && stateObj.attributes.friendly_name
        ? String(stateObj.attributes.friendly_name)
        : stateObj.entity_id;
      const meta = typeof getEntityMeta === 'function' ? (getEntityMeta(stateObj.entity_id, stateObj) || null) : null;
      const deviceName = meta && meta.device_name ? String(meta.device_name) : fallbackDeviceName(stateObj);
      const deviceKey = meta && meta.device_key ? String(meta.device_key) : deviceKeyFromName(deviceName);
      const deviceId = meta && meta.device_id ? String(meta.device_id) : null;
      const accessOptions = accessOptionsForEntity(domain, false, null);
      const defaultAccess = accessOptions.includes('readWrite') ? 'readWrite' : 'read';
      const accessResolved = resolveAccessFromExport(exportDef, accessOptions, defaultAccess);

      const enumMap = Array.isArray(exportDef && exportDef.enum_map)
        ? exportDef.enum_map
        : inferred.enum_options.map((key, idx) => ({ key, value: idx }));

      entities.push({
        entity_id: stateObj.entity_id,
        friendly_name: friendlyName,
        state: String(stateObj.state ?? ''),
        domain,
        source_entity_id: stateObj.entity_id,
        is_virtual: false,
        parameter_key: null,
        parameter_label: null,
        climate_section: domain === 'climate' ? 'mode' : null,
        device_name: deviceName,
        device_key: deviceKey,
        device_id: deviceId,
        selected: Boolean(exportDef),
        type: exportDef ? exportDef.type : suggestedType,
        access: accessResolved.access,
        access_options: accessOptions,
        access_user_set: accessResolved.access_user_set,
        identifier: exportDef ? exportDef.identifier : slugIdentifier(stateObj.entity_id),
        description: exportDef && exportDef.description ? String(exportDef.description) : friendlyName,
        write_cooldown_ms: exportDef && exportDef.write_cooldown_ms != null ? Number(exportDef.write_cooldown_ms) : null,
        write_debounce_ms: exportDef && exportDef.write_debounce_ms != null ? Number(exportDef.write_debounce_ms) : null,
        suggested_type: suggestedType,
        enum_options: inferred.enum_options,
        enum_map: enumMap
      });

      if (domain === 'climate') {
        entities.push(...buildClimateVirtualEntities(stateObj, exportMap, {
          device_name: deviceName,
          device_key: deviceKey,
          device_id: deviceId
        }));
      }
    });

  return entities.sort((a, b) => a.entity_id.localeCompare(b.entity_id));
}

function sanitizeConfigAccess(config) {
  const exportsList = Array.isArray(config && config.exports) ? config.exports : [];
  const sanitizedExports = exportsList.map((item) => {
    const ref = parseEntityRef(item && item.entity_id ? item.entity_id : '');
    const domain = ref.base_entity_id && ref.base_entity_id.includes('.')
      ? ref.base_entity_id.split('.')[0]
      : '';
    const accessOptions = accessOptionsForEntity(domain, ref.isVirtual, ref.parameter_key);
    const currentAccess = item && item.access ? String(item.access) : 'read';
    const resolvedAccess = accessOptions.includes(currentAccess) ? currentAccess : accessOptions[0];

    if (resolvedAccess === currentAccess) {
      return item;
    }

    return {
      ...item,
      access: resolvedAccess
    };
  });

  return {
    ...config,
    exports: sanitizedExports
  };
}

function createApiServer(options) {
  const {
    getConfig,
    setConfig,
    applyConfig,
    getStatus,
    getTreeMap,
    getStates,
    getEntityMeta,
    getLogs,
    configFilePath
  } = options;

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/status', (_req, res) => {
    res.json(getStatus());
  });

  app.get('/api/logs', (_req, res) => {
    const logs = typeof getLogs === 'function' ? getLogs() : [];
    res.json({ logs });
  });

  app.get('/api/tree-map', (_req, res) => {
    const entries = typeof getTreeMap === 'function' ? getTreeMap() : [];
    res.json({ entries });
  });

  app.get('/api/config', (_req, res) => {
    const cfg = getConfig();
    res.json(cfg);
  });

  app.get('/api/entities', (_req, res) => {
    const cfg = getConfig();
    const states = getStates();
    res.json({
      entities: entitiesFromStates(states, cfg.exports, getEntityMeta)
    });
  });

  app.post('/api/config', async (req, res) => {
    try {
      const raw = req.body || {};
      const normalized = normalizeConfig(raw);
      const sanitized = sanitizeConfigAccess(normalized);
      setConfig(sanitized);
      await applyConfig();
      res.json({ success: true, config: getConfig() });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/reload', async (_req, res) => {
    try {
      await applyConfig();
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/info', (_req, res) => {
    res.json({
      config_file: configFilePath,
      version: '0.1.5'
    });
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use((_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  return app;
}

module.exports = {
  createApiServer,
  entitiesFromStates,
  inferType,
  accessOptionsForEntity,
  resolveAccessFromExport
};
