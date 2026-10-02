# READ-ONLY recon: DSH profile/bundle patch semantics, plugin install, module resolution

All `path:line` evidence below was re-verified **directly against the asar** with a corrected reader.
Archive root prefix inside the installed app's `Contents/Resources/app.asar` is `dsh/`.

## 0. TOOLING CAVEAT (affects every line number you may already have)

The first-pass asar reader used `base = 16 + headerJsonSize`, but this archive's header JSON has
`size % 4 == 2`, so the real data base is `16 + size + 2`. The reader therefore read **2 bytes early**
and 2 bytes short. For most files the 2 stolen bytes are a stray `<char>\n`, so **every line number it
produced was +1 vs. reality**, and the last line was truncated. (Example: its read of
`dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` started `">\nimport …"`.)

A corrected reader (same `lookup`/`listDir`, fixed base only) produced **every line number in this
report**, so they are authoritative against the asar. (Sanity check: `JSON.parse` of every
`package.json` succeeds.)

---

## 1. Schema of a patch entry, and exactly what `insert` does

Runtime implementation (the one the Loader actually uses — the profile root is mounted as
`cordis:include` with `config.patches`):

`dsh/node_modules/@deepseek-ai/cordis-plugin-include/lib/index.js:56-105` — `applyEntryPatches()`.
`dsh-app-boot` carries a byte-identical copy used by offline tooling
(`dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:61-110`; its own doc at `:44-46` says it is
"THE patch semantics of this include, shared by mounting (`applyPatches`) and offline config tooling").

Decisive code (`cordis-plugin-include/lib/index.js:68-105`):

```js
const { id, insert, name, ...overrides } = patch;
if (insert) {
    if (id) {
        const target = entryMap.get(id);
        if (!target) { warn("patch insert: entry %C not found", id); continue; }
        if (!target.group) { warn("patch insert: entry %C is not a group", id); continue; }
        if (!Array.isArray(target.config)) target.config = [];
        target.config.push(...insert);
    } else data.push(...insert);
    buildMap(insert);
    continue;
}
if (!id) { warn("patch: id is required for non-insert patches"); continue; }
const target = entryMap.get(id);
if (!target) { warn("patch: entry %C not found", id); continue; }
if (name && name !== target.name) { warn("patch: name mismatch for %C (expected %C, got %C), skipping", id, target.name, name); continue; }
for (const [key, value] of Object.entries(overrides)) {
    if (key === "id") continue;
    target[key] = value;
}
```

**Top-level keys and their real meaning**

| key | meaning |
| --- | --- |
| `insert` | array of *entries* (rows) to append. Presence short-circuits everything else in that patch entry. |
| `id` | with `insert`: the id of a **group** row to append into. Without `insert`: the id of the row to override (required; missing ⇒ warn+skip). |
| `name` | **assertion only** (see below). Never written onto the target. |
| everything else (`config`, `disabled`, `inject`, `intercept`, `isolate`, `group`, and any unknown key) | collected into `overrides` and assigned verbatim: `target[key] = value`. |

Type declaration, `dsh/node_modules/@deepseek-ai/cordis-plugin-include/src/index.ts:130-142`:

```ts
export interface PatchOptions {
  id?: string
  insert?: EntryOptions[]
  name?: string
  config?: any
  group?: boolean | null
  disabled?: boolean | null
  inject?: any
  intercept?: any
  isolate?: any
  [key: string]: any
}
```

Row (`EntryOptions`) fields, `dsh/node_modules/@deepseek-ai/cordis-plugin-loader/src/config/entry.ts:10-24`:
`id`, `name`, `config`, `group`, `disabled`, `inject` (plus `intercept`/`isolate` in the schema).

**There is no `remove` / `delete` key.** Nothing in `applyEntryPatches` removes a row; an unknown key
such as `remove: true` is simply assigned to the row as inert data. The only way to neutralise a row
from a patch is `disabled: true` (or `group: false` for a group).

**What `insert` does, precisely — position:**

