import { expect, test } from "@playwright/test";

test("loads the Studio shell and books API", async ({ page, request }) => {
  const api = await request.get("/api/v1/books");
  expect(api.ok()).toBe(true);
  await expect(api.json()).resolves.toMatchObject({
    books: expect.any(Array),
  });

  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();
});
