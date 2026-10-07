import {useEffect, useRef, useState} from 'react';
import * as THREE from 'three';
import {RoomEnvironment} from 'three/examples/jsm/environments/RoomEnvironment.js';
import s from './sculpture.module.css';

/** An interactive study of two connected paths; no live participant data is implied. */
export default function ConnectionSculpture({paused = false}: {paused?: boolean}) {
  const host = useRef<HTMLDivElement>(null);
  const pause = useRef(paused);
  pause.current = paused;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({alpha: true, antialias: true});
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.65));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.domElement.setAttribute('aria-hidden', 'true');
    node.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(33, 1, 0.1, 80);
    camera.position.set(0, 0, 15);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const environment = pmrem.fromScene(room, 0.04);
    scene.environment = environment.texture;
    room.dispose();
    pmrem.dispose();
    const sculpture = new THREE.Group();
    scene.add(sculpture);
    const metal = new THREE.MeshPhysicalMaterial({
      color: 0xaeb0b8,
      metalness: 1,
      roughness: 0.13,
      clearcoat: 1,
      clearcoatRoughness: 0.12,
      envMapIntensity: 1.45,
    });
    const darkMetal = new THREE.MeshPhysicalMaterial({color: 0x343640, metalness: 1, roughness: 0.25, envMapIntensity: 1.5});
    const paths: THREE.CatmullRomCurve3[] = [];
    // Two offset orbital paths form a single hop, with a narrow ribbon profile.
    for (let side = 0; side < 2; side++) {
      const points: THREE.Vector3[] = [];
      for (let i = 0; i < 160; i++) {
        const a = (i / 160) * Math.PI * 2;
        const x = Math.cos(a) * 2.15 + (side === 0 ? -1.25 : 1.25);
        const y = Math.sin(a) * 2.55;
        const z = Math.sin(a) * (side === 0 ? 0.9 : -0.9) + Math.cos(a) * 0.15;
        points.push(new THREE.Vector3(x, y, z));
      }
      const path = new THREE.CatmullRomCurve3(points, true);
      paths.push(path);
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(path, 240, 0.21, 24, true), metal);
      sculpture.add(mesh);
      const inner = new THREE.Mesh(new THREE.TubeGeometry(path, 240, 0.018, 8, true), darkMetal);
      inner.scale.setScalar(0.9);
      sculpture.add(inner);
    }
    const packets = paths.map(() => {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.105, 20, 12),
        new THREE.MeshStandardMaterial({color: 0xffffff, emissive: 0xc6b4ff, emissiveIntensity: 1.7, metalness: 0.5, roughness: 0.2}),
      );
      sculpture.add(m);
      return m;
    });
    const key = new THREE.DirectionalLight(0xffffff, 4);
    key.position.set(-5, 6, 7);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9281f7, 2);
    rim.position.set(4, -3, -1);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0xaac6ff, 1);
    fill.position.set(-5, -3, 2);
    scene.add(fill);
    sculpture.rotation.set(0.18, -0.3, -0.27);
    sculpture.position.y = 0.65;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0,
      last = 0,
      time = 0,
      visible = true,
      dragging = false,
      lastX = 0,
      lastY = 0,
      turnX = 0,
      turnY = 0,
      lastDraw = 0,
      dirty = true,
      wasPaused = false;
    const resize = () => {
      dirty = true;
      const w = node.clientWidth,
        h = node.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.position.z = w < 650 ? 19 : 15;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(node);
    resize();
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    observer.observe(node);
    const down = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      node.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      dirty = true;
      turnY += (e.clientX - lastX) * 0.006;
      turnX += (e.clientY - lastY) * 0.004;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const up = () => {
      dragging = false;
    };
    const lost = (e: Event) => {
      e.preventDefault();
      setFailed(true);
    };
    node.addEventListener('pointerdown', down);
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
    renderer.domElement.addEventListener('webglcontextlost', lost);
    const render = (now: number) => {
      frame = requestAnimationFrame(render);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      if (!visible || document.hidden || now - lastDraw < 33) return;
      const still = pause.current || reduce.matches;
      if (still && wasPaused && !dirty) return;
      wasPaused = still;
      dirty = false;
      lastDraw = now;
      if (!still) time += dt;
      sculpture.rotation.y = -0.3 + Math.sin(time * 0.17) * 0.32 + turnY;
      sculpture.rotation.x = 0.18 + Math.sin(time * 0.13) * 0.1 + turnX;
      packets.forEach((packet, i) => packet.position.copy(paths[i].getPointAt((time * 0.075 + i * 0.45) % 1)));
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      observer.disconnect();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose();
      });
      environment.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);
  return (
    <div className={s.scene} ref={host} aria-hidden="true">
      {failed && (
        <svg viewBox="0 0 800 600" className={s.fallback}>
          <g fill="none" stroke="#9d9da6" strokeWidth="2">
            <ellipse cx="300" cy="300" rx="155" ry="225" transform="rotate(-25 300 300)" />
            <ellipse cx="500" cy="300" rx="155" ry="225" transform="rotate(25 500 300)" />
            <path d="M170 360Q400 130 630 360" />
          </g>
        </svg>
      )}
    </div>
  );
}