- `insert` **without** `id` → `data.push(...insert)` (line 82): appended to the **end of the top-level
  entry list**.
- `insert` **with** `id` → the target must be an existing row with a truthy `group` and (or initialisable)
  array `config`; the new rows are `target.config.push(...insert)` (line 81): appended to the **end of
  that group's child list**. A non-group target warns and is skipped (line 77-80).
- **There is no before/after/position control at all.** Order within the appended block is the array order.
- Inserted rows are indexed immediately (`buildMap(insert)`, line 84), so a later patch in the same list
  can target a row an earlier patch inserted.
- **`insert` never overrides an existing row.** If an inserted row reuses an existing `id`, you get a
  *second* row; the id index is overwritten by the later one (`entryMap.set(entry.id, entry)` at
  `cordis-plugin-include/lib/index.js:63`). Whether the Loader then rejects the duplicate id was **not**
  verified — flag if this matters.
- Because of the `continue`, an entry cannot combine `insert` with `config`/`disabled` overrides.
- Parse-time validation of a patch file: `dsh-app-boot/lib/index.js:3559-3571` (`parsePatchList`) — the
  file must be a top-level YAML array of mappings, parsed with `entryListSchema`
  (`:3460 const userPatchesSchema = entryListSchema`), i.e. `yaml.JSON_SCHEMA.extend(JsExpr)` (`:20-33`),
  so `!!js "…"` scalars are allowed anywhere. Per-entry structural errors throw; a patch whose *target
  row* is missing is only a Loader warning.
- Relative `name` values inside `insert` are rewritten to `file://` URLs anchored beside the patch file:
  `dsh-app-boot/lib/index.js:3537-3545` (`anchorInsertedPluginNames`).

---

## 2. MERGE SEMANTICS — answer: **(a) wholesale replacement, never a deep merge**

`dsh/node_modules/@deepseek-ai/cordis-plugin-include/lib/index.js:100-103`:

```js
for (const [key, value] of Object.entries(overrides)) {
    if (key === "id") continue;
    target[key] = value;
}
```

`config` arrives as one value in `overrides` and is assigned with `=`. There is **no `Object.assign`,
no recursive merge, no key-by-key union anywhere in the patch path.** Same code in
`dsh-app-boot/lib/index.js:104-107`.

Stated explicitly in the shipped schema/docs:

- `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:2760`:
  `"An insert appends entries, optionally inside the group identified by id. Other patches replace supplied fields; config is replaced wholesale, not deep-merged. A truthy name asserts the existing plugin name rather than renaming it. …"`
- `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:2923`:
  `"Bundle, profile, home, and CLI layers apply in that order. A patch config replaces the whole config. …"`
- `dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:6-7` (bundle header):
  `"# A patch replaces the targeted row's whole \`config\` rather than merging into it, …"`
- `dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml:5-6`:
  `"# A patch replaces the targeted row's whole \`config\`, so each row below restates every key it owns."`

Practical consequence: to add one key to the `web` row you must restate `searchProvider` **and**
`fetchProvider` (plus every other key you want kept). The existing profile layer already does exactly
this, e.g. `~/.dsh/profiles/desktop/cordis.patch.yml:4-8` restates the whole `agent-default-model` config.

**Other row fields**

- `disabled`, `inject`, `intercept`, `isolate`, `group`, and arbitrary unknown keys **can** be changed
  (wholesale assignment).
