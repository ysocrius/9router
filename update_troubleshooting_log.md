# Update Troubleshooting Log (v0.4.64)

This document outlines the various attempts made to build, package, and globally install the `v0.4.64` update for 9Router, and the ultimate solution that succeeded.

## The Goal
To build the latest changes (including the new "What's New" page and the restored Freebuff AI provider) and install them globally so the local `9router` CLI command reflects these updates.

---

## ❌ Attempt 1: Building and packing from the root directory
**Approach:** 
Ran `npm run build`, followed by `npm pack` and `npm install -g ./9router-app-0.4.64.tgz` directly from the project's root directory.

**Why it failed:**
- **Missing Dependencies:** The initial build failed because of missing `node_modules` (e.g., `monaco-editor`, `zustand`, etc.), likely due to an incomplete `npm install` caused by previous disk space (`ENOSPC`) issues.
- **Wrong Package Context:** Even after fixing the dependencies and installing the `9router-app` package globally, the `9router` command still launched the old version. The root directory builds the `9router-app` (the Next.js dashboard), but the actual `9router` executable is provided by a separate package located in the `./cli` folder. 

## ❌ Attempt 2: Next.js Prerender Failures (recharts)
**Approach:** 
During the rebuilds in Attempt 1, Next.js static page generation threw repeated `TypeError: (0 , g.combineReducers) is not a function` errors.

**Why it failed:**
- The `recharts` package (version 3.7.0/3.8.1) internally uses `@reduxjs/toolkit`, which has known ESM/CJS interop issues when being prerendered by the Next.js App Router.
- **The Fix:** Added `transpilePackages: ['recharts', '@reduxjs/toolkit']` to `next.config.mjs` so Next.js properly bundles these specific dependencies during the build.

## ❌ Attempt 3: Installing the correct CLI package while the server was running
**Approach:** 
Realizing the executable lives in the `./cli` directory, the version in `cli/package.json` was bumped to `0.4.64`. We ran `npm run build` and `npm pack` inside the `./cli` folder, followed by `npm install -g ./9router-0.4.64.tgz`.

**Why it failed:**
- The final installation step failed with an `EBUSY: resource busy or locked` error. 
- The existing `9router` server (specifically its background system tray process) was still actively running in the background. Windows locks open files, which prevented NPM from overwriting the globally installed CLI files.
- Attempts to gracefully kill the server via its `/api/shutdown` API failed due to a `401 Unauthorized` block.
- Attempts to forcefully kill the Process ID via PowerShell failed with `Access is denied` because the background node processes were running with different/higher privileges than the terminal session.

---

## ✅ The Final Successful Solution
**Approach:**
To successfully install the update, the environment had to be completely clear of file locks, and the build had to be triggered from the correct sub-package.

1. **Clean Installation:** Deleted the corrupted `node_modules`, cleared the npm cache, and ran a fresh `npm install` in the root directory.
2. **Next.js Config Patch:** Updated `next.config.mjs` to transpile `recharts` and `@reduxjs/toolkit` to prevent static generation crashes.
3. **Correct Build Context:** Navigated to the `./cli` directory (which contains the actual `9router` executable script) and bumped its `package.json` version to `0.4.64`.
4. **CLI Packaging:** Ran `npm run build` inside `./cli` (which bundles the Next.js dashboard into the CLI app) and packed it into a `.tgz` file.
5. **Manual Process Termination:** The user manually quit the `9router` system tray application and killed any lingering background `node.exe` processes via Task Manager.
6. **Global Install:** With the file locks released, successfully ran `npm install -g ./9router-0.4.64.tgz` from the `./cli` folder. 

**Result:** The new version of the CLI was installed correctly, and running `9router` successfully launched the dashboard featuring the new "What's New" page and restored Freebuff provider.
