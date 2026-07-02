// Wave 9: видео-эффекты камеры — размытие фона через Mediapipe Selfie
// Segmentation (@mediapipe/tasks-vision, WASM; модель selfie_segmenter
// ~250KB лежит в репо — self-host не ходит в Google CDN). Pipeline:
//
//   getUserMedia (raw camera track)
//     → <video> (скрытый) → маленький input-canvas (256×144, сегментация
//       дешёвая) → ImageSegmenter → маска человека (alpha)
//     → композит на выходном canvas полного разрешения:
//         1) copy + blur(4px): маска (сглаженные края);
//         2) source-in: резкий кадр — остаётся только человек;
//         3) destination-over + blur(N): размытый кадр подкладывается фоном
//     → canvas.captureStream() → track в RTCPeerConnection
//
// Тот же контракт, что у denoiser.ts (N.4): менеджеры зовут
// wrapCameraTrack() сразу после getUserMedia и держат pipeline;
// dispose() гасит raw-track, цикл и сегментер. Эффект применяется при
// следующем включении камеры (как и остальные voice-настройки).
//
// Деградация: WASM/модель не загрузились или сегментация упала на
// первом кадре → console.warn и прозрачный fallback на raw-track —
// камера работает без эффекта, звонок не ломается.

import { getVoiceSettings, type CameraEffect } from "./voiceSettings";

export interface CameraPipeline {
  track: MediaStreamTrack;
  // Реально ли работает эффект (false = passthrough/none/fallback).
  active: boolean;
  dispose(): void;
}

// Радиус размытия фона в долях ширины кадра — на 720p это ~8px и ~19px.
const BLUR_RATIO: Record<Exclude<CameraEffect, "none">, number> = {
  "blur-light": 0.006,
  "blur-strong": 0.015
};

// Сегментация на уменьшенном кадре: модель внутри всё равно 256×256,
// а перегонять маску в ImageData на полном разрешении — дорогой JS-цикл.
const SEG_W = 256;
const SEG_H = 144;

function passthrough(raw: MediaStreamTrack): CameraPipeline {
  return {
    track: raw,
    active: false,
    dispose: () => {
      raw.stop();
    }
  };
}

// Типы tasks-vision тянем только динамически — пакет с 11MB wasm не должен
// попадать в основной бандл.
type ImageSegmenterT = import("@mediapipe/tasks-vision").ImageSegmenter;

// Кэш ImageSegmenter'а на модуль: инициализация WASM ~сотни мс, а камера
// может включаться/выключаться много раз за звонок. runningMode VIDEO
// допускает переиспользование между сессиями камеры.
let segmenterPromise: Promise<ImageSegmenterT> | null = null;

async function loadSegmenter(): Promise<ImageSegmenterT> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const [{ ImageSegmenter }, wasmJsUrl, wasmBinUrl, modelUrl] = await Promise.all([
        import("@mediapipe/tasks-vision"),
        import("@mediapipe/tasks-vision/vision_wasm_internal.js?url"),
        import("@mediapipe/tasks-vision/vision_wasm_internal.wasm?url"),
        import("../assets/selfie_segmenter.tflite?url")
      ]);
      // FilesetResolver.forVisionTasks хочет CDN-каталог — вместо него
      // собираем WasmFileset руками из Vite-ассетов (только SIMD-вариант:
      // WebView2/Chromium его поддерживает всегда).
      const fileset = {
        wasmLoaderPath: wasmJsUrl.default,
        wasmBinaryPath: wasmBinUrl.default
      };
      return ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelUrl.default, delegate: "GPU" },
        runningMode: "VIDEO",
        outputCategoryMask: false,
        outputConfidenceMasks: true
      });
    })();
    // Ошибку не кэшируем — следующее включение камеры попробует заново.
    segmenterPromise.catch(() => {
      segmenterPromise = null;
    });
  }
  return segmenterPromise;
}