- `name` **cannot** be changed. It is destructured out before the override loop, so it never reaches
  `overrides`; a truthy `name` is compared with `target.name` and, on mismatch, the whole patch is
  skipped with a warning (`cordis-plugin-include/lib/index.js:96-99`). A patch entry may *assert* the
  plugin identity but never rename a row. (Consistent with the schema rule at
  `dsh-app-boot/lib/index.js:2909`, which only permits `name` equal to the target's name.)
- `id` cannot be changed either (destructured; the `if (key === "id") continue` is unreachable).
- The comparison is against the row's **current** `name`, so ordering matters: a patch asserting `name`
  must match what earlier layers left there.

---

## 3. Layer order, and where the `web` row / `fetchProvider: http` comes from

**Order of application (authoritative):**

`dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:920-956` (`loadProfileDirectory`) — bundle
patches are loaded by iterating `dsh.profile.bundles` **in manifest order**:

```js
const bundles = readProfileManifest(binName, dir).dsh?.profile?.bundles ?? [];
for (const packageName of bundles) try { … const patchPaths = bundlePatchPaths(packageDir, bundle);
    const patches = patchPaths.flatMap((patchPath) => loadOverlayPatches(binName, patchPath));
    layers.push({ packageName, packageDir, patchPaths, patches }); } catch …
```

A bundle may declare **several** patch files, applied in the declared array order
(`bundlePatchFiles`, `:495-499`: "one file for a string `patch`, the listed files in order for an array").

`dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:1023-1034` (`readProfilePatches`) — the final
flattened order:

```js
const patches = structuredClone([
    ...profile.layers.flatMap((layer) => layer.patches),          // 1. bundles, manifest order
    ...initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? [], // 2. profile cordis.patch.yml
    ...loadOptionalPatches(binName, join(context.home, "cordis.patch.yml")) ?? [],       // 3. $DSH_HOME/cordis.patch.yml
    ...context.overlays                                            // 4. --patch files, argv order
]);
… patches.push(telemetryPatch)                                     // 5. DSH_TELEMETRY_DISABLED disable patch
```

Everything is passed as **one flattened patch list** into a single `applyEntryPatches` call:
`mountRootInclude` at `dsh-app-boot/lib/index.js:3691-3712` calls
`prepareProfilePatches(ctx, [...patches], …)` (`:2150-2154`), which composes all layers over an empty root
and returns `[{ insert: rows }]` — that single insert is the root include's `config.patches`.

**Correction to the premise in the task:** the profile's own `cordis.patch.yml` is applied after every
bundle layer, but **not strictly last** — `$DSH_HOME/cordis.patch.yml` (if present), then `--patch`
overlays, then the telemetry disable patch all come after it. On this machine `~/.dsh/cordis.patch.yml`
does **not** exist (`ls: No such file or directory`), so today the profile layer is effectively last.

**So for `bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", <our-plugin>]`:** base first,
web-app second (overriding base rows by id), our plugin third — i.e. our plugin's patch layer is applied
after both, and a later layer always wins because each patch writes onto the already-patched row.

**Which bundle defines `web` + `fetchProvider: http`:** **`@deepseek-ai/dsh-base`**, and it is the only
definition anywhere in the shipped packages. A full-tree grep for `id: web$` over
`dsh/node_modules/@deepseek-ai` returns exactly one hit.

`dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:472-477`:

```yaml
    - id: web
      name: '@deepseek-ai/dsh-web'
      config:
        searchProvider: deepseek-official
        fetchProvider: http
```

(`@deepseek-ai/dsh-web-app`'s patch does not mention `web`/`fetchProvider` at all; its own header at
`dsh-web-app/cordis.patch.yml:1-3` says it is "Applied after dsh-base's insert; rows here override base
rows by id". The shipped `web` profile template is just
`PROFILE_TEMPLATES.web = { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] }`,
`dsh-app-boot/lib/index.js:531`.)

The neighbouring rows are also base-owned: `web-search-deepseek` at `:478-481`, `web-fetch-http` at
`:483-484`, `tool-web` at `:486+` (disabled by `dsh-web-app` later).

---

## 4. How `dsh.bundle.patch` reaches `dsh.profile.bundles`

**Answer: it is automatic in both paths. The user does not edit `package.json` by hand.**

### CLI: `dsh plugin --profile desktop add <pkg>`

`dsh/node_modules/@deepseek-ai/dsh/lib/plugin-BGnVfe_D.js:63-99` (`runPlugin`) builds
`{profile, dir, installAnchor: INSTALL_ANCHOR, cwd}` and, for `desktop`, wraps
`runProfilePnpm(context, args, options)` in a profile-`package.json` file lock (`:90-93`);
`INSTALL_ANCHOR` is the CLI package's own manifest (`dsh/lib/profile-boot-BZ2ZjNWi.js:119`:
`fileURLToPath(new URL("../package.json", import.meta.url))`).
Note `plugin-BGnVfe_D.js:10-12`: for `--profile desktop` the desktop app must have been opened once and
must be fully quit.

`dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:526-537` (`runPluginCommand`)
→ `runProfilePnpm` (same file, and `dsh-plugin-manager/lib/index.js:438`). After pnpm exits 0 and the
post-install compatibility sweep passes:

`dsh-plugin-manager/lib/types/operations.js:503-505`

```js
else if (options.activateNewBundles !== false) {
    await reconcile(before, dir, context.installAnchor, options);
}
```

`reconcile` — `dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js:238-266`:

```js
for (const name of dependencies) {
    if (beforeDeps.has(name)) continue;
    const metadata = bundleManifest(name, dir, anchor);
    if (metadata?.dsh?.bundle === void 0) {
        options.onOutput?.(`dsh: warning: ${name} declares no dsh.bundle — installed as a plain dependency, not a profile layer\n`, "stderr");
        continue;
    }
    for (const file of bundlePatchPaths(resolveBundleDir("dsh", name, anchor, dir), metadata.dsh.bundle)) loadOverlayPatches("dsh", file);
    if (!bundles.includes(name)) bundles.push(name);
}
… after.dsh = { …profile: { …bundles } }; await saveManifest(dir, after);
```

So: newly added **dependencies** that declare `dsh.bundle.patch` are appended to
`dsh.profile.bundles` and the manifest is written atomically (`saveManifest`, `:234-236`, mode 0600).
Packages without `dsh.bundle` stay plain dependencies and produce the warning above. Note `reconcile`
appends at the **end**, which is what you want for "my layer wins".

### Web/UI Plugins page

`dsh-plugin-manager/lib/index.js:1749-1808` (the `install` operation) runs
`this.runPnpm(["add", spec, …])`, which passes `activateNewBundles: false` (`:1916`) so `reconcile` is
*not* used; instead, after the install it requires `manifest.dsh.bundle` to exist
(`:1786` `throw new ManagementFailure("not-bundle")`), re-checks compatibility (`:1787-1788`), then

`dsh-plugin-manager/lib/index.js:1800`

```js
if (options?.enabled !== false) await this.selectBundle(name, true);
```

and `selectBundle` (`:1979-2005`) appends the name to `dsh.profile.bundles` and saves the manifest.
The sidebar page is `@deepseek-ai/dsh-client-ui-plugin-manager`, mounted as row `ui-plugin-manager`
(`dsh-web-app/cordis.patch.yml`), over the `pluginManager` Remote.

### The version-compatibility gate

`dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:286-313`:

```js
function evaluatePluginCompatibility(manifest, exemptions = {}, runtimeVersion = getDshRuntimeVersion()) {
    runtimeVersionOf(runtimeVersion);
    const fields = objectOf$1(manifest, "Plugin manifest");
    if (!Object.hasOwn(fields, "peerDependencies")) return void 0;
    const dependencies = objectOf$1(fields.peerDependencies, "Plugin manifest peerDependencies");
    const peers = {};
    for (const [name, range] of Object.entries(dependencies)) {
        if (typeof range !== "string") throw …
        if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;
        const requirement = ["workspace:^","workspace:~","workspace:*"].includes(range) ? runtimeVersion : range;
        if (requirement.trim() === "" || !semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })) peers[name] = range;
    }
    if (Object.keys(peers).length === 0) return void 0;
    const name = identityField(fields, "name"); const version = identityField(fields, "version");
    const key = `${name}@${version}`;
    return { name, version, runtimeVersion, peers,
             exempted: (Object.hasOwn(exemptions, key) ? exemptions[key] : void 0)?.includes(runtimeVersion) === true };
}
```

Key facts:

- **Only peers named `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` are checked** (line 294). Any other peer
  (e.g. `undici`, `zod`) is ignored entirely.
