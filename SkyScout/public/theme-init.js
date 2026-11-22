// A same-origin script runs before React and also works with production CSP.
try {
  var theme = localStorage.getItem('skyscout-theme') === 'dark' ? 'dark' : 'light';
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
} catch {
  document.documentElement.style.colorScheme = 'light';
}
