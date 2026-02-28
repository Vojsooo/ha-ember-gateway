# Changelog

## 0.1.4

- Add dedicated `Logs` menu section.
- Move `Runtime Logs` out of Dashboard into the new Logs view.
- Expand logs view to use full browser height for improved log monitoring.

## 0.1.3

- Add clear support policy messaging (limited maintenance, no direct support) in GitHub documentation and add-on metadata.
- Refactor web UI layout into menu-based navigation:
  - `Home > Dashboard`
  - `Settings > Connection`
  - `Settings > Advanced`
- Move Connection form from main page to `Settings > Connection`.
- Add `Enable All Entities` option in `Settings > Advanced` with confirmation dialog and high-load warning.
- Implement runtime override for `Enable All Entities`:
  - exports all discovered entities/parameters to Ember+.
  - ignores per-entity checkbox selections while enabled.
  - preserves checkbox selections for when the option is disabled.
- Add header diagnostics display: RAM usage, CPU usage, and storage usage.

## 0.1.2

- Remove hardcoded Home Assistant URL defaults.
- Add automatic Home Assistant OS add-on detection when `home_assistant.url` is empty and `SUPERVISOR_TOKEN` exists (connects through `ws://supervisor/core/websocket`).
- If URL points to supervisor proxy and token is empty, use `SUPERVISOR_TOKEN`.
- Enable `homeassistant_api: true` in add-on metadata.

## 0.1.1

- Fix GHCR image naming to lowercase owner (`vojsooo`) for successful publishing.
- Keep standalone container and add-on packaging in one repository.

## 0.1.0

- Initial add-on packaging for HA Ember Gateway.
- Uses prebuilt GHCR images per architecture (`amd64`, `aarch64`).