- The declared peer **range is compared against the dsh runtime version**, not against the installed
  package version. `runtimeVersion` comes from `getDshRuntimeVersion()` (`:271-275`), which reads
  `../package.json` relative to `@deepseek-ai/dsh-app-boot/lib/index.js` → **`0.2.0-rc.2`** on this install.
  So a plugin declaring `"@deepseek-ai/dsh-tools": "^0.1.0"` is **rejected** on 0.2.0-rc.2, while
  `">=0.1.0-rc.6 <0.3.0"` (what the installed example plugin declares) passes. Prereleases participate
  (`includePrerelease: true`); `workspace:^|~|*` is treated as the current runtime.
- A plugin with **no** `peerDependencies` is always compatible (line 289).
- Exemptions live in `<profileDir>/compatibility.json` — a separate file, keyed by exact
  `name@version` → array of exact dsh versions (`:328`, `:359-410`). Grants require
  `--accept-risk` and must name the currently running dsh version (`:421-425`); CLI surface
  `dsh plugin --profile <p> allow-version <pkg@ver> --dsh-version <ver> --accept-risk`
  (`dsh/lib/plugin-BGnVfe_D.js:14-56`, `runPluginCommand`).
- Denial is **fail-loud at several layers**: pre-install (`operations.js` preflight, `namedSpecManifest`
  → `rejected(preflight, "nothing was installed")`), post-install (restores `package.json` +
  `pnpm-lock.yaml` and reinstalls), bundle **load** (`loadProfileDirectory` `:930-931` throws → the bundle
  lands in `skippedBundles` and contributes **no** patch layer, `:941-946`), and per-row **preflight**
  (`prepareProfileEntries`/`preflight` `:2057-2140` sets `row.disabled = true` for a denied row).
- The user-facing text is `pluginCompatibilityWarning` (`:320-323`).

The installed example is fully consistent: a third-party plugin under
`~/.dsh/profiles/desktop/node_modules/<plugin>/package.json` declares
`"peerDependencies": {"@deepseek-ai/dsh-tools": ">=0.1.0-rc.6 <0.3.0"}` and
`"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`; its patch is a single `insert`
(`…/<plugin>/cordis.patch.yml`), and the name is already the last entry of
`~/.dsh/profiles/desktop/package.json` `dsh.profile.bundles`.

### Bonus finding: `~/.dsh/profiles/desktop/cordis.yml` is an OUTPUT, not an input

`dsh/node_modules/@deepseek-ai/dsh/lib/profile-boot-BZ2ZjNWi.js:121-127`:

