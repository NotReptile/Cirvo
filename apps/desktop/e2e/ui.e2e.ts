import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: route.request().url().endsWith("/realtime/ticket")
        ? { ticket: "qa-ticket" }
        : { items: [], registrationOpen: false },
    }),
  );
  await page.routeWebSocket("**/ws*", () => {});
  await page.goto("/");
  await page.waitForFunction(() => "__RUCORD_QA__" in window);
  await page.evaluate(() => (window as any).__RUCORD_QA__.seed(3000));
});

test("presence and typing leave composer, message nodes and scroll intact", async ({
  page,
}) => {
  await page
    .locator("#send-form input[name=body]")
    .fill("Несохранённый черновик");
  const result = await page.evaluate(() => {
    const qa = (window as any).__RUCORD_QA__,
      list = document.querySelector("#message-list") as HTMLElement;
    const input = document.querySelector(
      "#send-form input[name=body]",
    ) as HTMLInputElement;
    const row = list.querySelector(".message");
    list.scrollTop -= 300;
    const top = list.scrollTop;
    const start = performance.now();
    qa.event({
      event: "presence.updated",
      payload: { userId: "qa-user-1", mode: "dnd", customStatus: "Занят" },
    });
    const presenceMs = performance.now() - start;
    qa.event({
      event: "typing.start",
      payload: { channelId: "qa-chat", userId: "qa-user-2" },
    });
    return {
      presenceMs,
      sameInput:
        input === document.querySelector("#send-form input[name=body]"),
      sameRow: row === list.querySelector(".message"),
      value: input.value,
      focused: input === document.activeElement,
      scrollDelta: list.scrollTop - top,
      nodes: document.querySelectorAll("*").length,
    };
  });
  expect(result.sameInput).toBeTruthy();
  expect(result.sameRow).toBeTruthy();
  expect(result.focused).toBeTruthy();
  expect(result.value).toContain("черновик");
  expect(result.scrollDelta).toBe(0);
  expect(result.nodes).toBeLessThan(10000);
  expect(result.presenceMs).toBeLessThan(process.env.CI ? 150 : 30);
  await expect(page.locator("#typing-line")).not.toBeEmpty();
});

test("created, edited, deleted and reacted messages update only affected rows", async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const qa = (window as any).__RUCORD_QA__,
      state = qa.state();
    const old = document.querySelector('[data-id="qa-message-2900"]');
    const started = performance.now();
    qa.event({
      event: "message.created",
      channelId: "qa-chat",
      payload: {
        id: "qa-created",
        channelId: "qa-chat",
        authorId: "qa-user-1",
        body: "Новое сообщение",
        createdAt: "2026-12-01T12:00:00Z",
      },
    });
    const createdMs = performance.now() - started;
    const same = old === document.querySelector('[data-id="qa-message-2900"]');
    qa.event({
      event: "message.reaction.added",
      channelId: "qa-chat",
      payload: { messageId: "qa-created", userId: "qa-me", emoji: "👍" },
    });
    qa.event({
      event: "message.updated",
      channelId: "qa-chat",
      payload: { ...state.messages.at(-1), body: "Отредактировано" },
    });
    return {
      same,
      createdMs,
      count: document.querySelectorAll("#message-list .message").length,
    };
  });
  expect(result.same).toBeTruthy();
  expect(result.count).toBe(200);
  expect(result.createdMs).toBeLessThan(process.env.CI ? 150 : 30);
  await expect(page.locator(".message[data-id=qa-created]")).toContainText(
    "Отредактировано",
  );
  await expect(page.locator(".message[data-id=qa-created]")).toContainText(
    "👍",
  );
  await page.evaluate(() =>
    (window as any).__RUCORD_QA__.event({
      event: "message.deleted",
      channelId: "qa-chat",
      payload: { id: "qa-created" },
    }),
  );
  await expect(page.locator(".message[data-id=qa-created]")).toHaveCount(0);
});

test("edit draft survives full renders, one submit stays one request", async ({
  page,
}) => {
  await page.evaluate(() => {
    const qa = (window as any).__RUCORD_QA__;
    qa.state().messages = qa
      .state()
      .messages.map((m: any) =>
        m.id === "qa-message-2999" ? { ...m, authorId: "qa-me" } : m,
      );
    qa.render();
  });
  await page
    .locator('.message[data-id="qa-message-2999"] .message-body')
    .hover();
  await page
    .locator('.message[data-id="qa-message-2999"] .action-edit')
    .click();
  const edit = page.locator(".edit-form input[name=body]");
  await edit.fill("Новый черновик правки");
  await page.locator("#send-form input[name=body]").focus();
  await page.evaluate(() => {
    const qa = (window as any).__RUCORD_QA__;
    for (let i = 0; i < 20; i++) qa.render();
  });
  await expect(edit).toHaveValue("Новый черновик правки");
  let requests = 0;
  await page.route("**/api/v1/messages/qa-message-2999", async (route) => {
    requests++;
    await route.fulfill({
      json: {
        id: "qa-message-2999",
        channelId: "qa-chat",
        authorId: "qa-me",
        body: "Новый черновик правки",
        createdAt: "2026-10-02T12:00:00Z",
      },
    });
  });
  await edit.press("Enter");
  await expect.poll(() => requests).toBe(1);
  await expect(page.locator(".edit-form")).toHaveCount(0);
});