export async function wrapCameraTrack(raw: MediaStreamTrack): Promise<CameraPipeline> {
  const effect = getVoiceSettings().cameraEffect;
  if (effect === "none") {
    return passthrough(raw);
  }

  try {
    const segmenter = await loadSegmenter();

    const settings = raw.getSettings();
    const width = settings.width ?? 1280;
    const height = settings.height ?? 720;
    const fps = settings.frameRate ?? 30;

    // Скрытый video-элемент — источник кадров для canvas'ов.
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([raw]);
    await video.play();

    const inputCanvas = document.createElement("canvas");
    inputCanvas.width = SEG_W;
    inputCanvas.height = SEG_H;
    const inputCtx = inputCanvas.getContext("2d", { willReadFrequently: false })!;

    // Канвас с маской: alpha = уверенность «это человек».
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = SEG_W;
    maskCanvas.height = SEG_H;
    const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true })!;
    const maskImage = maskCtx.createImageData(SEG_W, SEG_H);
    // RGB маски не важен (используется только alpha через 'copy'+'source-in'),
    // но не-нулевой RGB упрощает отладку в devtools.
    for (let i = 0; i < maskImage.data.length; i += 4) {
      maskImage.data[i] = 255;
    }

    const outCanvas = document.createElement("canvas");
    outCanvas.width = width;
    outCanvas.height = height;
    const outCtx = outCanvas.getContext("2d")!;

    const blurPx = Math.max(4, Math.round(width * BLUR_RATIO[effect]));
    let disposed = false;

    const renderFrame = (): void => {
      if (disposed) return;
      inputCtx.drawImage(video, 0, 0, SEG_W, SEG_H);
      let result;
      try {
        result = segmenter.segmentForVideo(inputCanvas, performance.now());
      } catch {
        // Одиночный сбой кадра (например, gap при resize) — пропускаем.
        scheduleNext();
        return;
      }
      const mask = result?.confidenceMasks?.[0];
      if (mask) {
        const conf = mask.getAsFloat32Array();
        const px = maskImage.data;
        for (let i = 0; i < conf.length; i++) {
          px[i * 4 + 3] = (conf[i] * 255) | 0;
        }
        maskCtx.putImageData(maskImage, 0, 0);
        result.close();

        // 1) маска со сглаженными краями заменяет содержимое канваса;
        outCtx.globalCompositeOperation = "copy";
        outCtx.filter = "blur(4px)";
        outCtx.drawImage(maskCanvas, 0, 0, width, height);
        // 2) в область маски рисуем резкого человека;
        outCtx.globalCompositeOperation = "source-in";
        outCtx.filter = "none";
        outCtx.drawImage(video, 0, 0, width, height);
        // 3) под всё подкладываем размытый кадр — фон.
        outCtx.globalCompositeOperation = "destination-over";
        outCtx.filter = `blur(${blurPx}px)`;
        outCtx.drawImage(video, 0, 0, width, height);
        outCtx.filter = "none";
        outCtx.globalCompositeOperation = "source-over";
      }
      scheduleNext();
    };

    // requestVideoFrameCallback тикает с fps камеры (обычно 30) и не жжёт
    // CPU на 60Hz-мониторах; fallback на rAF для старых webview.
    const videoWithRVFC = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    const scheduleNext = (): void => {
      if (disposed) return;
      if (typeof videoWithRVFC.requestVideoFrameCallback === "function") {
        videoWithRVFC.requestVideoFrameCallback(renderFrame);
      } else {
        requestAnimationFrame(renderFrame);
      }
    };

    // Первый кадр гоним сразу — captureStream не отдаёт данные, пока на
    // канвасе ничего не нарисовано, и удалённая сторона видела бы чёрный
    // прямоугольник до первого тика.
    renderFrame();

    const outStream = outCanvas.captureStream(fps);
    const outTrack = outStream.getVideoTracks()[0];
    if (!outTrack) {
      throw new Error("captureStream returned no track");
    }

    return {
      track: outTrack,
      active: true,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        outTrack.stop();
        video.srcObject = null;
        raw.stop();
        // Сегментер НЕ закрываем — он общий на модуль (кэш) и переживает
        // сессии камеры; WASM-инстанс дешевле держать, чем реинициализировать.
      }
    };
  } catch (err) {
    console.warn("videoEffects: segmentation pipeline failed, falling back to raw camera", err);
    return passthrough(raw);
  }
}
