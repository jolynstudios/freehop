import type {PathKind} from '../PathBadge';

// The real Freehop browser client, copied from ../src/client into static/lib at build time and
// loaded at runtime, exactly like the live call demo. These types cover what Hopper uses.
type Emitter = {on(type: string, fn: (detail: any) => void): () => void};

export type RoomStats = {
  gates: {url: string; state: string; bytesIn: number; bytesOut: number}[];
  links: {
    peer: string;
    connected: boolean;
    phase: number;
    path: {kind: PathKind; via?: string | null};
    media: {inbound: Record<string, {packets: number; bytes: number; frames: number}>};
  }[];
};

export type FreehopRoom = Emitter & {
  id: string;
  localStream: MediaStream | null;
  setMicrophone(on: boolean): Promise<void>;
  setCamera(on: boolean): Promise<void>;
  switchDevice(kind: 'audio' | 'video', deviceId: string | null): Promise<boolean>;
  send(data: unknown, options?: {to?: string}): Promise<number>;
  stats(): Promise<RoomStats>;
  leave(): Promise<void>;
};

export type ClientModule = {join(options: Record<string, unknown>): Promise<FreehopRoom>};

// The same public WebTorrent trackers (as gates) and STUN servers as the live call demo.
export const TRACKERS = ['bt+wss://tracker.openwebtorrent.com', 'bt+wss://tracker.webtorrent.dev'];
export const STUN = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];
// Hopper's own app name keeps its meetings apart from the live call demo's rooms.
export const APP = 'hopper';

// Tracker stats expose a plain wss URL; configuration and events may use bt+wss.
export const trackerKey = (url: string) => (url.startsWith('bt+') ? url : `bt+${url}`);
export const trackerName = (url: string) => trackerKey(url).replace('bt+wss://', '');

/** Plain-language reason a microphone could not start, by DOMException name. */
export function micProblem(err: {name?: string; message?: string}): string {
  switch (err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Your browser blocked the microphone for this page. Allow it in the site settings (the icon next to the address), then try again. You can also join without a microphone and just listen.';
    case 'NotReadableError':
    case 'AbortError':
      return 'Your microphone is busy in another app or tab. Close it there, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Hopper could not find a microphone. Plug one in and try again, or join without a microphone and just listen.';
    default:
      return `Hopper could not start the microphone (${err.message ?? 'unknown error'}).`;
  }
}

/** Plain-language reason a camera could not start, by DOMException name. */
export function cameraProblem(err: {name?: string; message?: string}): string {
  switch (err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Your browser blocked the camera for this page. Allow it in the site settings (the icon next to the address), then turn the camera on again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'Your camera is busy in another app or tab. Close it there, then turn the camera on again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Hopper could not find a camera on this device.';
    default:
      return `The camera did not start (${err.message ?? 'unknown error'}).`;
  }
}

/** Whether this browser can send call audio to a chosen speaker. */
export const canPickSpeaker = () =>
  typeof HTMLMediaElement !== 'undefined' && typeof (HTMLMediaElement.prototype as {setSinkId?: unknown}).setSinkId === 'function';

export type DeviceChoice = {audio: string | null; video: string | null; speaker: string | null};

export type DeviceLists = {audio: MediaDeviceInfo[]; video: MediaDeviceInfo[]; speaker: MediaDeviceInfo[]};

/** Devices the browser reports. Labels are only filled in once the page has device permission. */
export async function listDevices(): Promise<DeviceLists> {
  const empty: DeviceLists = {audio: [], video: [], speaker: []};
  if (!navigator.mediaDevices?.enumerateDevices) return empty;
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    // Chrome adds "default" and "communications" aliases for real devices; keep them, they are what people expect.
    return {
      audio: all.filter(d => d.kind === 'audioinput' && d.deviceId),
      video: all.filter(d => d.kind === 'videoinput' && d.deviceId),
      speaker: all.filter(d => d.kind === 'audiooutput' && d.deviceId),
    };
  } catch {
    return empty;
  }
}
