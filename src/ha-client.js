const EventEmitter = require('events');
const WebSocket = require('ws');
const { parseEntityRef } = require('./entity-ref');

function toWsUrl(baseUrl) {
  const trimmed = String(baseUrl || '').trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
    const wsBase = trimmed.replace(/\/$/, '');
    if (wsBase.endsWith('/core') || wsBase.endsWith('/core/api') || wsBase.endsWith('/core/websocket')) {
      return wsBase.replace(/\/core(?:\/api|\/websocket)?$/, '/core/websocket');
    }
    if (wsBase.endsWith('/api') || wsBase.endsWith('/api/websocket')) {
      return wsBase.replace(/\/api(?:\/websocket)?$/, '/api/websocket');
    }
    return `${wsBase}/api/websocket`;
  }

  const withScheme = trimmed.includes('://') ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    const origin = `${wsProtocol}//${parsed.host}`;
    const path = parsed.pathname.replace(/\/+$/, '');

    if (!path || path === '/') {
      return `${origin}/api/websocket`;
    }

    if (path === '/api' || path === '/api/websocket') {
      return `${origin}/api/websocket`;
    }

    if (path === '/core' || path === '/core/api' || path === '/core/websocket') {
      return `${origin}/core/websocket`;
    }

    return `${origin}${path}/api/websocket`;
  } catch (error) {
    return `ws://${trimmed.replace(/\/$/, '')}/api/websocket`;
  }
}

function isSupervisorModeUrl(url) {
  const text = String(url || '').trim().toLowerCase();
  if (!text) {
    return false;
  }
  return text.includes('://supervisor/core') || text.includes('://supervisor.local/core');
}

function firstNonEmptyText(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) {
      return text;
    }
  }
  return '';
}

function slugText(value, fallback = 'unassigned') {
  const text = String(value || '').trim().toLowerCase();
  const slug = text.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || fallback;
}

function guessDeviceNameFromFriendlyName(friendlyName) {
  const text = String(friendlyName || '').trim();
  if (!text) {
    return '';
  }

  const dashParts = text.split(' - ');
  if (dashParts.length > 1) {
    return String(dashParts[0] || '').trim();
  }

  const colonParts = text.split(':');
  if (colonParts.length > 1) {
    return String(colonParts[0] || '').trim();
  }

  return '';
}

function guessDeviceNameFromEntityId(entityId) {
  const objectId = entityId && entityId.includes('.') ? entityId.split('.')[1] : '';
  if (!objectId) {
    return 'Unassigned';
  }

  const parts = objectId.split('_').filter(Boolean);
  if (parts.length === 0) {
    return 'Unassigned';
  }

  if (parts.length >= 3 && /^[0-9a-f]{8,}$/i.test(parts[1])) {
    return `${parts[0]} ${parts[1]}`;
  }

  if (parts.length >= 2) {
    return `${parts[0]} ${parts[1]}`;
  }

  return parts[0];
}

class HomeAssistantClient extends EventEmitter {
  constructor() {
    super();
    this.url = '';
    this.token = '';
    this.wsUrl = '';
    this.connectionMode = 'direct';
    this.ws = null;
    this.connected = false;
    this.authenticated = false;
    this.shouldRun = false;
    this.msgId = 1;
    this.pending = new Map();
    this.reconnectTimer = null;
    this.reconnectDelayMs = 1000;
    this.maxReconnectDelayMs = 30000;
    this.stateCache = new Map();
    this.entityRegistry = new Map();
    this.deviceRegistry = new Map();
  }

  configure(url, token) {
    const configuredUrl = String(url || '').trim();
    const configuredToken = String(token || '').trim();
    const supervisorToken = String(process.env.SUPERVISOR_TOKEN || '').trim();
    const hasSupervisorToken = Boolean(supervisorToken);

    if (!configuredUrl && hasSupervisorToken) {
      this.url = 'http://supervisor/core';
      this.token = supervisorToken;
      this.wsUrl = 'ws://supervisor/core/websocket';
      this.connectionMode = 'supervisor';
      return;
    }

    this.url = configuredUrl;
    this.wsUrl = toWsUrl(this.url);

    if (!configuredToken && hasSupervisorToken && isSupervisorModeUrl(this.url)) {
      this.token = supervisorToken;
      this.connectionMode = 'supervisor';
      return;
    }

    this.token = configuredToken;
    this.connectionMode = 'direct';
  }

