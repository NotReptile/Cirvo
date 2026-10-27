import { expect, test } from "@playwright/test";

test("device labels survive asynchronous enumeration and repeated refreshes", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "enumerateDevices", { value: async () => [
      { kind: "audioinput", deviceId: "qa-mic", label: "USB Microphone", groupId: "qa" },
      { kind: "audiooutput", deviceId: "qa-out", label: "Headphones", groupId: "qa" },
      { kind: "videoinput", deviceId: "qa-cam", label: "Camera", groupId: "qa" },
    ] });
  });
  await page.route("**/api/**", route => route.fulfill({ json: { items: [] } }));
  await page.routeWebSocket("**/ws*", () => {});
  await page.goto("/");
  await page.waitForFunction(() => "__CIRVO_QA__" in window);
  await page.evaluate(() => (window as any).__CIRVO_QA__.seed(20));
  await page.locator("#open-profile").click();
  await page.locator("[data-settings-tab=voice]").first().click();
  const trigger = page.getByRole("combobox", { name: "Микрофон", exact: true });
  await expect(trigger).toContainText("Системный по умолчанию");
  await trigger.click();
  await page.locator(".listbox-portal.is-open").getByRole("option", { name: "USB Microphone", exact: true }).click();
  await expect(page.locator("#vs-audio-in")).toHaveValue("qa-mic");
  for (let i = 0; i < 3; i++) {
    await page.locator("#vs-refresh-devices").click();
    await expect(trigger).toContainText("USB Microphone");
    await expect(page.locator("#vs-audio-in")).toHaveValue("qa-mic");
  }
});

test("custom selects support keyboard access and escape modal clipping", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.route("**/api/**", (route) => route.fulfill({ json: { items: [] } }));
  await page.routeWebSocket("**/ws*", () => {});
  await page.goto("/");
  await page.waitForFunction(() => "__CIRVO_QA__" in window);
  await page.evaluate(() => (window as any).__CIRVO_QA__.seed(20));

  await page.evaluate(async () => {
    const shell = document.querySelector<HTMLElement>(".shell");
    if (!shell) throw new Error("App shell did not render");
    const modal = document.createElement("section");
    modal.id = "listbox-test-modal";
    modal.style.cssText =
      "position:fixed;left:20px;top:420px;width:360px;height:150px;overflow:auto;z-index:99999;background:#222;padding:12px";
    modal.innerHTML = `
      <div style="height:150px"></div>
      <label for="qa-listbox">Уровень оповещения</label>
      <select id="qa-listbox">
        <option value="quiet">Тихо</option>
        <option value="blocked" disabled>Недоступно</option>
        <option value="normal" selected>Обычно</option>
        <option value="loud">Громко</option>
      </select>
      <select id="qa-disabled-listbox" disabled aria-label="Недоступный список">
        <option value="only">Единственный вариант</option>
      </select>`;
    document.body.append(modal);
    const { polishListboxes } = await import("/src/app/listbox.ts");
    polishListboxes(modal);
    const select = modal.querySelector<HTMLSelectElement>("#qa-listbox")!;
    (window as any).__listboxChanges = 0;
    select.addEventListener("change", () => ((window as any).__listboxChanges += 1));
  });

  const trigger = page.getByRole("combobox", { name: "Уровень оповещения" });
  const disabledTrigger = page.locator("#qa-disabled-listbox + .listbox-trigger");
  const disabledPopupId = await page.locator("#qa-disabled-listbox").evaluate((select) =>
    select.parentElement?.querySelector<HTMLButtonElement>(".listbox-trigger")?.getAttribute("aria-controls"),
  );
  await expect(disabledTrigger).toBeDisabled();
  await expect(page.locator(`#${disabledPopupId}`)).toBeHidden();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const popupId = await page.locator("#qa-listbox").evaluate((select) => {
    const trigger = select.parentElement?.querySelector<HTMLButtonElement>(".listbox-trigger");
    return trigger?.getAttribute("aria-controls");
  });
  expect(popupId).toBeTruthy();
  const popup = page.locator(`#${popupId}`);
  await expect(popup).toBeVisible();
  // A delayed scroll from bringing the trigger into view must not close a
  // popup already positioned against the resulting anchor coordinates.
  await page.locator("#listbox-test-modal").evaluate((element) => {
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(popup).toBeVisible();
  await expect(popup).toHaveAttribute("role", "listbox");
  await expect(popup.locator("[role=option]")).toHaveCount(4);
  await expect(popup.locator('[role=option][data-value="blocked"]')).toHaveAttribute("aria-disabled", "true");

  const popupGeometry = await popup.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      inBodyPortal: element.parentElement === document.body,
      clippedByModal: Boolean(element.closest("#listbox-test-modal")),
      top: rect.top,
      bottom: rect.bottom,
      position: getComputedStyle(element).position,
    };
  });
  expect(popupGeometry.inBodyPortal).toBeTruthy();
  expect(popupGeometry.clippedByModal).toBeFalsy();
  expect(popupGeometry.position).toBe("fixed");
  expect(popupGeometry.top).toBeGreaterThanOrEqual(0);
  expect(popupGeometry.bottom).toBeLessThanOrEqual(600);

  await page.keyboard.press("ArrowDown");
  await expect(trigger).toHaveAttribute("aria-activedescendant", /option-3$/);
  await page.keyboard.press("Home");
  await expect(trigger).toHaveAttribute("aria-activedescendant", /option-0$/);
  await page.keyboard.press("ArrowDown");
  await expect(trigger).toHaveAttribute("aria-activedescendant", /option-2$/);
  await page.keyboard.press("End");
  await expect(trigger).toHaveAttribute("aria-activedescendant", /option-3$/);
  await page.keyboard.press("Enter");
  await expect(page.locator("#qa-listbox")).toHaveValue("loud");
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => (window as any).__listboxChanges)).toBe(1);

  await page.keyboard.press("ArrowUp");
  await expect(trigger).toHaveAttribute("aria-activedescendant", /option-2$/);
  await page.keyboard.press("Enter");
  await expect(page.locator("#qa-listbox")).toHaveValue("normal");
  expect(await page.evaluate(() => (window as any).__listboxChanges)).toBe(2);

  await page.keyboard.press("Space");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(popup).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => (window as any).__listboxChanges)).toBe(2);

  await trigger.click();
  await page.locator("#listbox-test-modal").evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await trigger.click();
  await page.setViewportSize({ width: 801, height: 600 });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await trigger.click();
  await page.locator("#listbox-test-modal").evaluate((element) => element.remove());
  await expect(popup).toBeHidden();
});
