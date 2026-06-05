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
	let fpsFrames = 0, fpsLast = 0;   // rolling FPS counter

	// --- scroll state -------------------------------------------------
	let scrollProgress = 0;     // 0..1 raw from scrollbar
	let easedProgress = 0;      // smoothed, drives rotation (uncapped — continues past 500vh)
	let easedScene = 0;         // smoothed 0..1, drives camera dolly only (capped at 500vh)
	let easedOutro = 0;         // smoothed 0..1 for the extra 20vh outro
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
		particleCount: 2000,
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
		outroStart: 525,        // vh position where the right-to-left fade begins
		trackHeight: 600,       // total scroll track height in vh
		outroDim: 0.5           // max uniform full-screen darkening behind the sweep (0 = off, 1 = full black)
	};
	let flakeTime = 0;          // accumulated time scaled by glowSpeed

	function readScroll() {
		const max = document.documentElement.scrollHeight - window.innerHeight;
		scrollProgress = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
	}

	// --- renderer / scene --------------------------------------------
	const isMobile = matchMedia("(pointer: coarse)").matches || window.innerWidth < 768;
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
		config.particleCount = 900;
		document.getElementById("s-count").value = 900;
		document.getElementById("v-count").textContent = "900";
	}

	const renderer = new THREE.WebGLRenderer({ canvas, antialias: !isMobile, alpha: false });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
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
		return tex;
	}
	const equirect = makeEnvTexture();
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
	}

	function addFallback() {
		clearSlabs();
		addSlab(new THREE.TorusKnotGeometry(1, 0.34, 180, 32));
		frameCore();
		modelReady = true;
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
			},
			undefined,
			(e) => { URL.revokeObjectURL(url); if (onError) onError(e); }
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

	// --- post-processing pipeline ------------------------------------
	const composer = new EffectComposer(
		renderer,
		new THREE.WebGLRenderTarget(window.innerWidth, initH, {
			type: THREE.HalfFloatType,
			samples: isMobile ? 0 : 4
		})
	);
	composer.addPass(new RenderPass(scene, camera));

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
		const t = clock.getElapsedTime();
		const dt = Math.min(0.05, t - lastElapsed);
		lastElapsed = t;
		flakeTime += dt * config.glowSpeed;

		const sr            = config.outroStart / config.trackHeight;
		const sceneProgress = Math.min(scrollProgress / sr, 1);
		const rotProgress   = scrollProgress / sr;
		const outroProgress = Math.max(0, (scrollProgress - sr) / (1 - sr));
		easedProgress += (rotProgress   - easedProgress) * 0.08;
		easedScene    += (sceneProgress - easedScene)    * 0.08;
		easedOutro    += (outroProgress - easedOutro)    * config.outroSpeed;

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
		if (outroProgress > 0) {
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

		camera.position.z = config.cameraDist - easedScene * 2.2;
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
		bloomPass.strength = config.bloom;
		bloomPass.enabled = config.bloom > 0;

		const sceneHidden = easedOutro > 0.995;
		if (!sceneHidden) {
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

	setupGyro();
	readScroll();
	tick();
})();
