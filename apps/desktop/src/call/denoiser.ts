// N.2+N.4: RuCord-шумодав — RNNoise (xiph.org, GRU, ~85KB весов) через WASM
// в AudioWorklet. Пакет @sapphi-red/web-noise-suppressor (MIT) даёт готовый
// worklet-процессор и загрузчик wasm (simd-вариант подхватывается сам, если
// поддерживается). Pipeline:
//
//   getUserMedia (raw) → AudioContext(48kHz) → MediaStreamSource
//     ├→ RnnoiseWorkletNode → wetGain ─┐
//     └→ dryGain ─────────────────────┴→ MediaStreamDestination → PC
//
// Интенсивность (0..100) — dry/wet микс: 100 = только очищенный сигнал,
// 0 = только оригинал (как ручка Strength в OBS). Режим rucord-aggressive
// всегда 100% wet (а browser-NS дополнительно включён в constraints — см.
// buildAudioConstraints).
//
// Менеджеры (callManager / voiceChannelManager) вызывают wrapMicStream()
// сразу после getUserMedia и держат возвращённый pipeline:
//   - pipeline.stream — то, что идёт в addTrack/localStream;
//   - pipeline.dispose() — в teardown'е, останавливает raw-треки и AudioContext.
// Для off/browser pipeline прозрачный (stream === raw), dispose всё равно
// обязателен (no-op кроме остановки raw — её делает и сам manager, повторный
// stop() безопасен).
//
// Деградация: WASM/worklet не загрузился (нет файлов в сборке, старый
// webview) → консольный warn и прозрачный fallback на raw-стрим с нативным
// browser-NS — звонок не ломаем никогда.

import { getVoiceSettings, subscribeVoiceSettings, type DenoiserMode } from "./voiceSettings";

export interface MicPipeline {
  stream: MediaStream;
  // Активен ли реально RNNoise (false = прозрачный fallback/off/browser).
  active: boolean;
  dispose(): void;
}

function isRucordMode(mode: DenoiserMode): boolean {
  return mode === "rucord" || mode === "rucord-aggressive";
}

// WASM-байты кэшируем на модуль (один fetch на сессию приложения);
// addModule — per-AudioContext, поэтому он внутри wrapMicStream.
let wasmPromise: Promise<ArrayBuffer> | null = null;

async function loadWasm(): Promise<ArrayBuffer> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const [{ loadRnnoise }, wasmUrl, wasmSimdUrl] = await Promise.all([
        import("@sapphi-red/web-noise-suppressor"),
        import("@sapphi-red/web-noise-suppressor/rnnoise.wasm?url"),
        import("@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url")
      ]);
      return loadRnnoise({ url: wasmUrl.default, simdUrl: wasmSimdUrl.default });
    })();
    // Неудачную загрузку не кэшируем — следующий звонок попробует снова
    // (сеть могла мигнуть на lazy-чанке).
    wasmPromise.catch(() => {
      wasmPromise = null;
    });
  }
  return wasmPromise;
}

function passthrough(raw: MediaStream): MicPipeline {
  return {
    stream: raw,
    active: false,
    dispose: () => {
      for (const t of raw.getTracks()) t.stop();
    }
  };
}

export async function wrapMicStream(raw: MediaStream): Promise<MicPipeline> {
  const settings = getVoiceSettings();
  if (!isRucordMode(settings.denoiserMode)) {
    return passthrough(raw);
  }

  try {
    const [{ RnnoiseWorkletNode }, workletUrl, wasmBinary] = await Promise.all([
      import("@sapphi-red/web-noise-suppressor"),
      import("@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url"),
      loadWasm()
    ]);

    // RNNoise обучен на 48kHz-фреймах (480 сэмплов) — фиксируем rate явно,
    // ресемплинг с нативного rate микрофона берёт на себя Chromium.
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule(workletUrl.default);
    // Join идёт из user-gesture, но на всякий случай — autoplay-policy
    // может оставить контекст suspended.
    void ctx.resume();

    const source = ctx.createMediaStreamSource(raw);
    const rnnoise = new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
    const wetGain = ctx.createGain();
    const dryGain = ctx.createGain();
    const dest = ctx.createMediaStreamDestination();

    const applyMix = () => {
      const s = getVoiceSettings();
      // aggressive — всегда полный wet; интенсивность слайдера только для rucord.
      const wet = s.denoiserMode === "rucord-aggressive" ? 1 : Math.min(100, Math.max(0, s.denoiserIntensity)) / 100;
      wetGain.gain.value = wet;
      dryGain.gain.value = 1 - wet;
    };
    applyMix();
    // Слайдер интенсивности в настройках пишет в voiceSettings без render() —
    // подписка делает изменение слышимым прямо в активном звонке.
    const unsubscribe = subscribeVoiceSettings(applyMix);

    source.connect(rnnoise);
    rnnoise.connect(wetGain);
    wetGain.connect(dest);
    source.connect(dryGain);
    dryGain.connect(dest);

    let disposed = false;
    return {
      stream: dest.stream,
      active: true,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        try {
          rnnoise.destroy();
        } catch {
          /* worklet мог не дожить до destroy */
        }
        void ctx.close();
        for (const t of raw.getTracks()) t.stop();
        for (const t of dest.stream.getTracks()) t.stop();
      }
    };
  } catch (err) {
    console.warn("denoiser: RNNoise pipeline failed, falling back to raw mic", err);
    // В rucord-режиме browser-NS отключён в constraints (RNNoise должен
    // видеть сырой шум) — при fallback'е возвращаем хотя бы нативный NS,
    // чтобы юзер не остался совсем без шумодава.
    void raw.getAudioTracks()[0]?.applyConstraints({ noiseSuppression: true }).catch(() => undefined);
    return passthrough(raw);
  }
}
