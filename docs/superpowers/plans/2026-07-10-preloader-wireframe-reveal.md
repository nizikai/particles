# Preloader Wireframe Reveal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the black/wordmark preloader phase, have the iris reveal open onto a glowing white wireframe version of the hero scene (logo + ground) with 4 small labeled floating shards, hold briefly, then crossfade into the fully rendered scene.

**Architecture:** Single-file change to `showcase/main.js` (no new files, no new dependencies — everything needed is already imported via `import * as THREE from "three"`). A new intro-sequence state machine, driven by the existing per-frame `tick()` loop (same pattern as the current iris-mask code — no new `requestAnimationFrame` loop), runs after `hidePreloader()` fires: build wireframe outlines as siblings of the real meshes (hiding the real meshes via `.visible`), hold, then crossfade (wireframe opacity → 0, real meshes popped back visible, bloom eased back to normal), then dispose everything the intro created.

**Tech Stack:** Vanilla JS, Three.js r169 (`THREE.EdgesGeometry`, `THREE.LineSegments`, `THREE.LineBasicMaterial`, `THREE.TetrahedronGeometry`, `THREE.Sprite`/`THREE.SpriteMaterial`, `THREE.CanvasTexture` — all already available via the existing `three` import, no new imports). No test framework exists in this project (static HTML/JS/CSS, no `package.json`) — verification is via `node --check` for syntax and Playwright-driven visual screenshots, matching how the preloader/iris/headline features earlier in this project were verified.

## Global Constraints