  async start() {
    this.shouldRun = true;

    if (!this.wsUrl || !this.token) {
      this.emit('status', {
        connected: false,
        authenticated: false,
        reason: 'Missing Home Assistant URL or token'
      });
      return;
    }

    if (this.ws) {
      return;
    }

    this.connect();
  }

  async stop() {
    this.shouldRun = false;
    this.clearReconnectTimer();

    if (this.ws) {
      try {
        this.ws.close();
      } catch (error) {
        // ignore
      }
      this.ws = null;
    }

    this.connected = false;
    this.authenticated = false;
    this.rejectAllPending(new Error('Client stopped'));
    this.entityRegistry.clear();
    this.deviceRegistry.clear();
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  scheduleReconnect() {
    if (!this.shouldRun) {
      return;
    }

    this.clearReconnectTimer();
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.maxReconnectDelayMs);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  connect() {
    if (!this.shouldRun || !this.wsUrl) {
      return;
    }

    console.log(`[ha] Connecting to ${this.wsUrl} (${this.connectionMode})`);

    this.ws = new WebSocket(this.wsUrl, {
      handshakeTimeout: 10000
    });

    this.ws.on('open', () => {
      this.connected = true;
      this.emit('status', {
        connected: true,
        authenticated: false,
        reason: 'Socket open'
      });
    });

    this.ws.on('message', async (data) => {
      this.handleMessage(data);
    });

    this.ws.on('error', (error) => {
      console.error('[ha] WebSocket error:', error.message);
      this.emit('status', {
        connected: false,
        authenticated: false,
        reason: `Socket error: ${error.message}`
      });
    });

    this.ws.on('close', () => {
      this.connected = false;
      this.authenticated = false;
      this.rejectAllPending(new Error('Socket closed'));
      this.ws = null;

      this.emit('status', {
        connected: false,
        authenticated: false,
        reason: 'Socket closed'
      });

      this.scheduleReconnect();
    });
  }

  rejectAllPending(error) {
    for (const [, p] of this.pending) {
      p.reject(error);
    }
    this.pending.clear();
  }

  nextId() {
    const id = this.msgId;
    this.msgId += 1;
    return id;
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket not connected'));
    }

    const id = this.nextId();
    const frame = { id, ...payload };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(frame), (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async refreshStates() {
    if (!this.authenticated) {
      return [];
    }

    const response = await this.send({ type: 'get_states' });
    if (!response.success || !Array.isArray(response.result)) {
      throw new Error(response.error ? response.error.message : 'get_states failed');
    }

    this.stateCache.clear();
    for (const stateObj of response.result) {
      if (stateObj && stateObj.entity_id) {
        this.stateCache.set(stateObj.entity_id, stateObj);
      }
    }

    this.emit('states', this.getStatesArray());
    return response.result;
  }

  async refreshEntityMetadata() {
    if (!this.authenticated) {
      return {
        entities: 0,
        devices: 0
      };
    }

    const [entityResponse, deviceResponse] = await Promise.all([
      this.send({ type: 'config/entity_registry/list' }),
      this.send({ type: 'config/device_registry/list' })
    ]);

    if (!entityResponse.success || !Array.isArray(entityResponse.result)) {
      throw new Error(entityResponse.error ? entityResponse.error.message : 'config/entity_registry/list failed');
    }

    if (!deviceResponse.success || !Array.isArray(deviceResponse.result)) {
      throw new Error(deviceResponse.error ? deviceResponse.error.message : 'config/device_registry/list failed');
    }

    this.entityRegistry.clear();
    for (const item of entityResponse.result) {
      if (item && item.entity_id) {
        this.entityRegistry.set(item.entity_id, item);
      }
    }

    this.deviceRegistry.clear();
    for (const item of deviceResponse.result) {
      if (item && item.id) {
        this.deviceRegistry.set(item.id, item);
      }
    }

    return {
      entities: this.entityRegistry.size,
      devices: this.deviceRegistry.size
    };
  }

  getEntityMeta(entityId, stateObj = null) {
    const registryEntry = this.entityRegistry.get(entityId) || null;
    const friendlyName = stateObj && stateObj.attributes && stateObj.attributes.friendly_name
      ? String(stateObj.attributes.friendly_name)
      : '';

    const deviceId = registryEntry && registryEntry.device_id ? String(registryEntry.device_id) : '';
    const device = deviceId ? (this.deviceRegistry.get(deviceId) || null) : null;

    const deviceName = firstNonEmptyText(
      device && device.name_by_user,
      device && device.name,
      registryEntry && registryEntry.device_name,
      guessDeviceNameFromFriendlyName(friendlyName),
      guessDeviceNameFromEntityId(entityId),
      'Unassigned'
    );

    return {
      entity_id: entityId,
      device_id: deviceId || null,
      area_id: registryEntry && registryEntry.area_id ? String(registryEntry.area_id) : null,
      device_name: deviceName,
      device_key: slugText(deviceName),
      has_registry_entry: Boolean(registryEntry)
    };
  }

  async callService(domain, service, serviceData = {}, target = null) {
    if (!this.authenticated) {
      throw new Error('Home Assistant is not authenticated');
    }

    const payload = {
      type: 'call_service',
      domain,
      service,
      service_data: serviceData || {}
    };

    if (target && typeof target === 'object') {
      payload.target = target;
    }

    const response = await this.send(payload);
    if (!response.success) {
      throw new Error(response.error ? response.error.message : `call_service failed (${domain}.${service})`);
    }

    return response.result;
  }

  static boolFromAny(value) {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return value !== 0;
    }

    const text = String(value || '').trim().toLowerCase();
    return text === 'on' || text === 'true' || text === '1' || text === 'open' || text === 'lock';
  }

  static enumTextFromValue(value, enumMap = []) {
    if (!Array.isArray(enumMap) || enumMap.length === 0) {
      return String(value ?? '');
    }

    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      const byValue = enumMap.find((entry) => Number(entry.value) === asNumber);
      if (byValue) {
        return String(byValue.key);
      }
    }

    const text = String(value ?? '');
    const byKey = enumMap.find((entry) => String(entry.key) === text);
    if (byKey) {
      return String(byKey.key);
    }

    return text;
  }