test("cached history windows preserve anchor and replies reach outside the DOM", async ({
  page,
}) => {
  const before = await page
    .locator("#message-list .message")
    .first()
    .getAttribute("data-id");
  expect(before).toBe("qa-message-2800");
  await page.evaluate(() => {
    const list = document.querySelector("#message-list") as HTMLElement;
    list.scrollTop = 0;
    list.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator("#message-list .message").first()).toHaveAttribute(
    "data-id",
    "qa-message-2700",
  );
  await page.evaluate(() => {
    const qa = (window as any).__RUCORD_QA__;
    qa.state().messages = qa.state().messages.map((m: any) =>
      m.id === "qa-message-2750"
        ? {
            ...m,
            replyTo: {
              messageId: "qa-message-40",
              authorId: "qa-user-0",
              body: "Старое",
            },
          }
        : m,
    );
    qa.render();
  });
  await page
    .locator('[data-id="qa-message-2750"] .reply-snippet')
    .click({ force: true });
  await expect(page.locator('.message[data-id="qa-message-40"]')).toBeVisible();
  expect(await page.locator("#message-list .message").count()).toBe(200);
});

test("pins fetch around messages outside the cache", async ({ page }) => {
  await page.route("**/messages?limit=100&around=old-message", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "old-message",
            channelId: "qa-chat",
            authorId: "qa-user-0",
            body: "Далёкий закреп",
            createdAt: "2025-01-01T12:00:00Z",
          },
        ],
      },
    }),
  );
  await page.evaluate(() => {
    const qa = (window as any).__RUCORD_QA__,
      s = qa.state();
    s.pinsPopupOpen = true;
    s.channelPinsChannelId = "qa-chat";
    s.channelPins = [
      {
        id: "old-message",
        channelId: "qa-chat",
        authorId: "qa-user-0",
        body: "Далёкий закреп",
        createdAt: "2025-01-01T12:00:00Z",
      },
    ];
    qa.render();
  });
  await page.locator("[data-pin-jump=old-message]").click();
  await expect(page.locator(".message[data-id=old-message]")).toBeVisible();
});

test("settings tabs and modal close work after repeated renders", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#open-profile").click();
  const tabs = await page
    .locator(".settings-tab[data-settings-tab]")
    .evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.settingsTab),
    );
  for (const tab of tabs) {
    await page.locator(`.settings-tab[data-settings-tab="${tab}"]`).click();
    await expect(page.locator(".settings-modal")).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-modal")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("pins refresh in place and equal-size block lists invalidate the right rows", async ({
  page,
}) => {
  await page.evaluate(() => {
    const qa = (window as any).__RUCORD_QA__,
      state = qa.state();
    state.pinsPopupOpen = true;
    state.channelPinsChannelId = "qa-chat";
    state.channelPins = [];
    state.blockedIds = new Set(["qa-user-0"]);
    qa.render();
    qa.event({
      event: "message.pinned",
      channelId: "qa-chat",
      payload: { ...state.messages.at(-1), isPinned: true },
    });
  });
  await expect(page.locator(".pins-popup .pin-row")).toHaveCount(1);
  await page.evaluate(() => {
    const qa = (window as any).__RUCORD_QA__,
      s = qa.state();
    s.blockedIds = new Set(["qa-user-1"]);
    qa.render();
  });
  await expect(
    page.locator('.message[data-id="qa-message-2980"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-reveal-blocked="qa-message-2981"]'),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as any).__RUCORD_QA__.event({
      event: "message.unpinned",
      channelId: "qa-chat",
      payload: { id: "qa-message-2999", channelId: "qa-chat" },
    }),
  );
  await expect(page.locator(".pins-popup .pin-row")).toHaveCount(0);
});

