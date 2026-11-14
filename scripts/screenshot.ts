// Serves the built app and screenshots it: UI smoke test + submission cover image.
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const srv = spawn("npx", ["vite", "preview", "--port", "4173", "--strictPort"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, colorScheme: "dark" });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("http://localhost:4173/");
  await page.waitForSelector("text=Play auction");
  // step through the whole recording
  for (let i = 0; i < 40; i++) {
    const next = page.getByRole("button", { name: "Next step" });
    if (await next.isDisabled()) break;
    await next.click();
  }
  await page.waitForSelector("text=wins the auction");
  // cover: wind back to mid-reveal so both panes are populated, controls at the top of the frame
  await page.getByRole("button", { name: "Reset" }).click();
  for (let i = 0; i < 15; i++) await page.getByRole("button", { name: "Next step" }).click();
  await page.evaluate(() => document.querySelector(".controls")!.scrollIntoView());
  await page.screenshot({ path: "docs/cover.png" }); // 1280x720 >= 1200x675
  for (let i = 0; i < 40 && !(await page.getByRole("button", { name: "Next step" }).isDisabled()); i++)
    await page.getByRole("button", { name: "Next step" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "docs/mobile.png", fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log("horizontal overflow on mobile:", overflow);
  console.log("console/page errors:", errors.length ? errors : "none");
  console.log("entries rendered:", await page.locator(".entry").count());
} finally {
  await browser.close();
  srv.kill();
}
