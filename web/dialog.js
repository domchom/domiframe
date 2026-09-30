// In-page dialogs instead of the browser's confirm/prompt/alert. Browsers let people block those
// ("prevent this page from creating more dialogs"), after which confirm() silently says no and
// actions like "Remove all" just do nothing.

let dlg = null;

function build() {
  dlg = document.createElement("dialog");
  dlg.className = "ask";
  dlg.innerHTML = `
    <form method="dialog">
      <h2 class="ask-title"></h2>
      <p class="ask-message"></p>
      <input class="text ask-input" autocomplete="off">
      <div class="ask-buttons">
        <button type="button" class="chip ask-cancel"></button>
        <button type="submit" class="chip ask-ok"></button>
      </div>
    </form>`;
  document.body.append(dlg);
}

/**
 * Ask something. Resolves to the typed text (with `input`), true (confirmed) or null (cancelled).
 * @param {{ title: string, message?: string, ok?: string, cancel?: string|null, danger?: boolean,
 *           input?: { value?: string, placeholder?: string }, mustType?: string }} o
 *   mustType: the OK button stays disabled until exactly this is typed (for deleting things)
 */
export function ask(o) {
  if (!dlg) build();
  const $ = (sel) => dlg.querySelector(sel);
  const input = $(".ask-input"), ok = $(".ask-ok"), cancel = $(".ask-cancel");
  $(".ask-title").textContent = o.title;
  $(".ask-message").textContent = o.message || "";
  $(".ask-message").hidden = !o.message;
  const wantsText = !!(o.input || o.mustType);
  input.hidden = !wantsText;
  input.value = o.input?.value || "";
  input.placeholder = o.input?.placeholder || o.mustType || "";
  ok.textContent = o.ok || "OK";
  ok.classList.toggle("danger", !!o.danger);
  cancel.textContent = o.cancel || "Cancel";
  cancel.hidden = o.cancel === null;
  const check = () => {
    ok.disabled = o.mustType ? input.value.trim() !== o.mustType : o.input ? !input.value.trim() : false;
  };
  check();

  return new Promise((resolve) => {
    let answer = null;
    const done = () => {
      input.removeEventListener("input", check);
      cancel.onclick = null;
      dlg.onclose = null;
      resolve(answer);
    };
    input.addEventListener("input", check);
    cancel.onclick = () => dlg.close();
    dlg.onclose = done; // Escape closes too: counts as cancel
    $("form").onsubmit = (e) => {
      if (ok.disabled) { e.preventDefault(); return; }
      answer = wantsText ? input.value.trim() : true;
    };
    dlg.showModal();
    (wantsText ? input : ok).focus();
    if (wantsText) input.select();
  });
}

/** Tell the person something (one button). */
export const tell = (title, message) => ask({ title, message, cancel: null });
