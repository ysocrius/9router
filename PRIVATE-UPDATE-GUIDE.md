# 🚀 Private 9Router Update Guide

> **Purpose:** This document explains how to sync the original developer's new features into your private forked version without losing custom fixes (DeepSeek reasoning injection, Gemini adaptive token handler).

---

## Overview

Your private fork lives at: [https://github.com/ysocrius/9router](https://github.com/ysocrius/9router)

A GitHub Action workflow automatically builds a `.tgz` release every time code is pushed to the `master` branch.

---

## 📥 When a New Version Drops

Do all of this from your terminal — **no browser needed**.

### Step 1: Sync the Fork

```powershell
gh repo sync ysocrius/9router
```

This merges the original developer's new code into your fork, preserving your custom fixes.

### Step 2: Wait for GitHub Cloud to Build It

```powershell
gh run watch
```

GitHub's servers compile everything (~3 min). When done, a release is created automatically.

### Step 3: Download the Built File

```powershell
gh release download --repo ysocrius/9router
```

The `.tgz` file lands in your current folder.

### Step 4: Install Globally

```powershell
npm install -g *.tgz
```

Restart your server. You're done!

---

## ⏪ Reverting (If New Version is Broken)

If the update breaks something, roll back instantly:

### Step 1: List Past Releases

```powershell
gh release list
```

Each release has the pre-built `.tgz` from that version.

### Step 2: Download the Old Working Version

```powershell
gh release download v0.4.64
```

Replace `v0.4.64` with whichever version worked for you.

### Step 3: Reinstall

```powershell
npm install -g *.tgz
```

Restart your server. You're back to the old version in seconds.

---

## ⚙️ What the GitHub Action Does

File: `.github/workflows/build.yml`

On every push to `master`, GitHub's cloud:
1. Installs dependencies (`npm ci`)
2. Runs the Next.js build + MITM bundler
3. Packs everything into a `.tgz`
4. Creates a **GitHub Release** with that file as a downloadable artifact

This means you never have to wait for the 2-minute local build on your laptop.

---

## 💡 Tip: Check Build Progress

After triggering a sync, see the live build log:

```powershell
gh run watch
```

The URL of the build will also appear in your terminal after running `gh repo sync`.
