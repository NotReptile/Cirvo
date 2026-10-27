import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: { items: [] } }));
  await page.routeWebSocket("**/ws*", () => {});
  await page.goto("/");
  await page.waitForFunction(() => "__CIRVO_QA__" in window);
  await page.evaluate(() => (window as any).__CIRVO_QA__.seed(40));
});

test("server actions control menus and composer independently of primary role", async ({ page }) => {
  await page.evaluate(async () => {
    const caps = (window as any).__CIRVO_QA__.capabilities;
    const qa = (window as any).__CIRVO_QA__;
    qa.state().workspaces[0].role = "member";
    qa.state().workspaceMenu = { workspaceId: "qa-ws", x: 10, y: 10 };
    caps.workspaceCapabilities.set("qa-ws", { mode: "known", actions: ["workspace.update"] });
    caps.channelCapabilities.set("qa-chat", { mode: "known", actions: ["channel.view"] });
    qa.render();
  });
  await expect(page.locator('[data-workspace-action="manage-roles"]')).toBeVisible();
  await expect(page.locator("#send-form input[name=body]")).toBeDisabled();
  await expect(page.locator(".action-react")).toHaveCount(0);
  await page.evaluate(async () => {
    const caps = (window as any).__CIRVO_QA__.capabilities;
    const qa = (window as any).__CIRVO_QA__;
    qa.state().workspaces[0].role = "owner";
    caps.workspaceCapabilities.set("qa-ws", { mode: "known", actions: [] });
    qa.render();
  });
  await expect(page.locator('[data-workspace-action="manage-roles"]')).toHaveCount(0);
});

for (const status of [404, 403, 500]) {
  test(`capability endpoint ${status} only uses legacy fallback for a missing route`, async ({ page }) => {
    await page.route("**/api/v1/workspaces/qa-ws/capabilities", (route) => status === 404
      ? route.fulfill({ status, contentType: "text/plain", body: "404 page not found" })
      : route.fulfill({ status, json: { error: { code: status === 403 ? "authorization_denied" : "internal_error", message: "Unavailable" } } }));
    const result = await page.evaluate(async () => {
      const caps = (window as any).__CIRVO_QA__.capabilities;
      await caps.loadWorkspaceCapabilities("qa-ws");
      return { state: caps.workspaceCapabilities.get("qa-ws"), allowed: caps.canWorkspace("workspace.update", "qa-ws") };
    });
    expect(result.state.mode).toBe(status === 404 ? "legacy" : "error");
    expect(result.allowed).toBe(status === 404);
  });
}

test("structured resource 404 never enables legacy fallback", async ({ page }) => {
  await page.route("**/api/v1/channels/qa-chat/capabilities", (route) => route.fulfill({ status: 404,
    json: { error: { code: "resource_not_found_or_not_visible", message: "channel not visible" } } }));
  const result = await page.evaluate(async () => {
    const caps = (window as any).__CIRVO_QA__.capabilities;
    await caps.loadChannelCapabilities("qa-chat");
    const state = (window as any).__CIRVO_QA__.state();
    return { mode: caps.channelCapabilities.get("qa-chat").mode, selected: state.selectedChannelId, messages: state.messages.length };
  });
  expect(result).toEqual({ mode: "error", selected: null, messages: 0 });
});

test("RBAC invalidations coalesce, clear inaccessible channel and leave its voice session", async ({ page }) => {
  let requests = 0, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/workspaces/qa-ws", (route) => route.fulfill({ json: { id: "qa-ws", name: "QA", role: "member" } }));
  await page.route("**/api/v1/workspaces/qa-ws/categories", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/v1/workspaces/qa-ws/channels", async (route) => {
    requests++; await gate; await route.fulfill({ json: { items: [] } });
  });
  await page.route("**/api/v1/workspaces/qa-ws/capabilities", (route) => route.fulfill({ json: { actions: ["channel.view"] } }));
  await page.evaluate(async () => {
    const qa = (window as any).__CIRVO_QA__;
    (window as any).__leftVoice = false;
    (window as any).__oldVoice = qa.replaceVoiceManager({ getSnapshot: () => ({ channelId: "qa-chat" }), leave: async () => { (window as any).__leftVoice = true; },
      getLocalStream: () => null, getRemoteStream: () => null, isActive: () => false } as any);
    for (let i = 0; i < 20; i++) qa.event({ event: "permissions.updated", workspaceId: "qa-ws", payload: {} });
  });
  await expect(page.locator("#send-form input[name=body]")).toBeDisabled();
  release();
  await expect.poll(() => page.evaluate(() => (window as any).__leftVoice)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__CIRVO_QA__.state().selectedChannelId)).toBeNull();
  expect(requests).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => (window as any).__CIRVO_QA__.state().messages.length)).toBe(0);
  await page.evaluate(async () => {
    (window as any).__CIRVO_QA__.replaceVoiceManager((window as any).__oldVoice);
  });
});

test("presence and typing never request capabilities", async ({ page }) => {
  let requests = 0;
  await page.route("**/capabilities", (route) => { requests++; return route.fulfill({ json: { actions: [] } }); });
  await page.evaluate(() => {
    const qa = (window as any).__CIRVO_QA__;
    for (let i = 0; i < 20; i++) {
      qa.event({ event: "presence.updated", payload: { userId: "qa-user-1", mode: "online" } });
      qa.event({ event: "typing.start", payload: { channelId: "qa-chat", userId: "qa-user-1" } });
    }
  });
  await expect(page.locator("#typing-line")).not.toBeEmpty();
  expect(requests).toBe(0);
});