```js
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`;
const PROFILE_ROOT_FILENAME = "cordis.yml";
```

and `:189` / `:207` unconditionally
`writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)` on every boot. The large
composed tree you see in `cordis.yml` is the vendored Loader's write-back. **Editing `cordis.yml` has no
effect on the next boot**; the real inputs are `package.json`'s `dsh.profile.bundles` and
`cordis.patch.yml`.

---

## 5. How a profile-installed plugin's bare `import '@deepseek-ai/…'` resolves

Verified live: `~/.dsh/profiles/desktop/node_modules/` contains **only one** third-party plugin
(`<plugin>/`), plus `.modules.yaml`, `.pnpm/` and `.pnpm-workspace-state-v1.json` — there is
**no `@deepseek-ai/` directory** (`ls: …/node_modules/@deepseek-ai: No such file or directory`).
That plugin's `src/index.js:27` does `import { defineTool } from '@deepseek-ai/dsh-tools'`.

**The rule: the runtime resolver supplies the transitive `dependencies` + `peerDependencies` closure of
the installation manifest (plus packages carried by the profile's *selected* bundles) to any module
whose importer lives inside a profiles tree.**

Mechanism, in order:

1. Node's internal ESM/CJS resolvers are patched at boot. `internalModules()`
   (`dsh-app-boot/lib/index.js:1574-1594`) pulls `internal/modules/esm/loader`, `internal/modules/cjs/loader`,
   `internal/modules/helpers`, `internal/modules/esm/utils`, `internal/modules/esm/resolve` through the
   `node-addon-require-builtin` addon, and asserts `esm.resolveSync`, `getOrCreateModuleJob` (or
   `getModuleJobForImport`), `Module._resolveFilename`, `getCjsConditions`, `getDefaultConditions`,
   `defaultResolve` all exist — else `"profile resolution: unsupported Node module loader"`.
   `installRuntimeInterception(resolution)` (`:1641`) then wraps `esm.resolveSync` / `resolve` (`:1698-1731`)
   and `Module._resolveFilename` (`:1732+`), restoring them on dispose.
   It is installed by the `PluginPackages` service: `dsh-app-boot/lib/index.js:3207-3221`
   (`const interception = installRuntimeInterception(config.resolution)`), mounted by the launcher at
   `dsh/lib/profile-boot-BZ2ZjNWi.js:275` (`await hostCtx.plugin(PluginPackages, { resolution: composed.resolution })`).
   Workers get the same table through `registerWorkerResolution` (`:3216`,
   `dsh-app-boot/lib/worker/profile-resolution-bootstrap.js`, same router at `:101`, `:346`).

2. **Only importers inside a profiles tree (or a linked root) are intercepted** —
   `dsh-app-boot/lib/index.js:1214-1223`:

```js
function findInterceptionLayer(path, resolution) {
    const treeRoot = resolution.profilePaths.find((prefix) => path.startsWith(prefix));
    const activeProfile = resolution.profile.find((prefix) => path.startsWith(prefix));
    const dir = treeRoot !== void 0 ? profileChild(path, treeRoot) : activeProfile?.slice(0, -1);
    if (dir !== void 0) return computeProfileLayer(dir, activeProfile !== void 0);
    if (!startsWithin(path, resolution.linkedPaths)) return void 0;
    if (startsWithin(path, resolution.installationPaths)) return void 0;
    return { kind: "linked" };
}
```

   A plugin at `~/.dsh/profiles/desktop/node_modules/<pkg>/src/index.js` is inside the profiles tree **and**
   inside the active profile → `{kind:"profile", active:true}` (`computeProfileLayer`, `:1203-1213`).

3. **The decisive routing branch** — `dsh-app-boot/lib/index.js:1459-1467`:

```js
const route = target !== void 0 && (target.scope === "installation" || layer.active) ? {
    kind: "interception",
    entry: target,
    after: layer.after
} : {
    kind: "native-after-interception",
    parent: layer.nativeAfter
};
```

   `target = resolution.entries.get(name)` (`:1421`). An interception route re-resolves the request as if
   the importer were the package's **declarer** (`:1674`:
   `const routedParent = pathToFileURL(route.kind === "interception" ? route.entry.declarer : route.parent).href;`),
   so the module comes from the installation's own `node_modules`. Note that a **local copy wins first**:
   `:1423-1428` walks `createRequire(parent).resolve.paths(name)` restricted to `layer.localPrefix` (the
   profile dir), and `routeLocalPackage` (`:1526-1533`) short-circuits `localPackageNames` to native.

4. **What populates `resolution.entries`** — `dsh-app-boot/lib/index.js:681-726`
   (`collectInstallationScopePackages`), documented at `:681` as
   *"Resolve the installation packages that the runtime resolver supplies to every profile."*
   It seeds from the install anchor's manifest and walks `dependencies` + `peerDependencies`
   transitively (`profileDependencyNames`, `:677-680`), tagging each entry `scope: "installation"`
   (`:746-758`). `collectProfileScopePackages` (`:816-821`) adds the dependency closures of the profile's
   **selected bundles** (`profile.layers`), tagged `scope: "profile"`.

   **It is therefore NOT "every package installed in the dsh installation" literally — it is the
   declared dependency/peer closure of the installation manifest.** I enumerated that closure from the
   asar (walking `dependencies`+`peerDependencies` only, exactly as the code does):

   - Anchor = the desktop app's install anchor, `app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json`
     (see below): closure of **499** packages; of the **290** `@deepseek-ai/*` packages physically present
     under `dsh/node_modules/@deepseek-ai/`, **287 are reachable**. The 3 that are not:
     `@deepseek-ai/dsh-desktop-host`, `@deepseek-ai/libreoffice-kit-darwin-arm64`,
     `@deepseek-ai/node-addon-system-darwin-arm64` (the last two are platform binaries, almost certainly
     reached via `optionalDependencies`, which `profileDependencyNames` does **not** walk).
   - `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-web`, `@deepseek-ai/dsh-web-fetch-http` are all reachable
     under either anchor.
   - The desktop app's anchor: `lib/main.js:11030-11037` sets `dsh: join(app.getAppPath(), "dsh")` for the
     packaged app, and `dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js:220` computes
     `installAnchor = join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "package.json")` — i.e.
     `<app.asar>/dsh/node_modules/@deepseek-ai/dsh/package.json`. (With the desktop-runtime manifest
     `dsh/package.json` as anchor the closure is 501 packages, missing only the two platform binaries.)

**Direct answer to the last question:** Yes — a plugin at
`~/.dsh/profiles/desktop/node_modules/<pkg>/src/index.js` **can** bare-import any `@deepseek-ai/*`
package that is reachable in the installation's `dependencies`/`peerDependencies` closure. In practice
that is essentially the whole shipped runtime (`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-web`,
`@deepseek-ai/dsh-web-fetch-http`, `@deepseek-ai/dsh-session`, … all qualify), and it resolves to the
**app.asar copy**, not a profile copy. It is *not* an unconditional "anything under
`app.asar/dsh/node_modules`": a package present in the archive but absent from the closure would not be
supplied (I found exactly 3 such `@deepseek-ai` packages, and only for the CLI anchor /
2 for the runtime anchor). Also note the plugin's own `peerDependencies` are **not** what grants this —
resolution is name-based against the installation table; the `peerDependencies` field only drives the
compatibility gate of §4. Practically, declaring the peer is still required, because otherwise the
compatibility check silently passes but nothing else changes — and `pnpm` will not install a copy into
the profile (the example plugin's manifest has no `dependencies` at all).

---

## Could NOT determine / worth checking next

1. **Duplicate `id` behaviour.** `insert`ing a row whose id already exists leaves two rows and moves the
   id index. Whether the Cordis Loader rejects the duplicate id (or silently mounts both) is unverified —
   check `dsh/node_modules/@deepseek-ai/cordis-plugin-loader/src/config/tree.ts` / `entry.ts` id handling.
2. **`optionalDependencies` are not walked** by `collectInstallationScopePackages`; I inferred (did not
   confirm) that `@deepseek-ai/libreoffice-kit-darwin-arm64` / `node-addon-system-darwin-arm64` are
   optional deps of `libreoffice-kit` / `node-addon-system`. If a plugin needs one of those, the
   interception table will not supply it.
3. **The `linked` layer** (`linkedProfileRoots`, `:630-675`; `routeLinked`, `:1472-1526`) governs profile
   `node_modules` symlinks pointing outside the profiles tree (e.g. `file:`/`link:` installs). I read the
   code but did not exercise it; a symlinked third-party plugin resolves through a different branch.
4. **`--patch` overlay ordering** is argv order (`context.overlays`, `readProfilePatches:1029`), and the
   launcher passes `patchFiles: []` for the desktop app
   (`dsh-desktop-host/lib/index.js:230`). Not exercised.
5. **Exact `app.getAppPath()` value** for this installed bundle was inferred from
   `lib/main.js:11036` + the presence of `dsh/` inside `app.asar`; I did not run Electron to print it.
   The two candidate anchors give the same answer for every package that matters here.
6. `~/.dsh/profiles/desktop/.plugin-manager/` exists (logs/run records) — I did not read it; it may
   contain the history of the plugin install.

## Scratch artifacts

The one-off archive reader/grep scripts used for this recon were not kept in this repository: they are
about 30 lines over the archive's JSON header (see §0) and are unrelated to the plugin itself.