  resolveForwardService(entityId, value, valueType, enumMap = []) {
    const ref = parseEntityRef(entityId);
    const resolvedEntityId = ref.base_entity_id;
    const domain = resolvedEntityId.includes('.') ? resolvedEntityId.split('.')[0] : '';

    if (ref.isVirtual && domain === 'climate') {
      const option = HomeAssistantClient.enumTextFromValue(value, enumMap);
      const numericValue = Number(value);

      if (ref.parameter_key === 'target_temperature' || ref.parameter_key === 'temperature') {
        if (!Number.isFinite(numericValue)) {
          return null;
        }
        return {
          domain: 'climate',
          service: 'set_temperature',
          service_data: {
            entity_id: resolvedEntityId,
            temperature: numericValue
          }
        };
      }

      if (ref.parameter_key === 'fan_mode') {
        if (!option) {
          return null;
        }
        return {
          domain: 'climate',
          service: 'set_fan_mode',
          service_data: {
            entity_id: resolvedEntityId,
            fan_mode: option
          }
        };
      }

      if (ref.parameter_key === 'preset_mode') {
        if (!option) {
          return null;
        }
        return {
          domain: 'climate',
          service: 'set_preset_mode',
          service_data: {
            entity_id: resolvedEntityId,
            preset_mode: option
          }
        };
      }

      if (ref.parameter_key === 'swing_mode') {
        if (!option) {
          return null;
        }
        return {
          domain: 'climate',
          service: 'set_swing_mode',
          service_data: {
            entity_id: resolvedEntityId,
            swing_mode: option
          }
        };
      }

      return null;
    }

    if (domain === 'button') {
      return {
        domain: 'button',
        service: 'press',
        service_data: { entity_id: resolvedEntityId }
      };
    }

    if (valueType === 'boolean') {
      const boolValue = HomeAssistantClient.boolFromAny(value);

      if (domain === 'lock') {
        return {
          domain: 'lock',
          service: boolValue ? 'lock' : 'unlock',
          service_data: { entity_id: resolvedEntityId }
        };
      }

      if (domain === 'cover') {
        return {
          domain: 'cover',
          service: boolValue ? 'open_cover' : 'close_cover',
          service_data: { entity_id: resolvedEntityId }
        };
      }

      return {
        domain: 'homeassistant',
        service: boolValue ? 'turn_on' : 'turn_off',
        service_data: { entity_id: resolvedEntityId }
      };
    }

    if (valueType === 'enum') {
      const option = HomeAssistantClient.enumTextFromValue(value, enumMap);

      if (!option) {
        return null;
      }

      if (domain === 'climate') {
        return {
          domain: 'climate',
          service: 'set_hvac_mode',
          service_data: {
            entity_id: resolvedEntityId,
            hvac_mode: option
          }
        };
      }

      if (domain === 'select' || domain === 'input_select') {
        return {
          domain,
          service: 'select_option',
          service_data: {
            entity_id: resolvedEntityId,
            option
          }
        };
      }

      if (domain === 'water_heater') {
        return {
          domain: 'water_heater',
          service: 'set_operation_mode',
          service_data: {
            entity_id: resolvedEntityId,
            operation_mode: option
          }
        };
      }

      return null;
    }

    if (valueType === 'integer' || valueType === 'real') {
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue)) {
        return null;
      }

