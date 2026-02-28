# Changelog

## 0.1.8

- Refine header layout to remove large empty gap on desktop:
  - keep logo on right side.
  - keep `Clients: x` and title on left side.
  - place status/diagnostics lines directly below title area for cleaner visual flow.

## 0.1.7

- Use the exact provided logo file (`ChatGPT Image Feb 28, 2026, 08_53_44 AM.png`) as:
  - web header logo on the right side.
  - Home Assistant add-on info logo (`ha-ember-gateway-addon/logo.png`).
- Increase web header logo display size for better readability.

## 0.1.6

- Web UI header layout update:
  - move `Clients: x` button to the left side.
  - move logo to the right side of header.
  - increase header logo size by approximately 2x.
- Home Assistant branding asset update:
  - regenerate `icon.png` with tighter crop for larger visible symbol.
  - regenerate `logo.png` with tighter crop for larger, more readable add-on info branding.

## 0.1.5

- Add official HA Ember Gateway branding assets to the repository.
- Add logo to web UI header (top-left) and configure web favicon.
- Bundle add-on `icon.png` and `logo.png` so Home Assistant shows branded app icon and add-on info logo.
- Add logo to GitHub main page (`README.md`).

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
