import { expect, test } from "@playwright/test";

test("friend row actions do not also open the profile", async ({ page }) => {
  const requests: string[] = [];
  await page.route("**/api/**", async route => {
    requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await route.fulfill({ json: { items: [] } });
  });
  await page.routeWebSocket("**/ws*", () => {});
  await page.goto("/");
  await page.waitForFunction(() => "__CIRVO_QA__" in window);
  await page.evaluate(() => (window as any).__CIRVO_QA__.seed(20));
  for (const [index, action] of ["accept", "remove", "unblock"].entries()) {
    await page.evaluate(action => {
      const qa = (window as any).__CIRVO_QA__;
      Object.assign(qa.state(), { modal: null, dmMode: true, selectedChannelId: null,
        friendsTab: action === "unblock" ? "blocked" : "pending",
        friends: [{ userId: "qa-friend", username: "qa_friend", displayName: "Friend QA",
          online: true, status: action === "unblock" ? "blocked" : "pending_in",
          since: "2026-10-01T12:00:00Z" }] });
      qa.render();
    }, action);
    const expected = action === "accept" ? "POST /api/v1/friends/qa-friend/accept" :
      action === "unblock" ? "DELETE /api/v1/friends/qa-friend/block" : "DELETE /api/v1/friends/qa-friend";
    await page.locator(`[data-friend-${action}="qa-friend"]`).click();
    await expect.poll(() => requests.includes(expected)).toBe(true);
    await expect.poll(() => requests.filter(url => url === "GET /api/v1/friends").length).toBe(index + 1);
    await expect.poll(() => page.evaluate(() => (window as any).__CIRVO_QA__.state().friendsLoading)).toBe(false);
    expect(await page.evaluate(() => (window as any).__CIRVO_QA__.state().modal)).toBeNull();
    expect(requests.some(url => url.includes("/users/qa-friend"))).toBe(false);
  }
  // The rest of the row retains its profile action.
  await page.evaluate(() => {
    const qa = (window as any).__CIRVO_QA__;
    Object.assign(qa.state(), { friendsTab: "all", friends: [{ userId: "qa-friend",
      username: "qa_friend", displayName: "Friend QA", status: "accepted", online: true,
      since: "2026-10-01T12:00:00Z" }] });
    qa.render();
  });
  await page.locator(".friends-row-name").click();
  await expect.poll(() => page.evaluate(() => (window as any).__CIRVO_QA__.state().modal)).toBe("userProfile");
});
