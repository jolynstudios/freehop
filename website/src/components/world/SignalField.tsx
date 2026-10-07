import {useEffect, useRef, useState} from 'react';
import * as THREE from 'three';
import s from './signalField.module.css';

/** A moving, woven signal field. Decorative artwork, not live call activity. */
export default function SignalField({paused = false}: {paused?: boolean}) {
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
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute('aria-hidden', 'true');
    node.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
    camera.position.set(0, 0, 14);
    const uniforms = {time: {value: 0}};
    const geometry = new THREE.PlaneGeometry(2, 2, 320, 128);
    const material = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: `
        uniform float time;
        varying vec2 surface;
        varying vec3 world;
        void main() {
          surface = uv;
          float u = position.x;
          float v = position.y;
          float phase = time * .16;
          float fold = sin(u * 2.8 + v * .85 + phase);
          vec3 p = vec3(u * 6.4 + v * .55,
            fold * (1.65 + .35 * cos(v * 2.)) + v * .9,
            v * 2.2 + cos(u * 2.8 + phase) * (1.25 + v * .3));
          p.y += .2 * sin(u * 7. + v * 3. - phase);
          world = p;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
        }`,
      fragmentShader: `
        varying vec2 surface;
        varying vec3 world;
        void main() {
          float weave = abs(fract(surface.y * 108.) - .5);
          float aa = max(fwidth(surface.y * 108.), .03);
          float thread = 1. - smoothstep(.13, .13 + aa, weave);
          float ends = smoothstep(0., .19, surface.x) * (1. - smoothstep(.78, 1., surface.x));
          float edge = smoothstep(0., .035, surface.y) * (1. - smoothstep(.965, 1., surface.y));
          vec3 normal = normalize(cross(dFdx(world), dFdy(world)));
          float light = .3 + .7 * pow(abs(dot(normal, normalize(vec3(-.2, .8, 1.)))), .65);
          float highlight = pow(max(0., 1. - abs(surface.y - .55) * 1.8), 3.);
          vec3 pearl = mix(vec3(.31, .48, .63), vec3(.93, .91, .84), smoothstep(.15, .85, surface.x));
          pearl = mix(pearl, vec3(.93, .96, 1.), highlight * .75);
          gl_FragColor = vec4(pearl * light, thread * ends * edge * .92);
        }`,
    });
    const field = new THREE.Mesh(geometry, material);
    field.rotation.set(0.12, -0.18, -0.28);
    scene.add(field);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0,
      last = 0,
      lastDraw = 0,
      time = 0,
      visible = true,
      dirty = true,
      wasStill = false;
    let dragging = false,
      px = 0,
      py = 0,
      turn = 0,
      tilt = 0;
    const resize = () => {
      const w = node.clientWidth,
        h = node.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.position.z = w < 650 ? 16 : 14;
      camera.updateProjectionMatrix();
      dirty = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(node);
    resize();
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      dirty = true;
    });
    io.observe(node);
    const down = (e: PointerEvent) => {
      dragging = true;
      px = e.clientX;
      py = e.clientY;
      node.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      turn = Math.max(-0.4, Math.min(0.4, turn + (e.clientX - px) * 0.002));
      tilt = Math.max(-0.3, Math.min(0.3, tilt + (e.clientY - py) * 0.002));
      px = e.clientX;
      py = e.clientY;
      dirty = true;
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
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const still = pause.current || reduced.matches;
      if (!visible || document.hidden) return;
      if (!still) time += dt;
      if (now - lastDraw < 33 || (still && wasStill && !dirty)) return;
      lastDraw = now;
      dirty = false;
      wasStill = still;
      uniforms.time.value = time;
      field.rotation.y = -0.18 + turn;
      field.rotation.x = 0.12 + tilt;
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      io.disconnect();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);
  return (
    <div className={s.scene} ref={host} aria-hidden="true">
      {failed && (
        <svg className={s.fallback} viewBox="0 0 900 600">
          <defs>
            <linearGradient id="signal-fade">
              <stop stopColor="#516e85" />
              <stop offset=".5" stopColor="#ddd" />
              <stop offset="1" stopColor="#000" />
            </linearGradient>
          </defs>
          <g fill="none" stroke="url(#signal-fade)" strokeWidth=".8">
            {Array.from({length: 65}, (_, i) => (
              <path key={i} d={`M0 ${300 + i * 2} C240 ${-80 + i * 5} 370 ${670 - i * 3} 900 ${170 + i * 2}`} />
            ))}
          </g>
        </svg>
      )}
    </div>
  );
}
