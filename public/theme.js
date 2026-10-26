// ライト/ダーク切り替え。手動で選んだらそれを保存し、未選択なら OS の設定に従う。
(() => {
  const KEY = "wtt-theme";
  const root = document.documentElement;
  const media = matchMedia("(prefers-color-scheme: dark)");

  const read = () => {
    try { return localStorage.getItem(KEY); } catch { return null; }
  };
  const current = () => read() || (media.matches ? "dark" : "light");

  const apply = () => {
    const saved = read();
    if (saved) root.dataset.theme = saved;
    else delete root.dataset.theme;
    const button = document.getElementById("themeButton");
    if (button) {
      const dark = current() === "dark";
      button.textContent = dark ? "☀︎" : "☾";
      button.title = dark ? "ライトモードにする" : "ダークモードにする";
      button.setAttribute("aria-label", button.title);
    }
  };

  apply();
  media.addEventListener("change", apply);
  // 記録一覧の別ウィンドウとも同期
  window.addEventListener("storage", (e) => { if (e.key === KEY) apply(); });

  document.addEventListener("DOMContentLoaded", () => {
    apply();
    document.getElementById("themeButton")?.addEventListener("click", () => {
      const next = current() === "dark" ? "light" : "dark";
      try { localStorage.setItem(KEY, next); } catch {}
      apply();
    });
  });
})();
