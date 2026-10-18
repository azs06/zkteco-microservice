// Light by default; the viewer's choice is remembered in this browser. Loaded as a classic
// script in <head> so the theme is set before the page paints (no flash of the wrong theme).
(function () {
  var KEY = "adms-theme";
  var read = function () {
    try {
      return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
    } catch (e) {
      return "light";
    }
  };
  var apply = function (theme) {
    document.documentElement.setAttribute("data-theme", theme);
    var buttons = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < buttons.length; i++) {
      var dark = theme === "dark";
      buttons[i].setAttribute("aria-pressed", String(dark));
      buttons[i].setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
      buttons[i].title = dark ? "Light mode" : "Dark mode";
      buttons[i].textContent = dark ? "☀" : "☾";
    }
  };
  apply(read());
  document.addEventListener("DOMContentLoaded", function () {
    apply(read());
    document.addEventListener("click", function (event) {
      var button = event.target.closest && event.target.closest("[data-theme-toggle]");
      if (!button) return;
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(KEY, next);
      } catch (e) {}
      apply(next);
    });
  });
})();
