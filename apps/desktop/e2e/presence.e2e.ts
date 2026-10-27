import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: { items: [] } }));
  await page.routeWebSocket("**/ws*", () => {});
  await page.goto("/");
  await page.waitForFunction(() => "__CIRVO_QA__" in window);
  await page.evaluate(() => { const qa = (window as any).__CIRVO_QA__; qa.seed(20); qa.render(); });
});

test("manual idle and DND survive activity after automatic idle", async ({ page }) => {
  const writes: any[] = [];
  await page.route("**/users/me/status", async route => {
    const body = route.request().postDataJSON(); writes.push(body);
    await route.fulfill({ json: { id: "qa-self", presenceMode: body.mode, customStatus: body.customStatus, updatedAt: new Date().toISOString() } });
  });
  for (const mode of ["idle", "dnd"]) {
    await page.evaluate(async mode => {
      const qa = (window as any).__CIRVO_QA__;
      qa.presence.startIdleAutoDetect(); qa.presence.setIdleAuto(true);
      await qa.presence.saveStatus(mode, "manual");
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    }, mode);
    await expect.poll(() => page.evaluate(() => (window as any).__CIRVO_QA__.state().me.presenceMode)).toBe(mode);
    expect(writes.map(value => value.mode)).toEqual(mode === "idle" ? ["idle"] : ["idle", "dnd"]);
    expect(await page.evaluate(() => (window as any).__CIRVO_QA__.presence.idleAuto())).toBe(false);
  }
});

test("invisible public events stay private and a late member snapshot cannot replace realtime", async ({ page }) => {
  await page.evaluate(() => {
    const qa = (window as any).__CIRVO_QA__;
    qa.state().me.presenceMode = "invisible"; qa.state().me.customStatus = "private";
    const revision = qa.presence.presenceRevision();
    qa.event({ event: "presence.updated", payload: { userId: "qa-user-0", mode: "dnd", customStatus: "fresh" } });
    qa.presence.applyPresenceSnapshot("qa-user-0", { presenceMode: "online", customStatus: "old" }, revision);
    qa.event({ event: "presence.updated", payload: { userId: qa.state().me.id, mode: "offline", customStatus: "" } });
  });
  await expect.poll(() => page.evaluate(() => (window as any).__CIRVO_QA__.presence.resolveUserPresence("qa-user-0"))).toEqual({ mode: "dnd", online: true, customStatus: "fresh" });
  expect(await page.evaluate(() => { const qa = (window as any).__CIRVO_QA__; return qa.presence.resolveUserPresence(qa.state().me.id); })).toEqual({ mode: "invisible", online: false, customStatus: "private" });
});
