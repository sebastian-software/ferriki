export function finalCodeText(pre) {
  const code = pre?.querySelector("code");
  if (!code) return "";

  return Array.from(code.children)
    .filter((line) => line.classList.contains("line") && !line.classList.contains("remove"))
    .map((line) => line.textContent ?? "")
    .join("\n");
}

export function scrollCodeBlockFromKey(pre, event) {
  if (
    !["ArrowLeft", "ArrowRight"].includes(event.key) ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  )
    return false;

  const current = pre.scrollLeft;
  const maximum = pre.scrollWidth - pre.clientWidth;
  const distance = event.key === "ArrowRight" ? 48 : -48;
  const next = Math.max(0, Math.min(maximum, current + distance));
  if (next === current) return false;

  pre.scrollLeft = next;
  event.preventDefault();
  return true;
}

if (typeof document !== "undefined") {
  for (const pre of document.querySelectorAll(".code-example pre[tabindex='0']")) {
    pre.addEventListener("keydown", (event) => scrollCodeBlockFromKey(pre, event));
  }

  for (const button of document.querySelectorAll("[data-copy-code]")) {
    button.addEventListener("click", async () => {
      const pre = document.getElementById(button.getAttribute("aria-controls"));
      const status = document.getElementById(button.getAttribute("aria-describedby"));
      if (!pre || !status) return;

      try {
        await navigator.clipboard.writeText(finalCodeText(pre));
        status.textContent = "Final code copied.";
      } catch {
        status.textContent = "Copy failed. Select the code and copy it.";
      }
    });
  }
}