      if (domain === 'number' || domain === 'input_number') {
        return {
          domain,
          service: 'set_value',
          service_data: {
            entity_id: resolvedEntityId,
            value: numericValue
          }
        };
      }

      return null;
    }

    if (valueType === 'string') {
      const textValue = String(value ?? '');

      if (domain === 'input_text' || domain === 'text') {
        return {
          domain,
          service: 'set_value',
          service_data: {
            entity_id: resolvedEntityId,
            value: textValue
          }
        };
      }

      if (domain === 'select' || domain === 'input_select') {
        return {
          domain,
          service: 'select_option',
          service_data: {
            entity_id: resolvedEntityId,
            option: textValue
          }
        };
      }

      return null;
    }

    return null;
  }

  async forwardEntityUpdate(entityId, value, valueType, enumMap = []) {
    const svc = this.resolveForwardService(entityId, value, valueType, enumMap);
    if (!svc) {
      return {
        forwarded: false,
        reason: `No forward mapping for ${entityId} (${valueType})`
      };
    }

    await this.callService(svc.domain, svc.service, svc.service_data, svc.target || null);
    return {
      forwarded: true,
      service: `${svc.domain}.${svc.service}`,
      service_data: svc.service_data
    };
  }

  getStatesArray() {
    return Array.from(this.stateCache.values());
  }

  getState(entityId) {
    return this.stateCache.get(entityId) || null;
  }

  async subscribeStateChanged() {
    const response = await this.send({
      type: 'subscribe_events',
      event_type: 'state_changed'
    });

    if (!response.success) {
      throw new Error(response.error ? response.error.message : 'subscribe_events failed');
    }
  }

  async handleAuthRequired() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(JSON.stringify({
      type: 'auth',
      access_token: this.token
    }));
  }

  async handleAuthOk() {
    this.authenticated = true;
    this.reconnectDelayMs = 1000;

    this.emit('status', {
      connected: true,
      authenticated: true,
      reason: 'Authenticated'
    });

    try {
      await this.refreshStates();
      try {
        const meta = await this.refreshEntityMetadata();
        console.log(`[ha] Loaded metadata: ${meta.entities} entities, ${meta.devices} devices`);
      } catch (error) {
        console.warn('[ha] Registry metadata unavailable:', error.message);
      }
      await this.subscribeStateChanged();
      console.log('[ha] Subscribed to state_changed events');
    } catch (error) {
      console.error('[ha] Post-auth setup failed:', error.message);
    }
  }

  handleMessage(rawData) {
    let msg;

    try {
      msg = JSON.parse(rawData.toString());
    } catch (error) {
      console.error('[ha] Failed to parse message:', error.message);
      return;
    }

    if (msg.type === 'auth_required') {
      this.handleAuthRequired();
      return;
    }

    if (msg.type === 'auth_ok') {
      this.handleAuthOk();
      return;
    }

    if (msg.type === 'auth_invalid') {
      console.error('[ha] Authentication failed:', msg.message || 'invalid token');
      this.emit('status', {
        connected: false,
        authenticated: false,
        reason: `Authentication failed: ${msg.message || 'invalid token'}`
      });

      if (this.ws) {
        try {
          this.ws.close();
        } catch (error) {
          // ignore
        }
      }
      return;
    }

    if (msg.type === 'event' && msg.event && msg.event.event_type === 'state_changed') {
      const eventData = msg.event.data || {};
      const newState = eventData.new_state;
      const entityId = eventData.entity_id;

      if (entityId) {
        if (newState) {
          this.stateCache.set(entityId, newState);
        } else {
          this.stateCache.delete(entityId);
        }

        this.emit('state_changed', {
          entity_id: entityId,
          new_state: newState
        });
      }
      return;
    }

    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      pending.resolve(msg);
    }
  }
}

module.exports = {
  HomeAssistantClient,
  toWsUrl
};
