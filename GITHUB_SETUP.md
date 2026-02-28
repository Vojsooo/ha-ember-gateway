# GitHub Setup Manual (Standalone + Home Assistant Add-on)

This guide publishes one codebase for both:

- Standalone Docker container
- Home Assistant add-on (custom repository)

## 1) Create GitHub repository

1. Sign in to GitHub.
2. Click `New repository`.
3. Name it `ha-ember-gateway`.
4. Set visibility to `Public` (required so Home Assistant can pull images without auth).
5. Do not add README/license/gitignore from UI (files already exist locally).
6. Create repository.

## 2) Install tools on your computer

- Install Git: `https://git-scm.com/downloads`
- Install Docker Desktop (or Docker Engine): `https://www.docker.com/products/docker-desktop/`

Optional but recommended:

- Install GitHub CLI: `https://cli.github.com/`

## 3) Account values already set

This local copy is already prepared for your GitHub account:

- GitHub user: `Vojsooo`
- Repository URL: `https://github.com/Vojsooo/ha-ember-gateway`

## 4) Push code to GitHub

From PowerShell in project folder:

```powershell
cd \\192.168.6.3\Container\ha-ember-gateway
git init
git add .
git commit -m "Initial standalone + Home Assistant add-on repository"
git branch -M main
git remote add origin https://github.com/Vojsooo/ha-ember-gateway.git
git push -u origin main
```

If Git asks for credentials, use your GitHub login or a Personal Access Token.

## 5) Enable GitHub Actions + GHCR package publishing

1. Open repository on GitHub.
2. Open `Actions` tab and enable workflows if prompted.
3. Workflow file is already included:
   - `.github/workflows/build-images.yml`
4. No extra secret is needed for GHCR; workflow uses `GITHUB_TOKEN`.

## 6) Build and publish release images

For each release:

1. Update versions to the same value:
   - `package.json` -> `version`
   - `ha-ember-gateway-addon/config.yaml` -> `version`
   - `ha-ember-gateway-addon/CHANGELOG.md`
2. Commit and push:

```powershell
git add .
git commit -m "Release 0.1.1"
git push
```

3. Create and push Git tag:

```powershell
git tag v0.1.1
git push origin v0.1.1
```

4. GitHub Actions builds and pushes:
   - `ghcr.io/vojsooo/ha-ember-gateway-amd64:0.1.1`
   - `ghcr.io/vojsooo/ha-ember-gateway-aarch64:0.1.1`

## 7) Make GHCR package public

Home Assistant cannot pull private images without credentials.

1. GitHub -> your profile -> `Packages`.
2. Open `ha-ember-gateway-amd64` and `ha-ember-gateway-aarch64`.
3. Package settings -> change visibility to `Public`.

## 8) Add repository to Home Assistant

1. Home Assistant -> `Settings` -> `Add-ons` (or `Apps`) -> `Store`.
2. Open menu (top-right) -> `Repositories`.
3. Add:

`https://github.com/Vojsooo/ha-ember-gateway`

4. Install `HA Ember Gateway`.
5. Start add-on.
6. Open add-on Web UI (`port 8090`) and configure Home Assistant URL + token.

## 9) Ongoing automatic updates

Your update flow becomes:

1. Push code changes to `main`.
2. Bump version files.
3. Push Git tag `vX.Y.Z`.
4. GitHub Actions publishes images.
5. Home Assistant shows add-on update (new version in `config.yaml`).
