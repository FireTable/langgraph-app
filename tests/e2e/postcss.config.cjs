// Empty PostCSS config — the e2e harness serves a single plain HTML
// page, so it doesn't need Tailwind / autoprefixer / etc. Vite walks
// up the directory tree looking for postcss.config; this empty
// definition blocks it from finding the project's PostCSS plugin
// (@tailwindcss/postcss) and failing to load.
module.exports = { plugins: [] };
