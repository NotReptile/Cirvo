// Воспроизведение удалённого звука голосового канала. Каждый аудио-трек
// участника (голос и звук демонстрации экрана) идёт отдельным узлом:
// MediaStreamSource → GainNode → destination. Так громкость каждого
// регулируется независимо и может быть выше 100% (HTMLMediaElement.volume
// ограничен единицей, GainNode — нет).
//
// Один <video> на участника играет только картинку (muted): раньше его
// звук шёл вторым проигрыванием того же стрима, и громкость регулировала
// лишь одну из двух копий.
//
// Декларативный API: caller передаёт полный список нужных слотов, роутер
// сам создаёт, обновляет и освобождает узлы. Слот пересоздаётся, если
// трек сменился; завершённые треки пропускаются.

import { clampVolume } from "./participantVolumes";

export interface RemoteAudioSlot {
  id: string;
  track: MediaStreamTrack;
  // 0..2, локальная громкость слота (без учёта общей громкости и deafen).
  volume: number;
}

export interface RemoteAudioOutput {
  // Общая громкость вывода, 0..1 (настройка «Громкость вывода»).
  volume?: number;
  deafened?: boolean;
  // Идентификатор устройства вывода; "" — системное по умолчанию.
  sinkId?: string;
}

// Минимальные интерфейсы WebAudio/DOM, нужные роутеру. Подменяются в тестах.
interface AudioNodeLike {
  connect(target: unknown): unknown;
  disconnect(): void;
}
interface GainNodeLike extends AudioNodeLike {
  gain: { value: number };
}
export interface AudioContextLike {
  readonly destination: unknown;
  readonly state?: string;
  createMediaStreamSource(stream: MediaStream): AudioNodeLike;
  createGain(): GainNodeLike;
  resume?(): Promise<void>;
  setSinkId?(id: string): Promise<void>;
  close?(): Promise<void>;
}
export interface HolderElementLike {
  // HTMLMediaElement.srcObject: MediaProvider | null; сужать тип не нужно.
  srcObject: unknown;
  muted: boolean;
  autoplay: boolean;
  remove(): void;
}

export interface RemoteAudioRouterDeps {
  createContext?: () => AudioContextLike | null;
  createHolder?: () => HolderElementLike | null;
}

interface SlotNode {
  track: MediaStreamTrack;
  volume: number;
  source: AudioNodeLike;
  gain: GainNodeLike;
  holder: HolderElementLike | null;
}

function defaultCreateContext(): AudioContextLike | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: new () => AudioContextLike;
    webkitAudioContext?: new () => AudioContextLike;
  };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

function defaultCreateHolder(): HolderElementLike | null {
  if (typeof document === "undefined") return null;
  const el = document.createElement("audio");
  // Chromium/WebView2 может не отдавать звук стрима в WebAudio, пока тот же
  // стрим не «отрисован» медиа-элементом. Элемент без звука (muted) выполняет
  // эту роль, сам ничего не проигрывает.
  el.muted = true;
  el.autoplay = true;
  el.style.display = "none";
  document.body.appendChild(el);
  return el;
}

export class RemoteAudioRouter {
  private ctx: AudioContextLike | null = null;
  private ctxFailed = false;
  private readonly nodes = new Map<string, SlotNode>();
  private outputVolume = 1;
  private deafened = false;
  private sinkId = "";

  constructor(private readonly deps: RemoteAudioRouterDeps = {}) {}

  get slotIds(): string[] {
    return [...this.nodes.keys()];
  }

  sync(slots: RemoteAudioSlot[]): void {
    const wanted = new Set(slots.map((s) => s.id));
    for (const [id, node] of this.nodes) {
      if (!wanted.has(id)) this.release(id, node);
    }
    for (const slot of slots) {
      const existing = this.nodes.get(slot.id);
      if (existing && existing.track === slot.track) {
        this.setVolume(slot.id, slot.volume);
        continue;
      }
      if (existing) this.release(slot.id, existing);
      if (slot.track.readyState === "ended") continue;
      this.attach(slot);
    }
  }

  setVolume(id: string, volume: number): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.volume = clampVolume(volume);
    this.applyGain(node);
  }

  setOutput(output: RemoteAudioOutput): void {
    if (output.volume !== undefined && Number.isFinite(output.volume)) {
      this.outputVolume = Math.min(1, Math.max(0, output.volume));
    }
    if (output.deafened !== undefined) this.deafened = output.deafened;
    if (output.sinkId !== undefined && output.sinkId !== this.sinkId) {
      this.sinkId = output.sinkId;
      const ctx = this.ctx;
      if (ctx?.setSinkId) {
        ctx.setSinkId(this.sinkId).catch(() => {
          // Устройство пропало или не поддерживается — остаёмся на системном выводе.
        });
      }
    }
    for (const node of this.nodes.values()) this.applyGain(node);
  }

  dispose(): void {
    for (const [id, node] of [...this.nodes]) this.release(id, node);
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx?.close) void ctx.close().catch(() => {});
  }

  private ensureContext(): AudioContextLike | null {
    if (this.ctx) return this.ctx;
    if (this.ctxFailed) return null;
    const create = this.deps.createContext ?? defaultCreateContext;
    this.ctx = create();
    if (!this.ctx) this.ctxFailed = true;
    if (this.ctx?.state === "suspended") void this.ctx.resume?.()?.catch(() => {});
    if (this.ctx && this.sinkId && this.ctx.setSinkId) {
      this.ctx.setSinkId(this.sinkId).catch(() => {});
    }
    return this.ctx;
  }

  private attach(slot: RemoteAudioSlot): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    try {
      const stream = new MediaStream([slot.track]);
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      source.connect(gain);
      gain.connect(ctx.destination);
      const holderFactory = this.deps.createHolder ?? defaultCreateHolder;
      const holder = holderFactory();
      if (holder) holder.srcObject = stream;
      const node: SlotNode = { track: slot.track, volume: clampVolume(slot.volume), source, gain, holder };
      this.applyGain(node);
      this.nodes.set(slot.id, node);
    } catch {
      // Трек закрылся между проверкой и подключением — следующий sync подберёт заново.
    }
  }

  private release(id: string, node: SlotNode): void {
    try {
      node.source.disconnect();
    } catch {
      /* уже отключён */
    }
    try {
      node.gain.disconnect();
    } catch {
      /* уже отключён */
    }
    if (node.holder) {
      node.holder.srcObject = null;
      node.holder.remove();
    }
    this.nodes.delete(id);
  }

  private applyGain(node: SlotNode): void {
    node.gain.gain.value = this.deafened ? 0 : node.volume * this.outputVolume;
  }
}

// Общий роутер приложения: единственный AudioContext на все голоса канала.
export const remoteAudioRouter = new RemoteAudioRouter();
