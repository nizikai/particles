import * as THREE from "three";
import { MeshTransmissionMaterial, DiscardMaterial } from "./MeshTransmissionMaterial.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// Standalone version of showcase4's third section: the dark dust ambience with
// the code-editor terminal (a refracting glass slab carrying the VS Code
// particle skeleton). Page opens straight onto the dust field; scrolling
// rises/tilts the terminal into frame — no preloader, no hero, no carousel.
(() => {
	const canvas = document.getElementById("webgl");
	const fpsEl = document.getElementById("fps");
	const codeSkeletonEl = document.getElementById("codeSkeleton");
	let fpsFrames = 0, fpsLast = 0;   // rolling FPS counter

	// --- live-tunable config (driven by the control panel) ------------
	const config = {
		// section 3 (code editor) — same keys/defaults as showcase4
		s3Depth: 50,            // px the particle skeleton floats in front of the glass slab (the parallax gap)
		s3GlassTilt: 5.2,       // max glass-slab look-at-cursor tilt in degrees
		s3EnterTilt: 65,        // degrees the slab lies back at the start of the scroll (swings up flat as it lands)
		s3EnterRise: 70,        // how far below the frame the slab starts, in % of viewport height (rises up as it lands)
		s3SkyAngle: 280,        // sky heading in degrees — parks the sun/glow
		s3GlassScale: 1.18,     // glass footprint vs the wireframe — >1 so the slab frames it
		s3GlassThickness: 0.1,  // geometric depth of the code slab (real extruded volume)
		s3EdgeBrightness: 3,    // code-slab dotted-perimeter color gain
		s3EdgeRadius: 0.55,     // code-slab dotted-perimeter cursor proximity
		s3DotSize: 7,           // particle-skeleton dot size
		s3DotDetail: 1,         // sampling density multiplier (higher = finer pitch; resamples)
		s3DotJitter: 0.55,      // dot scatter off the sampling grid (0 = crisp grid; resamples)
		s3DotBright: 0.2,       // particle-skeleton color gain
		s3Shimmer: 0,           // per-dot shimmer depth (0 = steady)
		s3LineBright: 0.3,      // hairline-divider dot brightness vs the bars (resamples)

		// edge-dot hover defaults (no sliders — same values showcase4 locked in)
		scHoverIntensity: 1,    // spotlight strength (0 = off)
		scHoverFade: 2,         // dwell seconds before the spotlight dies (0 = never)
		scHoverDotSize: 10,     // spotlight dot size

		// glass material (makeCardGlass reads these — showcase4's locked defaults)
		logoTransmission: 1,
		logoRoughness: 0.1,
		logoMetalness: 0,
		logoIOR: 2,
		logoThickness: 0.7,
		logoChroma: 0.15,
		logoAnisotropy: 0.5,
		logoClearcoat: 1,
		logoClearcoatRough: 0,
		logoEnvIntensity: 1.6,
		logoAttenuationDist: 10,

		sectionParticles: 400,  // ambient dust count (auto-reduced on mobile)
		particleSize: 15,       // dust base point size in px
		glowSpeed: 0.3,         // dust flutter + glint speed multiplier
		cameraDist: 10,         // camera distance
		bloom: 0.15,            // bloom strength
		chroma: 0.012,          // chromatic aberration strength
		grain: 0.01,            // film grain + dither amount
		vignetteOuter: 1.2,     // scene vignette: radius where it's fully dark
		vignetteInner: 0.4      // scene vignette: radius where it's fully clear
	};
	let flakeTime = 0;          // accumulated time scaled by glowSpeed

	// --- scroll state -------------------------------------------------
	// the whole track is the terminal's entrance: the slab rises/tilts in over
	// the first ENTRANCE_END of the scroll (mirrors showcase4's outro2 wipe
	// window), then the skeleton dots materialize over the rest (its easedAmbience)
	const ENTRANCE_END = 0.55;
	let scrollProgress = 0;     // 0..1 raw from scrollbar
	let easedEnter = 0;         // smoothed 0..1 slab entrance (rise + tilt)
	let easedAmbience = 0;      // smoothed 0..1 skeleton materialize phase
	let codeSlab = null;
	const CODE_SLAB_DIST = 6;    // distance in front of the camera the slab floats
	const _codeSlabDir = new THREE.Vector3();
	const _codeSlabUp = new THREE.Vector3();
	const _codeSlabEuler = new THREE.Euler();
	const _codeSlabTilt = new THREE.Quaternion();
	const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
	// hover mode's own smoothed cursor — chases pointer.tx/ty faster than the
	// parallax pointer (0.05) so the particle reaction feels attached to the mouse
	const hoverCursor = { x: 0, y: 0 };

	function readScroll() {
		const max = document.documentElement.scrollHeight - window.innerHeight;
		scrollProgress = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
	}

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

	// --- renderer / scene --------------------------------------------
	const isMobile = matchMedia("(pointer: coarse)").matches || window.innerWidth < 768;
	const cardFboScale = isMobile ? 0.5 : 0.6;   // slab refraction FBO resolution

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
		config.sectionParticles = 200;
		document.getElementById("s-secpart").value = 200;
		document.getElementById("v-secpart").textContent = "200";
	}

	const renderer = new THREE.WebGLRenderer({ canvas, antialias: !isMobile, alpha: false });
	// cap by a backing-store pixel budget instead of a flat DPR cap: huge canvases
	// drop toward DPR 1 while normal displays keep full sharpness
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
	const equirect = makeEnvTexture();
	const pmrem = new THREE.PMREMGenerator(renderer);
	scene.environment = pmrem.fromEquirectangular(equirect).texture;
	scene.background = equirect;
	pmrem.dispose();

	// --- lighting -----------------------------------------------------
	const keyLight = new THREE.DirectionalLight(0xffb066, 2.6);
	keyLight.position.set(7, 4, 2);
	scene.add(keyLight);
	const fillLight = new THREE.DirectionalLight(0x6a3a1a, 0.5);
	fillLight.position.set(-6, 1.5, -3);
	scene.add(fillLight);

	// --- edge-dot material: preloader-style amber dots along the slab's
	// perimeter, visible only near the cursor (same shader as showcase4's
	// hover/edge spotlight, pre-set to "always spawned + cursor reveal")
	const NET_COLOR_A = 0xffb347, NET_COLOR_B = 0xfff2d9;
	const codeEdgeMat = new THREE.ShaderMaterial({
		transparent: true,
		depthWrite: false,
		depthTest: true,
		blending: THREE.AdditiveBlending,
		uniforms: {
			u_size: { value: 10 },
			u_opacity: { value: 1 },
			u_brightness: { value: config.s3EdgeBrightness },
			u_spawnElapsed: { value: 1e4 },      // long past every spawn delay — always fully "spawned"
			u_spawnWindow: { value: 1 },
			u_spawnFadeIn: { value: 0.6 },
			u_colorA: { value: new THREE.Color(0xffb347) },
			u_colorB: { value: new THREE.Color(0xfff2d9) },
			u_wipeNear: { value: -2 },           // behind the camera = whole field visible
			u_wipeFar: { value: -1 },
			u_cursor: { value: new THREE.Vector2(0, 0) },
			u_cursorRadius: { value: config.s3EdgeRadius },
			u_cursorReveal: { value: 1 },        // visible only inside the cursor spotlight
			u_aspect: { value: 1 }
		},
		vertexShader: `
			uniform float u_size;
			uniform float u_spawnElapsed;
			uniform float u_spawnWindow;
			uniform float u_spawnFadeIn;
			uniform vec2 u_cursor;
			uniform float u_cursorRadius;
			uniform float u_aspect;
			attribute float aSeed;
			attribute float aSpawnDelay;
			varying float vSeed;
			varying float vSpawn;
			varying float vDepth;
			varying float vHover;
			void main() {
				vSeed = aSeed;
				float spawnStart = aSpawnDelay * u_spawnWindow;
				vSpawn = clamp((u_spawnElapsed - spawnStart) / u_spawnFadeIn, 0.0, 1.0);
				vec4 mv = modelViewMatrix * vec4(position, 1.0);
				vDepth = -mv.z;
				gl_Position = projectionMatrix * mv;
				// cursor proximity in aspect-corrected NDC, so the spotlight is a
				// circle on screen regardless of window shape
				vec2 away = (gl_Position.xy / max(0.0001, gl_Position.w) - u_cursor) * vec2(u_aspect, 1.0);
				vHover = 1.0 - smoothstep(0.0, u_cursorRadius, length(away));
				gl_PointSize = u_size * vSpawn / max(1.0, -mv.z);
			}
		`,
		fragmentShader: `
			uniform vec3 u_colorA;
			uniform vec3 u_colorB;
			uniform float u_opacity;
			uniform float u_brightness;
			uniform float u_wipeNear;
			uniform float u_wipeFar;
			uniform float u_cursorReveal;
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
				vec3 col = mix(u_colorA, u_colorB, vSeed) * u_brightness;
				float a = soft * 0.7 + core * 1.4;
				gl_FragColor = vec4(col, a * vSpawn * u_opacity * wipe * mix(1.0, vHover, u_cursorReveal));
			}
		`
	});

	// splat dots along the mesh's sharp edges as a child Points cloud — the
	// dotted perimeter the cursor lights up (showcase4's makeWireframePoints +
	// makeHoverDots collapsed into the one edges-only path this page uses)
	const WIREFRAME_DOT_SPACING_FRACTION = 0.02;
	function makeEdgeDots(mesh, refDiag, mat, edgeDensity = 1) {
		mat.uniforms.u_size.value = config.scHoverDotSize * renderer.getPixelRatio();
		// threshold angle well above the default 1° — keeps only genuinely
		// sharp/silhouette edges instead of tessellation seams
		const edges = new THREE.EdgesGeometry(mesh.geometry, 20);
		const src = edges.attributes.position;   // consecutive pairs: [a0,b0, a1,b1, ...]
		const spacing = refDiag * WIREFRAME_DOT_SPACING_FRACTION / edgeDensity;
		const jitterRadius = spacing * 0.15;   // subtle — dots scatter loosely around the edge
		const coords = [];
		const seeds = [];
		const spawnDelays = [];
		const a = new THREE.Vector3(), b = new THREE.Vector3();
		const dir = new THREE.Vector3(), ref = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3();
		for (let i = 0; i < src.count; i += 2) {
			a.fromBufferAttribute(src, i);
			b.fromBufferAttribute(src, i + 1);
			const edgeLen = a.distanceTo(b);
			if (edgeLen < 1e-6) continue;   // degenerate zero-length edge
			const steps = Math.max(1, Math.round(edgeLen / spacing));
			// stable perpendicular basis for this edge, so jitter can push dots
			// sideways off the line rather than just along it
			dir.subVectors(b, a).normalize();
			ref.set(0, 1, 0);
			if (Math.abs(dir.dot(ref)) > 0.99) ref.set(1, 0, 0);
			u.crossVectors(dir, ref).normalize();
			v.crossVectors(dir, u);
			for (let s = 0; s <= steps; s++) {
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
		edges.dispose();   // only used to derive the dot coordinates, never rendered
		const geo = new THREE.BufferGeometry();
		geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(coords), 3));
		geo.setAttribute("aSpawnDelay", new THREE.BufferAttribute(new Float32Array(spawnDelays), 1));
		geo.setAttribute("aSeed", new THREE.BufferAttribute(new Float32Array(seeds), 1));
		const points = new THREE.Points(geo, mat);
		// child of the glass: the dots inherit its transform AND visibility
		mesh.add(points);
		points.renderOrder = 2;
		return points;
	}

	// --- rounded-slab helpers (same geometry as showcase4's card glass) ---
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

	// real 3D slab: the rounded-rect shape extruded along z, recentered so its
	// volume straddles z=0 — gives the transmission material actual geometry to
	// refract through (reads as a solid glass block, not a plane)
	function makeGlassSlabGeo(shape, depth) {
		const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.001, depth), bevelEnabled: false, curveSegments: 12 });
		g.translate(0, 0, -depth / 2);
		g.computeVertexNormals();
		return g;
	}

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

	const discard = new DiscardMaterial();
	const CARD_H = 2.1;   // corner-radius ratio reference (0.18 / CARD_H, like the showcase cards)

	// --- particle skeleton: the lofi editor redrawn as amber dots ------------
	// CSS still does the layout — we read each DOM bar's screen rect and splat it
	// into slab-local coordinates as a Points cloud (bars filled at a tight pitch,
	// the hairline dividers as dimmer dotted lines). Parented to the code slab, so
	// it billboards/tilts with the glass; its z offset (s3Depth) becomes a real 3D
	// gap with genuine parallax. The DOM skeleton itself is never rendered.
	function makeSkeletonDots(wpp, cx, cy) {
		const BAR_PITCH = 3 / config.s3DotDetail, LINE_PITCH = 4 / config.s3DotDetail;   // sampling pitch in CSS px
		const pos = [], seed = [], base = [];
		const pushDot = (x, y, b) => {
			pos.push((x - cx) * wpp, -(y - cy) * wpp, 0);
			seed.push(Math.random());
			base.push(b);
		};
		const fillRect = (r, b) => {
			for (let y = r.top + BAR_PITCH / 2; y < r.bottom; y += BAR_PITCH)
				for (let x = r.left + BAR_PITCH / 2; x < r.right; x += BAR_PITCH)
					pushDot(x + (Math.random() - 0.5) * BAR_PITCH * config.s3DotJitter, y + (Math.random() - 0.5) * BAR_PITCH * config.s3DotJitter, b);
		};
		const edgeLine = (sel, edge, b = config.s3LineBright) => {
			const el = codeSkeletonEl.querySelector(sel);
			if (!el) return;
			const r = el.getBoundingClientRect();
			const horiz = edge === "top" || edge === "bottom";
			const at = edge === "top" ? r.top : edge === "bottom" ? r.bottom : edge === "left" ? r.left : r.right;
			for (let v = (horiz ? r.left : r.top); v <= (horiz ? r.right : r.bottom); v += LINE_PITCH)
				horiz ? pushDot(v, at, b) : pushDot(at, v, b);
		};
		// every solid placeholder block becomes a filled dot patch
		codeSkeletonEl.querySelectorAll(
			".cs-dot, .cs-activity span, .cs-side-head, .cs-file, .cs-line, .cs-tt, .cs-term-line, .cs-status span"
		).forEach((el) => fillRect(el.getBoundingClientRect(), 1));
		// the faint hairline dividers become sparse, dimmer dotted lines
		edgeLine(".cs-title", "bottom");
		edgeLine(".cs-activity", "right");
		edgeLine(".cs-sidebar", "right");
		edgeLine(".cs-tabs", "bottom");
		edgeLine(".cs-terminal", "top");
		edgeLine(".cs-term-tabs", "bottom");
		edgeLine(".cs-status", "top");
		edgeLine(".cs-tab.cs-tab-on", "bottom", 1);   // the amber active-tab underline stays bright
		const geo = new THREE.BufferGeometry();
		geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
		geo.setAttribute("aSeed", new THREE.BufferAttribute(new Float32Array(seed), 1));
		geo.setAttribute("aBase", new THREE.BufferAttribute(new Float32Array(base), 1));
		const mat = new THREE.ShaderMaterial({
			transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
			uniforms: {
				u_time: { value: 0 },
				u_size: { value: config.s3DotSize * renderer.getPixelRatio() },
				u_opacity: { value: 0 },
				u_bright: { value: config.s3DotBright },
				u_shimmer: { value: config.s3Shimmer },
				u_colorA: { value: new THREE.Color(NET_COLOR_A) },
				u_colorB: { value: new THREE.Color(NET_COLOR_B) }
			},
			vertexShader: `
				uniform float u_time; uniform float u_size; uniform float u_shimmer;
				attribute float aSeed; attribute float aBase;
				varying float vSeed; varying float vA;
				void main() {
					vec4 mv = modelViewMatrix * vec4(position, 1.0);
					// slow per-dot shimmer so the skeleton reads alive, not printed —
					// u_shimmer sets the depth (0 = steady, 1 = the classic 0.5..1 swing)
					float s = u_shimmer * 0.25;
					vA = aBase * max(0.0, 1.0 - s + s * sin(u_time * 1.4 + aSeed * 6.2831));
					vSeed = aSeed;
					gl_Position = projectionMatrix * mv;
					gl_PointSize = u_size * (0.7 + 0.6 * aSeed) / max(1.0, -mv.z);
				}
			`,
			fragmentShader: `
				uniform float u_opacity; uniform float u_bright; uniform vec3 u_colorA; uniform vec3 u_colorB;
				varying float vSeed; varying float vA;
				void main() {
					vec2 uv = gl_PointCoord - 0.5;
					float d = dot(uv, uv);
					float soft = exp(-d * 8.0);
					float core = exp(-d * 40.0);
					if (soft < 0.02 && core < 0.02) discard;
					gl_FragColor = vec4(mix(u_colorA, u_colorB, vSeed) * u_bright, (soft * 0.7 + core * 1.4) * vA * u_opacity);
				}
			`
		});
		const points = new THREE.Points(geo, mat);
		points.frustumCulled = false;
		points.renderOrder = 2;
		return points;
	}

	// build (or rebuild on resize) the real glass slab that backs the VS Code
	// wireframe: a rounded extruded slab with the card-glass transmission material,
	// sized so it covers the same on-screen rect as the centered DOM window. It's
	// billboarded in front of the camera each frame (see tick) so it stays locked
	// to the fixed overlay, and gets its own FBO refraction pass.
	function buildCodeSlab() {
		if (codeSlab) {
			codeSlab.edgeDots.geometry.dispose();
			codeSlab.dots.geometry.dispose();
			codeSlab.dots.material.dispose();
			scene.remove(codeSlab.mesh);
			codeSlab.mesh.geometry.dispose();
			codeSlab.mat.dispose();
			codeSlab.fbo.dispose();
			codeSlab = null;
		}
		const stack = document.querySelector(".cs-stack");
		const rect = stack.getBoundingClientRect();
		if (!rect.width || !rect.height) return;
		// world span of the full viewport at the slab's distance, then the window's
		// screen fraction of it (camera is centered on the slab, so no x/y offset)
		const vHFull = 2 * CODE_SLAB_DIST * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
		const slabH = (rect.height / window.innerHeight) * vHFull * config.s3GlassScale;
		const slabW = (rect.width / window.innerWidth) * vHFull * camera.aspect * config.s3GlassScale;
		const shape = makeCardShape(slabW, slabH, slabH * (0.18 / CARD_H));
		const mat = makeCardGlass();
		mat.envMapIntensity *= 1.5;   // brighter reflections so the glass is more noticeable
		const slabGeo = makeGlassSlabGeo(shape, config.s3GlassThickness);
		const mesh = new THREE.Mesh(slabGeo, mat);
		const fbo = new THREE.WebGLRenderTarget(
			Math.round(window.innerWidth * cardFboScale),
			Math.round(window.innerHeight * cardFboScale),
			{ type: THREE.HalfFloatType }
		);
		mat.buffer = fbo.texture;
		scene.add(mesh);
		// edge-only hover: the dotted perimeter with its own s3 keys
		slabGeo.computeBoundingSphere();
		const diag = slabGeo.boundingSphere.radius * 2;
		const edgeDots = makeEdgeDots(mesh, diag, codeEdgeMat, 10);
		// the particle skeleton floats in front of the slab's front face; wpp
		// (world units per CSS px at slab distance) converts the s3Depth slider
		const wpp = vHFull / window.innerHeight;
		const dots = makeSkeletonDots(wpp, rect.left + rect.width / 2, rect.top + rect.height / 2);
		mesh.add(dots);
		codeSlab = { mesh, mat, fbo, edgeDots, dots, wpp };
	}
	buildCodeSlab();

	// --- ambient dust drifting through the dark scene --------------------
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
			transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
			uniforms: {
				u_time: { value: 0 },
				u_size: { value: config.particleSize * renderer.getPixelRatio() },
				u_opacity: { value: 1 },   // the dust IS the page's base state — always on
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
		scene.add(points);
		sectionDust = { points, mat };
	}
	buildSectionDust();

	// --- cursor dwell: parked on the slab past scHoverFade, the edge dots die ---
	const raycaster = new THREE.Raycaster();
	const hoverPointer = { x: 0, y: 0, active: false };
	const _hoverNDC = new THREE.Vector2();
	let glassDwellT = 0;   // seconds the cursor has sat on the slab

	// --- post-processing pipeline ------------------------------------
	const composer = new EffectComposer(
		renderer,
		new THREE.WebGLRenderTarget(window.innerWidth, initH, {
			type: THREE.HalfFloatType,
			samples: isMobile ? 0 : (window.innerWidth * initH * fitPixelRatio() ** 2 > 4e6 ? 2 : 4)
		})
	);
	composer.addPass(new RenderPass(scene, camera));

	// sanitize HDR buffer before bloom: superbright glints can go Inf/NaN in the
	// HalfFloat target and UnrealBloomPass smears non-finite values into big
	// black rectangles for a frame. Detect Inf/NaN by bit pattern (float compares
	// get optimized away by fast-math shader compilers).
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
			uAspect: { value: window.innerWidth / initH },
			uVignetteOuter: { value: config.vignetteOuter },
			uVignetteInner: { value: config.vignetteInner }
		},
		vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
		fragmentShader: `
			uniform sampler2D tDiffuse;
			uniform float uTime, uGrain, uChroma, uAspect, uVignetteOuter, uVignetteInner;
			varying vec2 vUv;
			float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
			void main(){
				vec2 uv = vUv;
				vec2 d = uv - 0.5;
				vec2 off = d * dot(d, d) * uChroma;
				vec3 col;
				col.r = texture2D(tDiffuse, uv + off).r;
				col.g = texture2D(tDiffuse, uv).g;
				col.b = texture2D(tDiffuse, uv - off).b;
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
		const t = clock.getElapsedTime();
		const dt = Math.min(0.05, t - lastElapsed);
		lastElapsed = t;
		flakeTime += dt * config.glowSpeed;

		// slab entrance over the first ENTRANCE_END of the scroll, skeleton
		// materialize over the rest — same two-clock shape as showcase4's
		// outro2 window + ambience section
		const enterProgress = Math.min(1, scrollProgress / ENTRANCE_END);
		const ambienceProgress = Math.max(0, (scrollProgress - ENTRANCE_END) / (1 - ENTRANCE_END));
		// ease out faster than in, so scrolling back up doesn't dwell
		easedEnter    += (enterProgress    - easedEnter)    * (enterProgress    < easedEnter    ? 0.2 : 0.08);
		easedAmbience += (ambienceProgress - easedAmbience) * (ambienceProgress < easedAmbience ? 0.2 : 0.08);

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

		// cursor dwell on the slab drives the edge-dot fade (same clock shape as
		// showcase4's water-stir dwell, minus the water)
		let hasHit = false;
		if (hoverPointer.active && codeSlab) {
			_hoverNDC.set(
				(hoverPointer.x / window.innerWidth) * 2 - 1,
				-(hoverPointer.y / window.innerHeight) * 2 + 1
			);
			raycaster.setFromCamera(_hoverNDC, camera);
			hasHit = raycaster.intersectObject(codeSlab.mesh, false).length > 0;
		}
		glassDwellT = hasHit ? glassDwellT + dt : 0;
		codeEdgeMat.uniforms.u_cursor.value.set(hoverCursor.x, hoverCursor.y);
		codeEdgeMat.uniforms.u_cursorRadius.value = config.s3EdgeRadius;
		codeEdgeMat.uniforms.u_aspect.value = camera.aspect;
		codeEdgeMat.uniforms.u_brightness.value = config.s3EdgeBrightness;
		const edgeTarget = (config.scHoverFade > 0 ? Math.max(0, 1 - glassDwellT / config.scHoverFade) : 1) * config.scHoverIntensity;
		codeEdgeMat.uniforms.u_opacity.value += (edgeTarget - codeEdgeMat.uniforms.u_opacity.value) * Math.min(1, dt * 4);

		// sky parked at its own fixed heading (no glow sweep)
		scene.backgroundRotation.y = THREE.MathUtils.degToRad(config.s3SkyAngle);
		scene.environmentRotation.y = scene.backgroundRotation.y;

		camera.position.z = config.cameraDist;
		camera.position.x = -pointer.x * 0.6;
		camera.position.y = 0.3 - pointer.y * 0.4;
		camera.lookAt(0, 0, 0);

		// keep the glass slab pinned in front of the camera (billboard) so it stays
		// aligned with the fixed DOM overlay regardless of the camera's parallax
		if (codeSlab) {
			camera.getWorldDirection(_codeSlabDir);
			codeSlab.mesh.position.copy(camera.position).addScaledVector(_codeSlabDir, CODE_SLAB_DIST);
			// entrance: the slab starts lying back (top edge away, bottom toward the
			// viewer) AND below the frame, then rises + swings up flat through the
			// scroll — (1-p)² so the last stretch settles softly as it lands
			const slabSettle = Math.min(1, Math.max(easedEnter, easedAmbience));
			// at rest the page is dust-only: the slab (and its dot children) stay
			// hidden until the scroll starts pulling it up from below the frame
			codeSlab.mesh.visible = slabSettle > 0.001;
			const enterEase = (1 - slabSettle) * (1 - slabSettle);
			const enterTilt = enterEase * THREE.MathUtils.degToRad(config.s3EnterTilt);
			// rise: offset along the camera's local down, in world units at slab
			// distance (wpp * innerHeight = the full viewport height there)
			const enterDrop = enterEase * codeSlab.wpp * window.innerHeight * (config.s3EnterRise / 100);
			_codeSlabUp.set(0, -1, 0).applyQuaternion(camera.quaternion);
			codeSlab.mesh.position.addScaledVector(_codeSlabUp, enterDrop);
			// subtle look-at-cursor: tilt the slab so its face turns toward the pointer
			const slabLook = THREE.MathUtils.degToRad(config.s3GlassTilt);
			_codeSlabEuler.set(-pointer.y * slabLook - enterTilt, pointer.x * slabLook, 0);
			_codeSlabTilt.setFromEuler(_codeSlabEuler);
			codeSlab.mesh.quaternion.copy(camera.quaternion).multiply(_codeSlabTilt);
			// staged reveal: the slab arrives with the scroll, then the particle
			// skeleton materializes last — its ramp starts once the slab has landed
			const uiAppear = Math.min(1, Math.max(0, (easedAmbience - 0.05) / 0.35));
			const rev = uiAppear * uiAppear * (3 - 2 * uiAppear);   // smoothstep
			codeSlab.dots.material.uniforms.u_opacity.value = rev;
			codeSlab.dots.material.uniforms.u_time.value = t;
			// s3Depth as a real world-space gap off the slab's front face
			// (geometry is z-centered → face at +thickness/2)
			codeSlab.dots.position.z = config.s3GlassThickness / 2 + config.s3Depth * codeSlab.wpp;
		}

		sectionDust.mat.uniforms.u_time.value = flakeTime;
		sectionDust.points.rotation.y = t * 0.02;   // gentle idle drift

		gradePass.uniforms.uGrain.value = config.grain;
		gradePass.uniforms.uChroma.value = config.chroma;
		gradePass.uniforms.uTime.value = t;
		gradePass.uniforms.uVignetteOuter.value = config.vignetteOuter;
		gradePass.uniforms.uVignetteInner.value = config.vignetteInner;
		bloomPass.strength = config.bloom;
		bloomPass.enabled = config.bloom > 0;

		// the slab's refraction capture: discard the slab, render the dust/sky
		// behind it into its FBO, then let it refract that
		if (codeSlab && codeSlab.mesh.visible) {
			const oldTone = renderer.toneMapping;
			renderer.toneMapping = THREE.NoToneMapping;
			codeSlab.mesh.material = discard;
			codeSlab.dots.visible = false;   // keep the particle skeleton out of its own refraction
			codeSlab.mat.time = t;
			renderer.setRenderTarget(codeSlab.fbo);
			renderer.render(scene, camera);
			renderer.setRenderTarget(null);
			renderer.toneMapping = oldTone;
			codeSlab.mesh.material = codeSlab.mat;
			codeSlab.dots.visible = true;
		}
		composer.render();

		fpsFrames++;
		if (t - fpsLast >= 0.5) {
			fpsEl.textContent = Math.round(fpsFrames / (t - fpsLast)) + " fps";
			fpsFrames = 0; fpsLast = t;
		}

		rafId = requestAnimationFrame(tick);
	}

	// --- events -------------------------------------------------------
	// auto-advance: if the user pauses mid-entrance, glide the rest of the way
	// so the terminal always lands fully instead of hanging half-risen
	const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
	const IDLE_MS = 400;   // pause before the auto-glide kicks in
	// glide target: past the entrance far enough that the skeleton has fully
	// materialized (easedAmbience 0.4 → full dots)
	const SETTLE = Math.min(1, ENTRANCE_END + 0.4 * (1 - ENTRANCE_END));
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
			const e = p < 0.5 ? 8 * p * p * p * p : 1 - Math.pow(-2 * p + 2, 4) / 2;   // easeInOutQuart
			window.scrollTo(0, startY + dist * e);
			if (p < 1) autoScrollRaf = requestAnimationFrame(step);
			else { autoScrollRaf = null; autoScrolling = false; }
		}
		autoScrollRaf = requestAnimationFrame(step);
	}
	function maybeAutoAdvance() {
		if (autoScrolling) return;
		const max = document.documentElement.scrollHeight - window.innerHeight;
		// only once the entrance is meaningfully underway — a barely-scrolled
		// page stays where the user left it
		if (scrollProgress >= 0.15 && scrollProgress < SETTLE - 0.005) {
			autoScrollTo(SETTLE * max);
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
		gradePass.uniforms.uAspect.value = w / h;
		buildCodeSlab();   // slab size tracks the DOM window's screen rect
		sectionDust.mat.uniforms.u_size.value = config.particleSize * renderer.getPixelRatio();
		readScroll();
	});

	window.addEventListener("pointermove", (e) => {
		pointer.tx = (e.clientX / window.innerWidth) * 2 - 1;
		pointer.ty = -((e.clientY / window.innerHeight) * 2 - 1);
		hoverPointer.x = e.clientX; hoverPointer.y = e.clientY; hoverPointer.active = true;
	}, { passive: true });
	// touch has no "hover": drop the glow when the finger lifts
	window.addEventListener("pointerup", (e) => { if (e.pointerType !== "mouse") hoverPointer.active = false; }, { passive: true });
	window.addEventListener("pointercancel", () => { hoverPointer.active = false; }, { passive: true });
	window.addEventListener("blur", () => { hoverPointer.active = false; });

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

	bindSlider("s-s3depth", "v-s3depth", (v) => { config.s3Depth = v; }, (v) => Math.round(v) + "px");
	bindSlider("s-s3glasstilt", "v-s3glasstilt", (v) => { config.s3GlassTilt = v; }, (v) => v.toFixed(1) + "°");
	bindSlider("s-s3entertilt", "v-s3entertilt", (v) => { config.s3EnterTilt = v; }, (v) => Math.round(v) + "°");
	bindSlider("s-s3enterrise", "v-s3enterrise", (v) => { config.s3EnterRise = v; }, (v) => Math.round(v) + "%");
	bindSlider("s-s3skyangle", "v-s3skyangle", (v) => { config.s3SkyAngle = v; }, (v) => Math.round(v) + "°");
	bindSlider("s-s3glassscale", "v-s3glassscale", (v) => { config.s3GlassScale = v; buildCodeSlab(); }, (v) => v.toFixed(2));
	bindSlider("s-s3glassthick", "v-s3glassthick", (v) => { config.s3GlassThickness = v; buildCodeSlab(); }, (v) => v.toFixed(2));
	bindSlider("s-s3edgebright", "v-s3edgebright", (v) => { config.s3EdgeBrightness = v; }, (v) => v.toFixed(2) + "×");
	bindSlider("s-s3edgerad", "v-s3edgerad", (v) => { config.s3EdgeRadius = v; }, (v) => v.toFixed(2));
	bindSlider("s-s3dotsize", "v-s3dotsize", (v) => {
		config.s3DotSize = v;
		if (codeSlab) codeSlab.dots.material.uniforms.u_size.value = v * renderer.getPixelRatio();
	}, (v) => String(Math.round(v)));
	bindSlider("s-s3dotdetail", "v-s3dotdetail", (v) => { config.s3DotDetail = v; buildCodeSlab(); }, (v) => v.toFixed(2) + "×");
	bindSlider("s-s3dotjitter", "v-s3dotjitter", (v) => { config.s3DotJitter = v; buildCodeSlab(); }, (v) => v.toFixed(2));
	bindSlider("s-s3dotbright", "v-s3dotbright", (v) => {
		config.s3DotBright = v;
		if (codeSlab) codeSlab.dots.material.uniforms.u_bright.value = v;
	}, (v) => v.toFixed(2) + "×");
	bindSlider("s-s3shimmer", "v-s3shimmer", (v) => {
		config.s3Shimmer = v;
		if (codeSlab) codeSlab.dots.material.uniforms.u_shimmer.value = v;
	}, (v) => v.toFixed(2));
	bindSlider("s-s3linebright", "v-s3linebright", (v) => { config.s3LineBright = v; buildCodeSlab(); }, (v) => v.toFixed(2));
	bindSlider("s-secpart", "v-secpart", (v) => { config.sectionParticles = Math.round(v); buildSectionDust(); }, (v) => String(Math.round(v)));
	bindSlider("s-bloom", "v-bloom", (v) => { config.bloom = v; }, (v) => v.toFixed(2));
	bindSlider("s-chroma", "v-chroma", (v) => { config.chroma = v; }, (v) => v.toFixed(3));
	bindSlider("s-grain", "v-grain", (v) => { config.grain = v; }, (v) => v.toFixed(2));

	setupGyro();
	readScroll();
	tick();
})();
