const VIRTUAL_SEPARATOR = '::';

function parseEntityRef(entityId) {
  const raw = String(entityId || '').trim();
  if (!raw) {
    return {
      raw: '',
      isVirtual: false,
      base_entity_id: '',
      parameter_key: null
    };
  }

  const sepIndex = raw.indexOf(VIRTUAL_SEPARATOR);
  if (sepIndex <= 0 || sepIndex >= raw.length - VIRTUAL_SEPARATOR.length) {
    return {
      raw,
      isVirtual: false,
      base_entity_id: raw,
      parameter_key: null
    };
  }

  const baseEntityId = raw.slice(0, sepIndex).trim();
  const parameterKey = raw.slice(sepIndex + VIRTUAL_SEPARATOR.length).trim();

  if (!baseEntityId || !parameterKey) {
    return {
      raw,
      isVirtual: false,
      base_entity_id: raw,
      parameter_key: null
    };
  }

  return {
    raw,
    isVirtual: true,
    base_entity_id: baseEntityId,
    parameter_key: parameterKey
  };
}

function buildVirtualEntityId(baseEntityId, parameterKey) {
  const base = String(baseEntityId || '').trim();
  const parameter = String(parameterKey || '').trim();
  if (!base || !parameter) {
    return '';
  }
  return `${base}${VIRTUAL_SEPARATOR}${parameter}`;
}

module.exports = {
  VIRTUAL_SEPARATOR,
  parseEntityRef,
  buildVirtualEntityId
};
