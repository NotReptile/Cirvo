import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: { items: [] } }));
  await page.routeWebSocket("**/ws*", () => {});
  await page.goto("/");
  await page.waitForFunction(() => "__CIRVO_QA__" in window);
  await page.evaluate(() => (window as any).__CIRVO_QA__.seed(20));
});

test("role permission changes enable Save immediately and reverting disables it", async ({ page }) => {
  await page.evaluate(() => {
    const qa = (window as any).__CIRVO_QA__;
    const role = { id: "qa-role", code: "member", name: "Member", color: null,
      position: 1, hoisted: false, system: true, memberUserIds: [],
      baseActionMask: ["message.write"] };
    qa.state().modal = "workspaceRoles";
    qa.state().workspaceRoles = { workspaceId: "qa-ws", roles: [role],
      selectedRoleId: role.id, loading: false, saving: false, error: null,
      draft: { ...role, color: "", baseActionMask: [...role.baseActionMask] } };
    qa.render();
  });
  const save = page.locator("#role-save");
  const permission = page.locator('[data-role-action="message.write"]');
  await expect(save).toBeDisabled();
  await permission.uncheck();
  await expect(save).toBeEnabled();
  await permission.check();
  await expect(save).toBeDisabled();
  await page.locator("#role-name").fill("Changed");
  await expect(save).toBeEnabled();
  await page.locator("#role-name").fill("Member");
  await expect(save).toBeDisabled();
  await permission.uncheck();
  let body: any;
  await page.route("**/api/v1/workspaces/qa-ws/roles/qa-role", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({ json: { id: "qa-role", code: "member", system: true,
      memberUserIds: [], ...body } });
  });
  await save.click();
  await expect(save).toBeDisabled();
  expect(body.baseActionMask).toEqual([]);
});

test("late channel permission response cannot overwrite a newly opened editor", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/channels/qa-chat/permissions", async (route) => {
    await gate;
    await route.fulfill({ json: { channelId: "qa-chat", actions: ["message.write"],
      roles: ["member"], overrides: [] } });
  });
  await page.route("**/api/v1/channels/qa-chat/user-permissions", (route) =>
    route.fulfill({ json: { channelId: "qa-chat", actions: [], overrides: [] } }));
  await page.evaluate(async () => {
    const qa = (window as any).__CIRVO_QA__;
    qa.state().channelSettings = { channelId: "qa-chat", loading: true, draft: {}, userDraft: {} };
    (window as any).__permissionLoad = qa.permissions.loadChannelPermissions();
  });
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__permissionLoad))).toBe(true);
  await page.evaluate(() => {
    (window as any).__CIRVO_QA__.state().channelSettings = {
      channelId: "qa-other", loading: true, draft: { sentinel: {} }, userDraft: {}, data: null,
    };
  });
  release();
  await page.evaluate(() => (window as any).__permissionLoad);
  expect(await page.evaluate(() => (window as any).__CIRVO_QA__.state().channelSettings))
    .toMatchObject({ channelId: "qa-other", loading: true, data: null, draft: { sentinel: {} } });
});

test("saving one role preserves an unsaved draft in another selected role", async ({ page }) => {
  await page.evaluate(() => {
    const qa = (window as any).__CIRVO_QA__;
    const roles = ["first", "second"].map((id) => ({ id, code: id, name: id,
      color: null, position: 1, hoisted: false, system: false, memberUserIds: [], baseActionMask: [] }));
    qa.state().modal = "workspaceRoles";
    qa.state().workspaceRoles = { workspaceId: "qa-ws", roles, selectedRoleId: "first",
      loading: false, saving: false, error: null, draft: { ...roles[0], color: "" } };
    qa.render();
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/workspaces/qa-ws/roles/first", async (route) => {
    const body = route.request().postDataJSON();
    await gate;
    await route.fulfill({ json: { id: "first", code: "first", memberUserIds: [], ...body } });
  });
  await page.locator("#role-name").fill("Saved first");
  await page.locator("#role-save").click();
  await page.locator('[data-select-role="second"]').click();
  await page.locator("#role-name").fill("Unsaved second");
  release();
  await expect(page.locator("#role-save")).toBeEnabled();
  await expect(page.locator("#role-name")).toHaveValue("Unsaved second");
  expect(await page.evaluate(() => (window as any).__CIRVO_QA__.state().workspaceRoles.draft.name))
    .toBe("Unsaved second");
});

for (const kind of ["category", "roles"] as const) {
  test(`late ${kind} response cannot overwrite a newly opened editor`, async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const path = kind === "category" ? "categories/qa-category/permissions" : "workspaces/qa-ws/roles";
    await page.route(`**/api/v1/${path}`, async (route) => {
      await gate;
      await route.fulfill({ json: kind === "category"
        ? { roles: ["member"], actions: ["message.write"], overrides: [] }
        : { items: [{ id: "old-role", baseActionMask: [], memberUserIds: [] }] } });
    });
    await page.evaluate(async (kind) => {
      const qa = (window as any).__CIRVO_QA__;
      const mod = qa.permissions;
      if (kind === "category") (window as any).__permissionLoad = mod.openCategoryPermissions("qa-category");
      else {
        qa.state().workspaceRoles = { workspaceId: "qa-ws", loading: true, roles: [], draft: null };
        (window as any).__permissionLoad = mod.reloadWorkspaceRoles();
      }
    }, kind);
    await page.evaluate((kind) => {
      const state = (window as any).__CIRVO_QA__.state();
      if (kind === "category") state.categoryPerms = { categoryId: "new-category", loading: true, data: null, draft: {} };
      else state.workspaceRoles = { workspaceId: "new-ws", loading: true, roles: [], draft: null };
    }, kind);
    release();
    await page.evaluate(() => (window as any).__permissionLoad);
    const result = await page.evaluate((kind) => {
      const state = (window as any).__CIRVO_QA__.state();
      return kind === "category" ? state.categoryPerms : state.workspaceRoles;
    }, kind);
    expect(result).toMatchObject(kind === "category"
      ? { categoryId: "new-category", loading: true, data: null, draft: {} }
      : { workspaceId: "new-ws", loading: true, roles: [], draft: null });
  });
}
