import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { MeshSurfaceSampler } from "three/addons/math/MeshSurfaceSampler.js";
import { MeshTransmissionMaterial, DiscardMaterial } from "./MeshTransmissionMaterial.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

(() => {
	const canvas = document.getElementById("webgl");
	const noticeEl = document.getElementById("notice");
	const fpsEl = document.getElementById("fps");
	const preloaderEl = document.getElementById("preloader");
	const enterHintEl = document.querySelector(".enter-hint");
	let fpsFrames = 0, fpsLast = 0;   // rolling FPS counter

	// --- preloader: gate on the hero (logo/ground) + showcase (column) models,
	// plus the webfont, so nothing pops in after the loader fades. A hard
	// timeout guards against a stalled/failed asset trapping the user.
	let preloaderHidden = false;
	// --- click-to-enter gate: once loaded the scene holds dark, particles
	// fully spawned but masked to the cursor spotlight, until the user clicks.
	// The click also starts the ambient audio (user gesture = autoplay allowed).
	let awaitingEnter = false;
	let entered = false;             // entered via click — intro runs with dots pre-spawned, mask dissolving
	const FINE_POINTER = matchMedia("(pointer: fine)").matches;   // touch has no cursor to spotlight — show all dots, "tap to enter"
	const GATE_SPAWN_STRETCH = 1.6;  // gate spawn plays this much slower than the intro's — dots bloom in over ~4s instead of appearing at once
	let gateStart = null;            // performance.now() when the gate appeared — drives the gate's own spawn stagger
	const HOME_VOLUME = 0.8;
	const homeAudio = new Audio("home.wav");
	homeAudio.loop = true;
	homeAudio.preload = "auto";
	homeAudio.volume = 0;            // faded in over ~2s in tick() once entered
	const PRELOAD_MIN_MS = 2000;   // keep the wordmark on screen at least this long, even on a cache-hit reload
	const preloadStart = performance.now();
	const preloadState = { logo: false, ground: false, column: false, fonts: false };
	function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }
	// gain curve: k = 1 → linear, higher = stronger slow-in/slow-out. Drives the
	// dissolve wall (dimEase) instead of a fixed cubic.
	function easeGain(t, k) { const a = Math.pow(t, k); return a / (a + Math.pow(1 - t, k)); }

	// --- intro sequence: a particle-traced version of the scene that randomly
	// spawns in on a dark screen, then crossfades into the final rendered
	// scene. Driven by tick(), not a separate rAF loop (see updateIntroSequence()).
	const PARTICLE_SPAWN_MS = 2600;  // window over which particles individually glow in, staggered
	const CROSSFADE_MS = 2100;       // particle fade-out + real-mesh pop-in + bloom ease-down — slow, staged, not instant
	// a depth-fog "wall" that starts right in front of the camera and recedes
	// backward through the whole scene over the crossfade, so real geometry
	// emerges from front to back instead of popping in all at once
	const FOG_BAND_WIDTH = 6;    // depth-units the fog transition spans at any instant
	const FOG_FAR_START = 0.25;  // where the fog wall's far edge sits at crossfade start — at the camera plane, so
	                             // NOTHING is in front of it on frame one (the foreground pillars reach closer than
	                             // 1.5 units, and anything nearer than the far edge pops in partially unfogged)
	const FOG_FAR_END = 36;      // where it ends up at crossfade end — the band's *near* edge (far − FOG_BAND_WIDTH)
	                             // must also clear the ground's ~26-unit back edge, or removing scene.fog at
	                             // finish visibly unfogs the back wall in one frame
	// The glass logo (MeshTransmissionMaterial) refracts an offscreen capture of
	// the WHOLE scene every frame — so it only looks right once the scene is
	// stable (bright, no fog). Reveal it too early and it refracts the dim/foggy
	// transition into an opaque, gold, shattered-looking slab. Its particle
	// stand-in holds until the handoff, masked by a bloom flash.
	const logoRevealT = 0.1;         // fraction into the crossfade to swap logo particles → real glass (hand-tuned)
	const BLOOM_BOOST = 0.35;        // bloom strength while the particles are glowing (config.bloom is normally 0.15) — much higher and the logo's dense dot corners bloom into blocky, pixelated halos
	let introStart = null;           // performance.now() timestamp when hidePreloader() fired; null = not started
	let introBloomStrength = null;   // non-null overrides bloomPass.strength for the intro; null = use config.bloom
	let crossfadeStarted = false;
	let logoRevealed = false;
	let headlineStarted = false;
	let introDone = false;
	// non-null overrides scene.backgroundIntensity (+ forces haze/mist hidden)
	// for the intro — the real equirect texture stays as scene.background the
	// whole time (never swapped for an approximated flat color, which never
	// quite matches and produces a visible snap when handed back), just
	// dimmed to black then ramped back up to full brightness; null = normal
	const FOG_COLOR = new THREE.Color(0x120800);   // fixed — close to the equirect's own darkest gradient stop
	let introBgIntensity = null;
	// shared amber shader material for every particle stand-in — same soft-dot
	// falloff + colorA/colorB mix as the hero's ambient particle field
	// (buildParticles()), without its twinkle/glint motion since these sit
	// still tracing the model rather than drifting like ambient dust.
	// u_size gets pixel-ratio-scaled once renderer exists (see enterWireframePhase()).
	const wireframeParticleMat = new THREE.ShaderMaterial({
		transparent: true,
		depthWrite: false,
		// no depth test either: when the real meshes flip visible at crossfade
		// start they instantly z-write, which in ONE frame culls the dots lying
		// on their surfaces and hard-occludes everything behind the foreground
		// pillars — a visible snap. Additive dust doesn't need occlusion; the
		// front→back wipe retires each dot instead.
		depthTest: false,
		blending: THREE.AdditiveBlending,
		uniforms: {
			u_size: { value: 5.5 },
			u_opacity: { value: 1 },
			u_brightness: { value: 1 },
			u_pulseBoost: { value: 2.5 },         // localized HDR lift for the active front→back depth slice
			u_pulseSizeBoost: { value: 3 },       // keeps the active slice legible after perspective shrinks distant dots
			u_spawnElapsed: { value: 0 },        // seconds since introStart
			u_spawnWindow: { value: PARTICLE_SPAWN_MS / 1000 },
			u_spawnFadeIn: { value: 0.6 },        // seconds each particle takes to glow in once its own delay elapses
			// brighter than the ambient dust's colorA/colorB range (0x6a4420..0xffd49a)
			// on purpose — that dark end reads at nearly the same luminance as this
			// scene's warm amber background/environment and disappears against it
			u_colorA: { value: new THREE.Color(0xffb347) },
			u_colorB: { value: new THREE.Color(0xfff2d9) },
			// depth wipe tracking the crossfade's fog wall: dots nearer than
			// u_wipeNear are gone (their real surface is fully revealed), dots
			// beyond u_wipeFar hold full. Defaults sit behind the camera so the
			// whole field is visible until the crossfade drives them
			u_wipeNear: { value: -2 },
			u_wipeFar: { value: -1 },
			// cursor spotlight (hover mode) — at u_cursorReveal 0 (the intro's
			// default) dots ignore the cursor entirely; at 1 they're only visible
			// within u_cursorRadius of the cursor. Screen-space (NDC) distance.
			u_cursor: { value: new THREE.Vector2(0, 0) },
			u_cursorRadius: { value: 0.35 },
			u_cursorReveal: { value: 0 },
			// minimum brightness outside the spotlight while masked — 0 for the
			// site-wide hover dots (fully invisible away from the cursor), raised
			// only during the click-to-enter gate so the field stays faintly there
			u_revealFloor: { value: 0 },
			// falloff exponent for the spotlight gradient — 1 = the hover dots'
			// original curve; higher = brightness hugs the cursor and melts into
			// the floor with no visible rim (used by the click-to-enter gate)
			u_falloff: { value: 1 },
			// depth wall that LIFTS the cursor mask front→back on click-to-enter:
			// dots nearer than u_openNear are fully unmasked (100% opacity), dots
			// beyond u_openFar still obey the spotlight. Defaults behind the
			// camera = mask everywhere (no effect outside the gate).
			u_openNear: { value: -2 },
			u_openFar: { value: -1 },
			// second front→back wall chasing the bright peak: dots it has passed
			// settle down to u_settleLevel brightness. Defaults behind the
			// camera = no effect.
			u_settleNear: { value: -2 },
			u_settleFar: { value: -1 },
			u_settleLevel: { value: 1 },
			u_aspect: { value: 1 }
		},
		vertexShader: `
			uniform float u_size;
			uniform float u_spawnElapsed;
			uniform float u_spawnWindow;
			uniform float u_spawnFadeIn;
			uniform float u_pulseSizeBoost;
			uniform float u_openNear;
			uniform float u_openFar;
			uniform float u_settleNear;
			uniform float u_settleFar;
			uniform vec2 u_cursor;
			uniform float u_cursorRadius;
			uniform float u_falloff;
			uniform float u_aspect;
			attribute float aSeed;
			attribute float aSpawnDelay;
			varying float vSeed;
			varying float vSpawn;
			varying float vDepth;
			varying float vHover;
			void main() {
				vSeed = aSeed;
				// each particle waits its own random delay (spread across u_spawnWindow),
				// then pops in over u_spawnFadeIn — a staggered random spawn, not a
				// uniform fade-in
				float spawnStart = aSpawnDelay * u_spawnWindow;
				vSpawn = clamp((u_spawnElapsed - spawnStart) / u_spawnFadeIn, 0.0, 1.0);
				vec4 mv = modelViewMatrix * vec4(position, 1.0);
				vDepth = -mv.z;
				gl_Position = projectionMatrix * mv;
				// cursor proximity in aspect-corrected NDC, so the spotlight is a
				// circle on screen regardless of window shape (soft edge via smoothstep)
				vec2 away = (gl_Position.xy / max(0.0001, gl_Position.w) - u_cursor) * vec2(u_aspect, 1.0);
				vHover = pow(1.0 - smoothstep(0.0, u_cursorRadius, length(away)), u_falloff);
				float pointOpen = 1.0 - smoothstep(u_openNear, u_openFar, vDepth);
				float pointSettle = 1.0 - smoothstep(u_settleNear, u_settleFar, vDepth);
				float pointPulse = pointOpen * (1.0 - pointSettle);
				gl_PointSize = u_size * vSpawn * mix(1.0, u_pulseSizeBoost, pointPulse) / max(1.0, -mv.z);
			}
		`,
		fragmentShader: `
			uniform vec3 u_colorA;
			uniform vec3 u_colorB;
			uniform float u_opacity;
			uniform float u_brightness;
			uniform float u_pulseBoost;
			uniform float u_wipeNear;
			uniform float u_wipeFar;
			uniform float u_cursorReveal;
			uniform float u_revealFloor;
			uniform float u_openNear;
			uniform float u_openFar;
			uniform float u_settleNear;
			uniform float u_settleFar;
			uniform float u_settleLevel;
			varying float vSeed;
			varying float vSpawn;
			varying float vDepth;
			varying float vHover;
			void main() {
				if (vSpawn <= 0.0) discard;
				float wipe = smoothstep(u_wipeNear, u_wipeFar, vDepth);
				if (wipe <= 0.0) discard;
				vec2 uv = gl_PointCoord - 0.5;
				float d = dot(uv, uv);
				float soft = exp(-d * 8.0);
				float core = exp(-d * 40.0);
				if (soft < 0.02 && core < 0.02) discard;
				float a = soft * 0.7 + core * 1.4;
				float open = 1.0 - smoothstep(u_openNear, u_openFar, vDepth);
				float settle = 1.0 - smoothstep(u_settleNear, u_settleFar, vDepth);
				float pulse = open * (1.0 - settle);
				vec3 col = mix(u_colorA, u_colorB, vSeed) * u_brightness * mix(1.0, u_pulseBoost, pulse);
				gl_FragColor = vec4(col, a * vSpawn * u_opacity * wipe * mix(1.0, u_settleLevel, settle) * mix(1.0, max(vHover, u_revealFloor), u_cursorReveal * (1.0 - open)));
			}
		`
	});
	// the logo particles hold their opacity through the whole fog reveal (the
	// ground particles fade with the fog) and only vanish at the handoff to the
	// real glass, so they need their own opacity control — hence a separate
	// clone of the shared material rather than the same instance
	const logoParticleMat = wireframeParticleMat.clone();
	const wireframePairs = [];   // { mesh, points, isGlass } — real meshes hidden + their particle stand-in

	// --- hover spotlight: preloader-style dots over every glass surface (the
	// hero logo + the showcase cards' slabs), visible only near the cursor,
	// while the real glass stays fully rendered underneath. Own material clone
	// so the intro's uniforms (spawn/opacity/wipe) never touch it.
	const hoverDotMat = wireframeParticleMat.clone();
	// Unlike the intro scan, post-preloader hover dots obey the scene depth
	// buffer: foreground cards/geometry occlude particles behind them.
	hoverDotMat.depthTest = true;
	hoverDotMat.uniforms.u_spawnElapsed.value = 1e4;   // long past every spawn delay — dots are always fully "spawned"
	hoverDotMat.uniforms.u_cursorReveal.value = 1;     // visible only inside the cursor spotlight
	// the showcase cards' own clone — separate size/radius/opacity uniforms are
	// what let the two sections tune independently (one shared material was why
	// they couldn't before)
	const hoverCardMat = hoverDotMat.clone();
	// Dense card perimeter shown only on the card currently under the pointer.
	// Keep the cursor mask enabled so only nearby edge segments glow instead of
	// revealing the card's full outline at once.
	const hoverCardEdgeMat = hoverCardMat.clone();
	hoverCardEdgeMat.uniforms.u_cursorReveal.value = 1;
	const hoverLogoPoints = [];
	function makeHoverDots(mesh, refDiag, surfSpacing, edgeDensity = 1, mat = hoverDotMat, includeEdges = true) {
		mat.uniforms.u_size.value = (mat === hoverDotMat ? config.hoverDotSize : config.scHoverDotSize) * renderer.getPixelRatio();
		const points = makeWireframePoints(mesh, refDiag, mat, surfSpacing, 20, edgeDensity, 1, false, includeEdges);
		// child of the glass, not the sibling makeWireframePoints sets up: the
		// dots then inherit its transform AND visibility, so they vanish with it
		// (intro hides the logo, cards fade in/out) with no per-frame syncing
		mesh.add(points);
		points.position.set(0, 0, 0);
		points.quaternion.identity();
		points.scale.setScalar(1);
		// Draw after the title layer, while depth testing still lets foreground
		// card faces and scene geometry occlude dots that sit behind them.
		points.renderOrder = 2;
		mesh.visible = true;   // makeWireframePoints hides the mesh (intro behavior) — here the glass stays
		return points;
	}
	function buildHoverLogoDots() {
		teardownHoverLogoDots();
		for (const g of glassMeshes) hoverLogoPoints.push(makeHoverDots(g.mesh, coreMaxDim));
	}
	function teardownHoverLogoDots() {
		for (const p of hoverLogoPoints) {
			p.parent?.remove(p);
			p.geometry.dispose();
		}
		hoverLogoPoints.length = 0;
	}
	// hold on the click-to-enter gate: particles bloom in staggered (radial
	// sweep) under the cursor spotlight. html.loading stays on (scroll locked)
	// and introStart stays null (timeline paused) until enterSite().
	function enterGate() {
		enterWireframePhase();
		gateStart = performance.now();
		const reveal = FINE_POINTER ? 1 : 0;
		for (const m of [wireframeParticleMat, logoParticleMat]) {
			m.uniforms.u_cursorReveal.value = reveal;
			m.uniforms.u_cursorRadius.value = config.enterRadius;
			m.uniforms.u_revealFloor.value = config.enterDim;
			m.uniforms.u_falloff.value = 2.0;   // soft glow around the cursor, not a hard-rimmed spotlight
		}
		if (enterHintEl) {
			enterHintEl.textContent = FINE_POINTER ? "click to enter" : "tap to enter";
			enterHintEl.classList.add("show");
		}
		awaitingEnter = true;
	}
	function hidePreloader() {
		if (preloaderHidden) return;
		preloaderHidden = true;
		preloaderEl.classList.add("hidden");   // scene behind is already dark, so this fade is imperceptible
		enterGate();
	}
	function enterSite(ev) {
		if (ev?.target?.closest?.("#panel")) return;   // tuning the dev panel isn't entering the site
		if (!awaitingEnter) return;
		awaitingEnter = false;
		entered = true;
		document.documentElement.classList.remove("loading");
		enterHintEl?.classList.remove("show");
		homeAudio.play().catch(() => {});   // audio is a garnish — a blocked/failed play must not block entry
		startIntroText();
		// no glow-up: the cursor spotlight stays exactly as it was on the gate, so
		// the particles never flash to full brightness. The front→back fog wall +
		// dot wipe (updateIntroSequence) is the whole reveal.
		introStart = performance.now();
	}
	window.addEventListener("pointerdown", enterSite);
	function markLoaded(key) {
		preloadState[key] = true;
		if (Object.values(preloadState).every(Boolean)) {
			const wait = Math.max(0, PRELOAD_MIN_MS - (performance.now() - preloadStart));
			setTimeout(hidePreloader, wait);
		}
	}
	setTimeout(hidePreloader, 8000);

	// --- intro particles: glowing amber particle stand-ins for the logo +
	// ground, shown while the real meshes are hidden, so the iris opens onto a
	// "scanned" version of the hero before it resolves into the final render.
	// column.glb is out of scope — it's only visible later in the scroll-driven
	// showcase section, not in the hero view this intro plays over.
	const WIREFRAME_DOT_SPACING_FRACTION = 0.02;   // dot spacing, as a fraction of the *whole object's* bounding diagonal

	// the rotunda scene is almost all smooth curves (columns, ring) — at the
	// 20° threshold below EdgesGeometry finds nearly nothing there, so the
	// scene needs its surfaces splatted too, not just its (few) sharp edges
	const SURFACE_DOT_SPACING_MULT = 0.51;  // fraction of the scene-diag-based spacing — tuned so surface dots (~10.7k) + edge dots (~9.9k) ≈ half the original ~41k scene total
	const SURFACE_DOT_CAP = 60000;          // per-mesh safety cap — the whole rotunda is one mesh, so this has to fit its full surface

	function sampleSurfaceDots(mesh, surfSpacingWorld, coords, seeds, spawnDelays) {
		// area is measured in WORLD units (matrixWorld applied per-vertex) — the
		// scene GLB is quantized, so its local units are meaningless for sizing
		const pos = mesh.geometry.attributes.position;
		const idx = mesh.geometry.index;
		mesh.updateWorldMatrix(true, false);
		const m = mesh.matrixWorld;
		const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
		const ab = new THREE.Vector3(), ac = new THREE.Vector3();
		let area = 0;
		const triCount = (idx ? idx.count : pos.count) / 3;
		for (let i = 0; i < triCount; i++) {
			const i0 = idx ? idx.getX(i * 3) : i * 3;
			const i1 = idx ? idx.getX(i * 3 + 1) : i * 3 + 1;
			const i2 = idx ? idx.getX(i * 3 + 2) : i * 3 + 2;
			a.fromBufferAttribute(pos, i0).applyMatrix4(m);
			b.fromBufferAttribute(pos, i1).applyMatrix4(m);
			c.fromBufferAttribute(pos, i2).applyMatrix4(m);
			area += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2;
		}
		const count = Math.min(SURFACE_DOT_CAP, Math.floor(area / (surfSpacingWorld * surfSpacingWorld)));
		if (count < 1) return;
		const sampler = new MeshSurfaceSampler(mesh).build();
		const p = new THREE.Vector3();
		for (let i = 0; i < count; i++) {
			sampler.sample(p);
			coords.push(p.x, p.y, p.z);
			seeds.push(Math.random());
			spawnDelays.push(Math.random());
		}
	}

	function makeWireframePoints(mesh, refDiag, mat, surfSpacingWorld, edgeThreshold = 20, edgeDensity = 1, localScale = 1, verticalEdges = false, includeEdges = true) {
		// splat dots along the mesh's actual edges (not raw vertices) — this
		// traces the same recognizable silhouette the old EdgesGeometry lines
		// did, just rendered as a dotted line instead of a solid one.
		// refDiag is the *whole object's* raw bounding diagonal (coreMaxDim for
		// the logo, groundMaxDim for the ground) — not this one mesh's own,
		// since e.g. the logo is split into many small slabs and sizing spacing
		// off each tiny slab's own bbox packs far too many dots into the whole.
		// threshold angle well above the default 1° — a finely-tessellated
		// curved surface (the glass logo especially) has thousands of nearly-flat
		// triangle seams that count as "edges" at the default threshold, wildly
		// overcounting; this keeps only genuinely sharp/silhouette edges
		const edges = new THREE.EdgesGeometry(mesh.geometry, edgeThreshold);
		const src = edges.attributes.position;   // consecutive pairs: [a0,b0, a1,b1, ...]
		// localScale converts refDiag units → this geometry's local units. The scene
		// GLB is quantized (positions span ~2 local units, real size lives in a ~7.3×
		// node scale), so without it every edge measures ~7× too short, collapses to
		// steps=1 (just its 2 endpoints), and the jitter smears ~7× too wide.
		const spacing = refDiag * WIREFRAME_DOT_SPACING_FRACTION / (config.introDensity * edgeDensity * localScale);
		const jitterRadius = spacing * 0.15;   // subtle — dots scatter loosely around the edge, not plotted exactly on it
		const coords = [];
		const seeds = [];
		const spawnDelays = [];
		const a = new THREE.Vector3(), b = new THREE.Vector3();
		const dir = new THREE.Vector3(), ref = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3();
		const splat = (pairs, keep, splatSpacing = spacing) => {
			for (let i = 0; i < pairs.count; i += 2) {
				a.fromBufferAttribute(pairs, i);
				b.fromBufferAttribute(pairs, i + 1);
				const edgeLen = a.distanceTo(b);
				if (edgeLen < 1e-6) continue;   // degenerate zero-length edge — normalize() below would divide by zero into NaN
				if (keep && !keep(edgeLen)) continue;
				const steps = Math.max(1, Math.round(edgeLen / splatSpacing));
				// stable perpendicular basis for this edge, so jitter can push dots
				// sideways off the line rather than just along it
				dir.subVectors(b, a).normalize();
				ref.set(0, 1, 0);
				if (Math.abs(dir.dot(ref)) > 0.99) ref.set(1, 0, 0);
				u.crossVectors(dir, ref).normalize();
				v.crossVectors(dir, u);
				for (let s = 0; s <= steps; s++) {
					// irregular spacing along the edge (not perfectly even steps) plus
					// a small perpendicular offset — organic scatter, not a plotted line
					const t = THREE.MathUtils.clamp((s + (Math.random() - 0.5) * 0.35) / steps, 0, 1);
					const angle = Math.random() * Math.PI * 2;
					const r = Math.random() * jitterRadius;
					coords.push(
						a.x + (b.x - a.x) * t + (u.x * Math.cos(angle) + v.x * Math.sin(angle)) * r,
						a.y + (b.y - a.y) * t + (u.y * Math.cos(angle) + v.y * Math.sin(angle)) * r,
						a.z + (b.z - a.z) * t + (u.z * Math.cos(angle) + v.z * Math.sin(angle)) * r
					);
					seeds.push(Math.random());
					spawnDelays.push(Math.random());
				}
			}
		};
		if (includeEdges) splat(src);
		edges.dispose();   // only used to derive the dot coordinates above, never rendered itself
		if (includeEdges && verticalEdges) {
			// second, fully permissive pass (1° threshold) kept only for near-vertical
			// runs, traced denser than the sharp pass — column flutes and shaft lines
			// sit below the sharp threshold, so without this the pillars read as
			// stacked rings with nothing connecting them. Near-vertical sharp edges
			// get traced by both passes (the 1° set is a superset) — the doubled dots
			// just read as slightly brighter silhouettes.
			const soft = new THREE.EdgesGeometry(mesh.geometry, 1);
			// 0.6× spacing: the shaft is stacked drum segments, so each vertical run is
			// short — denser dots are what bridge the drum joints into continuous lines
			splat(soft.attributes.position, (len) => Math.abs(b.y - a.y) / len > 0.7, spacing * 0.6);
			soft.dispose();
		}
		if (surfSpacingWorld) sampleSurfaceDots(mesh, surfSpacingWorld, coords, seeds, spawnDelays);
		const geo = new THREE.BufferGeometry();
		geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(coords), 3));
		geo.setAttribute("aSpawnDelay", new THREE.BufferAttribute(new Float32Array(spawnDelays), 1));
		geo.setAttribute("aSeed", new THREE.BufferAttribute(new Float32Array(seeds), 1));
		const points = new THREE.Points(geo, mat);
		// sibling of mesh (not a child) — mesh.visible = false would also hide a
		// child, since Three.js skips an invisible object's whole subtree
		points.position.copy(mesh.position);
		points.quaternion.copy(mesh.quaternion);
		points.scale.copy(mesh.scale);
		mesh.parent.add(points);
		mesh.visible = false;
		return points;
	}

	function enterWireframePhase() {
		// the scene's dots sit much deeper than the logo's (the shader divides
		// point size by view depth), so they need a bigger base size to stay
		// legible as shapes instead of sub-pixel dust
		wireframeParticleMat.uniforms.u_size.value = 6.5 * renderer.getPixelRatio();
		logoParticleMat.uniforms.u_size.value = 3.0 * renderer.getPixelRatio();
		// isGlass tags let the crossfade treat the two differently: the ground
		// reveals gradually via fog while its particles fade; the logo (which
		// can't refract a mid-transition scene cleanly) keeps its own particles
		// full-strength until the very end, then swaps to real glass. Hence the
		// two use separate materials (see updateIntroSequence()).
		for (const g of glassMeshes) wireframePairs.push({ mesh: g.mesh, points: makeWireframePoints(g.mesh, coreMaxDim, logoParticleMat), isGlass: true });
		if (groundObj) {
			// surface-dot spacing in WORLD units, sized off the scene's world
			// bounding diagonal (quantized GLB — local units are unusable)
			const worldDiag = new THREE.Box3().setFromObject(groundObj).getSize(new THREE.Vector3()).length();
			// sceneDetail shifts the scene from a filled point-cloud toward a dotted
			// EDGE wireframe: higher = each sharp edge traced more densely while the
			// surface scatter thins out (sparser spacing). Surface spacing scales with
			// sceneDetail SQUARED so the fill drops off fast — count ∝ 1/spacing², so
			// this is a ~1/detail⁴ falloff and by the top of the slider the edges
			// dominate. ponytail: exponent is the knob — drop toward 1 for more fill.
			const surfDetail = config.sceneDetail * config.sceneDetail;
			const surfSpacing = worldDiag * WIREFRAME_DOT_SPACING_FRACTION * SURFACE_DOT_SPACING_MULT * surfDetail / config.introDensity;
			// threshold is clamped at 20° — going lower would admit thousands of tiny
			// tessellation-seam "edges" (flutes, capitals) that read as surface dust,
			// which is exactly what high sceneDetail is supposed to strip away. Below
			// 1× the threshold still rises, dropping edges for a sparser look.
			const edgeThreshold = Math.max(20, 20 / config.sceneDetail);
			// groundMaxDim is in raw-GLB-world units; the quantized meshes' geometry is
			// not — divide out the node scale between groundObj's root and each mesh
			const rootScale = groundObj.getWorldScale(new THREE.Vector3()).x;
			groundObj.traverse((o) => {
				if (o.isMesh) wireframePairs.push({ mesh: o, points: makeWireframePoints(o, groundMaxDim, wireframeParticleMat, surfSpacing, edgeThreshold, config.sceneDetail, o.getWorldScale(new THREE.Vector3()).x / rootScale, true), isGlass: false });
			});
		}
		// rewrite the (random) spawn delays into a radial sweep: dots near the
		// logo light up first and the spawn radiates outward through the scene,
		// with enough jitter that the wavefront reads organic, not scanned
		const sweepCenter = new THREE.Vector3(config.modelX, config.modelY, config.modelZ);
		const wp = new THREE.Vector3();
		const pairDists = [];
		let maxDist = 0;
		for (const { points } of wireframePairs) {
			points.updateWorldMatrix(true, false);
			const pos = points.geometry.attributes.position;
			const dists = new Float32Array(pos.count);
			for (let i = 0; i < pos.count; i++) {
				dists[i] = wp.fromBufferAttribute(pos, i).applyMatrix4(points.matrixWorld).distanceTo(sweepCenter);
				if (dists[i] > maxDist) maxDist = dists[i];
			}
			pairDists.push(dists);
		}
		wireframePairs.forEach(({ points }, k) => {
			const delay = points.geometry.attributes.aSpawnDelay;
			const dists = pairDists[k];
			for (let i = 0; i < delay.count; i++) {
				delay.setX(i, Math.min(1, (dists[i] / maxDist) * 0.75 + Math.random() * 0.25));
			}
			delay.needsUpdate = true;
		});
		introBloomStrength = BLOOM_BOOST;
		introBgIntensity = 0;
		scene.fog = new THREE.Fog(FOG_COLOR, 0.1, FOG_FAR_START);
		// scene.fog just went null -> non-null, which forces every affected
		// material (including the glass logo's heavy custom shader) to
		// recompile. Force that recompile now, while the real meshes are still
		// hidden, instead of letting it happen on the exact frame they first
		// become visible again — a mid-transition shader recompile risks a
		// one-frame rendering glitch on some GPUs.
		for (const { mesh } of wireframePairs) mesh.visible = true;
		renderer.compile(scene, camera);
		for (const { mesh } of wireframePairs) mesh.visible = false;
	}

	// remove + free the particle stand-ins, but keep the shared materials alive
	// so the intro can be replayed (see resetToGate()) without rebuilding them
	function teardownIntroParticles() {
		for (const { points } of wireframePairs) {
			points.parent?.remove(points);
			points.geometry.dispose();
		}
		wireframePairs.length = 0;
	}

	function finishIntroSequence() {
		introDone = true;
		introBloomStrength = null;
		introBgIntensity = null;
		scene.backgroundIntensity = 1;
		hazeMat.opacity = config.haze;
		scene.fog = null;
		revealLogo();   // no-op if already revealed (guards against skipped frames)
		teardownIntroParticles();
		// the wordmark stays in the DOM (faded via .leaving) so a replay can
		// re-show it; the #preloader div likewise stays (hidden) for the same reason
	}

	// dev-panel Replay: rewind the whole experience to the click-to-enter gate,
	// as if the site had loaded but was never entered — dark scene, spotlight,
	// wordmark + hint back, scroll locked, audio silent until the next click
	function resetToGate() {
		teardownIntroParticles();   // clear any in-progress intro (safe if empty)
		introStart = null;
		entered = false;
		crossfadeStarted = false;
		logoRevealed = false;
		headlineStarted = false;
		introDone = false;
		for (const m of [wireframeParticleMat, logoParticleMat]) {
			m.uniforms.u_opacity.value = 1;
			m.uniforms.u_spawnElapsed.value = 0;
			// all walls behind the camera = whole field visible / unmasked
			m.uniforms.u_wipeNear.value = -2;
			m.uniforms.u_wipeFar.value = -1;
			m.uniforms.u_openNear.value = -2;
			m.uniforms.u_openFar.value = -1;
			m.uniforms.u_settleNear.value = -2;
			m.uniforms.u_settleFar.value = -1;
		}
		const mark = document.querySelector(".preloader-mark");
		mark?.classList.remove("leaving");   // wordmark returns
		const headline = document.querySelector(".headline");
		headline.classList.remove("reveal");
		headline.classList.add("pre-reveal");
		headline.style.opacity = "";
		homeAudio.pause();
		homeAudio.currentTime = 0;
		homeAudio.volume = 0;   // pre-click silence — the next click starts the fade-in again
		document.documentElement.classList.add("loading");   // scroll locked again
		window.scrollTo(0, 0);
		enterGate();
	}

	// the wordmark fades out as the particles start spawning — the reveal
	// belongs to the particles alone, no text competing with it
	function startIntroText() {
		const mark = document.querySelector(".preloader-mark");
		if (mark) {
			mark.classList.remove("leaving");
			void mark.offsetWidth;   // restart the out animation on replay
			mark.classList.add("leaving");
		}
		const headline = document.querySelector(".headline");
		headline.classList.remove("reveal");
		headline.classList.add("pre-reveal");
		headline.style.opacity = "";   // the scroll handler's inline opacity would beat .pre-reveal and ghost the text through the replay
	}

	// hand off from the logo's particle stand-in to the real glass logo. Called
	// only once the scene is stable (fog gone, sky at full brightness, transition
	// particles hidden) so the glass refracts a clean scene, not the transition.
	function revealLogo() {
		if (logoRevealed) return;
		logoRevealed = true;
		// the particles cross-fade out over the rest of the crossfade (see
		// updateIntroSequence()) rather than vanishing this frame — additive
		// blending means glass + fading particles just read as a shimmer
		for (const { mesh, isGlass } of wireframePairs) if (isGlass) mesh.visible = true;
	}

	function updateIntroSequence(now) {
		if (introStart === null || introDone) return;
		const elapsed = now - introStart;
		if (!entered) {
			wireframeParticleMat.uniforms.u_spawnElapsed.value = elapsed / 1000;
			logoParticleMat.uniforms.u_spawnElapsed.value = elapsed / 1000;
		}
		const crossfadeMs = CROSSFADE_MS * config.introScale;
		// no hold: the front→back scene reveal starts the frame you enter
		const holdEnd = 0;
		const crossfadeEnd = holdEnd + crossfadeMs;
		if (elapsed < holdEnd) {
			introBloomStrength = BLOOM_BOOST;
			return;
		}
		if (!crossfadeStarted) {
			crossfadeStarted = true;
			// ground only — fog (below) hides it until the wall reaches each
			// part; the glass logo stays as particles until the very end (below)
			for (const { mesh, isGlass } of wireframePairs) if (!isGlass) mesh.visible = true;
		}
		const ct = Math.min(1, (elapsed - holdEnd) / crossfadeMs);
		// in-out, not ease-out: ease-out front-loads ~2/3 of the reveal into the
		// first ~1/3 of the time, which is exactly what read as "snappy".
		// sceneEase 2 ≈ the ease-in-out cubic this used to hardcode.
		const e = easeGain(ct, config.sceneEase);
		// hand off the logo particles → real glass at logoRevealT
		if (ct >= logoRevealT) revealLogo();
		introBloomStrength = BLOOM_BOOST + (config.bloom - BLOOM_BOOST) * e;
		introBgIntensity = e;   // the real sky texture, dimmed to black then ramped back to full — no color snap
		// a band sweeps front→back, so geometry emerges near-first
		const bandFar = FOG_FAR_START + (FOG_FAR_END - FOG_FAR_START) * e;
		scene.fog.far = bandFar;
		scene.fog.near = Math.max(0.1, bandFar - FOG_BAND_WIDTH);
		// ALL dots (scene + logo) clear with one front→back wall, lagging the
		// fog: the fog reveals geometry while the scene is still dim, so
		// dropping a dot the instant its surface clears reads as "particles
		// suddenly gone" on the big foreground pillars. This wipe starts a beat
		// later from the camera plane (once there's brightness to hand off to)
		// and completes exactly with the fog reveal. The logo dots joining
		// this wall is safe even when the dissolve spans the whole reveal: the
		// eased wall crawls off the camera plane and can't reach the logo's
		// depth before the real glass is in at logoRevealT (0.1) — no hole
		// where the logo was.
		// The dissolve always ENDS with the reveal — dissolveLen only sets how
		// early it starts (the fade-out window before crossfade end).
		const wipeStart = 1 - config.dissolveLen;
		const dt2 = ct <= wipeStart ? 0 : Math.min(1, (ct - wipeStart) / Math.max(0.05, config.dissolveLen));
		// same exponential wall as the enter sweep (see above): equal time per
		// depth-doubling so the dissolve marches at constant perceived speed,
		// and a proportional trailing edge (half the wall depth) so each dot
		// fades out over the same full doubling-beat — no snap at the back
		// where a fixed-width band would pass in a frame.
		const de = easeGain(dt2, config.dimEase);
		const dotFar = FOG_FAR_START * Math.pow(FOG_FAR_END * 2 / FOG_FAR_START, de);
		for (const m of [wireframeParticleMat, logoParticleMat]) {
			m.uniforms.u_wipeFar.value = dotFar;
			m.uniforms.u_wipeNear.value = dotFar * 0.5;
		}
		// starts 1s ahead of the rest of the intro finishing
		if (!headlineStarted && elapsed >= crossfadeEnd - 1000) {
			headlineStarted = true;
			const headline = document.querySelector(".headline");
			headline.classList.remove("pre-reveal");
			headline.classList.add("reveal");
		}
		if (elapsed >= crossfadeEnd) finishIntroSequence();
	}

	// --- scroll state -------------------------------------------------
	let scrollProgress = 0;     // 0..1 raw from scrollbar
	let heroSkyRotY = 0;        // this frame's hero sky rotation — applyLighting() restores it so the outro's showcase-preview render doesn't leave the hero sky snapped to the showcase orientation
	let easedProgress = 0;      // smoothed, drives rotation (uncapped — continues past 500vh)
	let easedScene = 0;         // smoothed 0..1, drives camera dolly only (capped at 500vh)
	let easedOutro = 0;         // smoothed 0..1 for the extra 20vh outro
	let easedShowcase = 0;      // smoothed 0..1 for the dark showcase carousel phase
	let easedOutro2 = 0;        // smoothed 0..1 for the second wipe window (showcase -> ambience)
	let easedAmbience = 0;      // smoothed 0..1 for the models-free ambience section (dust + sky only)
	let easedSpin = 0;          // smoothed 0..1 carousel rotation, starts ramping at the outro so it's already turning during the transition wipe instead of sitting frozen until easedShowcase kicks in
	// SCENE_RATIO is computed dynamically from config.outroStart in the tick loop
	const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
	// hover mode's own smoothed cursor — chases pointer.tx/ty faster than the
	// parallax pointer (0.05) so the particle reaction feels attached to the
	// mouse instead of dragged behind it
	const hoverCursor = { x: 0, y: 0 };

	// --- gyroscope (mobile/tablet) — overrides pointer when available ----
	const GYRO_TILT_RANGE = 22;   // degrees of physical tilt = full -1..1 range
	const GYRO_SMOOTH = 0.18;
	const gyro = {
		enabled: false, hasReading: false, listening: false,
		permissionRequested: false, permissionDenied: false,
		baseBeta: null, baseGamma: null,
		tx: 0, ty: 0, x: 0, y: 0
	};

	function onDeviceOrientation(e) {
		const beta = Number(e.beta), gamma = Number(e.gamma);
		if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return;
		if (gyro.baseBeta === null) { gyro.baseBeta = beta; gyro.baseGamma = gamma; }
		gyro.tx = Math.max(-1, Math.min(1, (gamma - gyro.baseGamma) / GYRO_TILT_RANGE));
		gyro.ty = Math.max(-1, Math.min(1, (gyro.baseBeta  - beta)  / GYRO_TILT_RANGE));
		gyro.enabled = true;
		gyro.hasReading = true;
	}

	function enableGyro() {
		if (gyro.listening) return;
		gyro.baseBeta = null; gyro.baseGamma = null;
		window.addEventListener("deviceorientation", onDeviceOrientation, { passive: true });
		gyro.listening = true;
	}

	async function requestGyroAccess() {
		if (gyro.listening || gyro.permissionDenied || gyro.permissionRequested) return;
		if (typeof DeviceOrientationEvent?.requestPermission !== "function") { enableGyro(); return; }
		gyro.permissionRequested = true;
		try {
			if (await DeviceOrientationEvent.requestPermission() === "granted") enableGyro();
			else gyro.permissionDenied = true;
		} catch { gyro.permissionRequested = false; }
	}

	function setupGyro() {
		if (!isMobile) return;
		if (!("DeviceOrientationEvent" in window)) return;
		if (typeof DeviceOrientationEvent?.requestPermission === "function") {
			// iOS 13+ requires a user-gesture to grant permission
			const onGesture = () => {
				requestGyroAccess();
				window.removeEventListener("touchend", onGesture, true);
			};
			window.addEventListener("touchend", onGesture, { passive: true, capture: true });
		} else {
			// Android / non-gated browsers — enable straight away
			enableGyro();
		}
	}

	// --- live-tunable config (driven by the control panel) ------------
	const config = {
		introScale: 0.8,        // intro duration multiplier (scales the crossfade) — see the Intro duration slider label
		sceneEase: 2,           // front→back reveal curve — 1 = steady march, higher = gentle start/landing with a faster middle
		dissolveLen: 1,         // fraction of the crossfade the particle fade-out occupies — it always ENDS with the reveal, this sets how early it starts (1 = the whole reveal, lower = later + quicker)
		dimEase: 2,             // dissolve wall curve — 1 = linear march, higher = slow start/end
		enterRadius: 1,             // gate spotlight radius (screen units, like hoverRadius)
		enterDim: 0.15,          // brightness of particles outside the spotlight while gated
		introDensity: 1,        // intro particle density multiplier (denser = more dots; applies on next Replay)
		sceneDetail: 2.5,       // hero-scene edge emphasis — higher = denser dots along each sharp edge + thinner surface scatter; doesn't touch the logo
		hoverIntensity: 1,      // strength of the cursor spotlight of preloader dots over the glass logo (0 = off)
		hoverRadius: 0.35,      // spotlight radius in screen units (1 = half the screen height)
		hoverDotSize: 5,        // spotlight dot size (same scale as the intro's logo stand-in)
		particleCount: 800,
		particleSize: 15,       // base point size in px
		glowSpeed: 0.3,         // flake flutter + glint speed multiplier
		modelScale: 1.5,        // target size of the model
		modelX: 0,              // glass logo position offset (x)
		modelY: 0.3,            // glass logo position offset (y)
		modelZ: 0,              // glass logo position offset (z)
		depthScale: 1,          // Z-depth multiplier: 1.0 = true scene.glb depth, <1 = slimmer slabs (art override)
		logoTransmission: 1,    // 1 = pure glass, 0 = fully opaque solid
		logoRoughness: 0.1,     // surface roughness (0 = mirror, 1 = matte)
		logoMetalness: 0,       // metallic amount
		logoIOR: 2,             // index of refraction
		logoThickness: 0.7,     // optical depth (affects color shift inside glass)
		logoChroma: 0.15,       // per-material chromatic aberration inside glass
		logoAnisotropy: 0.5,    // anisotropic blur on refracted background
		logoClearcoat: 1,       // clearcoat layer intensity
		logoClearcoatRough: 0,  // clearcoat roughness
		logoEnvIntensity: 1.6,  // environment map reflection intensity
		logoAttenuationDist: 10,// distance over which attenuationColor tints the glass
		netDensity: 1,          // glass-net dot density multiplier (1 = preloader-like pitch); change resamples
		netSize: 10,            // node point size in px
		waveSpeed: 1,           // water-sim propagation speed multiplier
		waveLife: 0.96,         // per-step damping: higher = ripples live longer (lively), lower = viscous calm
		waveStrength: 0.5,      // how hard the cursor stirs the water
		hoverFade: 2,           // seconds hovering the same glass before the stir AND the hover-mode dots die out (0 = never); leaving resets it
		splashSize: 3,          // amplitude of the arrival splash when the cursor first lands on a glass
		settleRate: 1,          // how fast sustained hovering settles from splash toward a murmur (higher = calms sooner)
		glowGain: 5,            // wave height → dot brightness (higher = ripples read hotter)
		waveMotion: 3,          // how far dots physically ride the waves (0 = glow only)

		// --- showcase (column section) twins: the card slabs read these instead
		// of the hero keys above, so the two sections tune independently.
		// Louder where the card art washes the effect out: glow gain + net size.
		scNetDensity: 1,        // showcase glass-net dot density (cards resample on change)
		scNetSize: 20,          // showcase node point size in px
		scWaveSpeed: 0.75,      // showcase water propagation speed
		scWaveLife: 0.96,       // showcase per-step damping
		scWaveStrength: 0.5,    // showcase stir strength
		scSplashSize: 3,        // showcase arrival splash amplitude
		scSettleRate: 1,        // showcase settle rate
		scGlowGain: 7,          // showcase wave brightness
		scWaveMotion: 3,        // showcase dot ride distance
		scHoverFade: 2,         // showcase dwell seconds before stir + spotlight die (0 = never)
		scHoverIntensity: 1,    // showcase spotlight strength (0 = off)
		scHoverRadius: 0.35,    // showcase spotlight radius
		scEdgeBrightness: 3,    // showcase dotted-perimeter color gain
		scEdgeRadius: 0.55,     // showcase dotted-perimeter cursor proximity
		scHoverDotSize: 10,     // showcase spotlight dot size

		// --- section 3 (ambience) — dust + sky only
		s3SkyAngle: 280,        // section-3's own sky heading in degrees — a different place than the showcase's swept sky

		rotationTurns: -2,      // turns over a full scroll (negative reverses)
		groundX: 0,             // ground position offset (x)
		groundY: 6,             // ground position offset (y)
		groundZ: -3,            // ground position offset (z)
		groundScale: 1.2,       // ground size multiplier (on top of auto-fit)
		groundTurns: -2,        // ground turns over a full scroll
		skyTurns: -2,           // sky/environment turns over a full scroll (the glow sweeps through view)
		skyAngle: 1.2217304763960306, // static sky/environment rotation offset (radians) — manual orientation
		skyDrift: 0,            // constant sky drift (radians/sec) — 0 = no automatic sky motion
		haze: 0.05,             // warm low haze opacity (0 = off)
		cameraDist: 10,         // camera distance — lower = bigger scene in frame
		bloom: 0.15,            // bloom strength (glow off bright areas)
		chroma: 0.012,          // chromatic aberration strength (RGB split toward edges; 0 = off)
		grain: 0.01,            // film grain + dither amount (also kills banding)
		outroSpeed: 0.10,       // easing speed of the transition build/release (higher = snappier)
		outroStart: 545,        // vh position where the glitch transition begins
		trackHeight: 1805,      // total scroll track height in vh
		outro2Start: 1400,      // vh position where the SECOND glitch transition (showcase -> ambience) begins
		section3Start: 1505,    // vh position where the models-free ambience section fully takes over
		transitionChroma: 0.05, // extra radial chromatic aberration at peak transition (added on top of the base "chroma" grade)
		transitionStreak: 0.1,  // peak directional zoom-streak distance at full transition
		wipeJitter: 0.1,        // how noisy/jagged the bottom-to-top wipe boundary gets at peak glitch
		wipeSoftness: 0.2,      // edge softness of the wipe boundary itself
		wipeNoiseScale: 1.0,    // frequency of the wipe boundary's jitter noise (higher = finer static-like noise)
		wipeFlickerSpeed: 1.0,  // how fast that noise animates over time
		wipeWaveAmp: 0.085,     // gentle low-frequency undulation of the wipe boundary, so it isn't a flat line
		wipeWaveTilt: -0.35,    // rotates the wipe boundary from horizontal (0) toward near-vertical (±1, ~80°); sign picks the lean direction
		transitionRelease: 0.15,// how quickly the glitch relaxes once past the showcase boundary (lower = snappier)
		vignetteOuter: 1.2,     // scene vignette: radius where it's fully dark
		vignetteInner: 0.4,     // scene vignette: radius where it's fully clear
		showcaseStart: 650,     // vh position where the dark showcase carousel begins
		showcaseRadius: 4.3,    // radius of the showcase card ring
		showcasePitch: 1.6,     // vertical rise per card — turns the ring into a DNA-style helix
		columnTurns: -0.5,      // how many turns the center column makes over the showcase scroll (negative = reverse)
		columnScale: 2,         // column size multiplier on top of the auto height fit (uniform, never stretches)
		columnTiltX: 0,         // degrees — straighten the scan if it leans forward/back
		columnTiltZ: 0,         // degrees — straighten the scan if it leans left/right
		columnY: -8,            // static vertical offset for the column (on top of the scroll motion)
		sectionParticles: 400,  // ambient particle count in the dark showcase section (auto-reduced on mobile)
		textDepth: 0.3,         // how far the title floats in front of the card
		cardDepth: -4,          // push the whole card ring toward (+) / away from (-) the camera
		cardScale: 1.25,        // overall card size multiplier
		cardArc: 0.85,          // angular spread between cards (1 = even, >1 = more separated, <1 = bunched)
		cardStart: 1.85,        // how far off-center the first card starts after the transition (0 = already centered, higher = enters from further down the entry lane)
		cardThickness: 0,        // card edge depth — kept 0: the card is a flat plane, the glass is the separate slab behind it
		cardGlassBack: true,    // render each card's back as a refracting glass slab
		cardGlassGap: 0.2,      // z distance between the flat card front and the floating glass slab behind it
		cardGlassScale: 1.05,   // glass slab size multiplier relative to the card (1 = same footprint)
		cardGlassThickness: 0.1,// geometric depth of the glass slab (real extruded volume, not just optical thickness)
		skyGlowX: 0.5,          // aligns the column's key light to the sun in the sky
		glowSpin: 2.5,          // how fast the sky glow sweeps relative to the column spin
		skySpeed: 0             // continuous sky drift over time (radians/sec) — the column is lit from the sun so its bright side follows
	};
	let flakeTime = 0;          // accumulated time scaled by glowSpeed

	function readScroll() {
		const max = document.documentElement.scrollHeight - window.innerHeight;
		scrollProgress = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
	}

	// --- renderer / scene --------------------------------------------
	const isMobile = matchMedia("(pointer: coarse)").matches || window.innerWidth < 768;
	if (isMobile) {
		// hand-tuned on iPhone 14 so the showcase column/cards fit comfortably
		// on narrow screens (desktop's wider FOV doesn't need this)
		config.columnScale = 1.6;
		config.cardScale = 1.15;
		config.cardArc = 0.8;
		config.cardDepth = -5;
		config.columnY = 0;
		// at IOR 1.8, logo slabs seen near edge-on turn into dark screen-locked
		// smudges (grazing-angle Fresnel reflects the mostly-black sky, and the
		// refraction smears the dark ceiling). Desktop shows the same thing but
		// tiny; portrait framing magnifies the logo enough that it reads as a
		// rendering artifact. 1.4 keeps the glass look without the dark ghosting.
		config.logoIOR = 1.4;
		document.getElementById("s-lior").value = 1.4;
		document.getElementById("v-lior").textContent = "1.40";
		// Keep card glass enabled; the mobile path already reduces its FBO scale
		// and transmission samples below to control the render cost.
	}
	const fboScale = isMobile ? 0.5 : 1;
	// card glass FBOs run at a lower resolution than the hero's — cards are
	// small on screen, the refraction already carries anisotropic blur, and
	// there are 5 of them per frame
	const cardFboScale = isMobile ? 0.5 : 0.6;

	function getLvh() {
		const el = document.createElement("div");
		el.style.cssText = "position:fixed;height:100lvh;top:0;pointer-events:none;visibility:hidden;";
		document.documentElement.appendChild(el);
		const h = el.offsetHeight || window.innerHeight;
		el.remove();
		return h;
	}
	const initH = isMobile ? getLvh() : window.innerHeight;
	if (isMobile) {
		config.particleCount = 500;
		document.getElementById("s-count").value = 500;
		document.getElementById("v-count").textContent = "500";
		config.sectionParticles = 200;
		document.getElementById("s-secpart").value = 200;
		document.getElementById("v-secpart").textContent = "200";
	}

	const renderer = new THREE.WebGLRenderer({ canvas, antialias: !isMobile, alpha: false });
	// 4K/5K panels report DPR 2, so a flat cap shades ~15M px through every
	// full-screen pass (bloom, grade, FBOs) and tanks the framerate. Cap by a
	// backing-store pixel budget instead: huge canvases drop toward DPR 1 while
	// normal displays keep full sharpness.
	// ponytail: fixed 6.5M budget; make it a slider only if a screen still stutters.
	const PIXEL_BUDGET = 6.5e6;
	function fitPixelRatio() {
		const cap = isMobile ? 1.5 : 2;
		const cssPx = window.innerWidth * (isMobile ? getLvh() : window.innerHeight);
		return Math.max(1, Math.min(cap, window.devicePixelRatio || 1, Math.sqrt(PIXEL_BUDGET / cssPx)));
	}
	renderer.setPixelRatio(fitPixelRatio());
	renderer.setSize(window.innerWidth, initH);
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.05;

	const ktx2Loader = new KTX2Loader()
		.setTranscoderPath("https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/libs/basis/")
		.detectSupport(renderer);
	const makeGLTFLoader = () =>
		new GLTFLoader().setKTX2Loader(ktx2Loader).setMeshoptDecoder(MeshoptDecoder);

	const scene = new THREE.Scene();

	const camera = new THREE.PerspectiveCamera(35, window.innerWidth / initH, 0.1, 100);
	camera.position.set(0, 0.3, config.cameraDist);
	camera.lookAt(0, 0, 0);

	// --- procedural environment: dark + one warm glow ----------------
	function makeEnvTexture() {
		const cv = document.createElement("canvas"); cv.width = 1024; cv.height = 512;
		const x = cv.getContext("2d");
		const g = x.createLinearGradient(0, 0, 0, 512);
		g.addColorStop(0.00, "#000000"); g.addColorStop(0.55, "#1a0c03");
		g.addColorStop(0.78, "#4d1f02"); g.addColorStop(1.00, "#0a0502");
		x.fillStyle = g; x.fillRect(0, 0, 1024, 512);
		const r = x.createRadialGradient(512, 330, 0, 512, 330, 240);
		r.addColorStop(0.00, "#fff4e0"); r.addColorStop(0.25, "#ffb24d");
		r.addColorStop(0.60, "#7a3a05"); r.addColorStop(1.00, "rgba(0,0,0,0)");
		x.fillStyle = r; x.fillRect(0, 0, 1024, 512);
		const tex = new THREE.CanvasTexture(cv);
		tex.mapping = THREE.EquirectangularReflectionMapping;
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.anisotropy = renderer.capabilities.getMaxAnisotropy();   // no aliasing at grazing angles
		return tex;
	}
	const equirect = makeEnvTexture();   // clean single-sun sky (no glints/cloud smudges)
	const pmrem = new THREE.PMREMGenerator(renderer);
	scene.environment = pmrem.fromEquirectangular(equirect).texture;
	scene.background = equirect;
	pmrem.dispose();

	// --- warm low haze ------------------------------------------------
	function makeHazeTexture() {
		const s = 256;
		const c = document.createElement("canvas"); c.width = s; c.height = s;
		const x = c.getContext("2d");
		const g = x.createRadialGradient(s*0.5, s*0.58, 0, s*0.5, s*0.58, s*0.5);
		g.addColorStop(0.00, "rgba(255,170,90,0.95)");
		g.addColorStop(0.30, "rgba(255,135,55,0.55)");
		g.addColorStop(0.65, "rgba(190,85,30,0.18)");
		g.addColorStop(1.00, "rgba(120,50,15,0)");
		x.fillStyle = g; x.fillRect(0, 0, s, s);
		const t = new THREE.CanvasTexture(c);
		t.colorSpace = THREE.SRGBColorSpace;
		return t;
	}
	function makeMobileHazeTexture() {
		const c = document.createElement("canvas"); c.width = 32; c.height = 256;
		const x = c.getContext("2d");
		const g = x.createLinearGradient(0, 0, 0, c.height);
		g.addColorStop(0.00, "rgba(120,50,15,0)");
		g.addColorStop(0.30, "rgba(190,85,30,0.08)");
		g.addColorStop(0.62, "rgba(255,135,55,0.45)");
		g.addColorStop(0.82, "rgba(255,170,90,0.22)");
		g.addColorStop(1.00, "rgba(120,50,15,0)");
		x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
		const t = new THREE.CanvasTexture(c);
		t.colorSpace = THREE.SRGBColorSpace;
		return t;
	}
	const hazeMat = new THREE.MeshBasicMaterial({
		// A broad vertical wash keeps the mobile atmosphere without exposing the
		// circular edge of the radial desktop haze in the narrow camera crop.
		map: isMobile ? makeMobileHazeTexture() : makeHazeTexture(),
		transparent: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
		opacity: config.haze
	});
	const haze = new THREE.Mesh(new THREE.PlaneGeometry(34, 20), hazeMat);
	haze.position.set(0, -1.3, -3);
	scene.add(haze);

	// --- drifting volumetric mist -------------------------------------
	const mistTex = makeHazeTexture();
	const mistGroup = new THREE.Group();
	const mistLayers = [];
	for (let i = 0; i < 5; i++) {
		const m = new THREE.Mesh(
			new THREE.PlaneGeometry(26, 12),
			new THREE.MeshBasicMaterial({ map: mistTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.06 })
		);
		m.position.set((Math.random() - 0.5) * 14, -2.4 + Math.random() * 1.2, -2 - Math.random() * 5);
		m.userData.seed = Math.random() * 6.28;
		m.userData.baseX = m.position.x;
		mistGroup.add(m); mistLayers.push(m);
	}
	scene.add(mistGroup);

	// --- lighting -----------------------------------------------------
	const keyLight = new THREE.DirectionalLight(0xffb066, 2.6);
	keyLight.position.set(7, 4, 2);
	scene.add(keyLight);
	const keyLightBase = keyLight.position.clone();   // hero position; showcase tracks the sun instead
	const keyLightDist = Math.hypot(keyLightBase.x, keyLightBase.z);
	const fillLight = new THREE.DirectionalLight(0x6a3a1a, 0.5);
	fillLight.position.set(-6, 1.5, -3);
	scene.add(fillLight);

	// applies hero or showcase lighting on demand — used for both the real render
	// and the temporary "opposite state" preview render captured during the wipe
	function applyLighting(phase, t) {
		if (phase === "ambience") {
			// section 3 parks the sky at its own fixed heading (no glow sweep), so
			// the ambience reads as a different place than the showcase
			scene.backgroundRotation.y = THREE.MathUtils.degToRad(config.s3SkyAngle) + t * config.skySpeed;
			scene.environmentRotation.y = scene.backgroundRotation.y;
			keyLight.position.copy(keyLightBase);
		} else if (phase === "showcase") {
			scene.backgroundRotation.y = columnGroup.rotation.y * config.glowSpin + t * config.skySpeed;
			scene.environmentRotation.y = scene.backgroundRotation.y;
			const sunAz = scene.backgroundRotation.y + config.skyGlowX * Math.PI * 2;
			keyLight.position.set(Math.sin(sunAz) * keyLightDist, keyLightBase.y, Math.cos(sunAz) * keyLightDist);
		} else {
			scene.backgroundRotation.y = heroSkyRotY;
			scene.environmentRotation.y = heroSkyRotY;
			keyLight.position.copy(keyLightBase);
		}
	}

	// scroll phases: "hero" (bright logo scene), "showcase" (dark carousel WITH column+cards),
	// "ambience" (the same dark dust+sky, NO models). Toggles group visibility for a phase —
	// used both for the live render and to capture the transition wipe's opposite state.
	function setPhaseVisibility(phase) {
		const dark = phase !== "hero";
		const models = phase === "showcase";       // ambience keeps only the dust + sky
		showcaseGroup.visible = columnGroup.visible = models;
		sectionDust.points.visible = dark;
		core.visible = groundPivot.visible = particles.points.visible =
			haze.visible = !dark;
		mistGroup.visible = !dark && !isMobile;
	}

	// --- the rotating core group -------------------------------------
	const core = new THREE.Group();
	scene.add(core);

	// --- particles orbiting the core ---------------------------------
	function buildParticles() {
		const COUNT = config.particleCount;
		const positions = new Float32Array(COUNT * 3);
		const seeds = new Float32Array(COUNT);
		const flake = new Float32Array(COUNT);
		for (let i = 0; i < COUNT; i++) {
			const r = 2.6 + Math.random() * 7.0;
			const theta = Math.random() * Math.PI * 2;
			const phi = Math.acos(2 * Math.random() - 1);
			positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
			positions[i * 3 + 1] = (r * Math.cos(phi)) * 0.8;
			positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
			seeds[i] = Math.random();
			flake[i] = Math.random() < 0.18 ? 1.0 : 0.0;
		}
		const geo = new THREE.BufferGeometry();
		geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
		geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
		geo.setAttribute("aFlake", new THREE.BufferAttribute(flake, 1));

		const mat = new THREE.ShaderMaterial({
			transparent: true,
			depthWrite: false,
			depthTest: true,
			blending: THREE.AdditiveBlending,
			uniforms: {
				u_time: { value: 0 },
				u_size: { value: config.particleSize * renderer.getPixelRatio() },
				u_colorA: { value: new THREE.Color(0x6a4420) },
				u_colorB: { value: new THREE.Color(0xffd49a) }
			},
			vertexShader: `
				uniform float u_time;
				uniform float u_size;
				attribute float aSeed;
				attribute float aFlake;
				varying float vFade;
				varying float vFlake;
				varying float vGlint;
				void main() {
					vec3 p = position;
					float t = u_time * (0.12 + aSeed * 0.4);
					p.x += sin(t + aSeed * 6.28) * 0.6;
					p.y += cos(t * 0.7 + aSeed * 6.28) * 0.45 + sin(u_time * 0.08 + aSeed * 3.0) * 0.3;
					p.z += sin(t * 0.9 + aSeed * 4.0) * 0.6;
					vec4 mv = modelViewMatrix * vec4(p, 1.0);
					vFade = clamp((-mv.z) / 16.0, 0.0, 1.0);
					vFlake = aFlake;
					float g = sin(u_time * (2.0 + aSeed * 5.0) + aSeed * 40.0);
					vGlint = aFlake * pow(max(g, 0.0), 8.0);
					gl_Position = projectionMatrix * mv;
					float twinkle = 0.5 + 0.5 * sin(u_time * (1.0 + aSeed * 3.0) + aSeed * 30.0);
					float baseSize = mix(0.35, 1.4, aSeed) * mix(0.8, 1.6, aFlake);
					gl_PointSize = u_size * baseSize * (twinkle * 0.6 + 0.4 + vGlint * 1.6) / max(1.0, -mv.z);
				}
			`,
			fragmentShader: `
				uniform vec3 u_colorA;
				uniform vec3 u_colorB;
				varying float vFade;
				varying float vFlake;
				varying float vGlint;
				void main() {
					vec2 uv = gl_PointCoord - 0.5;
					float d = dot(uv, uv);
					float sharp = mix(7.0, 26.0, vFlake);
					float soft = exp(-d * sharp);
					float core = exp(-d * 80.0);
					if (soft < 0.02 && core < 0.02) discard;
					vec3 col = mix(u_colorA, u_colorB, clamp(vFlake * 0.5 + vGlint + core, 0.0, 1.0));
					float a = soft * (0.22 + vFade * 0.6) + core * (0.4 + vGlint * 0.6);
					a *= (0.6 + vFade * 0.6);
					gl_FragColor = vec4(col, a);
				}
			`
		});

		const points = new THREE.Points(geo, mat);
		scene.add(points);
		return { points, mat };
	}
	let particles = buildParticles();

	function rebuildParticles() {
		scene.remove(particles.points);
		particles.points.geometry.dispose();
		particles.mat.dispose();
		particles = buildParticles();
	}

	// --- load the model ----------------------------------------------
	let modelReady = false;
	let coreMaxDim = 1;

	function frameCore() {
		const box = new THREE.Box3().setFromObject(core);
		const size = new THREE.Vector3();
		const center = new THREE.Vector3();
		box.getSize(size);
		box.getCenter(center);
		coreMaxDim = Math.max(size.x, size.y, size.z) || 1;
		core.children.forEach((c) => c.position.sub(center));
		applyModelScale();
	}

	function applyModelScale() {
		const s = config.modelScale / coreMaxDim;
		core.scale.set(s, s, s * config.depthScale);
	}

	function applyModelPos() {
		core.position.set(config.modelX, config.modelY, config.modelZ);
	}

	// --- glass-through-glass: split fused mesh + multi-pass transmission --
	function splitConnected(geometry) {
		const pos = geometry.attributes.position;
		const nrm = geometry.attributes.normal || null;
		const idx = geometry.index ? geometry.index.array : null;
		const triCount = idx ? idx.length / 3 : pos.count / 3;
		const tri = (t) => idx ? [idx[t*3], idx[t*3+1], idx[t*3+2]] : [t*3, t*3+1, t*3+2];

		const q = 1e-4, map = new Map(), weld = new Int32Array(pos.count);
		let next = 0;
		for (let i = 0; i < pos.count; i++) {
			const k = Math.round(pos.getX(i)/q)+'_'+Math.round(pos.getY(i)/q)+'_'+Math.round(pos.getZ(i)/q);
			let r = map.get(k); if (r === undefined) { r = next++; map.set(k, r); }
			weld[i] = r;
		}
		const parent = new Int32Array(next); for (let i=0;i<next;i++) parent[i]=i;
		const find = a => { while (parent[a]!==a){ parent[a]=parent[parent[a]]; a=parent[a]; } return a; };
		const uni  = (a,b)=>{ a=find(a); b=find(b); if(a!==b) parent[a]=b; };
		for (let t=0;t<triCount;t++){ const [a,b,c]=tri(t); uni(weld[a],weld[b]); uni(weld[b],weld[c]); }
		const groups = new Map();
		for (let t=0;t<triCount;t++){ const root=find(weld[tri(t)[0]]); (groups.get(root)||groups.set(root,[]).get(root)).push(t); }
		const geos = [];
		for (const tris of groups.values()) {
			const p = new Float32Array(tris.length*9);
			const nn = nrm ? new Float32Array(tris.length*9) : null;
			let o = 0;
			for (const t of tris) { const v = tri(t);
				for (let k=0;k<3;k++){ const vi=v[k];
					p[o]=pos.getX(vi); p[o+1]=pos.getY(vi); p[o+2]=pos.getZ(vi);
					if (nn){ nn[o]=nrm.getX(vi); nn[o+1]=nrm.getY(vi); nn[o+2]=nrm.getZ(vi); }
					o+=3;
				}
			}
			const g = new THREE.BufferGeometry();
			g.setAttribute('position', new THREE.BufferAttribute(p,3));
			if (nn) g.setAttribute('normal', new THREE.BufferAttribute(nn,3)); else g.computeVertexNormals();
			geos.push(g);
		}
		return geos;
	}

	function makeGlass() {
		const m = new MeshTransmissionMaterial(isMobile ? 6 : 10, false);
		m.transmission = config.logoTransmission; m._transmission = config.logoTransmission;
		m.roughness = config.logoRoughness;
		m.metalness = config.logoMetalness;
		m.ior = config.logoIOR;
		m.thickness = config.logoThickness;
		m.chromaticAberration = config.logoChroma;
		m.anisotropicBlur = config.logoAnisotropy;
		m.clearcoat = config.logoClearcoat;
		m.clearcoatRoughness = config.logoClearcoatRough;
		m.envMapIntensity = config.logoEnvIntensity;
		m.attenuationColor = new THREE.Color(0xffd9a8);
		m.attenuationDistance = config.logoAttenuationDist;
		m.color = new THREE.Color(0xffffff);
		// this material's transmission/refraction shader is heavily custom
		// (multi-pass FBO sampling) and its interaction with scene.fog is
		// unverified — disabling fog here specifically avoided a broken/
		// "shattered" look on this mesh during the intro's fog reveal
		m.fog = false;
		return m;
	}

	// glass material for a showcase card's back face — same MeshTransmissionMaterial
	// refraction as the hero logo, but with fewer samples (cards are small + there
	// are 5 of them) and its own per-card FBO. DoubleSide so the glass reads from
	// both sides as the card spirals around the ring.
	function makeCardGlass() {
		const m = new MeshTransmissionMaterial(isMobile ? 2 : 4, false);
		m.transmission = config.logoTransmission; m._transmission = config.logoTransmission;
		m.roughness = config.logoRoughness;
		m.metalness = config.logoMetalness;
		m.ior = config.logoIOR;
		m.thickness = config.logoThickness;
		m.chromaticAberration = config.logoChroma;
		m.anisotropicBlur = config.logoAnisotropy;
		m.clearcoat = config.logoClearcoat;
		m.clearcoatRoughness = config.logoClearcoatRough;
		m.envMapIntensity = config.logoEnvIntensity;
		m.attenuationColor = new THREE.Color(0xffd9a8);
		m.attenuationDistance = config.logoAttenuationDist;
		m.color = new THREE.Color(0xffffff);
		m.side = THREE.DoubleSide;
		m.fog = false;
		return m;
	}

	const glassMeshes = [];
	const discard = new DiscardMaterial();

	// glass-net shared state — declared here (not next to makeGlassNet below)
	// because addSlab/createCardBack call makeGlassNet as models load, which can
	// fire synchronously on a loader error, before a later declaration would run.
	const glassNets = [];   // one per glass mesh — dots + its water-sim grid (see makeGlassNet)
	const NET_COLOR_A = 0xffb347, NET_COLOR_B = 0xfff2d9;   // same amber pair as the preloader dots
	// dot pitch as a fraction of refSize — the whole logo's max dim for hero slabs
	// (uniform pitch across big and small slabs, like the preloader's trace), a
	// card slab's own diameter otherwise
	const NET_DOT_SPACING_FRACTION = 0.02;
	const NET_DOT_CAP = 4000;   // per-mesh safety cap

	function addSlab(geo) {
		const mat = makeGlass();
		const mesh = new THREE.Mesh(geo, mat);
		const fbo = new THREE.WebGLRenderTarget(Math.round(window.innerWidth * fboScale), Math.round(initH * fboScale), { type: THREE.HalfFloatType });
		mat.buffer = fbo.texture;
		core.add(mesh);
		// net built later (rebuildGlassNets after frameCore) — its dot pitch needs
		// coreMaxDim, the whole logo's size, which frameCore computes once all
		// slabs are in
		glassMeshes.push({ mesh, mat, fbo, net: null });
	}

	function clearSlabs() {
		for (const g of glassMeshes) {
			if (g.net) disposeGlassNet(g.net);
			core.remove(g.mesh);
			g.mesh.geometry.dispose();
			g.mat.dispose();
			g.fbo.dispose();
		}
		glassMeshes.length = 0;
	}

	function buildGlassFrom(gltfScene) {
		clearSlabs();
		gltfScene.updateMatrixWorld(true);
		const geos = [];
		gltfScene.traverse((o) => {
			if (!o.isMesh || !o.geometry) return;
			const g = o.geometry.clone();
			if (!g.attributes.normal) g.computeVertexNormals();
			g.applyMatrix4(o.matrixWorld);
			splitConnected(g).forEach((part) => geos.push(part));
			g.dispose();
		});
		if (!geos.length) { addFallback(); return; }
		geos.forEach(addSlab);
		frameCore();
		rebuildGlassNets();
		buildHoverLogoDots();
		modelReady = true;
		markLoaded("logo");
	}

	function addFallback() {
		clearSlabs();
		addSlab(new THREE.TorusKnotGeometry(1, 0.34, 180, 32));
		frameCore();
		rebuildGlassNets();
		buildHoverLogoDots();
		modelReady = true;
		markLoaded("logo");
	}

	makeGLTFLoader().load(
		"logo.glb",
		(gltf) => buildGlassFrom(gltf.scene),
		undefined,
		() => {
			noticeEl.classList.add("show");
			noticeEl.innerHTML = "Couldn't load <code>logo.glb</code>. " +
				"Open this page from a local server (e.g. <code>python3 -m http.server</code>) " +
				"so the model can load. Showing a placeholder for now.";
			addFallback();
		}
	);

	// --- ground -------------------------------------------------------
	const GROUND_SPAN = 22;
	const GROUND_TOP_Y = -2.2;
	const groundPivot = new THREE.Group();
	scene.add(groundPivot);
	let groundReady = false;
	let groundHalfH = 0;
	let groundMaxDim = 1;   // raw (pre-fit-scale) bounding diagonal — used by the intro's dot-spacing calc

	function applyGround() {
		if (!groundReady) return;
		groundPivot.scale.setScalar(config.groundScale);
		groundPivot.position.set(
			config.groundX,
			GROUND_TOP_Y - groundHalfH * config.groundScale + config.groundY,
			config.groundZ
		);
	}

	let groundObj = null;

	function clearGround() {
		if (!groundObj) return;
		groundPivot.remove(groundObj);
		groundObj.traverse((o) => {
			if (!o.isMesh) return;
			o.geometry?.dispose();
			if (o.material) { o.material.map?.dispose?.(); o.material.normalMap?.dispose?.(); o.material.dispose(); }
		});
		groundObj = null;
		groundReady = false;
	}

	function loadGround(url, onError, normalUrl, diffuseUrl) {
		makeGLTFLoader().load(
			url,
			(gltf) => {
				clearGround();
				const ground = gltf.scene;
				let box = new THREE.Box3().setFromObject(ground);
				const size = box.getSize(new THREE.Vector3());
				const span = Math.max(size.x, size.z) || 1;
				const fit = GROUND_SPAN / span;
				groundMaxDim = size.length() || 1;
				ground.scale.setScalar(fit);

				box = new THREE.Box3().setFromObject(ground);
				ground.position.sub(box.getCenter(new THREE.Vector3()));
				groundHalfH = size.y * fit / 2;

				const maxAniso = renderer.capabilities.getMaxAnisotropy();
				const allMats = [];
				const needsDiffuse = [];
				ground.traverse((o) => {
					if (!o.isMesh || !o.material) return;
					const m = o.material;
					allMats.push(m);
					const realTex = m.map && m.map.image && m.map.image.width > 2;
					if (realTex) {
						m.map.anisotropy = maxAniso;
						m.map.minFilter = THREE.LinearFilter;
						m.map.generateMipmaps = false;
						if (!m.map.isCompressedTexture) m.map.colorSpace = THREE.SRGBColorSpace;
						m.map.wrapS = m.map.wrapT = THREE.RepeatWrapping;
						m.map.repeat.set(1.0005, 1.0005);
						m.map.needsUpdate = true;
						if (m.normalMap) {
							m.normalMap.anisotropy = maxAniso;
							m.normalScale.set(0.55, 0.55);
							m.normalMap.needsUpdate = true;
						}
					} else {
						m.map = null;
						m.color = new THREE.Color(0x4a3a2c);
						m.roughness = 0.92;
						m.metalness = 0.0;
						m.envMapIntensity = 0.35;
						needsDiffuse.push(m);
					}
				});

				if (diffuseUrl && needsDiffuse.length) {
					new THREE.TextureLoader().load(diffuseUrl, (tex) => {
						tex.colorSpace = THREE.SRGBColorSpace;
						tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
						tex.anisotropy = maxAniso;
						tex.generateMipmaps = true;
						tex.minFilter = THREE.LinearMipmapLinearFilter;
						needsDiffuse.forEach((m) => {
							m.map = tex;
							m.color = new THREE.Color(0xffffff);
							m.needsUpdate = true;
						});
					});
				}

				if (normalUrl && allMats.length) {
					new THREE.TextureLoader().load(normalUrl, (nrm) => {
						nrm.colorSpace = THREE.NoColorSpace;
						nrm.wrapS = nrm.wrapT = THREE.ClampToEdgeWrapping;
						nrm.anisotropy = maxAniso;
						nrm.generateMipmaps = true;
						nrm.minFilter = THREE.LinearMipmapLinearFilter;
						allMats.forEach((m) => {
							m.normalMap = nrm;
							m.normalScale.set(0.55, 0.55);
							m.needsUpdate = true;
						});
					});
				}

				groundPivot.add(ground);
				groundObj = ground;
				groundReady = true;
				applyGround();
				URL.revokeObjectURL(url);
				markLoaded("ground");
			},
			undefined,
			(e) => { URL.revokeObjectURL(url); if (onError) onError(e); markLoaded("ground"); }
		);
	}

	loadGround("scene-jpeg-etc1s.glb", () => console.warn("[ground] couldn't load scene-jpeg-etc1s.glb (serve over http)."));

	function loadGroundFile(file) {
		if (!file) return;
		loadGround(URL.createObjectURL(file), () => {
			noticeEl.classList.add("show");
			noticeEl.innerHTML = "Couldn't read that file — make sure it's a valid <code>.glb</code> or <code>.gltf</code>.";
			setTimeout(() => noticeEl.classList.remove("show"), 4000);
		});
	}

	// --- dark showcase carousel ----------------------------------------
	// warm hues only, to match the site's amber/gold palette (--accent #f6b32c ≈ hue 38)
	const projects = [
		{ title: "SUSTAINABLE\nHORIZONS", hueA: 38, hueB: 8  },
		{ title: "NEON\nDISTRICT",        hueA: 18, hueB: 45 },
		{ title: "DEEP\nCURRENTS",        hueA: 28, hueB: 3  },
		{ title: "SOLAR\nARCHIVE",        hueA: 45, hueB: 22 },
		{ title: "VOID\nGARDEN",          hueA: 12, hueB: 40 }
	];

	function makeCardShape(w, h, r) {
		const s = new THREE.Shape();
		const x = -w / 2, y = -h / 2;
		s.moveTo(x + r, y);
		s.lineTo(x + w - r, y);           s.quadraticCurveTo(x + w, y, x + w, y + r);
		s.lineTo(x + w, y + h - r);       s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
		s.lineTo(x + r, y + h);           s.quadraticCurveTo(x, y + h, x, y + h - r);
		s.lineTo(x, y + r);               s.quadraticCurveTo(x, y, x + r, y);
		return s;
	}

	function roundedRectGeo(shape, w, h) {
		const g = new THREE.ShapeGeometry(shape, 12);
		// remap UVs from shape space to 0..1 so the canvas texture fills the card
		const uv = g.attributes.uv;
		const x = -w / 2, y = -h / 2;
		for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) - x) / w, (uv.getY(i) - y) / h);
		return g;
	}

	// thin ribbon tracing the card's rounded silhouette from z=0 (front) to
	// z=-thickness (back) — the only geometry that reads as "edge" when a
	// card is seen near side-on, everything else stays a flat unlit plane
	function makeRimGeo(shape, thickness) {
		const pts = shape.getPoints(12);
		if (pts.length > 1 && pts[0].distanceTo(pts[pts.length - 1]) < 1e-6) pts.pop();
		const n = pts.length;
		const positions = new Float32Array(n * 2 * 3);
		for (let i = 0; i < n; i++) {
			positions[i * 3] = pts[i].x; positions[i * 3 + 1] = pts[i].y; positions[i * 3 + 2] = 0;
			positions[(n + i) * 3] = pts[i].x; positions[(n + i) * 3 + 1] = pts[i].y; positions[(n + i) * 3 + 2] = -thickness;
		}
		const indices = [];
		for (let i = 0; i < n; i++) {
			const a = i, b = (i + 1) % n, c = n + i, d = n + ((i + 1) % n);
			indices.push(a, b, d,  a, d, c);
		}
		const geo = new THREE.BufferGeometry();
		geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
		geo.setIndex(indices);
		return geo;
	}

	// real 3D slab for the glass back: the rounded-rect shape extruded along
	// z, then recentered so its volume straddles z=0 (front face at +depth/2,
	// back face at -depth/2). This gives the transmission material actual
	// geometry to refract through — reads as a solid glass block, not a plane.
	function makeGlassSlabGeo(shape, depth) {
		const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.001, depth), bevelEnabled: false, curveSegments: 12 });
		g.translate(0, 0, -depth / 2);
		g.computeVertexNormals();
		return g;
	}

	function makeCardTexture(p) {
		const W = 1024, H = 640;
		const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
		const x = cv.getContext("2d");
		x.fillStyle = "#05060a"; x.fillRect(0, 0, W, H);
		const blob = (cx, cy, r, hue, a) => {
			const rg = x.createRadialGradient(cx, cy, 0, cx, cy, r);
			rg.addColorStop(0, `hsla(${hue},70%,55%,${a})`);
			rg.addColorStop(1, "rgba(0,0,0,0)");
			x.fillStyle = rg; x.fillRect(0, 0, W, H);
		};
		blob(W * 0.72, H * 0.35, 520, p.hueA, 0.55);
		blob(W * 0.2,  H * 0.8,  460, p.hueB, 0.45);
		blob(W * 0.45, H * 0.15, 300, (p.hueA + p.hueB) / 2, 0.3);
		for (let i = 0; i < 10; i++) {
			blob(Math.random() * W, Math.random() * H, 60 + Math.random() * 160,
				Math.random() < 0.5 ? p.hueA : p.hueB, 0.06 + Math.random() * 0.1);
		}
		// grain
		const img = x.getImageData(0, 0, W, H), d = img.data;
		for (let i = 0; i < d.length; i += 4) {
			const n = (Math.random() - 0.5) * 18;
			d[i] += n; d[i + 1] += n; d[i + 2] += n;
		}
		x.putImageData(img, 0, 0);
		const tex = new THREE.CanvasTexture(cv);
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
		return tex;
	}

	// the title on its own transparent texture, so it can float on a plane sitting
	// in front of the card (real depth) instead of being baked into the card
	function makeTextTexture(p) {
		const W = 1024, H = 640;
		const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
		const x = cv.getContext("2d");
		x.textAlign = "center"; x.textBaseline = "middle";
		x.fillStyle = "rgba(255,255,255,0.98)";
		x.shadowColor = "rgba(255,255,255,0.5)"; x.shadowBlur = 24;
		const lines = p.title.split("\n");
		lines.forEach((ln, i) => {
			x.font = `500 ${i === 0 && lines.length > 1 ? 60 : 96}px "Clash Grotesk", sans-serif`;
			x.fillText(ln, W / 2, H / 2 + (i - (lines.length - 1) / 2) * 100);
		});
		const tex = new THREE.CanvasTexture(cv);
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
		return tex;
	}

	const showcaseGroup = new THREE.Group();
	showcaseGroup.visible = false;
	scene.add(showcaseGroup);
	const cards = [];
	const CARD_W = 3.4, CARD_H = 2.1;
	const cardShape = makeCardShape(CARD_W, CARD_H, 0.18);
	const cardGeo = roundedRectGeo(cardShape, CARD_W, CARD_H);
	const textGeo = new THREE.PlaneGeometry(CARD_W, CARD_H);   // title layer, floats in front of the card
	// the glass slab geometry is rebuilt per-card on demand (makeGlassSlabGeo)
	// since cardGlassThickness is live-tunable; cardGeo stays flat for the front

	function layoutCards() {
		const R = config.showcaseRadius;
		cards.forEach((c, i) => {
			const a = (i / cards.length) * Math.PI * 2;
			c.mesh.position.set(Math.sin(a) * R, -i * config.showcasePitch, Math.cos(a) * R);
			c.mesh.rotation.set(0, a, 0);
			c.baseAngle = a;
			c.helixY = -i * config.showcasePitch;
		});
	}

	// cheap back face: no texture, just the card's own hueA/hueB baked into
	// per-vertex color (a plain lerp across UV.x) — avoids paying for a second
	// texture sample per card once the front is real video content
	function makeBackGeo(p) {
		const geo = cardGeo.clone();
		const colorA = new THREE.Color().setHSL(p.hueA / 360, 0.55, 0.16, THREE.SRGBColorSpace);
		const colorB = new THREE.Color().setHSL(p.hueB / 360, 0.55, 0.16, THREE.SRGBColorSpace);
		const uv = geo.attributes.uv;
		const colors = new Float32Array(uv.count * 3);
		const c = new THREE.Color();
		for (let i = 0; i < uv.count; i++) {
			c.copy(colorA).lerp(colorB, uv.getX(i));
			colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
		}
		geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
		return geo;
	}

	// build (or swap) one card's back face: either a refracting glass slab that
	// samples a per-card FBO (cardGlassBack on) or the cheap baked gradient back.
	// Called from buildShowcase and again whenever the glass-back checkbox flips.
	function disposeCardBack(c) {
		if (c.glassMat) {
			if (c.glassNet) { disposeGlassNet(c.glassNet); c.glassNet = null; }
			if (c.hoverDots) { c.hoverDots.geometry.dispose(); c.hoverDots = null; }   // leaves the tree with its parent glassMesh below
			if (c.edgeDots) { c.edgeDots.geometry.dispose(); c.edgeDots = null; }
			if (c.hoverProxy) { c.mesh.remove(c.hoverProxy); c.hoverProxy = null; }   // shares slabGeo; disposed once via glassMesh below
			c.mesh.remove(c.glassMesh);
			c.glassMesh.geometry.dispose();   // slab owns its own geometry (rebuilt on thickness change)
			c.glassMat.dispose();
			c.glassFbo.dispose();
			c.glassMat = null; c.glassMesh = null; c.glassFbo = null;
		} else if (c.backMat) {
			c.mesh.remove(c.backMesh);
			c.backMesh.geometry.dispose();
			c.backMat.dispose();
			c.backMat = null; c.backMesh = null;
		}
	}

	function createCardBack(c, p) {
		disposeCardBack(c);
		if (config.cardGlassBack) {
			const mat = makeCardGlass();
			const fbo = new THREE.WebGLRenderTarget(
				Math.round(window.innerWidth * cardFboScale),
				Math.round(initH * cardFboScale),
				{ type: THREE.HalfFloatType }
			);
			mat.buffer = fbo.texture;
			// real extruded slab with its own geometric depth — a separate
			// glass volume floating behind the flat card, not a coplanar plane
			const slabGeo = makeGlassSlabGeo(cardShape, config.cardGlassThickness);
			const mesh = new THREE.Mesh(slabGeo, mat);
			mesh.position.z = -config.cardGlassGap;   // floats independently behind the card
			mesh.scale.setScalar(config.cardGlassScale);
			c.mesh.add(mesh);
			c.glassMat = mat; c.glassMesh = mesh; c.glassFbo = fbo;
			c.glassNet = makeGlassNet(mesh, undefined, true);
			// spotlight dots on the slab's own bounding diagonal (world scale ~1
			// inside the card group, so the local diag is the right spacing ref).
			// Unlike the logo's thin bars, the slab is one big flat face — its
			// edge trace is just the outline, so a cursor over the middle would
			// light nothing. The surface-fill pass covers the face itself.
			slabGeo.computeBoundingSphere();
			const slabDiag = slabGeo.boundingSphere.radius * 2 * config.cardGlassScale;
			// Surface spotlight only; edgeDots below owns the perimeter independently.
			c.hoverDots = makeHoverDots(mesh, slabDiag, slabDiag * 0.03, 1, hoverCardMat, false);
			c.edgeDots = makeHoverDots(mesh, slabDiag, null, 10, hoverCardEdgeMat);
			mesh.visible = false;   // updateShowcase drives visibility from the card's fade (after makeHoverDots, which re-shows the mesh)
			// invisible hover proxy pinned at the slab's RESTING position. On hover
			// the whole card lifts toward the camera (translateZ in updateShowcase),
			// which would drag the raycast target forward with it; the proxy stays
			// where the slab rests so hover detection stays anchored to the original
			// spot. Shares the slab geometry (raycast reads CPU attrs); never rendered.
			const proxy = new THREE.Mesh(slabGeo);
			proxy.visible = false;
			proxy.position.z = -config.cardGlassGap;
			proxy.scale.setScalar(config.cardGlassScale);
			c.mesh.add(proxy);
			c.hoverProxy = proxy;
		} else {
			const backMat = new THREE.MeshBasicMaterial({
				vertexColors: true,
				side: THREE.BackSide,
				transparent: true,
				opacity: 0
			});
			const backMesh = new THREE.Mesh(makeBackGeo(p), backMat);
			backMesh.position.z = -config.cardThickness;
			c.mesh.add(backMesh);
			c.backMat = backMat; c.backMesh = backMesh;
		}
	}

	function rebuildCardBacks() {
		cards.forEach((c, i) => createCardBack(c, projects[i]));
	}

	function buildShowcase() {
		projects.forEach((p, i) => {
			// FrontSide: cards on the far side of the ring face away and cull out,
			// so you never see mirrored title text through their backs. The card
			// itself is a clean flat plane — no rim, no edge, no thickness. The
			// separate glass slab (added below via createCardBack) is what carries
			// the 3D depth behind it.
			const mat = new THREE.MeshBasicMaterial({
				map: makeCardTexture(p),
				transparent: true,
				opacity: 0
			});
			const mesh = new THREE.Mesh(cardGeo, mat);
			// title on a plane parented to the card, pushed forward so it visibly
			// sits on top of the card surface (depthWrite off so it blends cleanly)
			const textMat = new THREE.MeshBasicMaterial({
				map: makeTextTexture(p),
				transparent: true,
				opacity: 0,
				depthWrite: false
			});
			const textMesh = new THREE.Mesh(textGeo, textMat);
			textMesh.position.z = config.textDepth;
			textMesh.renderOrder = 1;
			mesh.add(textMesh);
			// glass slab added via createCardBack (or the cheap gradient back when
			// cardGlassBack is off). Back refs start null so createCardBack can
			// populate either branch cleanly.
			const c = {
				mesh, mat, textMat, textMesh,
				helixY: 0, focusT: 0, hoverT: 0, baseAngle: 0,
				backMesh: null, backMat: null,
				glassMesh: null, glassMat: null, glassFbo: null, glassNet: null, hoverDots: null, hoverProxy: null
			};
			cards.push(c);
			createCardBack(c, p);
			showcaseGroup.add(mesh);
		});
		layoutCards();
	}

	// re-run when the thickness slider moves: reposition each card's back
	// face and swap in a rim geometry sized to the new depth
	// the card front is flat now (no rim), so this only repositions the cheap
	// gradient back when glass is off — the glass slab's depth lives in its
	// own geometry (see applyGlassSlab)
	function applyCardThickness() {
		cards.forEach((c) => {
			if (!c.glassMat) c.backMesh.position.z = -config.cardThickness;
		});
	}
	// rebuild each glass slab's extruded geometry when cardGlassThickness changes
	function applyGlassSlab() {
		cards.forEach((c) => {
			if (!c.glassMat) return;
			c.glassMesh.geometry.dispose();
			c.glassMesh.geometry = makeGlassSlabGeo(cardShape, config.cardGlassThickness);
			if (c.hoverProxy) c.hoverProxy.geometry = c.glassMesh.geometry;   // proxy shares the slab footprint
		});
	}
	// redraw titles once the webfont is in (textures are cheap to rebuild)
	document.fonts.ready.then(() => {
		cards.forEach((c, i) => {
			c.textMat.map.dispose();
			c.textMat.map = makeTextTexture(projects[i]);   // font only affects the title layer now
		});
		markLoaded("fonts");
	});
	buildShowcase();

	// --- ambient dust drifting through the dark section ------------------
	// a static warm field spanning the helix descent, so the camera falls through it
	let sectionDust = null;
	function buildSectionDust() {
		if (sectionDust) {
			scene.remove(sectionDust.points);
			sectionDust.points.geometry.dispose();
			sectionDust.mat.dispose();
		}
		const COUNT = Math.round(config.sectionParticles);
		const positions = new Float32Array(COUNT * 3);
		const seeds = new Float32Array(COUNT);
		const flake = new Float32Array(COUNT);
		for (let i = 0; i < COUNT; i++) {
			// exact same spherical spread as the hero field (buildParticles), so the
			// dust fills the whole view rather than clustering around the column
			const r = 2.6 + Math.random() * 7.0;
			const theta = Math.random() * Math.PI * 2;
			const phi = Math.acos(2 * Math.random() - 1);
			positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
			positions[i * 3 + 1] = (r * Math.cos(phi)) * 0.8;
			positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
			seeds[i] = Math.random();
			flake[i] = Math.random() < 0.18 ? 1.0 : 0.0;   // same flake ratio as the hero field
		}
		const geo = new THREE.BufferGeometry();
		geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
		geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
		geo.setAttribute("aFlake", new THREE.BufferAttribute(flake, 1));
		// same shader / colors / size as the hero particles (buildParticles) so the
		// section field reads identically — only u_opacity is added, to fade it in
		const mat = new THREE.ShaderMaterial({
			transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
			uniforms: {
				u_time: { value: 0 },
				u_size: { value: config.particleSize * renderer.getPixelRatio() },
				u_opacity: { value: 0 },
				u_colorA: { value: new THREE.Color(0x6a4420) },
				u_colorB: { value: new THREE.Color(0xffd49a) }
			},
			vertexShader: `
				uniform float u_time;
				uniform float u_size;
				attribute float aSeed;
				attribute float aFlake;
				varying float vFade;
				varying float vFlake;
				varying float vGlint;
				void main() {
					vec3 p = position;
					float t = u_time * (0.12 + aSeed * 0.4);
					p.x += sin(t + aSeed * 6.28) * 0.6;
					p.y += cos(t * 0.7 + aSeed * 6.28) * 0.45 + sin(u_time * 0.08 + aSeed * 3.0) * 0.3;
					p.z += sin(t * 0.9 + aSeed * 4.0) * 0.6;
					vec4 mv = modelViewMatrix * vec4(p, 1.0);
					vFade = clamp((-mv.z) / 16.0, 0.0, 1.0);
					vFlake = aFlake;
					float g = sin(u_time * (2.0 + aSeed * 5.0) + aSeed * 40.0);
					vGlint = aFlake * pow(max(g, 0.0), 8.0);
					gl_Position = projectionMatrix * mv;
					float twinkle = 0.5 + 0.5 * sin(u_time * (1.0 + aSeed * 3.0) + aSeed * 30.0);
					float baseSize = mix(0.35, 1.4, aSeed) * mix(0.8, 1.6, aFlake);
					gl_PointSize = u_size * baseSize * (twinkle * 0.6 + 0.4 + vGlint * 1.6) / max(1.0, -mv.z);
				}
			`,
			fragmentShader: `
				uniform vec3 u_colorA;
				uniform vec3 u_colorB;
				uniform float u_opacity;
				varying float vFade;
				varying float vFlake;
				varying float vGlint;
				void main() {
					vec2 uv = gl_PointCoord - 0.5;
					float d = dot(uv, uv);
					float sharp = mix(7.0, 26.0, vFlake);
					float soft = exp(-d * sharp);
					float core = exp(-d * 80.0);
					if (soft < 0.02 && core < 0.02) discard;
					vec3 col = mix(u_colorA, u_colorB, clamp(vFlake * 0.5 + vGlint + core, 0.0, 1.0));
					float a = soft * (0.22 + vFade * 0.6) + core * (0.4 + vGlint * 0.6);
					a *= (0.6 + vFade * 0.6);
					gl_FragColor = vec4(col, a * u_opacity);
				}
			`
		});
		const points = new THREE.Points(geo, mat);
		points.visible = false;
		scene.add(points);
		sectionDust = { points, mat };
	}
	buildSectionDust();

	// the dark section reuses the hero's equirect sky (scene.background = equirect),
	// rotated on its own so the glow sweeps with the column.

	// central column the camera descends past during the showcase. It follows the
	// helix rise (but not the rotation), so scrolling reads as the camera going
	// down along it while the cards spiral past.
	const columnGroup = new THREE.Group();
	columnGroup.visible = false;
	scene.add(columnGroup);
	let columnTemplate = null;      // upright, scale 1 — cloned into stacked segments
	const columnBox = new THREE.Box3();
	const columnAxisXZ = new THREE.Vector3();   // where the column's vertical axis sits (so it spins in place)
	const columnOccluderMat = new THREE.MeshBasicMaterial({ color: 0x0a0806 });   // flat dark core so the hollow scan isn't see-through

	function buildColumn() {
		if (!columnTemplate) return;
		columnGroup.clear();
		columnBox.setFromObject(columnTemplate);
		const size = columnBox.getSize(new THREE.Vector3());
		const c0 = columnBox.getCenter(new THREE.Vector3());
		// one piece, uniform scale — auto-fit its height to the helix, no stacking,
		// no stretching. The wide capital sets the bbox; the shaft stays slender.
		const helixSpan = (projects.length - 1) * config.showcasePitch;
		const s = (helixSpan + 12) / (size.y || 1) * config.columnScale;
		const seg = columnTemplate.clone();
		seg.scale.setScalar(s);
		// x/z from the true vertical axis (so it spins in place, centered at every
		// height); y from the bbox center so the full height spans the helix
		seg.position.set(-columnAxisXZ.x * s, -helixSpan / 2 - c0.y * s, -columnAxisXZ.z * s);
		// tilt correction pivots around the column's own center, not its feet
		const pivot = new THREE.Group();
		pivot.position.y = -helixSpan / 2;
		seg.position.y -= pivot.position.y;
		pivot.rotation.set(config.columnTiltX * Math.PI / 180, 0, config.columnTiltZ * Math.PI / 180);
		pivot.add(seg);
		// dark inner copy, slightly thinner, so looking through the open scan shell
		// hits solid dark instead of the background/cards behind. Follows the exact
		// column shape and stays inside the visible surface (no dark rim).
		const core = columnTemplate.clone();
		core.scale.set(s * 0.9, s, s * 0.9);
		core.position.copy(seg.position);
		core.traverse((o) => { if (o.isMesh) o.material = columnOccluderMat; });
		pivot.add(core);
		columnGroup.add(pivot);
	}

	// finds the scan's true long (vertical) axis by power-iterating the covariance
	// of its vertices, so we can align it exactly to +Y. Without this the baked
	// axis is slightly off vertical and the column visibly wobbles as it spins.
	function principalAxis(obj) {
		const c = new THREE.Vector3(), n = { v: 0 };
		const cov = [0, 0, 0, 0, 0, 0];   // xx, yy, zz, xy, xz, yz
		const p = new THREE.Vector3();
		obj.traverse((o) => {
			if (!o.isMesh || !o.geometry) return;
			const pos = o.geometry.attributes.position;
			for (let i = 0; i < pos.count; i++) {
				p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
				c.add(p); n.v++;
			}
		});
		if (!n.v) return { axis: new THREE.Vector3(0, 1, 0), centroid: new THREE.Vector3() };
		c.multiplyScalar(1 / n.v);
		obj.traverse((o) => {
			if (!o.isMesh || !o.geometry) return;
			const pos = o.geometry.attributes.position;
			for (let i = 0; i < pos.count; i++) {
				p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).sub(c);
				cov[0] += p.x * p.x; cov[1] += p.y * p.y; cov[2] += p.z * p.z;
				cov[3] += p.x * p.y; cov[4] += p.x * p.z; cov[5] += p.y * p.z;
			}
		});
		let v = new THREE.Vector3(0, 1, 0);   // start near vertical (expected answer)
		for (let k = 0; k < 40; k++) {
			v.set(
				cov[0] * v.x + cov[3] * v.y + cov[4] * v.z,
				cov[3] * v.x + cov[1] * v.y + cov[5] * v.z,
				cov[4] * v.x + cov[5] * v.y + cov[2] * v.z
			).normalize();
		}
		return { axis: v, centroid: c.clone() };
	}

	makeGLTFLoader().load("column.glb", (gltf) => {
		const obj = gltf.scene;
		const size = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
		if (size.z >= size.y && size.z >= size.x) obj.rotation.x = -Math.PI / 2;      // stand it upright
		else if (size.x >= size.y) obj.rotation.z = Math.PI / 2;
		obj.updateMatrixWorld(true);
		// align the scan's real long axis to vertical so it stays straight while spinning
		const { axis, centroid } = principalAxis(obj);
		if (axis.y < 0) axis.negate();
		const qAlign = new THREE.Quaternion().setFromUnitVectors(axis, new THREE.Vector3(0, 1, 0));
		obj.quaternion.premultiply(qAlign);
		obj.updateMatrixWorld(true);
		// the vertical axis runs through the centroid; remember its x/z (post-align) so
		// buildColumn can sit that axis on the spin axis and the column spins in place
		columnAxisXZ.copy(centroid).applyQuaternion(qAlign);
		// vertical warmth gradient: the warm key light only reaches the top, so the
		// lower shaft reads grey. Bake a per-vertex tint that's warm at the base and
		// neutral at the top to even it out — no lights touched. (tune warmBottom)
		const gbox = new THREE.Box3().setFromObject(obj);
		const gy0 = gbox.min.y, gspan = (gbox.max.y - gbox.min.y) || 1;
		const warmBottom = new THREE.Color(1.0, 0.82, 0.58);   // multiplier at the base → warmer/less blue
		const neutralTop = new THREE.Color(1, 1, 1);          // top keeps the base tint under the warm light
		const _v = new THREE.Vector3();
		obj.traverse((o) => {                                                         // dim it to match the dark stage
			if (!o.isMesh || !o.material) return;
			o.material.envMapIntensity = 0.5;
			o.material.color?.setHex(0x7d746a);
			o.material.side = THREE.FrontSide;    // outer surface only (cheaper); the dark core covers the open ends
			const pos = o.geometry.attributes.position, col = new Float32Array(pos.count * 3);
			for (let i = 0; i < pos.count; i++) {
				_v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
				const c = warmBottom.clone().lerp(neutralTop, THREE.MathUtils.clamp((_v.y - gy0) / gspan, 0, 1));
				col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
			}
			o.geometry.setAttribute("color", new THREE.BufferAttribute(col, 3));
			o.material.vertexColors = true;
		});
		columnTemplate = obj;
		buildColumn();
		prewarmShowcase();
		markLoaded("column");
	}, undefined, () => { console.warn("[column] couldn't load column.glb (serve over http)."); markLoaded("column"); });

	// compile shaders + upload textures for the showcase up front (while the hero
	// hides it) so arriving in the section doesn't hitch on the first frame
	function prewarmShowcase() {
		const sV = showcaseGroup.visible, cV = columnGroup.visible, dV = sectionDust.points.visible;
		showcaseGroup.visible = columnGroup.visible = sectionDust.points.visible = true;
		renderer.compile(scene, camera);
		cards.forEach((c) => { if (c.mat.map) renderer.initTexture(c.mat.map); if (c.textMat.map) renderer.initTexture(c.textMat.map); });
		columnGroup.traverse((o) => { if (o.isMesh && o.material.map) renderer.initTexture(o.material.map); });
		showcaseGroup.visible = sV; columnGroup.visible = cV; sectionDust.points.visible = dV;
	}

	// click-to-zoom focus + hover/click particle interaction
	const raycaster = new THREE.Raycaster();
	let focusedCard = null;
	let hoveredCard = null;
	// click-a-slab → screen darkens → whole scene rushes at the camera → navigate
	const TRANSITION_URL = "https://apple.com";
	let transition = null;      // { t, done } once a slab is clicked
	let camDolly = 0;           // forward camera push applied during the transition
	let returnT = null;         // return animation clock: zoom out + fade in from black
	const ZOOM_DUR = 0.9;       // zoom-in and zoom-out share this duration + easing so they mirror
	// ease-in-out cubic — a stronger S-curve than smoothstep (less "linear" middle)
	const easeInOut = (t) => { t = THREE.MathUtils.clamp(t, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
	const fadeEl = document.createElement("div");
	fadeEl.style.cssText = "position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;z-index:50";
	document.body.appendChild(fadeEl);
	// returning from the target page: fade back from black to the scene, mirroring
	// the fade-to-black on the way out. sessionStorage survives the round trip in
	// the same tab, so this covers both bfcache restores and full reloads.
	window.addEventListener("pageshow", () => {
		transition = null;
		canvas.style.opacity = "";                          // undo the nav-time canvas hide
		document.documentElement.style.background = "";
		if (sessionStorage.getItem("navFade")) {
			sessionStorage.removeItem("navFade");
			// mirror the exit: start zoomed-in + black, then zoom back out to normal
			// while the black fades away (both driven in the render loop, stays synced).
			returnT = 0; camDolly = 9; fadeEl.style.opacity = "1";
		} else {
			returnT = null; camDolly = 0; fadeEl.style.opacity = "0";
		}
	});
	// proximity hysteresis for hoveredCard: entering requires an exact raycast
	// hit, but once hovered a card only releases once the cursor is more than
	// HOVER_EXIT_PX pixels from the card's projected silhouette. This is done in
	// SCREEN space on purpose: at grazing view angles (cards toward the side of
	// the ring) the raycast hit flickers on/off every frame as the always-easing
	// ring nudges the silhouette under a still cursor, and a ray-plane test can't
	// help — near edge-on the intersection point shoots to infinity and flips
	// sign, so "just off the edge" and "far away" map to the same plane coord.
	// The projected rectangle, by contrast, stays well-behaved at any angle.
	const HOVER_EXIT_PX = 22;
	const _corner = new THREE.Vector3();
	// corners of the glass slab in its own local space (rounded-rect footprint,
	// spanning ±CARD_W/2 × ±CARD_H/2 at z=0 — the mesh's own transform carries the
	// 1.05 scale and the cardGlassGap depth offset that shift its silhouette).
	const _slabCorners = [[-CARD_W / 2, -CARD_H / 2], [CARD_W / 2, -CARD_H / 2], [CARD_W / 2, CARD_H / 2], [-CARD_W / 2, CARD_H / 2]];
	function stillNearCard(card, px, py) {
		const m = card.hoverProxy || card.glassMesh || card.mesh;   // resting-position proxy, so the exit band is anchored where the slab rests
		m.updateWorldMatrix(true, false);   // child of c.mesh — its matrixWorld can lag a frame
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const [lx, ly] of _slabCorners) {
			_corner.set(lx, ly, 0).applyMatrix4(m.matrixWorld).project(camera);
			const sx = (_corner.x * 0.5 + 0.5) * window.innerWidth;
			const sy = (-_corner.y * 0.5 + 0.5) * window.innerHeight;
			if (sx < minX) minX = sx; if (sx > maxX) maxX = sx;
			if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
		}
		const dx = Math.max(minX - px, 0, px - maxX);
		const dy = Math.max(minY - py, 0, py - maxY);
		return dx * dx + dy * dy < HOVER_EXIT_PX * HOVER_EXIT_PX;
	}
	function pickCard(clientX, clientY) {
		raycaster.setFromCamera(new THREE.Vector2(
			(clientX / window.innerWidth) * 2 - 1,
			-(clientY / window.innerHeight) * 2 + 1
		), camera);
		// recursive hit: the frontmost object is usually a child (text plane, glass
		// slab, hover proxy) of a card, so walk up to the owning card mesh.
		for (const h of raycaster.intersectObjects(cards.map((c) => c.mesh), true)) {
			if (h.object.isPoints || h.object.isLine) continue;   // net/edge dots aren't click targets
			for (let o = h.object; o; o = o.parent) {
				const c = cards.find((c) => c.mesh === o);
				if (c) return c;
			}
		}
		return null;
	}
	canvas.addEventListener("click", (e) => {
		if (!showcaseGroup.visible || transition) return;
		if (!pickCard(e.clientX, e.clientY)) return;   // only a slab starts the transition
		transition = { t: 0 };
	});

	// --- glass hover particles ---------------------------------------
	// amber particle dots densely sampled onto each glass surface (hero logo slabs
	// + showcase card glass) at the preloader's dot pitch, parented to the glass so
	// they rotate/move with it. Behind them runs a real 2D water simulation (a
	// wave-equation grid over each slab's face): the cursor stirs the water where
	// it touches, and the waves radiate, interfere, and reflect off the slab
	// edges entirely on their own — nothing is a stamped preset shape. Dots ride
	// the water: they glow at the wave crests/troughs and drift along the
	// surface's slope, easing home as the water stills. Invisible at rest, per
	// hovered mesh only; the sim sleeps once its field goes quiet.
	const hoverPointer = { x: 0, y: 0, active: false };
	const _hoverNDC = new THREE.Vector2();
	function hoverTargets() {
		if (core.visible) return glassMeshes.map((g) => g.mesh);
		if (showcaseGroup.visible && config.cardGlassBack)
			// the resting-position proxy, not the lifted glass slab, so hover
			// detection stays anchored where the slab rests (visible gate = the fade)
			return cards.filter((c) => c.hoverProxy && c.glassMesh.visible).map((c) => c.hoverProxy);
		return null;
	}

	function makeGlassNet(mesh, refSize, isCard = false) {
		mesh.geometry.computeBoundingSphere();
		const R = mesh.geometry.boundingSphere.radius || 1;
		refSize = refSize || R * 2;
		// surface area in the mesh's LOCAL space — the nodes are parented to the
		// mesh, so spacing/refSize live in the same local units
		const pos = mesh.geometry.attributes.position;
		const idx = mesh.geometry.index;
		const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
		const ab = new THREE.Vector3(), ac = new THREE.Vector3();
		let area = 0;
		const triCount = (idx ? idx.count : pos.count) / 3;
		for (let t = 0; t < triCount; t++) {
			va.fromBufferAttribute(pos, idx ? idx.getX(t * 3) : t * 3);
			vb.fromBufferAttribute(pos, idx ? idx.getX(t * 3 + 1) : t * 3 + 1);
			vc.fromBufferAttribute(pos, idx ? idx.getX(t * 3 + 2) : t * 3 + 2);
			area += ab.subVectors(vb, va).cross(ac.subVectors(vc, va)).length() / 2;
		}
		const spacing = refSize * NET_DOT_SPACING_FRACTION;
		const n = Math.max(32, Math.min(NET_DOT_CAP, Math.round(area / (spacing * spacing) * (isCard ? config.scNetDensity : config.netDensity))));
		const sampler = new MeshSurfaceSampler(mesh).build();
		const rest = new Float32Array(n * 3);   // home position on the glass
		const cur  = new Float32Array(n * 3);    // live position — dots ride the wave gradient (draw buffer)
		const nrm  = new Float32Array(n * 3);    // surface normal — facing fade
		const seed = new Float32Array(n);
		const brt  = new Float32Array(n);        // drawn brightness — the wave crests
		// water grid: a 2D wave field spanning the mesh's two largest local
		// extents (the slab's face). Cell aspect kept ~square so waves stay round.
		mesh.geometry.computeBoundingBox();
		const bb = mesh.geometry.boundingBox;
		const dims = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
		let a0 = 0; for (let k = 1; k < 3; k++) if (dims[k] > dims[a0]) a0 = k;
		let a1 = a0 === 0 ? 1 : 0; for (let k = 0; k < 3; k++) if (k !== a0 && dims[k] > dims[a1]) a1 = k;
		const gw = 64;
		const gh = Math.max(8, Math.min(64, Math.round(gw * dims[a1] / (dims[a0] || 1))));
		const min0 = bb.min.getComponent(a0), min1 = bb.min.getComponent(a1);
		const max0 = bb.max.getComponent(a0), max1 = bb.max.getComponent(a1);
		const cellU = dims[a0] / (gw - 1) || 1, cellV = dims[a1] / (gh - 1) || 1;
		const cellIdx = new Int32Array(n);       // each dot's wave-grid cell (interior-clamped)
		const p = new THREE.Vector3(), nn = new THREE.Vector3();
		for (let i = 0; i < n; i++) {
			sampler.sample(p, nn);
			rest[i * 3] = cur[i * 3] = p.x; rest[i * 3 + 1] = cur[i * 3 + 1] = p.y; rest[i * 3 + 2] = cur[i * 3 + 2] = p.z;
			nrm[i * 3] = nn.x; nrm[i * 3 + 1] = nn.y; nrm[i * 3 + 2] = nn.z;
			seed[i] = Math.random();
			const iu = Math.min(gw - 2, Math.max(1, Math.round((p.getComponent(a0) - min0) / cellU)));
			const iv = Math.min(gh - 2, Math.max(1, Math.round((p.getComponent(a1) - min1) / cellV)));
			cellIdx[i] = iv * gw + iu;
		}
		const geo = new THREE.BufferGeometry();
		geo.setAttribute("position", new THREE.BufferAttribute(cur, 3));    // dynamic — wave motion
		geo.setAttribute("aNormal", new THREE.BufferAttribute(nrm, 3));
		geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
		geo.setAttribute("aBright", new THREE.BufferAttribute(brt, 1));     // dynamic — the glow
		const mat = new THREE.ShaderMaterial({
			transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
			uniforms: {
				u_size:   { value: config.netSize },
				u_colorA: { value: new THREE.Color(NET_COLOR_A) },
				u_colorB: { value: new THREE.Color(NET_COLOR_B) }
			},
			vertexShader: `
				uniform float u_size;
				attribute vec3 aNormal; attribute float aSeed; attribute float aBright;
				varying float vBright; varying float vSeed;
				void main() {
					vec4 mv = modelViewMatrix * vec4(position, 1.0);
					// hide the back side so the net reads as sitting on the visible face
					float facing = smoothstep(-0.1, 0.4, dot(normalize(normalMatrix * aNormal), normalize(-mv.xyz)));
					vBright = aBright * facing;
					vSeed = aSeed;
					gl_Position = projectionMatrix * mv;
					gl_PointSize = u_size * facing * (0.5 + aBright) / max(1.0, -mv.z);
				}
			`,
			fragmentShader: `
				uniform vec3 u_colorA; uniform vec3 u_colorB;
				varying float vBright; varying float vSeed;
				void main() {
					if (vBright <= 0.001) discard;
					vec2 uv = gl_PointCoord - 0.5;
					float d = dot(uv, uv);
					float soft = exp(-d * 8.0);
					float core = exp(-d * 40.0);
					if (soft < 0.02 && core < 0.02) discard;
					gl_FragColor = vec4(mix(u_colorA, u_colorB, vSeed), (soft * 0.7 + core * 1.4) * vBright);
				}
			`
		});
		const nodes = new THREE.Points(geo, mat);
		nodes.frustumCulled = false;

		mesh.add(nodes);
		// refR: glow radius reference — half the whole logo's max dim for hero
		// slabs (so the glow spans slab boundaries at one consistent size), the
		// mesh's own radius for cards. center: local bounding-sphere center for
		// the cheap "epicenter can't reach this mesh" reject.
		const net = {
			mesh, nodes, mat, geo, R, refR: refSize / 2, n, rest, cur, brt, cellIdx,
			hPrev: new Float32Array(gw * gh), hCur: new Float32Array(gw * gh),
			gw, gh, a0, a1, min0, min1, max0, max1, cellU, cellV,
			acc: 0, energy: 0, dirty: false, wasLit: false, hoverT: 0, isCard
		};
		glassNets.push(net);
		return net;
	}
	function disposeGlassNet(net) {
		const i = glassNets.indexOf(net);
		if (i >= 0) glassNets.splice(i, 1);
		net.mesh.remove(net.nodes);
		net.geo.dispose(); net.mat.dispose();
	}
	function rebuildGlassNets() {   // density changed / model (re)loaded → resample
		[...glassNets].forEach(disposeGlassNet);
		glassMeshes.forEach((g) => { g.net = makeGlassNet(g.mesh, coreMaxDim); });
		cards.forEach((c) => { if (c.glassMesh) c.glassNet = makeGlassNet(c.glassMesh, undefined, true); });
	}
	function setNetsVisible(v) {
		for (const net of glassNets) net.nodes.visible = v;
	}
	const _netWorld = new THREE.Vector3(), _netLocal = new THREE.Vector3();
	const _netPtrPrev = { x: 0, y: 0, has: false };
	let netSpeedEased = 0;        // eased cursor speed, 0..1 — scales how hard the cursor stirs
	let glassDwellT = 0;          // seconds the cursor has sat on any glass — the hover-mode spotlight fades on the same hoverFade clock as the stir

	// one step of the classic two-buffer water sim (Hugo Elias): each cell moves
	// toward the average of its neighbours, overshooting past it (that's the
	// wave), then damps. Writes "next" into hPrev and swaps — hCur is always the
	// latest field. Borders stay 0 = walls, so waves reflect off the slab edges.
	function waveStep(net, damp) {
		const { hPrev, hCur, gw, gh } = net;
		let energy = 0;
		for (let y = 1; y < gh - 1; y++) {
			let o = y * gw + 1;
			for (let x = 1; x < gw - 1; x++, o++) {
				const v = ((hCur[o - 1] + hCur[o + 1] + hCur[o - gw] + hCur[o + gw]) * 0.5 - hPrev[o]) * damp;
				hPrev[o] = v;
				energy += v > 0 ? v : -v;
			}
		}
		net.energy = energy / (gw * gh);
		const t2 = net.hCur; net.hCur = net.hPrev; net.hPrev = t2;
	}
	// per-section tunables: card nets read the sc* twins, hero nets the originals
	function netCfg(net, key) {
		return net.isCard ? config["sc" + key[0].toUpperCase() + key.slice(1)] : config[key];
	}
	function updateGlassNets(t, dt) {
		if (!glassNets.length) return;
		// one raycast: the world-space epicenter AND which glass mesh was hit —
		// the effect stays on the hovered mesh only, neighbours are untouched
		let hasHit = false, hitMesh = null;
		if (hoverPointer.active) {
			const targets = hoverTargets();
			if (targets && targets.length) {
				_hoverNDC.set(
					(hoverPointer.x / window.innerWidth) * 2 - 1,
					-(hoverPointer.y / window.innerHeight) * 2 + 1
				);
				raycaster.setFromCamera(_hoverNDC, camera);
				const hit = raycaster.intersectObjects(targets, false)[0];
				if (hit) {
					_netWorld.copy(hit.point);
					// showcase targets are resting-position proxies — resolve each back
					// to its (lifted) glass mesh so the net/dwell logic below is unchanged;
					// hero targets are real glass meshes and pass straight through.
					const proxied = cards.find((c) => c.hoverProxy === hit.object);
					hitMesh = proxied ? proxied.glassMesh : hit.object;
					hasHit = true;
				}
			}
		}
		const rawHoveredCard = hasHit ? cards.find((c) => c.glassMesh === hitMesh) || null : null;
		if (rawHoveredCard) hoveredCard = rawHoveredCard;
		else if (hoveredCard && (!hoverPointer.active || !stillNearCard(hoveredCard, hoverPointer.x, hoverPointer.y))) hoveredCard = null;
		glassDwellT = hasHit ? glassDwellT + dt : 0;
		// movement-reactive: the glow follows cursor speed (screen-space, in
		// viewport-heights/sec, eased), so a parked cursor fades to invisible
		if (hoverPointer.active && _netPtrPrev.has && dt > 0) {
			const spd = Math.min(1, Math.hypot(hoverPointer.x - _netPtrPrev.x, hoverPointer.y - _netPtrPrev.y) / window.innerHeight / dt * 2.5);
			// quick to respond to a stroke, slower to let go when the cursor stops
			netSpeedEased += (spd - netSpeedEased) * Math.min(1, dt * (spd > netSpeedEased ? 14 : 5));
		} else netSpeedEased += (0 - netSpeedEased) * Math.min(1, dt * 5);
		_netPtrPrev.x = hoverPointer.x; _netPtrPrev.y = hoverPointer.y; _netPtrPrev.has = hoverPointer.active;
		const pr = renderer.getPixelRatio();
		for (const net of glassNets) {
			net.mat.uniforms.u_size.value = netCfg(net, "netSize") * pr;
			const stepDt = 1 / (90 * netCfg(net, "waveSpeed"));   // sim substep — waveSpeed scales propagation
			const lit = hasHit && net.mesh === hitMesh;
			// stir the water at the cursor: a hard dip on arrival, then a
			// continuous speed-scaled stir while moving. The sim does the rest —
			// waves radiate, interfere, and reflect off the slab edges on their own.
			if (lit) {
				_netLocal.copy(_netWorld);
				net.mesh.worldToLocal(_netLocal);
				net.hoverT = net.wasLit ? net.hoverT + dt : 0;
				const gate = Math.min(1, netSpeedEased * 2);
				// the stir mellows the longer you stay on the glass: arrival is the
				// loud splash, sustained hovering settles toward a subtle murmur
				const mellow = 0.15 + 0.85 * Math.exp(-net.hoverT * netCfg(net, "settleRate"));
				// dwell timeout: after hoverFade seconds on the same slab the stir
				// stops feeding the sim entirely — the standing waves damp out and
				// the dots ease home. Leaving the slab resets hoverT (above).
				const dwell = netCfg(net, "hoverFade") > 0 ? Math.max(0, 1 - net.hoverT / netCfg(net, "hoverFade")) : 1;
				const amp = netCfg(net, "waveStrength") * (!net.wasLit ? netCfg(net, "splashSize") : gate * 1.1 * mellow) * dwell;
				if (!net.wasLit || gate > 0.05) {
					// clamp so the whole splash footprint (center + 4 neighbors)
					// stays INTERIOR: waveStep never touches border cells, so a
					// neighbor write landing on one would sit there undamped
					// forever, leaking energy back into the field every step —
					// the water never falls below the sleep threshold and the
					// glow visibly sticks to that slab edge
					const iu = Math.min(net.gw - 3, Math.max(2, Math.round((_netLocal.getComponent(net.a0) - net.min0) / net.cellU)));
					const iv = Math.min(net.gh - 3, Math.max(2, Math.round((_netLocal.getComponent(net.a1) - net.min1) / net.cellV)));
					const c = iv * net.gw + iu;
					net.hCur[c] -= amp;
					net.hCur[c - 1] -= amp * 0.5; net.hCur[c + 1] -= amp * 0.5;
					net.hCur[c - net.gw] -= amp * 0.5; net.hCur[c + net.gw] -= amp * 0.5;
				}
			}
			net.wasLit = lit;
			// advance the water at a fixed substep (capped so a suspended tab
			// doesn't spiral); skip entirely once the field has gone still
			if (lit || net.energy > 1e-5) {
				net.acc = Math.min(net.acc + dt, stepDt * 4);
				while (net.acc >= stepDt) { net.acc -= stepDt; waveStep(net, netCfg(net, "waveLife")); }
			} else if (net.dirty) {
				net.brt.fill(0);
				net.hPrev.fill(0); net.hCur.fill(0);
				net.geo.attributes.position.needsUpdate = true;   // dots eased home with the field
				net.geo.attributes.aBright.needsUpdate = true;
				net.dirty = false;
				continue;
			} else continue;
			net.dirty = true;

			// dots ride the water: brightness from the wave height under each dot,
			// displacement along the surface following the wave's slope — every
			// shape on screen comes out of the simulation, nothing is stamped
			const rest = net.rest, cur = net.cur, brt = net.brt, cellIdx = net.cellIdx, h = net.hCur;
			const gw = net.gw, a0 = net.a0, a1 = net.a1;
			const mGain = netCfg(net, "waveMotion") * net.cellU * 4;
			const maxMoveU = net.cellU * 1.5, maxMoveV = net.cellV * 1.5;
			for (let i = 0; i < net.n; i++) {
				const ix = i * 3, c = cellIdx[i];
				const hv = h[c];
				brt[i] = Math.min(1, (hv > 0 ? hv : -hv) * netCfg(net, "glowGain"));
				// slope of the surface at this cell → in-plane drift, downhill
				const gu = THREE.MathUtils.clamp((h[c + 1] - h[c - 1]) * mGain, -maxMoveU, maxMoveU);
				const gv = THREE.MathUtils.clamp((h[c + gw] - h[c - gw]) * mGain, -maxMoveV, maxMoveV);
				cur[ix + a0] = THREE.MathUtils.clamp(rest[ix + a0] - gu, net.min0, net.max0);
				cur[ix + a1] = THREE.MathUtils.clamp(rest[ix + a1] - gv, net.min1, net.max1);
			}
			net.geo.attributes.position.needsUpdate = true;
			net.geo.attributes.aBright.needsUpdate = true;
		}
	}

	const _ringPos = new THREE.Vector3(), _ringQuat = new THREE.Quaternion();
	const _proj = new THREE.Vector3();
	const _focusPos = new THREE.Vector3(), _focusQuat = new THREE.Quaternion();
	// hover lift easing: exponential approach toward the target (1 hovered, 0 not),
	// which is fast when far and slow as it settles — a snappy rise with a long
	// luxurious tail. A higher rise rate than fall rate makes hovering feel
	// responsive while the release stays gentle. (rate ≈ 1/time-constant in sec)
	const HOVER_RISE_RATE = 9;
	const HOVER_FALL_RATE = 5;
	function updateShowcase(dt) {
		// helix: cards step down by showcasePitch each; the whole group rises so the
		// current card stays at eye level — incoming cards enter from the bottom
		// right and exit upper left, like page content moving up as you scroll.
		// t is a virtual card index; it starts at -lead so the first card travels
		// in from the bottom-right entry lane while it fades, instead of
		// materializing already centered.
		const appear = Math.min(1, easedShowcase / 0.2);
		const lead = config.cardStart;
		const t = easedSpin * (cards.length - 1 + lead) - lead;
		const arcStep = (Math.PI * 2 / cards.length) * config.cardArc;   // angular gap between cards
		showcaseGroup.rotation.y = -t * arcStep;
		showcaseGroup.position.y = t * config.showcasePitch;
		showcaseGroup.position.z = config.cardDepth;   // whole ring toward/away from camera
		// keep the column concentric with the card ring (same x/z rotation axis),
		// only offset vertically by columnY
		columnGroup.position.set(
			showcaseGroup.position.x,
			showcaseGroup.position.y + config.columnY,
			showcaseGroup.position.z
		);
		columnGroup.rotation.y = easedSpin * Math.PI * 2 * config.columnTurns;
		camera.updateMatrixWorld();   // so card→screen projection below is current
		cards.forEach((c, i) => {
			c.helixY = -i * config.showcasePitch;
			const baseAngle = i * arcStep;   // spread scales the per-card angle live
			c.focusT += ((c === focusedCard ? 1 : 0) - c.focusT) * Math.min(1, dt * 6);
			const hoverActive = c === hoveredCard && c !== focusedCard;
			// exponential ease toward the hover target: fast start, long soft settle.
			// 1 - exp(-dt*rate) keeps it frame-rate independent and always in [0,1].
			const hoverGoal = hoverActive ? 1 : 0;
			const hoverRate = hoverActive ? HOVER_RISE_RATE : HOVER_FALL_RATE;
			c.hoverT += (hoverGoal - c.hoverT) * (1 - Math.exp(-dt * hoverRate));
			const s = (0.85 + appear * 0.15) * config.cardScale;
			c.mesh.scale.setScalar(s);
			// helix transform (local to showcaseGroup)
			_ringPos.set(
				Math.sin(baseAngle) * config.showcaseRadius, c.helixY,
				Math.cos(baseAngle) * config.showcaseRadius
			);
			_ringQuat.setFromEuler(new THREE.Euler(0, baseAngle, 0));
			if (c.focusT > 0.001) {
				// world-space target in front of the camera, pulled into group space
				_focusPos.set(0, 0, -4.6).applyQuaternion(camera.quaternion).add(camera.position);
				showcaseGroup.worldToLocal(_focusPos);
				_focusQuat.copy(showcaseGroup.quaternion).invert().multiply(camera.quaternion);
				c.mesh.position.lerpVectors(_ringPos, _focusPos, c.focusT);
				c.mesh.quaternion.slerpQuaternions(_ringQuat, _focusQuat, c.focusT);
			} else {
				c.mesh.position.copy(_ringPos);
				c.mesh.quaternion.copy(_ringQuat);
			}
			// Keep the card anchored to the helix while easing it slightly toward
			// the viewer along its own facing direction. hoverT already carries the
			// easing (exponential settle above), so map it straight to the lift.
			const lift = c.hoverT * 0.35;
			c.mesh.translateZ(lift);
			// hold the hover proxy at the slab's resting position: cancel the lift
			// in the proxy's own local z. translateZ moves c.mesh in unscaled group
			// units while the proxy's local z is scaled by the card scale s, so the
			// compensation is lift/s. Refresh its world matrix by hand — the renderer
			// skips invisible objects, so it won't be updated during render.
			if (c.hoverProxy) {
				c.hoverProxy.position.z = -config.cardGlassGap - lift / s;
				c.hoverProxy.updateWorldMatrix(true, false);
			}
			// fade the whole card (body + text together) as it travels toward a screen
			// corner, so exiting cards don't leave their glowing text detached behind.
			// NDC x is compressed by aspect ratio, so on narrow mobile screens the
			// mostly-horizontal swing reaches the fade thresholds far sooner than on
			// desktop — undo that skew so the fade timing matches desktop's feel.
			c.mesh.getWorldPosition(_proj).project(camera);
			const rad = Math.hypot(isMobile ? _proj.x * camera.aspect : _proj.x, _proj.y);
			const cornerFade = c === focusedCard ? 1 : 1 - THREE.MathUtils.smoothstep(rad, 0.72, 1.08);
			c.mat.opacity = appear * cornerFade * (focusedCard && c !== focusedCard ? 0.35 : 1);
			c.textMat.opacity = c.mat.opacity;   // title fades with its card
			if (c.glassMat) {
				// glass slab is transmission-driven, not opacity — just gate it so
				// faded-out cards don't pay for an FBO capture this frame
				c.glassMesh.visible = c.mat.opacity > 0.02;
			} else {
				c.backMat.opacity = c.mat.opacity;   // back gradient fades with its card
			}
			c.textMesh.position.z = config.textDepth;
		});
	}

	// --- post-processing pipeline ------------------------------------
	const composer = new EffectComposer(
		renderer,
		new THREE.WebGLRenderTarget(window.innerWidth, initH, {
			type: THREE.HalfFloatType,
			// 4× MSAA supersamples the whole scene render; brutal on a 5K backing
			// store. Drop to 2× once we're already pushing lots of pixels — the
			// density hides it. Fixed at construction (resize rarely crosses screens).
			samples: isMobile ? 0 : (window.innerWidth * initH * fitPixelRatio() ** 2 > 4e6 ? 2 : 4)
		})
	);
	composer.addPass(new RenderPass(scene, camera));

	// captures the "opposite" scene state (hero vs showcase) during the
	// transition window only, so wipePass below can composite a real bottom-up
	// content reveal instead of a hard cut
	const otherRT = new THREE.WebGLRenderTarget(window.innerWidth, initH, { type: THREE.HalfFloatType });

	// sanitize HDR buffer before bloom: superbright glints can go Inf/NaN in the
	// HalfFloat target and UnrealBloomPass smears non-finite values into big
	// black rectangles for a frame. Float compares (x != x) get optimized away
	// by fast-math shader compilers, so detect Inf/NaN by bit pattern instead.
	composer.addPass(new ShaderPass(new THREE.ShaderMaterial({
		glslVersion: THREE.GLSL3,
		uniforms: { tDiffuse: { value: null } },
		vertexShader: `out vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
		fragmentShader: `
			precision highp float;
			uniform sampler2D tDiffuse;
			in vec2 vUv;
			out vec4 outColor;
			void main(){
				vec4 c = texture(tDiffuse, vUv);
				uvec3 bits = floatBitsToUint(c.rgb) & uvec3(0x7fffffffu);
				c.r = bits.x >= 0x7f800000u ? 0.0 : c.r;   // Inf/NaN -> 0
				c.g = bits.y >= 0x7f800000u ? 0.0 : c.g;
				c.b = bits.z >= 0x7f800000u ? 0.0 : c.b;
				outColor = vec4(min(c.rgb, vec3(48.0)), c.a);
			}
		`
	})));

	// composites the current render (tDiffuse, whichever of hero/showcase is
	// active) with the "opposite" state (tOther, captured only during the
	// transition window) along a noisy bottom-to-top wipe boundary — the jitter
	// scales with the glitch amount so the seam is only ever visible while
	// already chaotic, never as a clean line
	const wipePass = new ShaderPass({
		uniforms: {
			tDiffuse: { value: null },
			tOther: { value: null },   // set below — ShaderPass clones these uniforms at construction, and cloning a render-target texture isn't supported (warns + breaks the reference)
			uTime: { value: 0 },
			uWipe: { value: 0 },
			uGlitch: { value: 0 },
			uCurrentIsShowcase: { value: 0 },
			uJitter: { value: config.wipeJitter },
			uSoftness: { value: config.wipeSoftness },
			uNoiseScale: { value: config.wipeNoiseScale },
			uFlickerSpeed: { value: config.wipeFlickerSpeed },
			uWaveAmp: { value: config.wipeWaveAmp },
			uWaveTilt: { value: config.wipeWaveTilt }
		},
		vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
		fragmentShader: `
			uniform sampler2D tDiffuse, tOther;
			uniform float uTime, uWipe, uGlitch, uCurrentIsShowcase, uJitter, uSoftness, uNoiseScale, uFlickerSpeed, uWaveAmp, uWaveTilt;
			varying vec2 vUv;
			float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
			void main(){
				vec3 diffuseCol = texture2D(tDiffuse, vUv).rgb;
				vec3 otherCol = texture2D(tOther, vUv).rgb;
				float n = (hash(vUv * vec2(600.0, 300.0) * uNoiseScale + uTime * uFlickerSpeed) - 0.5) * uGlitch * uJitter;
				// uWaveTilt rotates the sweep axis from a bottom-to-top wipe (0)
				// toward a near-vertical wipe (±1, ~80°) — sign picks which way
				// it leans. The wave ripples along whichever axis now runs along
				// the boundary itself.
				float angle = uWaveTilt * radians(80.0);
				vec2 dir = vec2(sin(angle), cos(angle));
				float proj = vUv.x * dir.x + vUv.y * dir.y;
				float perp = vUv.x * dir.y - vUv.y * dir.x;
				float wave = (sin(perp * 15.7 + uTime * 0.4) * 0.6 + sin(perp * 6.3 - uTime * 0.25) * 0.4) * uWaveAmp;
				// proj's reach across the unit square shifts off the [0,1] range
				// once dir.x goes negative, so bound it from dir's sign rather
				// than assuming 0 is the minimum
				float minProj = min(0.0, dir.x);
				float maxProj = max(0.0, dir.x) + dir.y;
				float lineY = mix(minProj - uSoftness * 2.0, maxProj + uSoftness * 2.0, uWipe);
				float mask = 1.0 - smoothstep(lineY - uSoftness, lineY + uSoftness, proj + n + wave);
				vec3 heroCol = uCurrentIsShowcase > 0.5 ? otherCol : diffuseCol;
				vec3 showcaseCol = uCurrentIsShowcase > 0.5 ? diffuseCol : otherCol;
				gl_FragColor = vec4(mix(heroCol, showcaseCol, mask), 1.0);
			}
		`
	});
	wipePass.uniforms.tOther.value = otherRT.texture;
	composer.addPass(wipePass);

	const bloomPass = new UnrealBloomPass(
		new THREE.Vector2(window.innerWidth, initH),
		config.bloom, 0.6, 0.85
	);
	composer.addPass(bloomPass);

	const gradePass = new ShaderPass({
		uniforms: {
			tDiffuse: { value: null },
			uTime: { value: 0 },
			uGrain: { value: config.grain },
			uChroma: { value: config.chroma },
			uAspect: { value: window.innerWidth / initH },
			uTransition: { value: 0 },              // 0..1 hero→showcase glitch amount, driven by scroll
			uTransitionChroma: { value: config.transitionChroma },
			uTransitionStreak: { value: config.transitionStreak },
			uVignetteOuter: { value: config.vignetteOuter },
			uVignetteInner: { value: config.vignetteInner }
		},
		vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
		fragmentShader: `
			uniform sampler2D tDiffuse;
			uniform float uTime, uGrain, uChroma, uAspect, uTransition, uTransitionChroma, uTransitionStreak, uVignetteOuter, uVignetteInner;
			varying vec2 vUv;
			float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
			vec3 sampleChroma(vec2 uv, vec2 d, float chroma){
				vec2 off = d * dot(d, d) * chroma;
				vec3 c;
				c.r = texture2D(tDiffuse, uv + off).r;
				c.g = texture2D(tDiffuse, uv).g;
				c.b = texture2D(tDiffuse, uv - off).b;
				return c;
			}
			void main(){
				vec2 uv = vUv;
				vec2 d = uv - 0.5;
				float chroma = uChroma + uTransition * uTransitionChroma;
				vec3 col = sampleChroma(uv, d, chroma);
				// directional zoom-streak: radial multi-tap smear pulled toward center,
				// ramped in with the transition — the "chromatic distort" glitch on scroll
				if (uTransition > 0.001) {
					vec2 dir = d * uTransition * uTransitionStreak;
					vec3 streak = col;
					float wsum = 1.0;
					const int TAPS = 12;
					for (int i = 1; i <= TAPS; i++) {
						float ti = float(i) / float(TAPS);
						float w = 1.0 - ti;   // nearer samples weigh more — a fading trail instead of N equal-strength echoes
						vec2 suv = uv - dir * ti;
						streak += sampleChroma(suv, suv - 0.5, chroma) * w;
						wsum += w;
					}
					col = mix(col, streak / wsum, uTransition);
				}
				col *= smoothstep(uVignetteOuter, uVignetteInner, length(d * vec2(uAspect, 1.0)));
				float g = hash(uv * vec2(1920.0, 1080.0) + uTime) - 0.5;
				float lum = dot(col, vec3(0.299, 0.587, 0.114));
				col += g * uGrain * (1.0 - smoothstep(0.25, 0.9, lum));
				gl_FragColor = vec4(col, 1.0);
			}
		`
	});
	composer.addPass(gradePass);
	composer.addPass(new OutputPass());

	// --- render loop --------------------------------------------------
	const clock = new THREE.Clock();
	let lastElapsed = 0;
	function tick() {
		const now = performance.now();
		updateIntroSequence(now);
		const t = clock.getElapsedTime();
		const dt = Math.min(0.05, t - lastElapsed);
		lastElapsed = t;
		flakeTime += dt * config.glowSpeed;

		const sr = config.outroStart    / config.trackHeight;
		const cr = config.showcaseStart / config.trackHeight;
		const sceneProgress    = Math.min(scrollProgress / sr, 1);
		const rotProgress      = Math.min(scrollProgress / cr, 1) * (cr / sr); // keeps spinning through the veil sweep, freezes once dark
		const outroProgress    = Math.min(1, Math.max(0, (scrollProgress - sr) / (cr - sr)));
		const showcaseProgress = Math.max(0, (scrollProgress - cr) / (1 - cr));
		// second transition (showcase -> models-free ambience) + the ambience section
		const o2r = config.outro2Start  / config.trackHeight;
		const s3r = config.section3Start / config.trackHeight;
		const outro2Progress   = Math.min(1, Math.max(0, (scrollProgress - o2r) / (s3r - o2r)));
		const ambienceProgress = Math.max(0, (scrollProgress - s3r) / (1 - s3r));
		// same 0..1 span as showcaseProgress but starting at the outro (sr) instead
		// of the showcase boundary (cr), so the carousel is already mid-spin by the
		// time the wipe finishes instead of snapping from a standstill
		const spinProgress = Math.max(0, Math.min(1, (scrollProgress - sr) / (1 - sr)));
		easedProgress  += (rotProgress      - easedProgress)  * 0.08;
		easedScene     += (sceneProgress    - easedScene)     * 0.08;
		// the wipe and showcase ease out faster than in, so scrolling back up
		// reveals the hero without a long dwell
		easedOutro     += (outroProgress    - easedOutro)     * (outroProgress    < easedOutro    ? Math.max(config.outroSpeed, 0.2) : config.outroSpeed);
		easedShowcase  += (showcaseProgress - easedShowcase)  * (showcaseProgress < easedShowcase ? 0.2 : 0.08);
		easedSpin      += (spinProgress     - easedSpin)      * (spinProgress     < easedSpin     ? 0.2 : 0.08);
		easedOutro2    += (outro2Progress   - easedOutro2)    * (outro2Progress   < easedOutro2   ? Math.max(config.outroSpeed, 0.2) : config.outroSpeed);
		easedAmbience  += (ambienceProgress - easedAmbience)  * (ambienceProgress < easedAmbience ? 0.2 : 0.08);
		// while in showcase mode, drive the wipe shut so that scrolling back up
		// hands off through the wipe boundary instead of popping. EASED, not
		// snapped: outroProgress hits 1 a few frames before easedOutro catches
		// up, and assigning 1 outright jumped the wipe boundary mid-transition.
		if (easedShowcase > 0.001) easedOutro += (1 - easedOutro) * Math.max(config.outroSpeed, 0.2);
		// same handoff for the second wipe once the ambience section owns the frame
		if (easedAmbience > 0.001) easedOutro2 += (1 - easedOutro2) * Math.max(config.outroSpeed, 0.2);

		if (gyro.enabled && gyro.hasReading) {
			gyro.x += (gyro.tx - gyro.x) * GYRO_SMOOTH;
			gyro.y += (gyro.ty - gyro.y) * GYRO_SMOOTH;
			pointer.tx = gyro.x;
			pointer.ty = gyro.y;
		}
		pointer.x += (pointer.tx - pointer.x) * 0.05;
		pointer.y += (pointer.ty - pointer.y) * 0.05;

		hoverCursor.x += (pointer.tx - hoverCursor.x) * 0.25;
		hoverCursor.y += (pointer.ty - hoverCursor.y) * 0.25;
		// same dwell timeout as the water stir: parked on the glass past its
		// section's hoverFade, the spotlight dots fade away too (eased, so no
		// pop when glassDwellT resets on leaving); intensity scales the effect.
		// Hero and showcase materials each read their own section's keys.
		for (const [m, iK, rK, fK] of [
			[hoverDotMat, "hoverIntensity", "hoverRadius", "hoverFade"],
			[hoverCardMat, "scHoverIntensity", "scHoverRadius", "scHoverFade"],
			[hoverCardEdgeMat, "scHoverIntensity", "scEdgeRadius", "scHoverFade"]
		]) {
			m.uniforms.u_cursor.value.set(hoverCursor.x, hoverCursor.y);
			m.uniforms.u_cursorRadius.value = config[rK];
			m.uniforms.u_aspect.value = camera.aspect;
			const target = (config[fK] > 0 ? Math.max(0, 1 - glassDwellT / config[fK]) : 1) * config[iK];
			m.uniforms.u_opacity.value += (target - m.uniforms.u_opacity.value) * Math.min(1, dt * 4);
		}
		hoverCardEdgeMat.uniforms.u_brightness.value = config.scEdgeBrightness;

		// click-to-enter gate: the intro mats need the live cursor while the
		// spotlight mask is up (awaiting) and while it dissolves (just entered),
		// and the gate drives its own (stretched) spawn stagger — a Replay
		// instead drives spawn from introStart in updateIntroSequence()
		if (awaitingEnter || (entered && !introDone)) {
			const spawn = (performance.now() - gateStart) / 1000 / GATE_SPAWN_STRETCH;
			for (const m of [wireframeParticleMat, logoParticleMat]) {
				m.uniforms.u_cursor.value.set(hoverCursor.x, hoverCursor.y);
				m.uniforms.u_aspect.value = camera.aspect;
				m.uniforms.u_spawnElapsed.value = spawn;
				// re-read each frame so the gate sliders tune the live gate
				m.uniforms.u_cursorRadius.value = config.enterRadius;
				m.uniforms.u_revealFloor.value = config.enterDim;
			}
		}
		if (entered && homeAudio.volume < HOME_VOLUME) {
			homeAudio.volume = Math.min(HOME_VOLUME, homeAudio.volume + dt * HOME_VOLUME / 2);   // ~2s fade-in
		}

		if (modelReady) {
			core.rotation.y = easedProgress * Math.PI * config.rotationTurns + pointer.x * 0.4;
			core.rotation.x = -pointer.y * 0.25;
		}

		if (groundReady) {
			groundPivot.rotation.y = easedProgress * Math.PI * config.groundTurns;
		}

		// glitch transition: builds through the outro window (chroma + streak ramp
		// up in the grade shader below), then eases off quickly once the showcase
		// phase takes over — same timing shape as the old veil, just driving a
		// shader distortion instead of a black DOM overlay
		// min() of the two ramps rather than switching between them at the phase
		// flip: easedOutro is still short of 1 when the showcase takes over, so
		// swapping formulas there jumped the glitch up before releasing it
		const transitionAmt = Math.min(easedOutro, Math.max(0, 1 - easedShowcase / config.transitionRelease));
		// same glitch shape for the second wipe: builds through the outro2 window,
		// then relaxes once the ambience section settles
		const transition2Amt = Math.min(easedOutro2, Math.max(0, 1 - easedAmbience / config.transitionRelease));
		// the two windows never overlap, so the live one is just the larger value
		const glitchAmt = Math.max(transitionAmt, transition2Amt);

		heroSkyRotY = config.skyAngle + easedProgress * Math.PI * config.skyTurns + t * config.skyDrift - pointer.x * 0.15;
		scene.backgroundRotation.y = heroSkyRotY;
		scene.environmentRotation.y = heroSkyRotY;

		particles.points.rotation.y = -easedProgress * Math.PI * 1.5 - t * 0.02;
		particles.mat.uniforms.u_time.value = flakeTime;

		// slab-click transition: the screen darkens first, then the camera dives
		// forward so the whole scene (every card + column) rushes toward the viewer.
		if (transition) {
			transition.t += dt;
			const T = transition.t;
			// zoom FIRST: the whole scene rushes at the camera, then the black fades
			// in smoothly once the dive is underway (trailing the motion, not leading).
			camDolly = easeInOut(T / ZOOM_DUR) * 9;                        // scene rushes at the camera (eased)
			fadeEl.style.opacity = THREE.MathUtils.smoothstep(T, 0, 0.7);   // black completes before the zoom does
			if (T >= ZOOM_DUR && !transition.done) {
				transition.done = true;
				sessionStorage.setItem("navFade", "1");   // tell the return trip to fade in from black
				// belt-and-suspenders so the browser's outgoing/back-forward snapshot is
				// definitely black (a WebGL canvas can snapshot without the DOM overlay):
				canvas.style.opacity = "0";
				document.documentElement.style.background = "#000";
				window.location.href = TRANSITION_URL;
			}
		}
		// return trip: reverse of the exit — zoom out from the dive while the black lifts
		if (returnT !== null) {
			returnT += dt;
			camDolly = 9 * (1 - easeInOut(returnT / ZOOM_DUR));                          // zoom back out (eased, mirrors the zoom-in)
			fadeEl.style.opacity = 1 - THREE.MathUtils.smoothstep(returnT, 0.2, 0.9);   // black lifts to reveal the scene
			if (returnT >= ZOOM_DUR) { returnT = null; camDolly = 0; fadeEl.style.opacity = 0; }
		}

		const baseZ = config.cameraDist - easedScene * 2.2 + easedOutro * 2.2;
		camera.position.z = baseZ - camDolly;
		camera.position.x = -pointer.x * 0.6;
		camera.position.y = 0.3 - pointer.y * 0.4;
		camera.lookAt(0, 0, 0);

		// during the intro the warm haze/mist ride the same eased ramp as the sky
		// (0 while dark, up to full with the reveal) so they never pop in at the end
		const introEnvFade = introBgIntensity !== null ? introBgIntensity : 1;
		mistLayers.forEach((m) => {
			m.position.x = m.userData.baseX + Math.sin(t * 0.05 + m.userData.seed) * 2.0;
			m.material.opacity = (0.045 + 0.03 * (0.5 + 0.5 * Math.sin(t * 0.2 + m.userData.seed))) * introEnvFade;
		});

		gradePass.uniforms.uGrain.value = config.grain;
		gradePass.uniforms.uChroma.value = config.chroma;
		gradePass.uniforms.uTime.value = t;
		gradePass.uniforms.uTransition.value = glitchAmt;
		gradePass.uniforms.uTransitionChroma.value = config.transitionChroma;
		gradePass.uniforms.uTransitionStreak.value = config.transitionStreak;
		gradePass.uniforms.uVignetteOuter.value = config.vignetteOuter;
		gradePass.uniforms.uVignetteInner.value = config.vignetteInner;
		bloomPass.strength = introBloomStrength !== null ? introBloomStrength : config.bloom;
		bloomPass.enabled = config.bloom > 0;

		// phase switch: hero (bright) vs. dark showcase vs. models-free ambience
		const showcaseActive = easedShowcase > 0.001 || showcaseProgress > 0;
		const ambienceActive = easedAmbience > 0.001 || ambienceProgress > 0;
		const currentPhase = ambienceActive ? "ambience" : (showcaseActive ? "showcase" : "hero");
		// don't touch the headline's opacity until its own intro reveal has
		// fired (finishIntroSequence) — an inline style here beats the plain
		// (non-animated) .pre-reveal class rule and would ghost it in early
		if (introDone) document.querySelector(".headline").style.opacity = showcaseActive ? "0" : "1";
		setPhaseVisibility(currentPhase);
		scene.background = equirect;   // keep the hero's rich sky in the showcase too
		// carousel pose + dust uniforms run unconditionally (cheap, harmless while
		// invisible) so the showcase is already correctly posed for the transition
		// wipe's preview render below, not just once showcaseActive flips true
		updateShowcase(dt);
		const appear = Math.min(1, easedShowcase / 0.2);
		sectionDust.mat.uniforms.u_time.value = flakeTime;
		sectionDust.mat.uniforms.u_opacity.value = appear;
		// the dust rotates with the carousel as you scroll (a touch slower for
		// depth parallax) so the field turns with us, plus a gentle idle drift
		sectionDust.points.rotation.y = showcaseGroup.rotation.y * 0.6 + t * 0.02;
		applyLighting(currentPhase, t);
		updateGlassNets(t, dt);

		// intro override: while the wireframe particles are showing, dim the
		// real sky so they read as "particles on black" first, then the same
		// texture ramps back up to full brightness as part of the crossfade
		// (see updateIntroSequence()). Haze/mist fade with the same ramp via
		// introEnvFade above — opacity 0 on an additive plane renders nothing,
		// so the dark phase stays pure black without visibility toggles.
		if (introBgIntensity !== null) {
			scene.backgroundIntensity = introBgIntensity;
			hazeMat.opacity = config.haze * introBgIntensity;
		}

		// capture the "opposite" scene state for the wipe composite, only while
		// actually inside a transition window (zero cost outside it). The compositor
		// blends a "before" (mask 0) and "after" (mask 1) state; uCurrentIsShowcase
		// flags which of tDiffuse/tOther is the after-state. Window 1 blends
		// hero->showcase; window 2 blends showcase->ambience (models wiped away).
		const inWindow2 = outro2Progress > 0 || easedAmbience > 0.001;
		wipePass.uniforms.uTime.value = t;
		wipePass.uniforms.uWipe.value = inWindow2 ? easedOutro2 : easedOutro;
		wipePass.uniforms.uGlitch.value = glitchAmt;
		wipePass.uniforms.uCurrentIsShowcase.value = (inWindow2 ? ambienceActive : showcaseActive) ? 1 : 0;
		wipePass.uniforms.uJitter.value = config.wipeJitter;
		wipePass.uniforms.uSoftness.value = config.wipeSoftness;
		wipePass.uniforms.uNoiseScale.value = config.wipeNoiseScale;
		wipePass.uniforms.uFlickerSpeed.value = config.wipeFlickerSpeed;
		wipePass.uniforms.uWaveAmp.value = config.wipeWaveAmp;
		wipePass.uniforms.uWaveTilt.value = config.wipeWaveTilt;
		const capturePhase = (outroProgress > 0 && outroProgress < 1)
			? (showcaseActive ? "hero" : "showcase")              // window 1: the opposite of current
			: (outro2Progress > 0 && outro2Progress < 1)
				? (ambienceActive ? "showcase" : "ambience")      // window 2: the opposite model state
				: null;
		if (capturePhase) {
			setPhaseVisibility(capturePhase);
			applyLighting(capturePhase, t);
			renderer.setRenderTarget(otherRT);
			renderer.render(scene, camera);
			renderer.setRenderTarget(null);
			setPhaseVisibility(currentPhase);
			applyLighting(currentPhase, t);
		}

		setNetsVisible(false);   // keep the net out of every glass refraction FBO (else it refracts into the slab)
		if (core.visible) {   // glass FBO passes are pointless (and expensive) once the scene is dark
			const oldTone = renderer.toneMapping;
			// keep the intro's bright additive particles OUT of the glass's
			// refraction buffer — refracting them produces an opaque,
			// shattered-looking slab. (No-op after the intro: wireframePairs
			// is empty.) This lets the real glass appear at any point during
			// the intro without ever refracting the transition.
			for (const p of wireframePairs) p.points.visible = false;
			for (const g of glassMeshes) {
				g.mat.time = t;
				g.mesh.material = discard;
				renderer.toneMapping = THREE.NoToneMapping;
				renderer.setRenderTarget(g.fbo);
				renderer.render(scene, camera);
				renderer.setRenderTarget(null);
				renderer.toneMapping = oldTone;
				g.mesh.material = g.mat;
			}
			for (const p of wireframePairs) p.points.visible = true;
		}
		// showcase card glass-back refraction captures — same discard-the-mesh,
		// render-the-scene trick as the hero glass above, but per card back.
		// Every glass back (including the one being captured) is swapped to the
		// discard material for the whole pass so (a) a glass back never refracts
		// itself and (b) glass-through-glass recursion is avoided — each back
		// refracts the column/dust/sky plus the OTHER cards' opaque fronts. The
		// card's own front/text are also discarded during its capture so the
		// glass refracts the scene behind the card rather than its own art.
		if (showcaseGroup.visible && config.cardGlassBack) {
			const oldTone = renderer.toneMapping;
			renderer.toneMapping = THREE.NoToneMapping;
			for (const c of cards) if (c.glassMat) c.glassMesh.material = discard;
			for (const c of cards) {
				if (!c.glassMat || !c.glassMesh.visible) continue;
				const prevFront = c.mesh.material, prevText = c.textMesh.material;
				c.mesh.material = discard;
				c.textMesh.material = discard;
				c.glassMat.time = t;
				renderer.setRenderTarget(c.glassFbo);
				renderer.render(scene, camera);
				c.mesh.material = prevFront;
				c.textMesh.material = prevText;
			}
			renderer.setRenderTarget(null);
			renderer.toneMapping = oldTone;
			for (const c of cards) if (c.glassMat) c.glassMesh.material = c.glassMat;
		}
		setNetsVisible(introDone);   // net stays hidden through the particle intro, on once the scene is live
		composer.render();

		fpsFrames++;
		if (t - fpsLast >= 0.5) {
			fpsEl.textContent = Math.round(fpsFrames / (t - fpsLast)) + " fps";
			fpsFrames = 0; fpsLast = t;
		}

		rafId = requestAnimationFrame(tick);
	}

	// --- events -------------------------------------------------------
	// auto-advance: if the user pauses inside the glitch transition zone, glide
	// the rest of the way into the showcase so the effect always plays out fully
	// instead of leaving them stranded mid-transition
	const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
	const IDLE_MS = 400;   // pause before the auto-glide kicks in
	let autoScrollRaf = null, autoScrolling = false, scrollIdleTimer = null;

	function cancelAutoScroll() {
		if (autoScrollRaf !== null) { cancelAnimationFrame(autoScrollRaf); autoScrollRaf = null; }
		autoScrolling = false;
	}
	function autoScrollTo(targetY) {
		const startY = window.scrollY, dist = targetY - startY;
		if (Math.abs(dist) < 2) return;
		const duration = Math.min(3000, Math.max(1200, Math.abs(dist) * 2.8));
		const startT = performance.now();
		autoScrolling = true;
		function step(now) {
			const p = Math.min(1, (now - startT) / duration);
			const e = p < 0.5 ? 8 * p * p * p * p : 1 - Math.pow(-2 * p + 2, 4) / 2;   // easeInOutQuart — very gentle start, smooth settle
			window.scrollTo(0, startY + dist * e);
			if (p < 1) autoScrollRaf = requestAnimationFrame(step);
			else { autoScrollRaf = null; autoScrolling = false; }
		}
		autoScrollRaf = requestAnimationFrame(step);
	}
	function maybeAutoAdvance() {
		if (autoScrolling) return;
		const sr = config.outroStart / config.trackHeight;
		const cr = config.showcaseStart / config.trackHeight;
		const o2r = config.outro2Start  / config.trackHeight;
		const s3r = config.section3Start / config.trackHeight;
		// land PAST each transition boundary far enough that the glitch/chroma has
		// fully released — the glitch only hits 0 once its section clears
		// transitionRelease; landing exactly on the boundary parks on the peak
		const settle  = Math.min(1, cr  + (config.transitionRelease + 0.06) * (1 - cr));
		const settle2 = Math.min(1, s3r + (config.transitionRelease + 0.06) * (1 - s3r));
		const max = document.documentElement.scrollHeight - window.innerHeight;
		if (scrollProgress >= sr && scrollProgress < settle - 0.005) {
			autoScrollTo(settle * max);
		} else if (scrollProgress >= o2r && scrollProgress < settle2 - 0.005) {
			autoScrollTo(settle2 * max);
		}
	}
	function scheduleIdleCheck() {
		clearTimeout(scrollIdleTimer);
		scrollIdleTimer = setTimeout(maybeAutoAdvance, IDLE_MS);
	}

	window.addEventListener("scroll", () => {
		readScroll();
		// programmatic (auto) scrolls fire 'scroll' too — don't let them reschedule
		if (!autoScrolling && !reducedMotion) scheduleIdleCheck();
	}, { passive: true });

	if (!reducedMotion) {
		// real user input cancels an in-flight glide (and defers the next check)
		const onIntent = () => { cancelAutoScroll(); scheduleIdleCheck(); };
		window.addEventListener("wheel", onIntent, { passive: true });
		window.addEventListener("touchstart", onIntent, { passive: true });
		window.addEventListener("keydown", (e) => {
			if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"].includes(e.key)) onIntent();
		});
	}

	let rafId = null;
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) {
			if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
		} else if (rafId === null) {
			lastElapsed = clock.getElapsedTime();
			rafId = requestAnimationFrame(tick);
		}
	});

	let _lastW = window.innerWidth;
	window.addEventListener("resize", () => {
		const w = window.innerWidth;
		if (isMobile && w === _lastW) return;
		_lastW = w;
		const h = window.innerHeight;
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		renderer.setPixelRatio(fitPixelRatio());
		renderer.setSize(w, h);
		composer.setSize(w, h);
		bloomPass.setSize(w, h);
		otherRT.setSize(w, h);
		gradePass.uniforms.uAspect.value = w / h;
		glassMeshes.forEach((g) => g.fbo.setSize(Math.round(w * fboScale), Math.round(h * fboScale)));
		cards.forEach((c) => { if (c.glassFbo) c.glassFbo.setSize(Math.round(w * cardFboScale), Math.round(h * cardFboScale)); });
		particles.mat.uniforms.u_size.value = config.particleSize * renderer.getPixelRatio();
		readScroll();
	});

	window.addEventListener("pointermove", (e) => {
		pointer.tx = (e.clientX / window.innerWidth) * 2 - 1;
		pointer.ty = -((e.clientY / window.innerHeight) * 2 - 1);
		hoverPointer.x = e.clientX; hoverPointer.y = e.clientY; hoverPointer.active = true;
	}, { passive: true });
	// touch has no "hover": drop the glow when the finger lifts. Mouse re-activates
	// on the next move, so deactivating it on click/leave is harmless.
	window.addEventListener("pointerup", (e) => { if (e.pointerType !== "mouse") hoverPointer.active = false; }, { passive: true });
	window.addEventListener("pointercancel", () => { hoverPointer.active = false; }, { passive: true });
	window.addEventListener("blur", () => { hoverPointer.active = false; });

	document.getElementById("upload").addEventListener("change", (e) => {
		loadGroundFile(e.target.files[0]);
	});
	window.addEventListener("dragover", (e) => e.preventDefault());
	window.addEventListener("drop", (e) => {
		e.preventDefault();
		loadGroundFile(e.dataTransfer.files[0]);
	});

	// --- control panel wiring ----------------------------------------
	const panel = document.getElementById("panel");
	document.getElementById("panelToggle").addEventListener("click", () => {
		panel.classList.toggle("collapsed");
	});

	document.getElementById("replayBtn").addEventListener("click", () => resetToGate());


	const copyBtn = document.getElementById("copyBtn");
	copyBtn.addEventListener("click", () => {
		const text = "{\n" +
			Object.entries(config).map(([k, v]) => `\t${k}: ${v},`).join("\n") +
			"\n}";
		navigator.clipboard.writeText(text).then(() => {
			copyBtn.textContent = "Copied!";
			setTimeout(() => (copyBtn.textContent = "Copy settings"), 1200);
		}).catch(() => {
			copyBtn.textContent = "Copy failed";
			setTimeout(() => (copyBtn.textContent = "Copy settings"), 1200);
		});
	});

	function bindSlider(id, valId, onChange, fmt) {
		const slider = document.getElementById(id);
		const valEl = document.getElementById(valId);
		slider.addEventListener("input", () => {
			const v = parseFloat(slider.value);
			valEl.textContent = fmt(v);
			onChange(v);
		});
	}

	bindSlider("s-introdur", "v-introdur", (v) => { config.introScale = v; }, (v) => (CROSSFADE_MS * v / 1000).toFixed(1) + "s");
	bindSlider("s-gaterad", "v-gaterad", (v) => { config.enterRadius = v; }, (v) => v.toFixed(2));
	bindSlider("s-gatedim", "v-gatedim", (v) => { config.enterDim = v; }, (v) => v.toFixed(2));
	bindSlider("s-sceneease", "v-sceneease", (v) => { config.sceneEase = v; }, (v) => v.toFixed(2));
	bindSlider("s-dimease", "v-dimease", (v) => { config.dimEase = v; }, (v) => v.toFixed(2));
	bindSlider("s-dissolvelen", "v-dissolvelen", (v) => { config.dissolveLen = v; }, (v) => v.toFixed(2));
	bindSlider("s-introdens", "v-introdens", (v) => { config.introDensity = v; }, (v) => v.toFixed(1) + "×");
	bindSlider("s-scenedet", "v-scenedet", (v) => { config.sceneDetail = v; }, (v) => v.toFixed(1) + "×");
	bindSlider("s-hoverint", "v-hoverint", (v) => { config.hoverIntensity = v; }, (v) => v.toFixed(2));
	bindSlider("s-hoverrad", "v-hoverrad", (v) => { config.hoverRadius = v; }, (v) => v.toFixed(2));
	bindSlider("s-hoverdot", "v-hoverdot", (v) => { config.hoverDotSize = v; hoverDotMat.uniforms.u_size.value = v * renderer.getPixelRatio(); }, (v) => v.toFixed(1));
	bindSlider("s-schoverint", "v-schoverint", (v) => { config.scHoverIntensity = v; }, (v) => v.toFixed(2));
	bindSlider("s-schoverrad", "v-schoverrad", (v) => { config.scHoverRadius = v; }, (v) => v.toFixed(2));
	bindSlider("s-scedgebright", "v-scedgebright", (v) => { config.scEdgeBrightness = v; }, (v) => v.toFixed(2) + "×");
	bindSlider("s-scedgerad", "v-scedgerad", (v) => { config.scEdgeRadius = v; }, (v) => v.toFixed(2));
	bindSlider("s-schoverdot", "v-schoverdot", (v) => {
		config.scHoverDotSize = v;
		hoverCardMat.uniforms.u_size.value = v * renderer.getPixelRatio();
		hoverCardEdgeMat.uniforms.u_size.value = v * renderer.getPixelRatio();
	}, (v) => v.toFixed(1));
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
	bindSlider("s-s3skyangle", "v-s3skyangle", (v) => { config.s3SkyAngle = v; }, (v) => Math.round(v) + "°");
	bindSlider("s-count", "v-count", (v) => { config.particleCount = Math.round(v); rebuildParticles(); }, (v) => String(Math.round(v)));
	bindSlider("s-glow", "v-glow", (v) => { config.glowSpeed = v; }, (v) => v.toFixed(2) + "×");
	bindSlider("s-size", "v-size", (v) => { config.particleSize = v; particles.mat.uniforms.u_size.value = v * renderer.getPixelRatio(); }, (v) => String(Math.round(v)));
	bindSlider("s-scale", "v-scale", (v) => { config.modelScale = v; applyModelScale(); }, (v) => v.toFixed(1));
	bindSlider("s-mx", "v-mx", (v) => { config.modelX = v; applyModelPos(); }, (v) => v.toFixed(1));
	bindSlider("s-my", "v-my", (v) => { config.modelY = v; applyModelPos(); }, (v) => v.toFixed(1));
	bindSlider("s-mz", "v-mz", (v) => { config.modelZ = v; applyModelPos(); }, (v) => v.toFixed(1));
	bindSlider("s-cam", "v-cam", (v) => { config.cameraDist = v; }, (v) => v.toFixed(1));
	bindSlider("s-depth", "v-depth", (v) => { config.depthScale = v; applyModelScale(); }, (v) => v.toFixed(2));
	bindSlider("s-ltrans", "v-ltrans", (v) => { config.logoTransmission = v; glassMeshes.forEach(({ mat }) => { mat.transmission = v; mat._transmission = v; }); }, (v) => v.toFixed(2));
	bindSlider("s-lrough", "v-lrough", (v) => { config.logoRoughness = v; glassMeshes.forEach(({ mat }) => { mat.roughness = v; }); }, (v) => v.toFixed(2));
	bindSlider("s-lmetal", "v-lmetal", (v) => { config.logoMetalness = v; glassMeshes.forEach(({ mat }) => { mat.metalness = v; }); }, (v) => v.toFixed(2));
	bindSlider("s-lior", "v-lior", (v) => { config.logoIOR = v; glassMeshes.forEach(({ mat }) => { mat.ior = v; }); }, (v) => v.toFixed(2));
	bindSlider("s-lthick", "v-lthick", (v) => { config.logoThickness = v; glassMeshes.forEach(({ mat }) => { mat.thickness = v; }); }, (v) => v.toFixed(2));
	bindSlider("s-lchroma", "v-lchroma", (v) => { config.logoChroma = v; glassMeshes.forEach(({ mat }) => { mat.chromaticAberration = v; }); }, (v) => v.toFixed(3));
	bindSlider("s-laniso", "v-laniso", (v) => { config.logoAnisotropy = v; glassMeshes.forEach(({ mat }) => { mat.anisotropicBlur = v; }); }, (v) => v.toFixed(2));
	bindSlider("s-lcc", "v-lcc", (v) => { config.logoClearcoat = v; glassMeshes.forEach(({ mat }) => { mat.clearcoat = v; }); }, (v) => v.toFixed(2));
	bindSlider("s-lccr", "v-lccr", (v) => { config.logoClearcoatRough = v; glassMeshes.forEach(({ mat }) => { mat.clearcoatRoughness = v; }); }, (v) => v.toFixed(2));
	bindSlider("s-lenv", "v-lenv", (v) => { config.logoEnvIntensity = v; glassMeshes.forEach(({ mat }) => { mat.envMapIntensity = v; }); }, (v) => v.toFixed(2));
	bindSlider("s-latt", "v-latt", (v) => { config.logoAttenuationDist = v; glassMeshes.forEach(({ mat }) => { mat.attenuationDistance = v; }); }, (v) => v.toFixed(1));
	bindSlider("s-netnodes", "v-netnodes", (v) => { config.netDensity = v; rebuildGlassNets(); }, (v) => v.toFixed(2) + "×");
	bindSlider("s-netsize", "v-netsize", (v) => { config.netSize = v; }, (v) => String(Math.round(v)));
	bindSlider("s-wavespeed", "v-wavespeed", (v) => { config.waveSpeed = v; }, (v) => v.toFixed(2));
	bindSlider("s-wavelife", "v-wavelife", (v) => { config.waveLife = v; }, (v) => v.toFixed(3));
	bindSlider("s-wavestr", "v-wavestr", (v) => { config.waveStrength = v; }, (v) => v.toFixed(2));
	bindSlider("s-hoverfade", "v-hoverfade", (v) => { config.hoverFade = v; }, (v) => v > 0 ? v.toFixed(1) + "s" : "off");
	bindSlider("s-splash", "v-splash", (v) => { config.splashSize = v; }, (v) => v.toFixed(1));
	bindSlider("s-settle", "v-settle", (v) => { config.settleRate = v; }, (v) => v.toFixed(2));
	bindSlider("s-glowgain", "v-glowgain", (v) => { config.glowGain = v; }, (v) => v.toFixed(1));
	bindSlider("s-wavemove", "v-wavemove", (v) => { config.waveMotion = v; }, (v) => v.toFixed(2));
	bindSlider("s-rot", "v-rot", (v) => { config.rotationTurns = v; }, (v) => v.toFixed(1));
	bindSlider("s-gx", "v-gx", (v) => { config.groundX = v; applyGround(); }, (v) => v.toFixed(1));
	bindSlider("s-gy", "v-gy", (v) => { config.groundY = v; applyGround(); }, (v) => v.toFixed(1));
	bindSlider("s-gz", "v-gz", (v) => { config.groundZ = v; applyGround(); }, (v) => v.toFixed(1));
	bindSlider("s-gscale", "v-gscale", (v) => { config.groundScale = v; applyGround(); }, (v) => v.toFixed(2));
	bindSlider("s-gturns", "v-gturns", (v) => { config.groundTurns = v; }, (v) => v.toFixed(1));
	bindSlider("s-sky", "v-sky", (v) => { config.skyTurns = v; }, (v) => v.toFixed(1));
	bindSlider("s-skyangle", "v-skyangle", (v) => { config.skyAngle = v * Math.PI / 180; }, (v) => Math.round(v) + "°");
	bindSlider("s-skydrift", "v-skydrift", (v) => { config.skyDrift = v; }, (v) => v.toFixed(2));
	bindSlider("s-haze", "v-haze", (v) => { config.haze = v; hazeMat.opacity = v; }, (v) => v.toFixed(2));
	bindSlider("s-bloom", "v-bloom", (v) => { config.bloom = v; }, (v) => v.toFixed(2));
	bindSlider("s-chroma", "v-chroma", (v) => { config.chroma = v; }, (v) => v.toFixed(3));
	bindSlider("s-grain", "v-grain", (v) => { config.grain = v; }, (v) => v.toFixed(2));
	bindSlider("s-outro", "v-outro", (v) => { config.outroSpeed = v; }, (v) => v.toFixed(2));
	bindSlider("s-outrostart", "v-outrostart", (v) => { config.outroStart = v; }, (v) => Math.round(v) + "vh");
	bindSlider("s-track", "v-track", (v) => { config.trackHeight = v; document.querySelector(".scroll-track").style.height = v + "vh"; }, (v) => Math.round(v) + "vh");
	bindSlider("s-transchroma", "v-transchroma", (v) => { config.transitionChroma = v; }, (v) => v.toFixed(2));
	bindSlider("s-transstreak", "v-transstreak", (v) => { config.transitionStreak = v; }, (v) => v.toFixed(2));
	bindSlider("s-wipejitter", "v-wipejitter", (v) => { config.wipeJitter = v; }, (v) => v.toFixed(2));
	bindSlider("s-wipesoft", "v-wipesoft", (v) => { config.wipeSoftness = v; }, (v) => v.toFixed(3));
	bindSlider("s-wipenoise", "v-wipenoise", (v) => { config.wipeNoiseScale = v; }, (v) => v.toFixed(2));
	bindSlider("s-wipeflicker", "v-wipeflicker", (v) => { config.wipeFlickerSpeed = v; }, (v) => v.toFixed(2));
	bindSlider("s-wipewave", "v-wipewave", (v) => { config.wipeWaveAmp = v; }, (v) => v.toFixed(3));
	bindSlider("s-wavetilt", "v-wavetilt", (v) => { config.wipeWaveTilt = v; }, (v) => v.toFixed(2));
	bindSlider("s-transrelease", "v-transrelease", (v) => { config.transitionRelease = v; }, (v) => v.toFixed(2));
	bindSlider("s-vigouter", "v-vigouter", (v) => { config.vignetteOuter = v; }, (v) => v.toFixed(2));
	bindSlider("s-viginner", "v-viginner", (v) => { config.vignetteInner = v; }, (v) => v.toFixed(2));
	bindSlider("s-showstart", "v-showstart", (v) => { config.showcaseStart = v; }, (v) => Math.round(v) + "vh");
	bindSlider("s-showrad", "v-showrad", (v) => { config.showcaseRadius = v; }, (v) => v.toFixed(1));
	bindSlider("s-showpitch", "v-showpitch", (v) => { config.showcasePitch = v; }, (v) => v.toFixed(1));
	bindSlider("s-colturns", "v-colturns", (v) => { config.columnTurns = v; }, (v) => v.toFixed(2));
	bindSlider("s-colwidth", "v-colwidth", (v) => { config.columnScale = v; buildColumn(); }, (v) => v.toFixed(2));
	bindSlider("s-coly", "v-coly", (v) => { config.columnY = v; }, (v) => v.toFixed(1));
	bindSlider("s-coltiltx", "v-coltiltx", (v) => { config.columnTiltX = v; buildColumn(); }, (v) => v.toFixed(1) + "°");
	bindSlider("s-coltiltz", "v-coltiltz", (v) => { config.columnTiltZ = v; buildColumn(); }, (v) => v.toFixed(1) + "°");
	bindSlider("s-carddepth", "v-carddepth", (v) => { config.cardDepth = v; }, (v) => v.toFixed(1));
	bindSlider("s-cardsize", "v-cardsize", (v) => { config.cardScale = v; }, (v) => v.toFixed(2));
	bindSlider("s-cardarc", "v-cardarc", (v) => { config.cardArc = v; }, (v) => v.toFixed(2));
	bindSlider("s-cardstart", "v-cardstart", (v) => { config.cardStart = v; }, (v) => v.toFixed(2));
	// card thickness slider removed (card is now flat) — keep the config + handler
	// guarded in case the element was re-added later
	{
		const thickSlider = document.getElementById("s-cardthick");
		if (thickSlider) bindSlider("s-cardthick", "v-cardthick", (v) => { config.cardThickness = v; applyCardThickness(); }, (v) => v.toFixed(2));
	}
	bindSlider("s-cardglassgap", "v-cardglassgap", (v) => {
		config.cardGlassGap = v;
		cards.forEach((c) => { if (c.glassMat) c.glassMesh.position.z = -v; });
	}, (v) => v.toFixed(2));
	bindSlider("s-cardglassscale", "v-cardglassscale", (v) => {
		config.cardGlassScale = v;
		cards.forEach((c) => { if (c.glassMat) c.glassMesh.scale.setScalar(v); });
	}, (v) => v.toFixed(2));
	bindSlider("s-cardglassthick", "v-cardglassthick", (v) => {
		config.cardGlassThickness = v;
		applyGlassSlab();
	}, (v) => v.toFixed(2));
	bindSlider("s-textdepth", "v-textdepth", (v) => { config.textDepth = v; }, (v) => v.toFixed(2));
	bindSlider("s-skyglowx", "v-skyglowx", (v) => { config.skyGlowX = v; }, (v) => v.toFixed(2));   // aligns the column light to the sun
	bindSlider("s-glowspin", "v-glowspin", (v) => { config.glowSpin = v; }, (v) => v.toFixed(1));
	bindSlider("s-skyspeed", "v-skyspeed", (v) => { config.skySpeed = v; }, (v) => v.toFixed(2));
	bindSlider("s-secpart", "v-secpart", (v) => { config.sectionParticles = Math.round(v); buildSectionDust(); }, (v) => String(Math.round(v)));

	setupGyro();
	readScroll();
	tick();
})();
