import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: { items: [] } }));
  await page.routeWebSocket("**/ws*", () => {});
  await page.goto("/");
  await page.waitForFunction(() => "__CIRVO_QA__" in window);
  await page.evaluate(() => (window as any).__CIRVO_QA__.seed(20));
});

test("Cirvo color picker updates existing settings and validates HEX", async ({ page }) => {
  await page.locator("#open-profile").click();
  await page.locator('[data-settings-tab="appearance"]').first().click();
  const input = page.locator("#ap-accent");
  const trigger = input.locator("..").locator("button");
  await trigger.click();
  const picker = page.locator(".cirvo-input-picker");
  await expect(picker).toBeVisible();
  await picker.locator('input').fill("#12");
  await picker.getByRole("button", { name: "Применить" }).click();
  await expect(picker).toBeVisible();
  await picker.locator('input').fill("#123abc");
  await picker.locator('input').press("Enter");
  await expect(input).toHaveValue("#123abc");
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())).toBe("#123abc");
});

test("Cirvo audit calendar changes and clears the filter within a small window", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.evaluate(() => {
    const qa = (window as any).__CIRVO_QA__;
    qa.state().modal = "audit";
    qa.render();
  });
  const input = page.locator("#audit-filter-from");
  const trigger = input.locator("..").locator("button");
  await trigger.click();
  const picker = page.locator(".cirvo-input-picker");
  await expect(picker).toBeVisible();
  const box = (await picker.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(800);
  expect(box.y + box.height).toBeLessThanOrEqual(600);
  const day = picker.locator('.cirvo-calendar-grid button').first();
  const value = await day.getAttribute("aria-label");
  await day.click();
  await expect(input).toHaveValue(value!);
  await trigger.click();
  await picker.getByRole("button", { name: "Очистить" }).click();
  await expect(input).toHaveValue("");
  await trigger.click();
  await picker.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("Tab and Shift+Tab stay inside an open settings dialog", async ({ page }) => {
  await page.locator("#open-profile").click();
  await page.locator('[data-modal-close].settings-close').focus();
  for (let i = 0; i < 45; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
  }
  await page.locator('[data-settings-tab="profile"]').first().focus();
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
});
