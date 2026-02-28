# HA Ember Gateway add-on

## What this add-on does

This add-on exposes selected Home Assistant entities as an Ember+ tree and provides a web UI for configuring exports.

## Ports

- `8090/tcp`: web configuration UI
- `9000/tcp`: Ember+ endpoint

## Configuration

No add-on options are required in Home Assistant UI.

The gateway stores and loads its runtime config from:

`/data/config.yaml`

Open the web UI on port `8090` and configure:

- Home Assistant URL
- Long-lived access token
- Exported entities

## Standalone and add-on parity

The add-on and standalone container use the same app code and same config schema.
The add-on only sets `GATEWAY_CONFIG=/data/config.yaml` so config persists in add-on data storage.
