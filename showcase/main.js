import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
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
	let fpsFrames = 0, fpsLast = 0;   // rolling FPS counter

	// --- preloader: gate on the hero (logo/ground) + showcase (column) models,
	// plus the webfont, so nothing pops in after the loader fades. A hard
	// timeout guards against a stalled/failed asset trapping the user.
	let preloaderHidden = false;
	const PRELOAD_MIN_MS = 2000;   // keep the wordmark on screen at least this long, even on a cache-hit reload
	const REVEAL_MS = 1300;        // iris-reveal duration; also drives the opacity-fallback transition (see tick())
	const preloadStart = performance.now();
	const preloadState = { logo: false, ground: false, column: false, fonts: false };
	let revealStart = null;        // performance.now() timestamp when the reveal began; null = idle/done
	function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }

	// --- intro sequence: a particle-traced version of the scene that plays
	// under the iris, then crossfades into the final rendered scene. Driven
	// by tick(), not a separate rAF loop (see updateIntroSequence()).
	const WIREFRAME_HOLD_MS = 900;   // how long the particle scene sits before crossfading
	const CROSSFADE_MS = 900;        // particle fade-out + real-mesh pop-in + bloom ease-down
	const BLOOM_BOOST = 0.9;         // bloom strength while the particles are glowing (config.bloom is normally 0.15)
	let introStart = null;           // performance.now() timestamp when hidePreloader() fired; null = not started
	let introBloomStrength = null;   // non-null overrides bloomPass.strength for the intro; null = use config.bloom
	let crossfadeStarted = false;
	let introDone = false;
	// shared amber shader material for every particle stand-in — same soft-dot
	// falloff + colorA/colorB mix as the hero's ambient particle field
	// (buildParticles()), without its twinkle/glint motion since these sit
	// still tracing the model rather than drifting like ambient dust.
	// u_size gets pixel-ratio-scaled once renderer exists (see enterWireframePhase()).
	const wireframeParticleMat = new THREE.ShaderMaterial({
		transparent: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
		uniforms: {
			u_size: { value: 5.5 },
			u_opacity: { value: 1 },
			// brighter than the ambient dust's colorA/colorB range (0x6a4420..0xffd49a)
			// on purpose — that dark end reads at nearly the same luminance as this
			// scene's warm amber background/environment and disappears against it
			u_colorA: { value: new THREE.Color(0xffb347) },
			u_colorB: { value: new THREE.Color(0xfff2d9) }
		},
		vertexShader: `
			uniform float u_size;
			attribute float aSeed;
			varying float vSeed;
			void main() {
				vSeed = aSeed;
				vec4 mv = modelViewMatrix * vec4(position, 1.0);
				gl_Position = projectionMatrix * mv;
				gl_PointSize = u_size / max(1.0, -mv.z);
			}
		`,
		fragmentShader: `
			uniform vec3 u_colorA;
			uniform vec3 u_colorB;
			uniform float u_opacity;
			varying float vSeed;
			void main() {
				vec2 uv = gl_PointCoord - 0.5;
				float d = dot(uv, uv);
				float soft = exp(-d * 8.0);
				float core = exp(-d * 40.0);
				if (soft < 0.02 && core < 0.02) discard;
				vec3 col = mix(u_colorA, u_colorB, vSeed);
				float a = soft * 0.7 + core * 1.4;
				gl_FragColor = vec4(col, a * u_opacity);
			}
		`
	});
	const wireframePairs = [];   // { mesh, points } — real meshes hidden + their particle stand-in
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

	function makeWireframePoints(mesh, refDiag) {
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
		const edges = new THREE.EdgesGeometry(mesh.geometry, 20);
		const src = edges.attributes.position;   // consecutive pairs: [a0,b0, a1,b1, ...]
		const spacing = refDiag * WIREFRAME_DOT_SPACING_FRACTION;
		const jitterRadius = spacing * 0.35;   // subtle — dots scatter loosely around the edge, not plotted exactly on it
		const coords = [];
		const seeds = [];
		const a = new THREE.Vector3(), b = new THREE.Vector3();
		const dir = new THREE.Vector3(), ref = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3();
		for (let i = 0; i < src.count; i += 2) {
			a.fromBufferAttribute(src, i);
			b.fromBufferAttribute(src, i + 1);
			const edgeLen = a.distanceTo(b);
			if (edgeLen < 1e-6) continue;   // degenerate zero-length edge — normalize() below would divide by zero into NaN
			const steps = Math.max(1, Math.round(edgeLen / spacing));
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
				const t = THREE.MathUtils.clamp((s + (Math.random() - 0.5) * 0.6) / steps, 0, 1);
				const angle = Math.random() * Math.PI * 2;
				const r = Math.random() * jitterRadius;
				coords.push(
					a.x + (b.x - a.x) * t + (u.x * Math.cos(angle) + v.x * Math.sin(angle)) * r,
					a.y + (b.y - a.y) * t + (u.y * Math.cos(angle) + v.y * Math.sin(angle)) * r,
					a.z + (b.z - a.z) * t + (u.z * Math.cos(angle) + v.z * Math.sin(angle)) * r
				);
				seeds.push(Math.random());
			}
		}
		edges.dispose();   // only used to derive the dot coordinates above, never rendered itself
		const geo = new THREE.BufferGeometry();
		geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(coords), 3));
		geo.setAttribute("aSeed", new THREE.BufferAttribute(new Float32Array(seeds), 1));
		const points = new THREE.Points(geo, wireframeParticleMat);
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
		wireframeParticleMat.uniforms.u_size.value = 3.0 * renderer.getPixelRatio();
		for (const g of glassMeshes) wireframePairs.push({ mesh: g.mesh, points: makeWireframePoints(g.mesh, coreMaxDim) });
		if (groundObj) {
			groundObj.traverse((o) => {
				if (o.isMesh) wireframePairs.push({ mesh: o, points: makeWireframePoints(o, groundMaxDim) });
			});
		}
		introBloomStrength = BLOOM_BOOST;
	}

	function finishIntroSequence() {
		introDone = true;
		introBloomStrength = null;
		for (const { mesh, points } of wireframePairs) {
			mesh.parent.remove(points);
			points.geometry.dispose();
		}
		wireframeParticleMat.dispose();
		wireframePairs.length = 0;
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
		wireframeParticleMat.uniforms.u_opacity.value = 1 - e;
		if (elapsed >= crossfadeEnd) finishIntroSequence();
	}

	// --- scroll state -------------------------------------------------
	let scrollProgress = 0;     // 0..1 raw from scrollbar
	let easedProgress = 0;      // smoothed, drives rotation (uncapped — continues past 500vh)
	let easedScene = 0;         // smoothed 0..1, drives camera dolly only (capped at 500vh)
	let easedOutro = 0;         // smoothed 0..1 for the extra 20vh outro
	let easedShowcase = 0;      // smoothed 0..1 for the dark showcase carousel phase
	// SCENE_RATIO is computed dynamically from config.outroStart in the tick loop
	const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

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
		particleCount: 800,
		particleSize: 15,       // base point size in px
		glowSpeed: 0.3,         // flake flutter + glint speed multiplier
		modelScale: 1.5,        // target size of the model
		modelX: 0,              // glass logo position offset (x)
		modelY: 0.3,            // glass logo position offset (y)
		modelZ: 0,              // glass logo position offset (z)
		depthScale: 1,          // Z-depth multiplier: 1.0 = true scene.glb depth, <1 = slimmer slabs (art override)
		logoTransmission: 1,    // 1 = pure glass, 0 = fully opaque solid
		logoRoughness: 0.05,    // surface roughness (0 = mirror, 1 = matte)
		logoMetalness: 0,       // metallic amount
		logoIOR: 1.8,           // index of refraction
		logoThickness: 0.7,     // optical depth (affects color shift inside glass)
		logoChroma: 0.07,       // per-material chromatic aberration inside glass
		logoAnisotropy: 0,      // anisotropic blur on refracted background
		logoClearcoat: 1,       // clearcoat layer intensity
		logoClearcoatRough: 0,  // clearcoat roughness
		logoEnvIntensity: 1.6,  // environment map reflection intensity
		logoAttenuationDist: 10,// distance over which attenuationColor tints the glass
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
		outroSpeed: 0.10,       // easing speed of the fade-to-black (higher = snappier)
		outroStart: 545,        // vh position where the right-to-left fade begins
		trackHeight: 1400,      // total scroll track height in vh
		outroDim: 0.5,          // max uniform full-screen darkening behind the sweep (0 = off, 1 = full black)
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
		skyGlowX: 0.5,          // aligns the column's key light to the sun in the sky
		glowSpin: 2.5,          // how fast the sky glow sweeps relative to the column spin
		skySpeed: 0             // continuous sky drift over time (radians/sec) — the column is lit from the sun so its bright side follows
	};
	if (window.__TRIAL__) {
		config.logoChroma = 0.12;      // #3: more prism dispersion at glass edges
		config.logoAnisotropy = 0.12;  // #5: a touch of anisotropic highlight streak
	}
	let flakeTime = 0;          // accumulated time scaled by glowSpeed

	function readScroll() {
		const max = document.documentElement.scrollHeight - window.innerHeight;
		scrollProgress = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
	}

	// --- renderer / scene --------------------------------------------
	const isMobile = matchMedia("(pointer: coarse)").matches || window.innerWidth < 768;
	if (isMobile) {
		// narrow portrait screens have far less horizontal FOV, so the column
		// reads as too zoomed-in at desktop scale — shrink it to fit comfortably
		config.columnScale *= 0.5;
		config.cardScale *= 0.625;
		config.columnY = 0;
	}
	const fboScale = isMobile ? 0.5 : 1;

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
	const hazeMat = new THREE.MeshBasicMaterial({
		map: makeHazeTexture(),
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
		return m;
	}

	const glassMeshes = [];
	const discard = new DiscardMaterial();

	function addSlab(geo) {
		const mat = makeGlass();
		const mesh = new THREE.Mesh(geo, mat);
		const fbo = new THREE.WebGLRenderTarget(Math.round(window.innerWidth * fboScale), Math.round(initH * fboScale), { type: THREE.HalfFloatType });
		mat.buffer = fbo.texture;
		core.add(mesh);
		glassMeshes.push({ mesh, mat, fbo });
	}

	function clearSlabs() {
		for (const g of glassMeshes) {
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
		modelReady = true;
		markLoaded("logo");
	}

	function addFallback() {
		clearSlabs();
		addSlab(new THREE.TorusKnotGeometry(1, 0.34, 180, 32));
		frameCore();
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

	function roundedRectGeo(w, h, r) {
		const s = new THREE.Shape();
		const x = -w / 2, y = -h / 2;
		s.moveTo(x + r, y);
		s.lineTo(x + w - r, y);           s.quadraticCurveTo(x + w, y, x + w, y + r);
		s.lineTo(x + w, y + h - r);       s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
		s.lineTo(x + r, y + h);           s.quadraticCurveTo(x, y + h, x, y + h - r);
		s.lineTo(x, y + r);               s.quadraticCurveTo(x, y, x + r, y);
		const g = new THREE.ShapeGeometry(s, 12);
		// remap UVs from shape space to 0..1 so the canvas texture fills the card
		const uv = g.attributes.uv;
		for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) - x) / w, (uv.getY(i) - y) / h);
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
	const cardGeo = roundedRectGeo(3.4, 2.1, 0.18);
	const textGeo = new THREE.PlaneGeometry(3.4, 2.1);   // title layer, floats in front of the card

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

	function buildShowcase() {
		projects.forEach((p, i) => {
			// FrontSide: cards on the far side of the ring face away and cull out,
			// so you never see mirrored title text through their backs
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
			cards.push({ mesh, mat, textMat, textMesh, helixY: 0, focusT: 0, baseAngle: 0 });
			showcaseGroup.add(mesh);
		});
		layoutCards();
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
			transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
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
	function pickCard(clientX, clientY) {
		raycaster.setFromCamera(new THREE.Vector2(
			(clientX / window.innerWidth) * 2 - 1,
			-(clientY / window.innerHeight) * 2 + 1
		), camera);
		const hit = raycaster.intersectObjects(cards.map((c) => c.mesh))[0];
		return hit && cards.find((c) => c.mesh === hit.object);
	}
	canvas.addEventListener("click", (e) => {
		if (!showcaseGroup.visible) return;
		const card = pickCard(e.clientX, e.clientY);
		focusedCard = (card && card !== focusedCard) ? card : null;
	});

	const _ringPos = new THREE.Vector3(), _ringQuat = new THREE.Quaternion();
	const _proj = new THREE.Vector3();
	const _focusPos = new THREE.Vector3(), _focusQuat = new THREE.Quaternion();
	function updateShowcase(dt) {
		// helix: cards step down by showcasePitch each; the whole group rises so the
		// current card stays at eye level — incoming cards enter from the bottom
		// right and exit upper left, like page content moving up as you scroll.
		// t is a virtual card index; it starts at -lead so the first card travels
		// in from the bottom-right entry lane while it fades, instead of
		// materializing already centered.
		const appear = Math.min(1, easedShowcase / 0.2);
		const lead = 1;
		const t = easedShowcase * (cards.length - 1 + lead) - lead;
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
		columnGroup.rotation.y = easedShowcase * Math.PI * 2 * config.columnTurns;
		camera.updateMatrixWorld();   // so card→screen projection below is current
		cards.forEach((c, i) => {
			c.helixY = -i * config.showcasePitch;
			const baseAngle = i * arcStep;   // spread scales the per-card angle live
			c.focusT += ((c === focusedCard ? 1 : 0) - c.focusT) * Math.min(1, dt * 6);
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
			uAspect: { value: window.innerWidth / initH }
		},
		vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
		fragmentShader: `
			uniform sampler2D tDiffuse;
			uniform float uTime, uGrain, uChroma, uAspect;
			varying vec2 vUv;
			float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
			void main(){
				vec2 uv = vUv;
				vec2 d = uv - 0.5;
				float r2 = dot(d, d);
				vec2 off = d * r2 * uChroma;
				vec3 col;
				col.r = texture2D(tDiffuse, uv + off).r;
				col.g = texture2D(tDiffuse, uv).g;
				col.b = texture2D(tDiffuse, uv - off).b;
				col *= smoothstep(1.15, 0.35, length(d * vec2(uAspect, 1.0)));
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
		easedProgress  += (rotProgress      - easedProgress)  * 0.08;
		easedScene     += (sceneProgress    - easedScene)     * 0.08;
		// the veil and showcase ease out faster than in, so scrolling back up
		// reveals the hero without a long black dwell
		easedOutro     += (outroProgress    - easedOutro)     * (outroProgress    < easedOutro    ? Math.max(config.outroSpeed, 0.2) : config.outroSpeed);
		easedShowcase  += (showcaseProgress - easedShowcase)  * (showcaseProgress < easedShowcase ? 0.2 : 0.08);
		// while the veil is in showcase mode, keep the sweep pinned shut so that
		// scrolling back up hands off through solid black instead of popping
		if (easedShowcase > 0.001) easedOutro = 1;

		if (gyro.enabled && gyro.hasReading) {
			gyro.x += (gyro.tx - gyro.x) * GYRO_SMOOTH;
			gyro.y += (gyro.ty - gyro.y) * GYRO_SMOOTH;
			pointer.tx = gyro.x;
			pointer.ty = gyro.y;
		}
		pointer.x += (pointer.tx - pointer.x) * 0.05;
		pointer.y += (pointer.ty - pointer.y) * 0.05;

		if (modelReady) {
			core.rotation.y = easedProgress * Math.PI * config.rotationTurns + pointer.x * 0.4;
			core.rotation.x = -pointer.y * 0.25;
		}

		if (groundReady) {
			groundPivot.rotation.y = easedProgress * Math.PI * config.groundTurns;
		}

		// outro veil: constant-width soft band sweeps right → left + uniform dim
		if (easedShowcase > 0.001 || showcaseProgress > 0) {
			// showcase phase: veil lifts off the black to reveal the carousel
			const a = Math.max(0, 1 - easedShowcase / 0.15);
			document.getElementById("outro-veil").style.background =
				a > 0.001 ? `rgba(0,0,0,${a.toFixed(3)})` : "transparent";
		} else if (outroProgress > 0) {
			const d = easedOutro;
			const soft = 0.5;
			const lead = (1 - d) * (1 + soft) - soft;
			const at = (p) => ((lead + soft * p) * 100).toFixed(1);
			const full = (d * config.outroDim).toFixed(3);
			document.getElementById("outro-veil").style.background =
				`linear-gradient(to right,
					rgba(0,0,0,0)    ${at(0)}%,
					rgba(0,0,0,0.15) ${at(0.25)}%,
					rgba(0,0,0,0.5)  ${at(0.5)}%,
					rgba(0,0,0,0.85) ${at(0.75)}%,
					rgba(0,0,0,1)    ${at(1)}%),
				linear-gradient(rgba(0,0,0,${full}), rgba(0,0,0,${full}))`;
		} else {
			document.getElementById("outro-veil").style.background = "transparent";
		}

		scene.backgroundRotation.y =
			config.skyAngle + easedProgress * Math.PI * config.skyTurns + t * config.skyDrift - pointer.x * 0.15;
		scene.environmentRotation.y = scene.backgroundRotation.y;

		particles.points.rotation.y = -easedProgress * Math.PI * 1.5 - t * 0.02;
		particles.mat.uniforms.u_time.value = flakeTime;

		const baseZ = config.cameraDist - easedScene * 2.2 + easedOutro * 2.2;
		camera.position.z = baseZ;
		camera.position.x = -pointer.x * 0.6;
		camera.position.y = 0.3 - pointer.y * 0.4;
		camera.lookAt(0, 0, 0);

		mistLayers.forEach((m) => {
			m.position.x = m.userData.baseX + Math.sin(t * 0.05 + m.userData.seed) * 2.0;
			m.material.opacity = 0.045 + 0.03 * (0.5 + 0.5 * Math.sin(t * 0.2 + m.userData.seed));
		});

		gradePass.uniforms.uGrain.value = config.grain;
		gradePass.uniforms.uChroma.value = config.chroma;
		gradePass.uniforms.uTime.value = t;
		bloomPass.strength = introBloomStrength !== null ? introBloomStrength : config.bloom;
		bloomPass.enabled = config.bloom > 0;

		// phase switch: dark showcase vs. the original scene
		const showcaseActive = easedShowcase > 0.001 || showcaseProgress > 0;
		document.querySelector(".headline").style.opacity = showcaseActive ? "0" : "1";
		showcaseGroup.visible = columnGroup.visible = sectionDust.points.visible = showcaseActive;
		core.visible = groundPivot.visible = particles.points.visible =
			haze.visible = mistGroup.visible = !showcaseActive;
		if (showcaseActive) {
			scene.background = equirect;   // keep the hero's rich sky in the showcase too
			// sweeps with the column spin (amplified) plus a continuous drift
			scene.backgroundRotation.y = columnGroup.rotation.y * config.glowSpin + t * config.skySpeed;
			scene.environmentRotation.y = scene.backgroundRotation.y;   // reflections track the sky
			// light the column FROM the sun so its bright side tracks the glow
			const sunAz = scene.backgroundRotation.y + config.skyGlowX * Math.PI * 2;
			keyLight.position.set(Math.sin(sunAz) * keyLightDist, keyLightBase.y, Math.cos(sunAz) * keyLightDist);
			updateShowcase(dt);
			const appear = Math.min(1, easedShowcase / 0.2);
			sectionDust.mat.uniforms.u_time.value = flakeTime;
			sectionDust.mat.uniforms.u_opacity.value = appear;
			// the dust rotates with the carousel as you scroll (a touch slower for
			// depth parallax) so the field turns with us, plus a gentle idle drift
			sectionDust.points.rotation.y = showcaseGroup.rotation.y * 0.6 + t * 0.02;
		} else {
			keyLight.position.copy(keyLightBase);   // restore the hero's fixed key light
			scene.background = equirect;
		}

		const sceneHidden = easedOutro > 0.995 && !showcaseActive;
		if (!sceneHidden) {
			if (core.visible) {   // glass FBO passes are pointless (and expensive) once the scene is dark
				const oldTone = renderer.toneMapping;
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
			}
			composer.render();
		}

		fpsFrames++;
		if (t - fpsLast >= 0.5) {
			fpsEl.textContent = Math.round(fpsFrames / (t - fpsLast)) + " fps";
			fpsFrames = 0; fpsLast = t;
		}

		rafId = requestAnimationFrame(tick);
	}

	// --- events -------------------------------------------------------
	window.addEventListener("scroll", readScroll, { passive: true });

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
		gradePass.uniforms.uAspect.value = w / h;
		glassMeshes.forEach((g) => g.fbo.setSize(Math.round(w * fboScale), Math.round(h * fboScale)));
		particles.mat.uniforms.u_size.value = config.particleSize * renderer.getPixelRatio();
		readScroll();
	});

	window.addEventListener("pointermove", (e) => {
		pointer.tx = (e.clientX / window.innerWidth) * 2 - 1;
		pointer.ty = -((e.clientY / window.innerHeight) * 2 - 1);
	}, { passive: true });

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
	bindSlider("s-outrodim", "v-outrodim", (v) => { config.outroDim = v; }, (v) => v.toFixed(2));
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
	bindSlider("s-textdepth", "v-textdepth", (v) => { config.textDepth = v; }, (v) => v.toFixed(2));
	bindSlider("s-skyglowx", "v-skyglowx", (v) => { config.skyGlowX = v; }, (v) => v.toFixed(2));   // aligns the column light to the sun
	bindSlider("s-glowspin", "v-glowspin", (v) => { config.glowSpin = v; }, (v) => v.toFixed(1));
	bindSlider("s-skyspeed", "v-skyspeed", (v) => { config.skySpeed = v; }, (v) => v.toFixed(2));
	bindSlider("s-secpart", "v-secpart", (v) => { config.sectionParticles = Math.round(v); buildSectionDust(); }, (v) => String(Math.round(v)));

	setupGyro();
	readScroll();
	tick();
})();
