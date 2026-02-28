# HA Ember Gateway add-on

Support policy: community-maintained with limited maintenance and no guaranteed direct support.

## What this add-on does

This add-on exposes selected Home Assistant entities as an Ember+ tree and provides a web UI for configuring exports.

## Home Assistant OS quick setup

1. Go to `Settings -> Add-ons -> Add-on Store`.
2. Open menu (`...`) -> `Repositories`.
3. Add: `https://github.com/Vojsooo/ha-ember-gateway`.
4. Install `HA Ember Gateway`.
5. Start the add-on and open `Web UI`.
6. In `Settings -> Connection`, keep Home Assistant URL empty and token empty.
7. Save configuration and choose exported entities on the dashboard.
8. Connect Ember+ client to Home Assistant host on TCP `9000`.

## Ports

- `8090/tcp`: web configuration UI
- `9000/tcp`: Ember+ endpoint

## Configuration

No add-on options are required in Home Assistant UI.

The gateway stores and loads its runtime config from:

`/data/config.yaml`

Open the web UI on port `8090` and configure:

- Exported entities

For this add-on, the Home Assistant connection is automatic:

- keep Home Assistant URL empty
- keep token empty

The gateway auto-connects through supervisor proxy using the injected `SUPERVISOR_TOKEN`.

## Standalone and add-on parity

The add-on and standalone container use the same app code and same config schema.
The add-on only sets `GATEWAY_CONFIG=/data/config.yaml` so config persists in add-on data storage.
