const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DEFAULT_CONFIG = {
  home_assistant: {
    url: '',
    token: ''
  },
  ember: {
    host: '0.0.0.0',
    port: 9000,
    root_identifier: 'homeassistant'
  },
  web: {
    host: '0.0.0.0',
    port: 8090
  },
  write_control: {
    cooldown_ms: 400,
    debounce_ms: 150
  },
  advanced: {
    enable_all_entities: false
  },
  exports: []
};

function slugIdentifier(value) {
  if (!value || typeof value !== 'string') {
    return 'entity';
  }

  let out = value
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!out) {
    out = 'entity';
  }

  if (!/^[A-Za-z_]/.test(out)) {
    out = `_${out}`;
  }

  return out;
}

function normalizeExportItem(item) {
  const entityId = String(item.entity_id || '').trim();
  if (!entityId) {
    return null;
  }

  const type = String(item.type || 'string').trim();
  const allowedTypes = new Set(['boolean', 'integer', 'real', 'string', 'enum']);
  const normalizedType = allowedTypes.has(type) ? type : 'string';

  const accessRaw = String(item.access || 'read').trim();
  const access = accessRaw === 'readWrite' ? 'readWrite' : 'read';
  const accessUserSet = item && item.access_user_set === true;
  const description = String(item.description || '').trim();

  const writeCooldownMsRaw = Number(item.write_cooldown_ms);
  const writeDebounceMsRaw = Number(item.write_debounce_ms);
  const writeCooldownMs = Number.isFinite(writeCooldownMsRaw) && writeCooldownMsRaw >= 0
    ? Math.floor(writeCooldownMsRaw)
    : null;
  const writeDebounceMs = Number.isFinite(writeDebounceMsRaw) && writeDebounceMsRaw >= 0
    ? Math.floor(writeDebounceMsRaw)
    : null;

  let enumMap = [];
  if (Array.isArray(item.enum_map)) {
    enumMap = item.enum_map
      .map((entry) => ({
        key: String(entry && entry.key != null ? entry.key : '').trim(),
        value: Number(entry && entry.value != null ? entry.value : NaN)
      }))
      .filter((entry) => entry.key && Number.isInteger(entry.value))
      .sort((a, b) => a.value - b.value);
  } else if (Array.isArray(item.enum_options)) {
    enumMap = item.enum_options
      .map((opt, idx) => ({
        key: String(opt || '').trim(),
        value: idx
      }))
      .filter((entry) => entry.key);
  }

  return {
    entity_id: entityId,
    identifier: slugIdentifier(item.identifier || entityId),
    type: normalizedType,
    access,
    ...(accessUserSet ? { access_user_set: true } : {}),
    ...(description ? { description } : {}),
    ...(writeCooldownMs != null ? { write_cooldown_ms: writeCooldownMs } : {}),
    ...(writeDebounceMs != null ? { write_debounce_ms: writeDebounceMs } : {}),
    ...(normalizedType === 'enum' ? { enum_map: enumMap } : {})
  };
}

function normalizeNonNegativeInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function normalizeConfig(input) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...input,
    home_assistant: {
      ...DEFAULT_CONFIG.home_assistant,
      ...(input && input.home_assistant ? input.home_assistant : {})
    },
    ember: {
      ...DEFAULT_CONFIG.ember,
      ...(input && input.ember ? input.ember : {})
    },
    web: {
      ...DEFAULT_CONFIG.web,
      ...(input && input.web ? input.web : {})
    },
    write_control: {
      ...DEFAULT_CONFIG.write_control,
      ...(input && input.write_control ? input.write_control : {})
    },
    advanced: {
      ...DEFAULT_CONFIG.advanced,
      ...(input && input.advanced ? input.advanced : {})
    }
  };

  const exportsList = Array.isArray(merged.exports) ? merged.exports : [];
  const normalizedExports = exportsList
    .map(normalizeExportItem)
    .filter(Boolean);

  merged.home_assistant.url = String(merged.home_assistant.url || '').trim();
  merged.home_assistant.token = String(merged.home_assistant.token || '').trim();

  merged.ember.host = String(merged.ember.host || '0.0.0.0').trim() || '0.0.0.0';
  merged.ember.port = Number(merged.ember.port || 9000);
  if (!Number.isInteger(merged.ember.port) || merged.ember.port < 1 || merged.ember.port > 65535) {
    merged.ember.port = 9000;
  }
  merged.ember.root_identifier = slugIdentifier(merged.ember.root_identifier || 'homeassistant');

  merged.web.host = String(merged.web.host || '0.0.0.0').trim() || '0.0.0.0';
  merged.web.port = Number(merged.web.port || 8090);
  if (!Number.isInteger(merged.web.port) || merged.web.port < 1 || merged.web.port > 65535) {
    merged.web.port = 8090;
  }

  merged.write_control = {
    cooldown_ms: normalizeNonNegativeInt(
      merged.write_control && merged.write_control.cooldown_ms,
      DEFAULT_CONFIG.write_control.cooldown_ms
    ),
    debounce_ms: normalizeNonNegativeInt(
      merged.write_control && merged.write_control.debounce_ms,
      DEFAULT_CONFIG.write_control.debounce_ms
    )
  };

  merged.advanced = {
    enable_all_entities: Boolean(
      merged.advanced && merged.advanced.enable_all_entities === true
    )
  };

  merged.exports = normalizedExports;
  return merged;
}

function ensureConfigDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadConfig(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return normalizeConfig(DEFAULT_CONFIG);
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = raw.trim() ? yaml.load(raw) : {};
    return normalizeConfig(parsed || {});
  } catch (error) {
    console.error('[config] Failed to load config, using defaults:', error.message);
    return normalizeConfig(DEFAULT_CONFIG);
  }
}

function saveConfig(filePath, config) {
  ensureConfigDir(filePath);
  const normalized = normalizeConfig(config);
  const body = yaml.dump(normalized, {
    lineWidth: 140,
    noRefs: true,
    sortKeys: false
  });
  fs.writeFileSync(filePath, body, 'utf8');
  return normalized;
}

module.exports = {
  DEFAULT_CONFIG,
  slugIdentifier,
  normalizeConfig,
  loadConfig,
  saveConfig
};
