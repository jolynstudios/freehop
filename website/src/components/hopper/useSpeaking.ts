import {useEffect, useRef, useState} from 'react';

export type AudioSource = {key: string; track: MediaStreamTrack};

type Meter = {track: MediaStreamTrack; source: MediaStreamAudioSourceNode; analyser: AnalyserNode; loudAt: number};

const THRESHOLD = 0.018; // RMS of the waveform, roughly -35 dBFS
const HOLD_MS = 450; // keep the ring on between words
const EMPTY: ReadonlySet<string> = new Set();

const same = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every(k => b.has(k));

/**
 * Who is speaking, from Web Audio level meters on each audio track (remote and your own).
 * One AudioContext serves every meter. It exists only while `active`, which starts after the
 * visitor pressed Join, and it is closed when the call ends.
 */
export function useSpeaking(sources: AudioSource[], active: boolean): ReadonlySet<string> {
  const [speaking, setSpeaking] = useState<ReadonlySet<string>>(EMPTY);
  const ctxRef = useRef<AudioContext | null>(null);
  const meters = useRef(new Map<string, Meter>());

  useEffect(() => {
    if (!active) return;
    const Ctx = window.AudioContext ?? (window as unknown as {webkitAudioContext?: typeof AudioContext}).webkitAudioContext;
    if (!Ctx) return;
    let ctx: AudioContext;
    try {
      ctx = new Ctx();
    } catch {
      return;
    }
    ctxRef.current = ctx;
    const resume = () => {
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    };
    resume();
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
    const buffer = new Float32Array(1024);
    const timer = window.setInterval(() => {
      const now = performance.now();
      const next = new Set<string>();
      for (const [key, meter] of meters.current) {
        meter.analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
        if (meter.track.enabled && Math.sqrt(sum / buffer.length) > THRESHOLD) meter.loudAt = now;
        if (now - meter.loudAt < HOLD_MS) next.add(key);
      }
      setSpeaking(previous => (same(previous, next) ? previous : next));
    }, 120);
    const all = meters.current;
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
      for (const meter of all.values()) meter.source.disconnect();
      all.clear();
      ctxRef.current = null;
      void ctx.close().catch(() => {});
      setSpeaking(EMPTY);
    };
  }, [active]);

  // One meter per live track; a replaced track (another microphone) gets a fresh meter.
  const signature = sources.map(s => `${s.key}:${s.track.id}:${s.track.readyState}`).join('|');
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const wanted = new Map(sources.filter(s => s.track.readyState === 'live').map(s => [s.key, s.track]));
    for (const [key, meter] of meters.current) {
      if (wanted.get(key) === meter.track) continue;
      meter.source.disconnect();
      meters.current.delete(key);
    }
    for (const [key, track] of wanted) {
      if (meters.current.has(key)) continue;
      try {
        const source = ctx.createMediaStreamSource(new MediaStream([track]));
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        meters.current.set(key, {track, source, analyser, loudAt: 0});
      } catch {
        /* a track that cannot be metered simply shows no speaking ring */
      }
    }
    // `signature` captures every change to `sources` that matters here.
  }, [signature, active]);

  return speaking;
}

/** A 0..1 input level for one track, for the waiting room's microphone check. */
export function useLevel(track: MediaStreamTrack | null): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!track || track.readyState !== 'live') {
      setLevel(0);
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as {webkitAudioContext?: typeof AudioContext}).webkitAudioContext;
    if (!Ctx) return;
    let ctx: AudioContext;
    try {
      ctx = new Ctx();
    } catch {
      return;
    }
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buffer = new Float32Array(1024);
    const timer = window.setInterval(() => {
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
      const rms = track.enabled ? Math.sqrt(sum / buffer.length) : 0;
      // Map roughly -50..-10 dBFS onto 0..1.
      const db = 20 * Math.log10(Math.max(rms, 1e-5));
      setLevel(Math.max(0, Math.min(1, (db + 50) / 40)));
    }, 90);
    return () => {
      window.clearInterval(timer);
      source.disconnect();
      void ctx.close().catch(() => {});
      setLevel(0);
    };
  }, [track]);
  return level;
}
