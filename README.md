# xboard-admin-dist

This repository stores the compiled admin panel assets used by
`restaurant8/Xboard` as the `public/assets/admin` submodule.

It is not the admin frontend source repository. Files under `assets/`,
`locales/`, and `index.html` are already built static files.

## Repository Role

- Parent project: `restaurant8/Xboard`
- Submodule path: `public/assets/admin`
- Dist repository: `restaurant8/xboard-admin-dist`

The parent project stores only a submodule commit pointer. Always commit and
push this repository first, then commit the updated submodule pointer in
`restaurant8/Xboard`.

## Update Workflow

From the submodule inside the Xboard workspace:

```powershell
cd D:\Xboard\public\assets\admin
git status
git add assets/index-Hq1wzO6d-fix.js index.html locales/en-US.js locales/ru-RU.js locales/zh-CN.js README.md
git commit -m "update admin dist"
git pull --rebase origin main
git push origin HEAD:main
```

Then update the parent project pointer:

```powershell
cd D:\Xboard
git add public/assets/admin
git commit -m "update admin submodule"
git push origin HEAD:main
```

## Syntax Checks

Run these checks before publishing any manual dist edit:

```powershell
cd D:\Xboard\public\assets\admin
docker run --rm -v D:\Xboard\public\assets\admin:/app -w /app node:22 node --check assets/index-Hq1wzO6d-fix.js
docker run --rm -v D:\Xboard\public\assets\admin:/app -w /app node:22 node --check locales/zh-CN.js
docker run --rm -v D:\Xboard\public\assets\admin:/app -w /app node:22 node --check locales/en-US.js
docker run --rm -v D:\Xboard\public\assets\admin:/app -w /app node:22 node --check locales/ru-RU.js
```

If the browser reports `Uncaught SyntaxError`, check the bundle around the
reported line/column and confirm the file was saved as UTF-8 without BOM.

## Server Pull

On the panel server:

```bash
cd /www/wwwroot/muacloud
git fetch origin
git pull --ff-only origin main
git submodule sync --recursive
git submodule update --init --recursive
```

Confirm the active commits:

```bash
git rev-parse --short HEAD
git -C public/assets/admin rev-parse --short HEAD
```

