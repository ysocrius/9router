# Sync Issue Resolution (v0.4.63)

During the recent sync of the upstream `9router` repository, the build process still produced a **`9router-app-0.4.55.tgz`** archive instead of the expected **`9router-app-0.4.63.tgz`**.  The root cause and the exact steps to fix it are documented below.

---

## Why the 0.4.55 tarball appeared

| Symptom | Cause |
|---------|-------|
| `npm pack` generated `9router-app-0.4.55.tgz` | The **`version` field in `package.json`** was still set to `0.4.55` (see line 3 of the file). `npm pack` uses this field to name the tarball, so a newer codebase does not automatically change the version.
| `gh release download v0.4.63` returned *no assets* | The upstream GitHub Actions only upload a tarball when the **release tag matches the version in `package.json`**. With the version unchanged, the workflow did not generate an asset for `v0.4.63`.

Because the version was unchanged, the tarball you were trying to install (`9router-0.4.63.tgz`) did not exist, leading to the `ENOENT` error.

---

## Fix – Bump the version and rebuild

1. **Update `package.json`**
   ```powershell
   # One‑liner to replace the version string
   (Get-Content .\package.json -Raw) -replace "\"version\":\s*\"[0-9\.]+\"", "\"version\": \"0.4.63\"" | Set-Content .\package.json -Encoding utf8
   ```
   *Result:* line 3 now reads `"version": "0.4.63",`.

2. **Commit the change**
   ```powershell
   git add package.json
   git commit -m "chore: bump version to 0.4.63 for release"
   ```

3. **Re‑run the build & create a new tarball**
   ```powershell
   npm ci                 # reinstall exact dependencies
   npm run build          # produce the Next.js production build (optional but keeps CI happy)
   npm pack               # creates 9router-app-0.4.63.tgz
   ```
   You should now see `9router-app-0.4.63.tgz` in the repo root.

4. **Install globally**
   ```powershell
   npm install -g .\9router-app-0.4.63.tgz
   ```
   Verify with:
   ```powershell
   9router --version   # should output 0.4.63
   ```

5. **(Optional) Publish a GitHub release**
   ```powershell
   git tag v0.4.63
   git push origin v0.4.63
   ```
   The CI workflow will automatically create a release asset containing the newly generated tarball, making `gh release download v0.4.63` work for future machines.

---

## How to roll back if needed

Your private tag **`v0.4.56-private`** remains untouched.  To revert:
```powershell
git checkout v0.4.56-private
npm install -g .\9router-app-0.4.55.tgz   # the old tarball you already have
```
The server will run the previous stable version.

---

## Next steps for you
1. Run the one‑liner above (or edit `package.json` manually) to bump the version.
2. Re‑run the build/pack sequence.
3. Install the new `0.4.63` package globally.
4. Continue with any PR merges you planned (Key Groups, Speedtest, etc.) and repeat the pack‑install cycle after each merge.

If you encounter any errors during these steps, paste the exact terminal output and I’ll help troubleshoot.
