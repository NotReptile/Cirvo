import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: { items: [] } }));
  await page.routeWebSocket("**/ws*", () => {});
  await page.goto("/");
  await page.waitForFunction(() => "__RUCORD_QA__" in window);
  await page.evaluate(() => {
    const qa = (window as any).__RUCORD_QA__;
    qa.seed(20);
    qa.state().me.presenceMode = "dnd";
    qa.state().me.customStatus = "Проверяем интерфейс";
    qa.render();
  });
});

test("self mini-profile opens above the strip, shares status and enters profile settings", async ({ page }) => {
  await page.locator("#open-self-profile").click();
  const profile = page.locator(".user-profile-popup");
  await expect(profile).toBeVisible();
  await expect(profile.locator(".user-profile-name")).toContainText("Тестировщик");
  await expect(profile.locator("#open-status")).toContainText("Не беспокоить");
  await expect(profile.locator(".user-profile-status")).toHaveText("Проверяем интерфейс");
  for (const size of [{ width: 1280, height: 800 }, { width: 800, height: 600 }]) {
    await page.setViewportSize(size);
    await expect.poll(async () => { const bounds = await profile.boundingBox(); return bounds!.y + bounds!.height; }).toBeLessThanOrEqual(size.height - 7);
    const box = await profile.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(7);
    expect(box!.y).toBeGreaterThanOrEqual(7);
    expect(box!.x + box!.width).toBeLessThanOrEqual(size.width - 7);
    expect(box!.y + box!.height).toBeLessThanOrEqual(size.height - 7);
  }
  await profile.locator("#open-status").click();
  await expect(page.locator(".status-menu")).toBeVisible();
  const box = await page.locator(".status-menu").boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".status-menu")).toHaveCount(0);
  await profile.locator("[data-self-profile-edit]").click();
  await expect.poll(() => page.evaluate(() => (window as any).__RUCORD_QA__.state().modal)).toBe("settings");
  await expect.poll(() => page.evaluate(() => (window as any).__RUCORD_QA__.state().settings.tab)).toBe("profile");
});

test("member mini-profile follows live presence and dismisses without losing composer draft", async ({ page }) => {
  await page.locator("#send-form input[name=body]").fill("Черновик сообщения");
  await page.locator('[data-member-user="qa-user-0"]').click();
  const profile = page.locator(".user-profile-popup");
  await expect(profile).toBeVisible();
  await page.evaluate(() => (window as any).__RUCORD_QA__.event({ event: "presence.updated",
    payload: { userId: "qa-user-0", mode: "idle", customStatus: "Отошёл" } }));
  await expect(profile.locator(".user-profile-presence")).toContainText("Неактивен");
  await expect(profile.locator(".user-profile-status")).toHaveText("Отошёл");
  await profile.locator(".user-profile-close").click();
  await expect(profile).toHaveCount(0);
  await expect(page.locator('[data-member-user="qa-user-0"]')).toBeFocused();
  await expect(page.locator("#send-form input[name=body]")).toHaveValue("Черновик сообщения");
});

test("message authors open the same anchored mini-profile by keyboard", async ({ page }) => {
  const author = page.locator('.message .profile-name-button').first();
  await author.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".user-profile-popup")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".user-profile-popup")).toHaveCount(0);
  await expect(author).toBeFocused();
});

test("late profile responses cannot repopulate a dismissed mini-profile", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/users/qa-user-0", async route => {
    await pending;
    await route.fulfill({ json: { id: "qa-user-0", username: "stale", bio: "Delayed profile" } });
  });
  await page.locator('[data-member-user="qa-user-0"]').click();
  await page.locator(".user-profile-close").click();
  const response = page.waitForResponse(response => response.url().endsWith("/api/v1/users/qa-user-0"));
  release();
  await (await response).finished();
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  await expect(page.locator(".user-profile-popup")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__RUCORD_QA__.state().userProfileData)).toBeNull();
});
