import assert from "node:assert/strict";
import { chromium } from "playwright";
import { preview } from "vite";

const server = await preview({
  configFile: false,
  root: process.cwd(),
  logLevel: "silent",
  base: "/",
  build: { outDir: "build/client" },
  preview: { host: "127.0.0.1", port: 0 },
});
const address = server.httpServer.address();
const url = `http://127.0.0.1:${address.port}/evidence/compatibility/`;
const browser = await chromium.launch({ headless: true });
try {
  const colors = {};
  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage({ colorScheme: scheme });
    await page.goto(url, { waitUntil: "load" });
    const block = page.locator('pre[data-code-title="src/add.ts"]');
    assert.equal(await block.getAttribute("data-label"), "typescript");
    const token = block
      .locator("code span span")
      .filter({ hasText: /^export$/ })
      .first();
    colors[scheme] = await token.evaluate((element) => getComputedStyle(element).color);
    const highlighted = block.locator('[data-ln="2"]');
    assert.match(await highlighted.getAttribute("class"), /highlighted/);
    assert.equal(
      await block.textContent().then((value) => value.includes("return left + right;")),
      true,
    );
    await page.close();
  }
  assert.equal(colors.light, "rgb(207, 34, 46)");
  assert.equal(colors.dark, "rgb(255, 123, 114)");
  console.log(JSON.stringify({ colors, sourceAndMetadata: true, highlightedLine: 2 }));
} finally {
  await browser.close();
  await new Promise((resolve, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : resolve())),
  );
}
