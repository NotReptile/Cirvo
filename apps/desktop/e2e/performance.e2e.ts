import { test, expect } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

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
  // Production bootstrap shows the shell before the first channel response arrives.
  await page.evaluate(() => (window as any).__RUCORD_QA__.seed(0));
});

test("repeatable render measurements at 50, 1500 and 3000 messages", async ({
  page,
}) => {
  const results: unknown[] = [];
  for (const count of [50, 1500, 3000]) {
    const measurements = await page.evaluate((count) => {
      const qa = (window as any).__RUCORD_QA__;
      const initial = qa.seed(count);
      return {
        count,
        initial,
        runs: Array.from({ length: 5 }, () => qa.measure()),
      };
    }, count);
    results.push(measurements);
  }
  const dir = resolve("../../dev-notes/perf");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(
      dir,
      process.env.RUCORD_PERF_BASELINE ? "baseline.json" : "current.json",
    ),
    JSON.stringify(results, null, 2),
  );
  expect(results).toHaveLength(3);
});