- No new npm dependencies or imports beyond what `showcase/main.js` already imports.
- Match existing code style: tabs for indentation, comments only where the *why* isn't obvious from the code (per this file's existing commenting style).
- The column (`column.glb`/`columnGroup`) is NOT part of this feature — it's only visible later during the scroll-driven showcase section (`showcaseActive`), not in the hero view at page load, so it's out of scope for the wireframe reveal. Only the logo (`glassMeshes`) and ground (`groundObj`) are wireframed.
- `mesh.visible = false` on a Three.js object prevents its children from rendering (the renderer's `projectObject` returns before recursing into an invisible object's children) — wireframe lines must be added as **siblings** of the real mesh (with the mesh's local transform copied onto the line), never as children of a mesh that will be hidden.
- Do not attempt to opacity-fade `MeshTransmissionMaterial` (the glass logo's custom material, `showcase/MeshTransmissionMaterial.js`) — it has a heavily customized `onBeforeCompile` fragment shader and its interaction with the standard `opacity` uniform is unverified. Use `mesh.visible` toggling for the real meshes (logo + ground) instead of an opacity fade; the crossfade motion instead comes from the wireframe's own opacity fading out on top of the now-visible real mesh.

---

## File Structure

Everything lives in `showcase/main.js`, modifying:
1. The existing preloader state block (`main.js:19-50`) — add new intro-sequence state variables and constants, and call a new `enterWireframePhase()` from inside `hidePreloader()`.
2. A new section (placed right after the preloader block, before `// --- scroll state`) containing: `makeWireframeLine()`, `enterWireframePhase()`, `buildWireframeShards()`, `makeShardLabel()`, `updateIntroSequence()`, `finishIntroSequence()`.
3. `tick()` (`main.js:1204` onward) — hoist a single `performance.now()` read, call `updateIntroSequence(now)`, add a shard-rotation update, and change the hardcoded `bloomPass.strength = config.bloom;` (currently `main.js:1298`) to respect an intro override.

Three tasks, each independently verifiable with a screenshot:
- **Task 1** — wireframe construction: hide real logo/ground meshes, show glowing wireframe outlines once the iris opens.
- **Task 2** — floating shards + labels: 4 small labeled wireframe fragments drifting near the model during the wireframe phase.
- **Task 3** — crossfade + bloom + cleanup: wireframe fades out, real meshes pop back in, bloom eases down, everything the intro created gets disposed.

---

### Task 1: Wireframe construction (hide real meshes, show glowing outlines)

**Files:**
- Modify: `showcase/main.js:19-50` (preloader state block)
- Modify: `showcase/main.js` (new section after the preloader block, before line 52 `// --- scroll state`)

**Interfaces:**
- Produces: `wireframeMat` (module-scope `THREE.LineBasicMaterial`, shared by all wireframe lines — Task 3 fades this via `wireframeMat.opacity`), `wireframePairs` (module-scope array of `{ mesh, line }` — Task 3 iterates this to restore visibility and dispose), `enterWireframePhase()` (called once from `hidePreloader()`), `introStart` (module-scope timestamp, `null` until `hidePreloader()` fires — Task 3's `updateIntroSequence()` reads this).
- Consumes: existing `glassMeshes` array (`{ mesh, mat, fbo }` objects, `main.js:492`), existing `groundObj` (`THREE.Group | null`, `main.js:572`), existing `core` (`THREE.Group`, `main.js:316`), existing `hidePreloader()` (`main.js:29`).

- [ ] **Step 1: Add intro-sequence state variables to the preloader block**

In `showcase/main.js`, find the preloader block (starts at line 19 with the comment `// --- preloader: gate on the hero...`). Locate this existing line:

```js
	let revealStart = null;        // performance.now() timestamp when the reveal began; null = idle/done
	function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }
```

Replace it with (adds the new intro-sequence constants/state right after the existing iris-reveal state):

```js
	let revealStart = null;        // performance.now() timestamp when the reveal began; null = idle/done
	function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }

	// --- intro sequence: wireframe reveal that plays under the iris, then
	// crossfades into the final rendered scene. Driven by tick(), not a
	// separate rAF loop (see updateIntroSequence()).
	const WIREFRAME_HOLD_MS = 900;   // how long the wireframe scene sits before crossfading
	const CROSSFADE_MS = 900;        // wireframe fade-out + real-mesh pop-in + bloom ease-down
	const BLOOM_BOOST = 0.7;         // bloom strength while the wireframe is glowing (config.bloom is normally 0.15)
	let introStart = null;           // performance.now() timestamp when hidePreloader() fired; null = not started
	let introBloomStrength = null;   // non-null overrides bloomPass.strength for the intro; null = use config.bloom
	let crossfadeStarted = false;
	let introDone = false;
	const wireframeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, depthWrite: false });
	const wireframePairs = [];   // { mesh, line } — real meshes hidden + their wireframe outline, for Task 1/3
```

- [ ] **Step 2: Call `enterWireframePhase()` from `hidePreloader()`**

Find `hidePreloader()` (now a few lines further down due to Step 1's insertion, still easily found by its body):

```js
	function hidePreloader() {
		if (preloaderHidden) return;
		preloaderHidden = true;
		document.documentElement.classList.remove("loading");
		preloaderEl.style.transitionDuration = REVEAL_MS + "ms";
		preloaderEl.classList.add("hidden");
		revealStart = performance.now();
		setTimeout(() => preloaderEl.remove(), REVEAL_MS + 100);
		const mark = preloaderEl.querySelector(".preloader-mark");
		if (mark) mark.classList.add("leaving");
		const headline = document.querySelector(".headline");
		headline.classList.remove("pre-reveal");
		headline.classList.add("reveal");
	}
```

Replace it with:

```js
	function hidePreloader() {
		if (preloaderHidden) return;
		preloaderHidden = true;
		document.documentElement.classList.remove("loading");
		preloaderEl.style.transitionDuration = REVEAL_MS + "ms";
		preloaderEl.classList.add("hidden");
		revealStart = performance.now();
		introStart = revealStart;
		setTimeout(() => preloaderEl.remove(), REVEAL_MS + 100);
		const mark = preloaderEl.querySelector(".preloader-mark");
		if (mark) mark.classList.add("leaving");
		const headline = document.querySelector(".headline");
		headline.classList.remove("pre-reveal");
		headline.classList.add("reveal");
		enterWireframePhase();
	}
```

- [ ] **Step 3: Add `makeWireframeLine()` and `enterWireframePhase()`**

Immediately after the preloader block (right before the existing line `// --- scroll state -------------------------------------------------`), add:

```js
	// --- intro wireframe: glowing outline stand-ins for the logo + ground,
	// shown while the real meshes are hidden, so the iris opens onto a
	// "blueprint" version of the hero before it resolves into the final render.
	// column.glb is out of scope — it's only visible later in the scroll-driven
	// showcase section, not in the hero view this intro plays over.
	function makeWireframeLine(mesh) {
		const edges = new THREE.EdgesGeometry(mesh.geometry);
		const line = new THREE.LineSegments(edges, wireframeMat);
		// sibling of mesh (not a child) — mesh.visible = false would also hide a
		// child, since Three.js skips an invisible object's whole subtree
		line.position.copy(mesh.position);
		line.quaternion.copy(mesh.quaternion);
		line.scale.copy(mesh.scale);
		mesh.parent.add(line);
		mesh.visible = false;
		return line;
	}

	function enterWireframePhase() {
		for (const g of glassMeshes) wireframePairs.push({ mesh: g.mesh, line: makeWireframeLine(g.mesh) });
		if (groundObj) {
			groundObj.traverse((o) => {
				if (o.isMesh) wireframePairs.push({ mesh: o, line: makeWireframeLine(o) });
			});
		}
		introBloomStrength = BLOOM_BOOST;
	}
```

- [ ] **Step 4: Wire the bloom override into `tick()`**

Find this line inside `tick()` (currently `main.js:1298`, may shift slightly after the earlier insertions — search for it):

```js
		bloomPass.strength = config.bloom;
```

Replace with:

```js
		bloomPass.strength = introBloomStrength !== null ? introBloomStrength : config.bloom;
```

- [ ] **Step 5: Syntax check**

Run: `node --check /Users/nizikai/Documents/Website/particles/showcase/main.js`
Expected: no output (success).

- [ ] **Step 6: Visual verification with Playwright**

Serve the directory and screenshot mid-wireframe-phase (reuse the in-page-timer technique already used earlier in this project to verify the iris mask — wait until shortly after the ~2000ms (`PRELOAD_MIN_MS`) + partway through `REVEAL_MS` (1300ms) have elapsed, e.g. ~3000ms after navigation, well inside the new `WIREFRAME_HOLD_MS` window):

```bash
pkill -f "http.server 89" 2>/dev/null
(python3 -m http.server 8950 --directory /Users/nizikai/Documents/Website/particles/showcase &>/tmp/serve_wf.log &)
sleep 1
curl -sI http://localhost:8950/index.html | head -1
```

Then with the `playwright-cli` wrapper (`export PWCLI="$HOME/.claude/skills/playwright/scripts/playwright_cli.sh"`):

```bash
"$PWCLI" open http://localhost:8950/index.html
"$PWCLI" run-code "async (page) => { const age = await page.evaluate(() => performance.now()); await page.waitForTimeout(Math.max(0, 3000 - age)); await page.screenshot({ path: 'wireframe-check.png' }); }"
```

Read `showcase/wireframe-check.png`. Expected: the logo and ground render as bright glowing white outlines (no solid glass/stone surfaces), against the scene's dark warm background, with bloom visibly stronger than the site's normal subtle glow.

Then clean up:
```bash
"$PWCLI" close
pkill -f "http.server 8950" 2>/dev/null
rm -f /Users/nizikai/Documents/Website/particles/showcase/wireframe-check.png
```

- [ ] **Step 7: Commit**

```bash
cd /Users/nizikai/Documents/Website/particles
git add showcase/main.js
git commit -m "$(cat <<'EOF'
Add wireframe intro phase: hide real logo/ground, show glowing outlines

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Floating shards + labels

**Files:**
- Modify: `showcase/main.js` (extends the section added in Task 1)

**Interfaces:**
- Produces: `wireframeShards` (module-scope, `{ group: THREE.Group, lines: THREE.LineSegments[], labels: THREE.Sprite[] } | null` — Task 3 reads this to fade and dispose it), `buildWireframeShards()`, `makeShardLabel(text)`.
- Consumes: `wireframeMat` and `core` from Task 1/existing code; called from `enterWireframePhase()` (Task 1).

- [ ] **Step 1: Add `wireframeShards` state and the shard-building functions**

Right after the `enterWireframePhase()` function added in Task 1, add:

```js
	let wireframeShards = null;   // { group, lines, labels } — disposed once the crossfade finishes (Task 3)

	function makeShardLabel(text) {
		const cv = document.createElement("canvas"); cv.width = 64; cv.height = 32;
		const ctx = cv.getContext("2d");
		ctx.fillStyle = "rgba(255,255,255,0.55)";
		ctx.font = "600 20px ui-monospace, monospace";
		ctx.textAlign = "center"; ctx.textBaseline = "middle";
		ctx.fillText(text, 32, 16);
		const tex = new THREE.CanvasTexture(cv);
		const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
		sprite.scale.set(0.4, 0.2, 1);
		return sprite;
	}

	function buildWireframeShards() {
		const group = new THREE.Group();
		const lines = [];
		const labels = [];
		for (let i = 0; i < 4; i++) {
			const size = 0.15 + Math.random() * 0.15;
			const geo = new THREE.TetrahedronGeometry(size);
			const edges = new THREE.EdgesGeometry(geo);
			const line = new THREE.LineSegments(edges, wireframeMat);
			const theta = Math.random() * Math.PI * 2;
			const phi = Math.acos(2 * Math.random() - 1);
			const r = 2.6 + Math.random() * 1.4;   // just outside the logo, well inside the ambient particle field
			line.position.set(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi) * 0.8, r * Math.sin(phi) * Math.sin(theta));
			line.userData.spinAxis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
			line.userData.spinSpeed = 0.15 + Math.random() * 0.25;
			group.add(line);
			lines.push(line);

			const label = makeShardLabel(String(10 + Math.floor(Math.random() * 89)));
			label.position.copy(line.position).multiplyScalar(1.08);
			group.add(label);
			labels.push(label);
		}
		core.add(group);   // rides along with the logo's own transform
		return { group, lines, labels };
	}
```

- [ ] **Step 2: Spawn shards from `enterWireframePhase()` and animate them in `tick()`**

In `enterWireframePhase()` (added in Task 1), find:

```js
		introBloomStrength = BLOOM_BOOST;
	}
```

Replace with:

```js
		wireframeShards = buildWireframeShards();
		introBloomStrength = BLOOM_BOOST;
	}
```

In `tick()`, find the existing lines (currently `main.js:1215-1217`):

```js
		const dt = Math.min(0.05, t - lastElapsed);
		lastElapsed = t;
		flakeTime += dt * config.glowSpeed;
```

Add directly after them:

```js
		if (wireframeShards) {
			for (const l of wireframeShards.lines) l.rotateOnAxis(l.userData.spinAxis, l.userData.spinSpeed * dt);
		}
```

- [ ] **Step 3: Syntax check**

Run: `node --check /Users/nizikai/Documents/Website/particles/showcase/main.js`
Expected: no output (success).

- [ ] **Step 4: Visual verification with Playwright**

Repeat the serve + screenshot steps from Task 1 Step 6 (same ~3000ms timing, same wireframe-hold window). Read the resulting screenshot. Expected: in addition to the glowing logo/ground outlines from Task 1, 4 small faint tetrahedron wireframe shapes are visible drifting near the model, each with a small faint 2-digit number label beside it.

Clean up the same way as Task 1 Step 6.

- [ ] **Step 5: Commit**

```bash
cd /Users/nizikai/Documents/Website/particles
git add showcase/main.js
git commit -m "$(cat <<'EOF'
Add 4 labeled floating wireframe shards to the intro sequence

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Crossfade, bloom ease-down, and cleanup

**Files:**
- Modify: `showcase/main.js` (extends the sections added in Tasks 1-2)

**Interfaces:**
- Produces: `updateIntroSequence(now)` (called once per frame from `tick()`), `finishIntroSequence()`.
- Consumes: `introStart`, `crossfadeStarted`, `introDone`, `introBloomStrength`, `wireframeMat`, `wireframePairs`, `wireframeShards`, `BLOOM_BOOST`, `WIREFRAME_HOLD_MS`, `CROSSFADE_MS`, `easeOutCubic()`, `core` (all from Tasks 1-2 / existing code).

- [ ] **Step 1: Add `updateIntroSequence()` and `finishIntroSequence()`**

Right after `buildWireframeShards()` (added in Task 2), add:

```js
	function finishIntroSequence() {
		introDone = true;
		introBloomStrength = null;
		for (const { mesh, line } of wireframePairs) {
			mesh.parent.remove(line);
			line.geometry.dispose();
		}
		wireframeMat.dispose();
		wireframePairs.length = 0;
		if (wireframeShards) {
			for (const s of wireframeShards.labels) { s.material.map.dispose(); s.material.dispose(); }
			for (const l of wireframeShards.lines) l.geometry.dispose();
			core.remove(wireframeShards.group);
			wireframeShards = null;
		}
	}

	function updateIntroSequence(now) {
		if (introStart === null || introDone) return;
		const elapsed = now - introStart;
		const holdEnd = REVEAL_MS + WIREFRAME_HOLD_MS;
		const crossfadeEnd = holdEnd + CROSSFADE_MS;
		if (elapsed < holdEnd) {
			introBloomStrength = BLOOM_BOOST;
			return;
		}
		if (!crossfadeStarted) {
			crossfadeStarted = true;
			for (const { mesh } of wireframePairs) mesh.visible = true;
		}
		const ct = Math.min(1, (elapsed - holdEnd) / CROSSFADE_MS);
		const e = easeOutCubic(ct);
		introBloomStrength = BLOOM_BOOST + (config.bloom - BLOOM_BOOST) * e;
		wireframeMat.opacity = 1 - e;
		if (wireframeShards) { for (const s of wireframeShards.labels) s.material.opacity = 1 - e; }
		if (elapsed >= crossfadeEnd) finishIntroSequence();
	}
```

- [ ] **Step 2: Call `updateIntroSequence()` from `tick()`, sharing one `performance.now()` read with the iris mask**

Find the top of `tick()` (currently `main.js:1204-1213`):

```js
	function tick() {
		if (revealStart !== null) {
			const rt = Math.min(1, (performance.now() - revealStart) / REVEAL_MS);
			const pct = easeOutCubic(rt) * 100;
			const feather = 8;   // percentage-points of soft edge
			const g = `radial-gradient(circle farthest-corner at 50% 50%, transparent 0%, transparent ${Math.max(0, pct - feather)}%, white ${pct}%, white 100%)`;
			preloaderEl.style.maskImage = g;
			preloaderEl.style.webkitMaskImage = g;
			if (rt >= 1) revealStart = null;
		}
```

Replace with:

```js
	function tick() {
		const now = performance.now();
		if (revealStart !== null) {
			const rt = Math.min(1, (now - revealStart) / REVEAL_MS);
			const pct = easeOutCubic(rt) * 100;
			const feather = 8;   // percentage-points of soft edge
			const g = `radial-gradient(circle farthest-corner at 50% 50%, transparent 0%, transparent ${Math.max(0, pct - feather)}%, white ${pct}%, white 100%)`;
			preloaderEl.style.maskImage = g;
			preloaderEl.style.webkitMaskImage = g;
			if (rt >= 1) revealStart = null;
		}
		updateIntroSequence(now);
```

- [ ] **Step 3: Syntax check**

Run: `node --check /Users/nizikai/Documents/Website/particles/showcase/main.js`
Expected: no output (success).

- [ ] **Step 4: Visual verification — mid-crossfade**

Serve the directory (same as Task 1 Step 6, reusing port 8950 or another free port), then screenshot partway through the crossfade window: `REVEAL_MS (1300) + WIREFRAME_HOLD_MS (900) = 2200`, plus `PRELOAD_MIN_MS (2000)`, so the crossfade spans roughly [4200ms, 5100ms] after navigation. Target ~4650ms:

```bash
"$PWCLI" open http://localhost:8950/index.html
"$PWCLI" run-code "async (page) => { const age = await page.evaluate(() => performance.now()); await page.waitForTimeout(Math.max(0, 4650 - age)); await page.screenshot({ path: 'crossfade-check.png' }); }"
```

Read `showcase/crossfade-check.png`. Expected: the real logo/ground are visible again (not hidden), with the fading wireframe outline still faintly overlaid on top, and bloom partway between boosted and normal.

- [ ] **Step 5: Visual verification — final state matches prior behavior**

```bash
"$PWCLI" run-code "async (page) => { const age = await page.evaluate(() => performance.now()); await page.waitForTimeout(Math.max(0, 5500 - age)); await page.screenshot({ path: 'final-check.png' }); }"
```

Read `showcase/final-check.png`. Expected: scene looks identical to the pre-existing end state (solid glass logo, solid ground, no visible wireframe/shards/labels).

The intro's module state (`wireframePairs`, `wireframeShards`, etc.) lives inside `main.js`'s top-level IIFE and isn't exposed on `window`, so it can't be introspected directly from Playwright. Confirm cleanup visually instead — nudge the camera slightly (a small scroll changes the model's rotation/parallax) and re-screenshot, since any leaked wireframe line or shard/label sprite would still be visible from a shifted angle even if it happened to be occluded head-on:

```bash
"$PWCLI" eval "() => { window.scrollTo(0, 300); return true; }"
"$PWCLI" screenshot
```

Read the resulting screenshot. Expected: no stray wireframe lines or shard/label sprites visible anywhere in frame.

Clean up:
```bash
"$PWCLI" close
pkill -f "http.server 8950" 2>/dev/null
rm -f /Users/nizikai/Documents/Website/particles/showcase/crossfade-check.png /Users/nizikai/Documents/Website/particles/showcase/final-check.png
```

- [ ] **Step 6: Commit**

```bash
cd /Users/nizikai/Documents/Website/particles
git add showcase/main.js
git commit -m "$(cat <<'EOF'
Add crossfade from wireframe intro to final scene, with bloom ease-down and cleanup

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## End-to-End Verification (after all 3 tasks)

Full sequence check: reload the page fresh and watch (or screenshot-sample) the entire ~5.5s intro: black + wordmark (0-2000ms) → iris opens onto wireframe (2000-3300ms) → wireframe holds (3300-4200ms) → crossfade to final (4200-5100ms) → settled final scene. Confirm scrolling and all existing interactions (particle field, ground/logo rotation on scroll, showcase carousel further down) still work exactly as before — this feature only touches the first ~5.5s of the page's life and disposes everything it creates.
