# HA Ember Gateway

<p align="center">
  <img src="public/assets/haember-logo.png" alt="HA Ember Gateway logo" width="360" />
</p>

Bridge selected Home Assistant entities to Ember+ clients.

> Support policy: This is a community-maintained project with limited maintenance and no guaranteed direct support.

## Services

- Ember+ provider: `tcp/9000`
- Web configuration UI: `http://<gateway-ip>:8090`

## Run as standalone container

Use a bind-mounted config file so settings persist outside the container.

```bash
docker run -d \
  --name ha-ember-gateway \
  -p 9000:9000 \
  -p 8090:8090 \
  -v /path/on/host/config.yaml:/app/config/config.yaml \
  ghcr.io/vojsooo/ha-ember-gateway-amd64:0.1.7
```

## Config file

Example:

```yaml
home_assistant:
  url: ""
  token: ""
ember:
  host: 0.0.0.0
  port: 9000
  root_identifier: homeassistant
web:
  host: 0.0.0.0
  port: 8090
exports:
  - entity_id: sensor.outdoor_temperature
    identifier: sensor_outdoor_temperature
    type: real
    access: read
```

Standalone mode:

- set `home_assistant.url` to your HA URL (for example `http://homeassistant.local:8123`)
- set `home_assistant.token` to a long-lived access token

Home Assistant add-on mode:

- leave `home_assistant.url` empty
- leave `home_assistant.token` empty
- the app auto-detects add-on runtime and connects through supervisor proxy using `SUPERVISOR_TOKEN`

By default, the app reads config from `/app/config/config.yaml`. Override with:

```bash
GATEWAY_CONFIG=/data/config.yaml
```

The `GATEWAY_CONFIG` override is how the Home Assistant add-on uses the same app code path.

## Home Assistant add-on packaging

This repository includes add-on metadata in:

- `repository.yaml`
- `ha-ember-gateway-addon/config.yaml`

The add-on references prebuilt images:

- `ghcr.io/vojsooo/ha-ember-gateway-amd64:<version>`
- `ghcr.io/vojsooo/ha-ember-gateway-aarch64:<version>`

Image publishing is automated by `.github/workflows/build-images.yml` on Git tags (`v*`).

## Notes

- Standalone mode requires a Home Assistant long-lived token for API access.
- Add-on mode can auto-connect through supervisor with URL/token left empty.
- Use the web UI to select entities and save config.
- Climate entities expose virtual parameters (for example `::target_temperature`, `::fan_mode`) so Ember+ clients can map and write setpoints and mode sub-values.
- Ember+ tree layout is hierarchical: `root -> device -> type/domain -> exported parameters` (only enabled exports generate nodes).
