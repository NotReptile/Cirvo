import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: { items: [], actions: [] } }));
  await page.routeWebSocket("**/ws*", () => {});
  await page.goto("/");
  await page.waitForFunction(() => "__RUCORD_QA__" in window);
  await page.evaluate(async () => {
    const moduleUrl = "/src/app/state.ts";
    const { uiContext } = await import(moduleUrl);
    uiContext.connState = "connected";
    const qa = (window as any).__RUCORD_QA__;
    qa.seed(20);
    const s = qa.state();
    s.selectedChannelId = "qa-voice";
    s.me.presenceMode = "idle";
    s.me.customStatus = "Собираем команду";
    s.me.nameGradient = "#fe6688,#8866ff";
    s.voiceSnapshot = {
      state: "active", channelId: "qa-voice", selfSessionId: "qa-session", error: null,
      muted: false, cameraOn: false, screenSharing: false,
      participants: [
        { userId: "qa-me", sessionId: "qa-session", username: "qa_me", displayName: "Тестировщик", joinedAt: "2026-10-10T00:00:00Z" },
        { userId: "qa-user-0", sessionId: "peer-0", username: "qa_user_0", displayName: "Участник 0", joinedAt: "2026-10-10T00:00:00Z" },
        { userId: "qa-user-1", sessionId: "peer-1", username: "qa_user_1", displayName: "Участник 1", joinedAt: "2026-10-10T00:00:00Z" },
      ],
    };
    const remote = new MediaStream();
    (window as any).__voiceRemote = remote;
    const update = (patch: object) => { s.voiceSnapshot = { ...s.voiceSnapshot, ...patch }; qa.render(); };
    qa.replaceVoiceManager({
      getSnapshot: () => s.voiceSnapshot,
      isActive: () => s.voiceSnapshot?.state === "active",
      getLocalStream: () => null,
      getRemoteStream: () => remote,
      toggleMute: () => update({ muted: !s.voiceSnapshot.muted }),
      setMute: (muted: boolean) => update({ muted }),
      setPttGate: () => {},
      toggleCamera: async () => update({ cameraOn: !s.voiceSnapshot.cameraOn }),
      toggleScreenShare: async () => update({ screenSharing: !s.voiceSnapshot.screenSharing }),
      leave: async () => { s.voiceSnapshot = null; qa.render(); },
    });
    qa.render();
  });
});

test("voice stage fills available space and keeps controls at its bottom at every window size", async ({ page }, testInfo) => {
  for (const [width, height] of [[800, 600], [1000, 700], [1280, 800], [1920, 900]]) {
    await page.setViewportSize({ width, height });
    const boxes = await page.evaluate(() => {
      const rect = (selector: string) => {
        const r = document.querySelector(selector)!.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, width: r.width };
      };
      return { content: rect("main.content"), room: rect(".voice-room"), body: rect(".voice-room-body"), controls: rect(".voice-room-actions"),
        strip: rect(".voice-strip"), self: rect(".user-strip"), docWidth: document.documentElement.scrollWidth };
    });
    expect(boxes.docWidth).toBeLessThanOrEqual(width);
    expect(boxes.room.bottom).toBeGreaterThanOrEqual(boxes.content.bottom - 2);
    expect(boxes.body.height).toBeGreaterThan(height * 0.45);
    expect(boxes.controls.bottom).toBeLessThanOrEqual(boxes.room.bottom);
    expect(boxes.room.bottom - boxes.controls.bottom).toBeLessThanOrEqual(26);
    expect(boxes.controls.left).toBeGreaterThanOrEqual(boxes.room.left);
    expect(boxes.controls.right).toBeLessThanOrEqual(boxes.room.right);
    expect(Math.abs(boxes.strip.bottom - boxes.self.top)).toBeLessThanOrEqual(2);
    await expect(page.locator(".voice-strip [data-voice-action=mute]")).toHaveCount(0);
    await expect(page.locator(".voice-strip [data-voice-action=leave]")).toBeVisible();
    if (width === 800 || width === 1920)
      await page.screenshot({ path: testInfo.outputPath(`voice-stage-${width}.png`) });
  }
});

