// Light or dark: follows the system setting until the theme button picks one, which is kept on
// this device. A plain script in <head> (not a module), so the choice is set before the page draws
// and it never flashes the wrong colors. style.css reads <html data-theme>; brand.js redraws the
// wordmark on "themechange".
(() => {
  const KEY = "domiframe:theme";
  const root = document.documentElement;
  const system = matchMedia("(prefers-color-scheme: dark)");
  const BG = { light: "#e8e8e8", dark: "#111416" }; // --bg, for the browser's toolbar

  let picked = null;
  try { picked = localStorage.getItem(KEY); } catch {}
  const current = () => root.dataset.theme || (system.matches ? "dark" : "light");

  function apply(theme) {
    if (theme === "light" || theme === "dark") root.dataset.theme = theme;
    else delete root.dataset.theme;
    // Phones color their toolbars from theme-color; with a picked theme, both tags say it
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
      m.content = BG[theme || (m.media.includes("dark") ? "dark" : "light")];
    }
    const b = document.querySelector(".theme-toggle");
    if (b) {
      const next = current() === "dark" ? "light" : "dark";
      b.setAttribute("aria-label", `Switch to ${next} mode`);
      b.title = `Switch to ${next} mode`;
    }
    document.dispatchEvent(new Event("themechange"));
  }
  apply(picked);

  // The button goes in each page's header, before anything pushed to the right
  document.addEventListener("DOMContentLoaded", () => {
    const head = document.querySelector("header.site-head, header.brand");
    if (!head) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "theme-toggle";
    b.innerHTML = '<i aria-hidden="true"></i>';
    b.addEventListener("click", () => {
      const theme = current() === "dark" ? "light" : "dark";
      // Back to the system setting when the pick matches it, so a later system change still applies
      const keep = theme === (system.matches ? "dark" : "light") ? null : theme;
      try { keep ? localStorage.setItem(KEY, keep) : localStorage.removeItem(KEY); } catch {}
      apply(keep);
    });
    const right = head.querySelector(".frame-switch, #signout");
    head.insertBefore(b, right || null);
    apply(root.dataset.theme || null);
  });

  // No pick: follow the system as it changes
  system.addEventListener("change", () => { if (!root.dataset.theme) apply(null); });
})();
