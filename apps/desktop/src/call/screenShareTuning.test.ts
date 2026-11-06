import { describe, expect, it, vi } from "vitest";
import {
  applyCodecPreference,
  applySenderTuning,
  buildSendParameters,
  contentHintFor,
  degradationPreferenceFor,
  orderCodecs,
  resolveCodec,
  resolveMode,
  sanitizeScreenShareOptions,
  scaleDownFor,
  shouldUseNativeCapture,
} from "./screenShareTuning";

const q1080p60 = { width: 1920, height: 1080, frameRate: 60, maxBitrate: 10_000_000 };
const q1080p30 = { width: 1920, height: 1080, frameRate: 30, maxBitrate: 6_000_000 };
const q1440p60 = { width: 2560, height: 1440, frameRate: 60, maxBitrate: 18_000_000 };

describe("режим плавность / чёткость", () => {
  it("авто: плавность для 60 FPS, баланс для 30", () => {
    expect(resolveMode("auto", q1080p60)).toBe("smooth");
    expect(resolveMode("auto", q1080p30)).toBe("balanced");
  });
  it("явный выбор не зависит от пресета", () => {
    expect(resolveMode("sharp", q1080p60)).toBe("sharp");
    expect(resolveMode("smooth", q1080p30)).toBe("smooth");
  });
  it("contentHint и degradationPreference согласованы с режимом", () => {
    expect(contentHintFor("smooth")).toBe("motion");
    expect(contentHintFor("sharp")).toBe("detail");
    expect(contentHintFor("balanced")).toBe("");
    expect(degradationPreferenceFor("smooth")).toBe("maintain-framerate");
    expect(degradationPreferenceFor("sharp")).toBe("maintain-resolution");
    expect(degradationPreferenceFor("balanced")).toBe("balanced");
  });
});

describe("кодек и способ захвата", () => {
  it("авто выбирает H.264 только для тяжёлых пресетов", () => {
    expect(resolveCodec("auto", q1080p30)).toBe("default");
    expect(resolveCodec("auto", q1080p60)).toBe("h264");
    expect(resolveCodec("auto", q1440p60)).toBe("h264");
    expect(resolveCodec("vp8", q1440p60)).toBe("vp8");
  });
  it("авто-захват: системный для 60 FPS и >1080p", () => {
    expect(shouldUseNativeCapture("auto", q1080p30)).toBe(false);
    expect(shouldUseNativeCapture("auto", q1080p60)).toBe(true);
    expect(shouldUseNativeCapture("auto", { ...q1080p30, height: 1440 })).toBe(true);
    expect(shouldUseNativeCapture("compat", q1440p60)).toBe(false);
    expect(shouldUseNativeCapture("native", q1080p30)).toBe(true);
    expect(shouldUseNativeCapture("auto", undefined)).toBe(false);
  });
  it("битые значения из localStorage заменяются значениями по умолчанию", () => {
    expect(sanitizeScreenShareOptions({ mode: "x", codec: 5, capture: "native" })).toEqual({
      mode: "auto",
      codec: "auto",
      capture: "native",
    });
    expect(sanitizeScreenShareOptions(null).capture).toBe("auto");
  });
});

describe("scaleResolutionDownBy", () => {
  it("не увеличивает и не трогает подходящее разрешение", () => {
    expect(scaleDownFor(q1080p60, { width: 1920, height: 1080 })).toBe(1);
    expect(scaleDownFor(q1080p60, { width: 1280, height: 720 })).toBe(1);
    expect(scaleDownFor(q1080p60, undefined)).toBe(1);
  });
  it("уменьшает 4K-монитор до пресета 1080p", () => {
    expect(scaleDownFor(q1080p60, { width: 3840, height: 2160 })).toBe(2);
  });
  it("учитывает ультрашироский монитор по ширине", () => {
    expect(scaleDownFor(q1080p60, { width: 3440, height: 1440 })).toBe(1.79);
  });
});

describe("параметры sender'а", () => {
  it("задаёт потолки, приоритет и degradationPreference", () => {
    const params = { encodings: [{}] } as unknown as RTCRtpSendParameters;
    buildSendParameters(params, q1440p60, "smooth", { width: 2560, height: 1440 });
    const enc = params.encodings[0] as unknown as Record<string, unknown>;
    expect(enc.maxBitrate).toBe(18_000_000);
    expect(enc.maxFramerate).toBe(60);
    expect(enc.scaleResolutionDownBy).toBe(1);
    expect(enc.networkPriority).toBe("high");
    expect(enc.priority).toBe("high");
    expect((params as unknown as { degradationPreference: string }).degradationPreference).toBe(
      "maintain-framerate",
    );
  });
  it("создаёт encodings, если их нет", () => {
    const params = {} as RTCRtpSendParameters;
    buildSendParameters(params, q1080p30, "balanced");
    expect(params.encodings).toHaveLength(1);
  });
  it("при отказе в расширенных полях откатывается на битрейт и FPS", async () => {
    const calls: unknown[] = [];
    const sender = {
      track: { getSettings: () => ({ width: 1920, height: 1080 }) },
      getParameters: () => ({ encodings: [{}] }),
      setParameters: vi.fn(async (p: { encodings: Array<Record<string, unknown>> }) => {
        calls.push(JSON.parse(JSON.stringify(p)));
        if ("networkPriority" in p.encodings[0]) throw new Error("unsupported");
      }),
    } as unknown as RTCRtpSender;
    await applySenderTuning(sender, q1080p60, "smooth", []);
    expect(calls).toHaveLength(2);
    const last = calls[1] as { encodings: Array<Record<string, unknown>> };
    expect(last.encodings[0].maxBitrate).toBe(10_000_000);
    expect(last.encodings[0].maxFramerate).toBe(60);
  });
  it("повторяет попытку, пока setParameters не станет доступен", async () => {
    let n = 0;
    const sender = {
      track: null,
      getParameters: () => ({ encodings: [{}] }),
      setParameters: vi.fn(async () => {
        n += 1;
        if (n <= 2) throw new Error("not negotiated yet");
      }),
    } as unknown as RTCRtpSender;
    await applySenderTuning(sender, q1080p30, "balanced", [1, 1, 1]);
    // 2 вызова на первую попытку (полная + базовая) и 1 успешный на повторе.
    expect(n).toBe(3);
  });
});

describe("порядок кодеков", () => {
  const caps = [
    { mimeType: "video/VP8", clockRate: 90000 },
    { mimeType: "video/rtx", clockRate: 90000, sdpFmtpLine: "apt=96" },
    { mimeType: "video/VP9", clockRate: 90000 },
    { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "profile-level-id=42e01f" },
    { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "profile-level-id=640c1f" },
  ] as RTCRtpCodec[];

  it("выбранный кодек идёт первым, запасные сохраняются", () => {
    const ordered = orderCodecs(caps, "h264");
    expect(ordered.slice(0, 2).map((c) => c.mimeType)).toEqual(["video/H264", "video/H264"]);
    expect(ordered).toHaveLength(caps.length);
    expect(ordered.map((c) => c.mimeType).slice(2)).toEqual(["video/VP8", "video/rtx", "video/VP9"]);
  });
  it("default не меняет порядок", () => {
    expect(orderCodecs(caps, "default")).toBe(caps);
  });
  it("applyCodecPreference не падает без поддержки setCodecPreferences", () => {
    expect(() =>
      applyCodecPreference({ setCodecPreferences: () => { throw new Error("nope"); } } as unknown as RTCRtpTransceiver, "h264"),
    ).not.toThrow();
    expect(() => applyCodecPreference(undefined, "h264")).not.toThrow();
  });
});
