import {useEffect, useRef, useState} from 'react';
import * as THREE from 'three';
import {RoomEnvironment} from 'three/examples/jsm/environments/RoomEnvironment.js';
import {RoundedBoxGeometry} from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {EffectComposer} from 'three/examples/jsm/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/examples/jsm/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import {SMAAPass} from 'three/examples/jsm/postprocessing/SMAAPass.js';
import {OutputPass} from 'three/examples/jsm/postprocessing/OutputPass.js';
import s from './world.module.css';
const NO_WALLS: string[] = [];
export type Player = {id: string; x: number; y: number};
export default function WorldView({
  walls = NO_WALLS,
  players = [],
  goal = {x: 13, y: 7},
  orbital = false,
  preview = false,
}: {
  walls?: string[];
  players?: Player[];
  goal?: {x: number; y: number};
  orbital?: boolean;
  preview?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef({players, goal});
  current.current = {players, goal};
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({antialias: true, alpha: true});
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.domElement.setAttribute('aria-hidden', 'true');
    node.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(33, 1, 0.1, 100);
    camera.position.set(13, 14, 18);
    camera.lookAt(0, 0, 0);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04);
    scene.environment = env.texture;
    room.dispose();
    pmrem.dispose();
    const board = new THREE.Group();
    scene.add(board);
    const geometry = new RoundedBoxGeometry(1, 1, 1, 5, 0.06);
    const silver = new THREE.MeshStandardMaterial({color: orbital ? 0x233a3d : 0x393a40, metalness: 0.82, roughness: 0.23, envMapIntensity: 1.2});
    const floor = new THREE.MeshStandardMaterial({color: 0x0b0c10, metalness: 0.7, roughness: 0.36, envMapIntensity: 0.55});
    const edge = new THREE.MeshStandardMaterial({color: 0x16171a, metalness: 0.9, roughness: 0.21});
    function box(x: number, y: number, z: number, w: number, h: number, d: number, material: THREE.Material) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.scale.set(w, h, d);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      board.add(mesh);
      return mesh;
    }
    box(0, -0.55, 0, 15.6, 0.6, 9.6, edge);
    box(0, -0.21, 0, 15.3, 0.12, 9.3, floor);
    if (orbital) {
      // A machined arena with a low perimeter: the whole playable surface stays visible.
      box(0, -0.01, -4, 15, 0.25, 1, silver);
      box(0, -0.01, 4, 15, 0.25, 1, silver);
      box(-7, -0.01, 0, 1, 0.25, 7, silver);
      box(7, -0.01, 0, 1, 0.25, 7, silver);
      const etching = new THREE.MeshStandardMaterial({color: 0x4e6264, metalness: 0.6, roughness: 0.3});
      for (const radius of [1.5, 3, 4.4, 6]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.008, 6, 128), etching);
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = -0.14;
        ring.scale.y = 0.5;
        board.add(ring);
      }
      // Two open gantries carry the orbital language above and outside the playing area.
      for (const side of [-1, 1]) {
        const arch = new THREE.Mesh(new THREE.TorusGeometry(2.3, 0.06, 12, 128, Math.PI), silver);
        arch.position.set(side * 7.5, 0.05, 0);
        arch.rotation.y = Math.PI / 2;
        board.add(arch);
        const lightArch = new THREE.Mesh(
          new THREE.TorusGeometry(2.2, 0.015, 8, 128, Math.PI),
          new THREE.MeshStandardMaterial({color: 0x94d2cb, emissive: 0x5fa298, emissiveIntensity: 2}),
        );
        lightArch.position.copy(arch.position);
        lightArch.rotation.copy(arch.rotation);
        board.add(lightArch);
      }
    } else {
      // Merge contiguous wall runs into carved, uninterrupted forms.
      const visited = new Set<string>();
      for (let y = 0; y < 9; y++)
        for (let x = 0; x < 15; x++) {
          if (walls[y]?.[x] !== '#' || visited.has(`${x},${y}`)) continue;
          let width = 1,
            height = 1;
          while (x + width < 15 && walls[y][x + width] === '#' && !visited.has(`${x + width},${y}`)) width++;
          if (width === 1) while (y + height < 9 && walls[y + height]?.[x] === '#' && !visited.has(`${x},${y + height}`)) height++;
          for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) visited.add(`${x + dx},${y + dy}`);
          box(x - 7 + (width - 1) / 2, 0.24, y - 4 + (height - 1) / 2, width - 0.035, 0.78, height - 0.035, silver);
        }
    }
    // Inlaid perimeter lighting belongs to the game environment, not the page chrome.
    const lineMaterial = new THREE.MeshStandardMaterial({color: 0xbcc0cf, emissive: 0xaab0c6, emissiveIntensity: 1.8});
    box(0, -0.18, -4.55, 14.9, 0.015, 0.015, lineMaterial);
    box(0, -0.18, 4.55, 14.9, 0.015, 0.015, lineMaterial);
    const beacon = new THREE.Group();
    const portalMaterial = new THREE.MeshStandardMaterial({color: 0xe1c6b0, emissive: 0xcda280, emissiveIntensity: 2.8, metalness: 0.5, roughness: 0.15});
    const halo = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.028, 10, 64), portalMaterial);
    halo.position.y = 0.48;
    beacon.add(halo);
    board.add(beacon);
    const beaconBase = new THREE.Mesh(new THREE.CylinderGeometry(0.51, 0.56, 0.12, 48), edge);
    beacon.add(beaconBase);
    const avatars = new Map<string, THREE.Group>();
    const bodyGeometry = new THREE.SphereGeometry(0.2, 24, 16);
    const playerMaterials = [0xe7eaf4, 0xb2a2e5, 0x93cbc0, 0xd7b2a4].map(
      (color) => new THREE.MeshStandardMaterial({color, emissive: color, emissiveIntensity: 0.45, metalness: 0.6, roughness: 0.22}),
    );
    const light = new THREE.DirectionalLight(0xe6e6ef, 2.7);
    light.position.set(-7, 16, 5);
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    Object.assign(light.shadow.camera, {left: -11, right: 11, top: 11, bottom: -11, near: 1, far: 45});
    light.shadow.normalBias = 0.025;
    scene.add(light);
    const rim = new THREE.DirectionalLight(0xb6bfd8, 0.9);
    rim.position.set(8, 6, -10);
    scene.add(rim);
    scene.add(new THREE.AmbientLight(0xffffff, 0.15));
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(600, 400), 0.3, 0.4, 1);
    composer.addPass(bloom);
    const output = new OutputPass();
    composer.addPass(output);
    const antialias = new SMAAPass();
    composer.addPass(antialias);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let visible = true,
      frame = 0,
      last = 0,
      time = 0,
      lastDraw = 0,
      dirty = true;
    let previous = current.current;
    const resize = () => {
      dirty = true;
      const w = node.clientWidth,
        h = node.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      camera.aspect = w / h;
      camera.position.set(w / h < 1.2 ? 17 : 13, w / h < 1.2 ? 19 : 14, w / h < 1.2 ? 23 : 18);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(node);
    resize();
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
    });
    io.observe(node);
    const lost = (event: Event) => {
      event.preventDefault();
      setFailed(true);
    };
    renderer.domElement.addEventListener('webglcontextlost', lost);
    const render = (now: number) => {
      frame = requestAnimationFrame(render);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      if (!visible || document.hidden || now - lastDraw < 33) return;
      if (reduced.matches && !dirty && previous === current.current) return;
      lastDraw = now;
      dirty = false;
      previous = current.current;
      if (!reduced.matches) time += dt;
      const all = preview
        ? [
            {id: 'one', x: 3, y: 3},
            {id: 'two', x: 7, y: 5},
            {id: 'three', x: 11, y: 3},
          ]
        : current.current.players;
      const ids = new Set(all.map((p) => p.id));
      for (const [id, mesh] of avatars)
        if (!ids.has(id)) {
          board.remove(mesh);
          avatars.delete(id);
        }
      all.forEach((player, i) => {
        let mesh = avatars.get(player.id);
        if (!mesh) {
          mesh = new THREE.Group();
          const body = new THREE.Mesh(bodyGeometry, playerMaterials[i % 4]);
          body.castShadow = true;
          mesh.add(body);
          const marker = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.014, 8, 32), playerMaterials[i % 4]);
          marker.rotation.x = Math.PI / 2;
          marker.position.y = -0.23;
          mesh.add(marker);
          board.add(mesh);
          avatars.set(player.id, mesh);
        }
        mesh.position.set(player.x - 7, 0.19 + Math.sin(time * 1.3 + i) * 0.04, player.y - 4);
      });
      beacon.position.set(current.current.goal.x - 7, 0, current.current.goal.y - 4);
      halo.rotation.y = time * 0.18;
      composer.render();
    };
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      io.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      scene.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) for (const material of Array.isArray(m.material) ? m.material : [m.material]) material.dispose();
      });
      bodyGeometry.dispose();
      playerMaterials.forEach((m) => m.dispose());
      light.shadow.dispose();
      env.dispose();
      bloom.dispose();
      output.dispose();
      antialias.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [walls, orbital, preview]);
  return (
    <div
      ref={host}
      className={s.viewport}
      role="img"
      aria-label={
        preview
          ? 'Rendered game scene preview'
          : `3D ${orbital ? 'arena' : 'maze'} with ${players.length} players. Your position: ${players[0]?.x ?? 1}, ${players[0]?.y ?? 1}. Target: ${goal.x}, ${goal.y}.`
      }
    >
      {failed && <p className={s.fallback}>3D rendering is unavailable on this device. Switch to map view to play.</p>}
    </div>
  );
}