test("voice video nodes survive presence and full updates without duplicate ids", async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const qa = (window as any).__RUCORD_QA__,
      s = qa.state();
    s.selectedChannelId = "qa-voice";
    s.voiceSnapshot = {
      state: "joined",
      channelId: "qa-voice",
      selfSessionId: "qa-session",
      muted: false,
      cameraOn: true,
      screenSharing: false,
      participants: [
        {
          userId: "qa-me",
          sessionId: "qa-session",
          username: "qa_me",
          joinedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    qa.render();
    const video = document.querySelector("video[data-voice-self]");
    qa.event({
      event: "presence.updated",
      payload: { userId: "qa-user-1", mode: "online" },
    });
    for (let i = 0; i < 5; i++) qa.render();
    const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
    return {
      video: !!video,
      same: video === document.querySelector("video[data-voice-self]"),
      duplicateIds: ids.filter((id, i) => ids.indexOf(id) !== i),
      muteButtons: document.querySelectorAll("[data-voice-action=mute]").length,
    };
  });
  expect(result.video).toBeTruthy();
  expect(result.same).toBeTruthy();
  expect(result.duplicateIds).toEqual([]);
  expect(result.muteButtons).toBe(2);
});

test("chat and direct messages fill the window while overlay regions update", async ({
  page,
}) => {
  for (const width of [800, 1000, 1280, 1920]) {
    await page.setViewportSize({ width, height: width === 800 ? 600 : 800 });
    for (const dmMode of [false, true]) {
      await page.evaluate((dmMode) => {
        const qa = (window as any).__RUCORD_QA__;
        qa.state().dmMode = dmMode;
        qa.state().selectedChannelId = dmMode ? null : "qa-chat";
        qa.state().status = "Проверка уведомления";
        qa.render();
      }, dmMode);
      const checkHeight = async () => {
        const layout = await page.evaluate(() => {
          const rect = (selector: string) =>
            document.querySelector(selector)!.getBoundingClientRect();
          const shell = rect(".shell");
          return {
            viewportGap: innerHeight - shell.bottom,
            contentGap: shell.bottom - rect(".content").bottom,
            userGap: shell.bottom - rect(".user-strip").bottom,
          };
        });
        expect(Math.abs(layout.viewportGap)).toBeLessThanOrEqual(1);
        expect(Math.abs(layout.contentGap)).toBeLessThanOrEqual(1);
        expect(Math.abs(layout.userGap)).toBeLessThanOrEqual(1);
      };
      await checkHeight();
      await page.locator("#open-profile").click();
      await expect(page.locator(".settings-modal")).toBeVisible();
      await checkHeight();
      await page.keyboard.press("Escape");
      await expect(page.locator(".settings-modal")).toHaveCount(0);
      await checkHeight();
    }
  }
});

test("light theme fits supported window sizes with an active call", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const appearance = await import("/src/app/appearance.ts");
    appearance.updateAppearance({ theme: "light" });
    const qa = (window as any).__RUCORD_QA__;
    qa.state().callSnapshot = {
      state: "active",
      peerUserId: "qa-user-1",
      startedAt: Date.now(),
      muted: false,
      cameraOn: false,
      screenSharing: false,
    };
    qa.render();
  });
  for (const width of [800, 899, 901, 1000, 1280, 1920]) {
    await page.setViewportSize({ width, height: width === 800 ? 600 : 800 });
    const layout = await page.evaluate(() => {
      const rect = (selector: string) =>
        document.querySelector(selector)!.getBoundingClientRect();
      const composer = rect("#send-form"),
        call = rect(".call-bar");
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        overlap: composer.bottom > call.top + 1,
        composerGap: call.top - composer.bottom,
        contentGap: rect(".shell").bottom - rect(".content").bottom,
        height: rect(".shell").height,
        theme: document.documentElement.dataset.theme,
      };
    });
    expect(layout.theme).toBe("light");
    expect(layout.overflow).toBeFalsy();
    expect(layout.overlap).toBeFalsy();
    expect(Math.abs(layout.composerGap)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.contentGap)).toBeLessThanOrEqual(1);
    expect(layout.height).toBeGreaterThan(400);
  }
  await page.screenshot({ path: "../../dev-notes/perf/light-call-1920.png" });
});

test("RNNoise worklet and MediaPipe WASM load under the release CSP", async ({
  page,
}) => {
  await page.context().grantPermissions(["microphone", "camera"]);
  const result = await page.evaluate(async () => {
    const settings = await import("/src/call/voiceSettings.ts");
    const denoiser = await import("/src/call/denoiser.ts");
    const effects = await import("/src/call/videoEffects.ts");
    const config = await fetch("/src-tauri/tauri.conf.json").then((r) =>
      r.json(),
    );
    const meta = document.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content = config.app.security.csp;
    document.head.append(meta);
    settings.updateVoiceSettings({
      denoiserMode: "rucord",
      cameraEffect: "blur-light",
    });
    const audio = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mic = await denoiser.wrapMicStream(audio);
    const camera = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240 },
    });
    const effect = await effects.wrapCameraTrack(camera.getVideoTracks()[0]);
    const active = { mic: mic.active, camera: effect.active };
    mic.dispose();
    effect.dispose();
    return active;
  });
  expect(result.mic).toBeTruthy();
  expect(result.camera).toBeTruthy();
});