test("screen sharing gets available stage space and rearranges tiles without replacing videos", async ({ page }) => {
  const result = await page.evaluate(() => {
    const qa = (window as any).__RUCORD_QA__;
    const video = document.querySelector("video[data-voice-self]");
    qa.state().voiceSnapshot = { ...qa.state().voiceSnapshot, screenSharing: true };
    qa.render();
    const sameSharing = video === document.querySelector("video[data-voice-self]");
    qa.state().voiceSnapshot = { ...qa.state().voiceSnapshot, screenSharing: false };
    qa.render();
    return { sameSharing, sameAfter: video === document.querySelector("video[data-voice-self]") };
  });
  expect(result).toEqual({ sameSharing: true, sameAfter: true });
  await page.evaluate(() => {
    const qa = (window as any).__RUCORD_QA__;
    qa.state().voiceSnapshot = { ...qa.state().voiceSnapshot, screenSharing: true };
    qa.render();
  });
  for (const [width, height] of [[800, 600], [1920, 900]]) {
    await page.setViewportSize({ width, height });
    const primary = (await page.locator(".voice-primary").boundingBox())!;
    const body = (await page.locator(".voice-room-body").boundingBox())!;
    expect(primary.height).toBeGreaterThan(body.height * 0.55);
    expect(primary.width).toBeGreaterThan(body.width * 0.95);
    await expect(page.locator('.voice-room-actions [data-voice-action="screen"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('.voice-room-actions [data-voice-action="camera"]')).toBeDisabled();
  }
});

test("stage and self-strip audio controls stay synchronized and preserve remote video identity", async ({ page }) => {
  await expect(page.locator('[data-voice-action="mute"]')).toHaveCount(2);
  await expect(page.locator('[data-voice-action="deafen"]')).toHaveCount(2);
  await page.evaluate(() => { (window as any).__keptVideo = document.querySelector('video[data-voice-peer="peer-0"]'); });
  await page.locator('.voice-room-actions [data-voice-action="mute"]').click();
  await expect(page.locator('[data-voice-action="mute"][aria-pressed="true"]')).toHaveCount(2);
  await page.locator('.user-strip [data-voice-action="mute"]').click();
  await expect(page.locator('[data-voice-action="mute"][aria-pressed="false"]')).toHaveCount(2);
  await page.locator('.user-strip [data-voice-action="deafen"]').click();
  await expect(page.locator('[data-voice-action="deafen"][aria-pressed="true"]')).toHaveCount(2);
  await expect(page.locator('[data-voice-action="mute"][aria-pressed="true"]')).toHaveCount(2);
  expect(await page.locator('video[data-voice-peer="peer-0"]').evaluate((el: HTMLVideoElement) => el.muted)).toBe(true);
  await page.locator('.voice-room-actions [data-voice-action="deafen"]').click();
  await expect(page.locator('[data-voice-action="deafen"][aria-pressed="false"]')).toHaveCount(2);
  expect(await page.locator('video[data-voice-peer="peer-0"]').evaluate((el: HTMLVideoElement) => el.muted)).toBe(false);
  await page.evaluate(() => {
    (window as any).__RUCORD_QA__.event({ event: "presence.updated", payload: { userId: "qa-user-0", mode: "dnd", customStatus: "Занят" } });
  });
  await expect(page.locator('[data-voice-tile="peer-0"] .voice-tile-custom-status')).toHaveText("Занят");
  const media = await page.evaluate(() => {
    const qa = (window as any).__RUCORD_QA__;
    for (let i = 0; i < 5; i++) qa.render();
    const current = document.querySelector('video[data-voice-peer="peer-0"]') as HTMLVideoElement;
    const ids = [...document.querySelectorAll("[id]")].map(el => el.id);
    return { same: current === (window as any).__keptVideo, sameStream: current.srcObject === (window as any).__voiceRemote,
      duplicateIds: ids.filter((id, i) => ids.indexOf(id) !== i) };
  });
  expect(media).toEqual({ same: true, sameStream: true, duplicateIds: [] });
  await expect(page.locator('[data-voice-tile="qa-session"] .voice-tile-placeholder')).toContainText("Собираем команду");
  await expect(page.locator('[data-voice-tile="peer-0"] .voice-tile-placeholder')).toContainText("Занят");
  expect(await page.locator('[data-voice-tile="qa-session"] .voice-name').getAttribute("style")).toContain("linear-gradient");
});

test("voice avatar and name open the participant profile without replacing video", async ({ page }) => {
  await page.route("**/api/v1/users/qa-user-0", route => route.fulfill({ json: {
    id: "qa-user-0", username: "qa_user_0", displayName: "Участник 0", presenceMode: "idle", customStatus: "Отошёл", bio: "Профиль участника",
  } }));
  await page.evaluate(() => { (window as any).__keptVideo = document.querySelector('video[data-voice-peer="peer-0"]'); });
  await page.locator('[data-voice-tile="peer-0"] .voice-name').click();
  await expect(page.locator(".user-profile-popup")).toBeVisible();
  await expect(page.locator(".user-profile-popup")).toContainText("Участник 0");
  expect(await page.evaluate(() => (window as any).__keptVideo === document.querySelector('video[data-voice-peer="peer-0"]'))).toBe(true);
  await page.keyboard.press("Escape");
  await page.locator('[data-voice-tile="peer-0"] .voice-tile-avatar-button').click();
  await expect(page.locator(".user-profile-popup")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator("#open-self-profile").click();
  await expect(page.locator("#open-notifications")).toHaveCount(1);
  await expect(page.locator("#open-admin")).toHaveCount(1);
  await page.locator("#open-notifications").click();
  await expect.poll(() => page.evaluate(() => (window as any).__RUCORD_QA__.state().modal)).toBe("notifications");
});

test("switching text channels leaves a compact connection panel and functioning disconnect", async ({ page }) => {
  await page.evaluate(() => {
    const qa = (window as any).__RUCORD_QA__;
    qa.state().selectedChannelId = "qa-chat";
    qa.render();
  });
  await expect(page.locator(".voice-room")).toHaveCount(0);
  await expect(page.locator(".voice-strip")).toBeVisible();
  await expect(page.locator('.user-strip [data-voice-action="mute"]')).toBeVisible();
  await page.locator('.voice-strip [data-voice-action="leave"]').click();
  await expect(page.locator(".voice-strip")).toHaveCount(0);
});

test("direct-call audio controls share one state between call bar and self strip", async ({ page }) => {
  await page.evaluate(async () => {
    const moduleUrl = "/src/app/state.ts";
    const { uiContext } = await import(moduleUrl);
    const qa = (window as any).__RUCORD_QA__, s = qa.state();
    s.voiceSnapshot = null;
    s.selectedChannelId = "qa-chat";
    s.callSnapshot = { state: "active", peerUserId: "qa-user-0", muted: false, cameraOn: false, screenSharing: false,
      startedAt: Date.now(), via: "direct" };
    const remote = new MediaStream();
    const update = (patch: object) => { s.callSnapshot = { ...s.callSnapshot, ...patch }; qa.render(); };
    uiContext.callMgr = {
      getSnapshot: () => s.callSnapshot, isActive: () => s.callSnapshot?.state === "active",
      getLocalStream: () => null, getRemoteStream: () => remote,
      toggleMute: () => update({ muted: !s.callSnapshot.muted }), setMute: (muted: boolean) => update({ muted }),
      setPttGate: () => {}, hangup: () => { s.callSnapshot = null; qa.render(); },
    };
    qa.render();
  });
  await expect(page.locator('[data-call-action="mute"]')).toHaveCount(2);
  await expect(page.locator('[data-call-action="deafen"]')).toHaveCount(2);
  await page.locator('.user-strip [data-call-action="mute"]').click();
  await expect(page.locator('[data-call-action="mute"][aria-pressed="true"]')).toHaveCount(2);
  await page.locator('.call-bar [data-call-action="mute"]').click();
  await expect(page.locator('[data-call-action="mute"][aria-pressed="false"]')).toHaveCount(2);
  await page.locator('.call-bar [data-call-action="deafen"]').click();
  await expect(page.locator('[data-call-action="deafen"][aria-pressed="true"]')).toHaveCount(2);
  expect(await page.locator("video[data-call-remote]").evaluate((el: HTMLVideoElement) => el.muted)).toBe(true);
  await page.locator('.user-strip [data-call-action="deafen"]').click();
  await expect(page.locator('[data-call-action="deafen"][aria-pressed="false"]')).toHaveCount(2);
  await page.locator("#call-hangup").click();
  await expect(page.locator('[data-call-action="mute"]')).toHaveCount(0);
});
