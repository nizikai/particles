# Showcase Per-Section Hover & Water Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the showcase (column) section its own copy of every Cursor hover + Glass water setting, with louder defaults, so it can be tuned independently of the hero.

**Architecture:** Flat `sc*`-prefixed twins of the 13 existing config keys. Water: each glass net carries an `isCard` flag and reads every tunable through a tiny `netCfg()` resolver. Spotlight: cards get their own material clone (`hoverCardMat`) driven from the `sc*` keys in `tick()`. New "Showcase hover" panel section with the 13 twin sliders.

**Tech Stack:** Vanilla JS + Three.js (CDN importmap), static site — no build step. Verify with `python3 -m http.server` + `playwright-cli` (see the repo's `verify` skill).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-15-showcase-hover-settings-design.md`
- Only two files change: `showcase/main.js`, `showcase/index.html`.
- Showcase defaults equal hero values EXCEPT: `scHoverDotSize: 5`, `scGlowGain: 7`, `scNetSize: 14`.
- Hero behavior at defaults must be pixel-identical to before (its config keys and code paths keep their current values).
- The card dots' build-time 8× edge density + surface fill stay hardcoded.
- Tabs for indentation (match file style). No new dependencies.
- Line numbers below are approximate — locate by the quoted code, not the number.

---

### Task 1: Water sim reads per-section values

**Files:**
- Modify: `showcase/main.js` (config object ~line 640; `makeGlassNet` ~line 1862; `rebuildGlassNets` ~line 1973; `createCardBack` ~line 1490; `updateGlassNets` ~line 2005)

**Interfaces:**
- Produces: config keys `scNetDensity, scNetSize, scWaveSpeed, scWaveLife, scWaveStrength, scSplashSize, scSettleRate, scGlowGain, scWaveMotion, scHoverFade` (numbers); `netCfg(net, key)` → number (resolves `key` or its `sc` twin by `net.isCard`); `makeGlassNet(mesh, refSize, isCard)` third param; `net.isCard` boolean.
- Consumes: existing `config`, `glassNets`, `makeGlassNet`, `updateGlassNets`.

- [ ] **Step 1: Add the showcase water config keys**

In the `config` object, directly after the `waveMotion: 3,` line, insert:

```js
		// --- showcase (column section) twins: the card slabs read these instead
		// of the hero keys above, so the two sections tune independently.
		// Louder where the card art washes the effect out: glow gain + net size.
		scNetDensity: 1,        // showcase glass-net dot density (cards resample on change)
		scNetSize: 14,          // showcase node point size in px
		scWaveSpeed: 1,         // showcase water propagation speed
		scWaveLife: 0.96,       // showcase per-step damping
		scWaveStrength: 0.5,    // showcase stir strength
		scSplashSize: 3,        // showcase arrival splash amplitude
		scSettleRate: 1,        // showcase settle rate
		scGlowGain: 7,          // showcase wave brightness
		scWaveMotion: 3,        // showcase dot ride distance
		scHoverFade: 2,         // showcase dwell seconds before stir + spotlight die (0 = never)
		scHoverIntensity: 1,    // showcase spotlight strength (0 = off)
		scHoverRadius: 0.35,    // showcase spotlight radius
		scHoverDotSize: 5,      // showcase spotlight dot size
```

- [ ] **Step 2: Tag nets with their section and use per-section density**

Change the `makeGlassNet` signature and its density read:

```js
	function makeGlassNet(mesh, refSize, isCard = false) {
```

In the same function, change the sample-count line

```js
		const n = Math.max(32, Math.min(NET_DOT_CAP, Math.round(area / (spacing * spacing) * config.netDensity)));
```

to

```js
		const n = Math.max(32, Math.min(NET_DOT_CAP, Math.round(area / (spacing * spacing) * (isCard ? config.scNetDensity : config.netDensity))));
```

and add `isCard` to the `net` object literal (the one with `acc: 0, energy: 0, ...`):

```js
			acc: 0, energy: 0, dirty: false, wasLit: false, hoverT: 0, isCard
```

Update the two card-side callers to pass the flag:
- in `rebuildGlassNets`: `c.glassNet = makeGlassNet(c.glassMesh, undefined, true);`
- in `createCardBack`: `c.glassNet = makeGlassNet(mesh, undefined, true);`

(The hero caller `makeGlassNet(g.mesh, coreMaxDim)` stays as-is — defaults to `false`.)

- [ ] **Step 3: Resolve every water tunable through the net's section**

Just above `function updateGlassNets(t, dt)`, add:

```js
	// per-section tunables: card nets read the sc* twins, hero nets the originals
	function netCfg(net, key) {
		return net.isCard ? config["sc" + key[0].toUpperCase() + key.slice(1)] : config[key];
	}
```

Inside `updateGlassNets`, replace the two pre-loop constants

```js
		const size = config.netSize * renderer.getPixelRatio();
		const stepDt = 1 / (90 * config.waveSpeed);   // sim substep — waveSpeed scales propagation
		for (const net of glassNets) {
			net.mat.uniforms.u_size.value = size;
```

with per-net reads:

```js
		const pr = renderer.getPixelRatio();
		for (const net of glassNets) {
			net.mat.uniforms.u_size.value = netCfg(net, "netSize") * pr;
			const stepDt = 1 / (90 * netCfg(net, "waveSpeed"));   // sim substep — waveSpeed scales propagation
```

Then, still inside the loop, swap the remaining global reads for `netCfg`:
- `config.settleRate` → `netCfg(net, "settleRate")`
- `config.hoverFade` → `netCfg(net, "hoverFade")` (both occurrences in the `dwell` line)
- `config.waveStrength` → `netCfg(net, "waveStrength")`
- `config.splashSize` → `netCfg(net, "splashSize")`
- `waveStep(net, config.waveLife)` → `waveStep(net, netCfg(net, "waveLife"))`
- `const mGain = config.waveMotion * net.cellU * 4;` → `const mGain = netCfg(net, "waveMotion") * net.cellU * 4;`
- `config.glowGain` → `netCfg(net, "glowGain")`

- [ ] **Step 4: Verify no global water reads remain in the loop**

Run: `grep -n 'config\.\(netSize\|waveSpeed\|settleRate\|waveStrength\|splashSize\|waveLife\|waveMotion\|glowGain\)' showcase/main.js | grep -v bindSlider`
Expected: no hits inside `updateGlassNets` (hits in the config object comments / slider bindings are fine).

- [ ] **Step 5: Browser smoke test**

```bash
python3 -m http.server 8734 &   # repo root
export PWCLI="$HOME/.codex/skills/playwright/scripts/playwright_cli.sh"
"$PWCLI" open "http://localhost:8734/showcase/index.html"
```

Wait ~9s (intro), stir the logo (`mousemove` wiggle over ~640,330), confirm water ripples as before and die out after leaving. Scroll to `max*0.55`, stir the focused card — water dots should now render noticeably BIGGER and HOTTER than the hero's (scNetSize 14 vs 10, scGlowGain 7 vs 5). Console: only the pre-existing favicon 404.

- [ ] **Step 6: Commit**

```bash
git add showcase/main.js
git commit -m "Give showcase card water sim its own sc* config twins"
```

---

### Task 2: Spotlight gets a per-section material

**Files:**
- Modify: `showcase/main.js` (`hoverDotMat` block ~line 170; `makeHoverDots` ~line 180; `createCardBack` card-dots call ~line 1502; `tick()` hover-uniform block ~line 2375)

**Interfaces:**
- Consumes: Task 1's `scHoverIntensity, scHoverRadius, scHoverDotSize, scHoverFade` config keys; existing `hoverDotMat`, `makeHoverDots`, `glassDwellT`.
- Produces: `hoverCardMat` (THREE.ShaderMaterial clone, same uniforms as `hoverDotMat`); `makeHoverDots(mesh, refDiag, surfSpacing, edgeDensity = 1, mat = hoverDotMat)` fifth param.

- [ ] **Step 1: Add the card spotlight material**

Directly under the two `hoverDotMat.uniforms...` init lines, add:

```js
	// the showcase cards' own clone — separate size/radius/opacity uniforms are
	// what let the two sections tune independently (one shared material was why
	// they couldn't before)
	const hoverCardMat = hoverDotMat.clone();
```

(`clone()` copies the already-set `u_spawnElapsed`/`u_cursorReveal` values.)

- [ ] **Step 2: Let makeHoverDots build with either material**

Change:

```js
	function makeHoverDots(mesh, refDiag, surfSpacing, edgeDensity = 1) {
		hoverDotMat.uniforms.u_size.value = config.hoverDotSize * renderer.getPixelRatio();
		const points = makeWireframePoints(mesh, refDiag, hoverDotMat, surfSpacing, 20, edgeDensity);
```

to:

```js
	function makeHoverDots(mesh, refDiag, surfSpacing, edgeDensity = 1, mat = hoverDotMat) {
		mat.uniforms.u_size.value = (mat === hoverCardMat ? config.scHoverDotSize : config.hoverDotSize) * renderer.getPixelRatio();
		const points = makeWireframePoints(mesh, refDiag, mat, surfSpacing, 20, edgeDensity);
```

In `createCardBack`, pass the card material:

```js
			c.hoverDots = makeHoverDots(mesh, slabDiag, slabDiag * 0.03, 8, hoverCardMat);
```

- [ ] **Step 3: Drive both materials from their own keys in tick()**

Replace the block:

```js
		hoverDotMat.uniforms.u_cursor.value.set(hoverCursor.x, hoverCursor.y);
		hoverDotMat.uniforms.u_cursorRadius.value = config.hoverRadius;
		hoverDotMat.uniforms.u_aspect.value = camera.aspect;
		// same dwell timeout as the water stir: parked on the glass past
		// hoverFade, the spotlight dots fade away too (eased, so no pop when
		// glassDwellT resets on leaving); hoverIntensity scales the whole effect
		const dwellTarget = (config.hoverFade > 0 ? Math.max(0, 1 - glassDwellT / config.hoverFade) : 1) * config.hoverIntensity;
		hoverDotMat.uniforms.u_opacity.value += (dwellTarget - hoverDotMat.uniforms.u_opacity.value) * Math.min(1, dt * 4);
```

with:

```js
		// same dwell timeout as the water stir: parked on the glass past its
		// section's hoverFade, the spotlight dots fade away too (eased, so no
		// pop when glassDwellT resets on leaving); intensity scales the effect.
		// Hero and showcase materials each read their own section's keys.
		for (const [m, iK, rK, fK] of [
			[hoverDotMat, "hoverIntensity", "hoverRadius", "hoverFade"],
			[hoverCardMat, "scHoverIntensity", "scHoverRadius", "scHoverFade"]
		]) {
			m.uniforms.u_cursor.value.set(hoverCursor.x, hoverCursor.y);
			m.uniforms.u_cursorRadius.value = config[rK];
			m.uniforms.u_aspect.value = camera.aspect;
			const target = (config[fK] > 0 ? Math.max(0, 1 - glassDwellT / config[fK]) : 1) * config[iK];
			m.uniforms.u_opacity.value += (target - m.uniforms.u_opacity.value) * Math.min(1, dt * 4);
		}
```

- [ ] **Step 4: Browser verify both spotlights**

Reload the open page. Hero: hover the logo → spotlight dots at size 3 exactly as before; park 2s → fades; leave/return → back. Showcase (`scrollTo max*0.55`): fresh hover on the focused card → edge glow + surface dots now clearly BIGGER (size 5). Console clean.

- [ ] **Step 5: Commit**

```bash
git add showcase/main.js
git commit -m "Split cursor spotlight into hero + showcase materials with sc* keys"
```

---

### Task 3: "Showcase hover" panel section

**Files:**
- Modify: `showcase/index.html` (after the last Glass water ctrl — the "Wave motion" block)
- Modify: `showcase/main.js` (after the existing hero hover `bindSlider` calls ~line 2705)

**Interfaces:**
- Consumes: Task 1 + 2 config keys, `hoverCardMat`, `rebuildGlassNets`, `bindSlider(id, valId, onChange, fmt)`.
- Produces: slider ids `s-schoverint, s-schoverrad, s-schoverdot, s-schoverfade, s-scnetnodes, s-scnetsize, s-scwavespeed, s-scwavelife, s-scwavestr, s-scsplash, s-scsettle, s-scglowgain, s-scwavemove` (+ matching `v-*` spans).

- [ ] **Step 1: Add the HTML section**

In `showcase/index.html`, directly after the closing `</div>` of the "Wave motion" ctrl (the last Glass water control), insert:

```html
			<div class="section-label">Showcase hover</div>
			<div class="ctrl">
				<label>Hover intensity <span class="val" id="v-schoverint">1.00</span></label>
				<input type="range" id="s-schoverint" min="0" max="1" step="0.05" value="1" />
				<div class="hint">Spotlight dots on the showcase cards' glass. 0 = off.</div>
			</div>
			<div class="ctrl">
				<label>Hover radius <span class="val" id="v-schoverrad">0.35</span></label>
				<input type="range" id="s-schoverrad" min="0.05" max="1" step="0.05" value="0.35" />
			</div>
			<div class="ctrl">
				<label>Hover dot size <span class="val" id="v-schoverdot">5.0</span></label>
				<input type="range" id="s-schoverdot" min="1" max="10" step="0.5" value="5" />
			</div>
			<div class="ctrl">
				<label>Hover fade <span class="val" id="v-schoverfade">2.0s</span></label>
				<input type="range" id="s-schoverfade" min="0" max="10" step="0.5" value="2" />
			</div>
			<div class="ctrl">
				<label>Net density <span class="val" id="v-scnetnodes">1.00×</span></label>
				<input type="range" id="s-scnetnodes" min="0.2" max="3" step="0.05" value="1" />
				<div class="hint">Card water-dot density. Resamples the nets.</div>
			</div>
			<div class="ctrl">
				<label>Net node size <span class="val" id="v-scnetsize">14</span></label>
				<input type="range" id="s-scnetsize" min="2" max="40" step="1" value="14" />
			</div>
			<div class="ctrl">
				<label>Wave speed <span class="val" id="v-scwavespeed">1.00</span></label>
				<input type="range" id="s-scwavespeed" min="0.3" max="3" step="0.05" value="1" />
			</div>
			<div class="ctrl">
				<label>Wave life <span class="val" id="v-scwavelife">0.960</span></label>
				<input type="range" id="s-scwavelife" min="0.93" max="0.998" step="0.002" value="0.96" />
			</div>
			<div class="ctrl">
				<label>Stir strength <span class="val" id="v-scwavestr">0.50</span></label>
				<input type="range" id="s-scwavestr" min="0.2" max="3" step="0.05" value="0.5" />
			</div>
			<div class="ctrl">
				<label>Splash size <span class="val" id="v-scsplash">3.0</span></label>
				<input type="range" id="s-scsplash" min="0" max="6" step="0.1" value="3" />
			</div>
			<div class="ctrl">
				<label>Settle rate <span class="val" id="v-scsettle">1.00</span></label>
				<input type="range" id="s-scsettle" min="0" max="3" step="0.05" value="1" />
			</div>
			<div class="ctrl">
				<label>Glow gain <span class="val" id="v-scglowgain">7.0</span></label>
				<input type="range" id="s-scglowgain" min="1" max="10" step="0.1" value="7" />
			</div>
			<div class="ctrl">
				<label>Wave motion <span class="val" id="v-scwavemove">3.00</span></label>
				<input type="range" id="s-scwavemove" min="0" max="3" step="0.05" value="3" />
			</div>
```

- [ ] **Step 2: Bind the sliders**

In `showcase/main.js`, after the `bindSlider("s-hoverdot", ...)` line, add:

```js
	bindSlider("s-schoverint", "v-schoverint", (v) => { config.scHoverIntensity = v; }, (v) => v.toFixed(2));
	bindSlider("s-schoverrad", "v-schoverrad", (v) => { config.scHoverRadius = v; }, (v) => v.toFixed(2));
	bindSlider("s-schoverdot", "v-schoverdot", (v) => { config.scHoverDotSize = v; hoverCardMat.uniforms.u_size.value = v * renderer.getPixelRatio(); }, (v) => v.toFixed(1));
	bindSlider("s-schoverfade", "v-schoverfade", (v) => { config.scHoverFade = v; }, (v) => v > 0 ? v.toFixed(1) + "s" : "off");
	bindSlider("s-scnetnodes", "v-scnetnodes", (v) => { config.scNetDensity = v; rebuildGlassNets(); }, (v) => v.toFixed(2) + "×");
	bindSlider("s-scnetsize", "v-scnetsize", (v) => { config.scNetSize = v; }, (v) => String(Math.round(v)));
	bindSlider("s-scwavespeed", "v-scwavespeed", (v) => { config.scWaveSpeed = v; }, (v) => v.toFixed(2));
	bindSlider("s-scwavelife", "v-scwavelife", (v) => { config.scWaveLife = v; }, (v) => v.toFixed(3));
	bindSlider("s-scwavestr", "v-scwavestr", (v) => { config.scWaveStrength = v; }, (v) => v.toFixed(2));
	bindSlider("s-scsplash", "v-scsplash", (v) => { config.scSplashSize = v; }, (v) => v.toFixed(1));
	bindSlider("s-scsettle", "v-scsettle", (v) => { config.scSettleRate = v; }, (v) => v.toFixed(2));
	bindSlider("s-scglowgain", "v-scglowgain", (v) => { config.scGlowGain = v; }, (v) => v.toFixed(1));
	bindSlider("s-scwavemove", "v-scwavemove", (v) => { config.scWaveMotion = v; }, (v) => v.toFixed(2));
```

- [ ] **Step 3: Cross-check ids**

```bash
cd showcase
grep -o 'id="s-[a-z]*"' index.html | sort -u | sed 's/id="//;s/"//' > /tmp/html_ids.txt
grep -o '"s-[a-z]*"' main.js | sort -u | sed 's/"//g' > /tmp/js_ids.txt
comm -3 /tmp/html_ids.txt /tmp/js_ids.txt
```

Expected: only `s-cardthick` (pre-existing, null-guarded JS-only binding). Anything else = a typo to fix.

- [ ] **Step 4: Verify Copy settings includes the new keys**

The Copy button iterates `Object.entries(config)`, so all 13 keys appear automatically. Confirm in browser: open panel → the "Showcase hover" section renders with defaults (dot size 5.0, glow gain 7.0, net size 14); drag showcase Glow gain to 10 while hovering a card → card water gets hotter live; hero unaffected.

- [ ] **Step 5: Commit**

```bash
git add showcase/index.html showcase/main.js
git commit -m "Add Showcase hover panel section with the 13 sc* sliders"
```

---

### Task 4: End-to-end verification pass

**Files:** none (verification only)

**Interfaces:** consumes everything above.

- [ ] **Step 1: Hero regression** — reload; after intro: hover logo (spotlight size 3, water ripples, edge stir dies after leaving), park 2s → both fade, leave/return → both reset. Screenshot.
- [ ] **Step 2: Showcase boost** — scroll to `max*0.55`; fresh hover on focused card: spotlight dots clearly bigger than hero's, water glow hotter; park 2s → fades; leave/return → resets. Screenshot.
- [ ] **Step 3: Independence** — via panel, set showcase Stir strength to 3 and hero Stir strength unchanged; stir card (big waves), scroll to hero, stir logo (unchanged waves). Screenshot each.
- [ ] **Step 4: Health** — console shows only favicon 404; fps ≈ 60 in both sections; replay intro once (unaffected).
- [ ] **Step 5: Final commit if any fixes were needed**, message: `"Fix issues found in showcase hover settings verification"`.
