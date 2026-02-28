# Changelog

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
