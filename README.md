# ResizeKB
Free, open-source, private photo and signature resizer for online forms. Pure static site, no build step, no dependencies.

## Features
- Resize to exact pixels, to a KB limit, or both (modes A/B/C), with measured validation on the real output file
- JPG / PNG / WebP output, EXIF orientation, signature brightness/contrast
- Quick 20/50/100/200/500 KB buttons and live fit/quality hints
- Crop editor with draggable box, edge/corner handles and output-ratio lock
- Rotate 90° and flip horizontally/vertically
- Name / date stamp drawn at output resolution, with position, size, colour and an automatic contrasting halo; included in batch and PDF output
- Shareable limit links: the Copy link button encodes mode, pixels, KB range, format, fit, DPI and workflow in the URL hash, so a link opens with the fields filled in
- Print DPI tag written into JPEG (JFIF density) and PNG (pHYs) — no pixel change
- Batch queue: one set of limits for many images, per-file results, ZIP download
- Before/after comparison slider with keyboard support
- Image to single-page PDF under a size limit, A4 or US Letter, auto/portrait/landscape
- Copy the result to the clipboard, paste an image with Ctrl/⌘ + V
- Keyboard shortcuts, last-used settings, local presets with JSON import/export
- Aura interface: black-and-gold palette, Playfair Display headings, video hero with a CSS gradient fallback

## Files
- `index.html` — markup, metadata, structured data
- `styles.css` — design tokens, layout, components, motion
- `lib.js` — CRC32, stored ZIP writer, JPEG/PNG DPI patching (also usable from Node)
- `app.js` — file intake, canvas pipeline, crop, batch, PDF, presets

## Run locally
Open `index.html` in a browser, or run `python -m http.server 8080` and visit http://localhost:8080. Video and fonts need an internet connection; every resize feature works offline.

## Deploy
Upload the folder to any static host (Vercel, Netlify, Cloudflare Pages, GitHub Pages). Then replace `YOUR-DOMAIN.example` in `index.html`, `robots.txt` and `sitemap.xml` with your real domain.

The repository ships two optional header configs:

- `vercel.json` — security headers and caching for Vercel.
- `_headers` — the same rules for Netlify and Cloudflare Pages (both read this file from the publish root).

Both set `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, HSTS, and a Content Security Policy that allows only this origin plus Google Fonts and the hero video CDN. HTML is `max-age=0, must-revalidate` so a redeploy is visible immediately; CSS and JS are cached for an hour and then revalidated. GitHub Pages ignores both files.

If you self-host the fonts or the video, tighten `style-src`, `font-src` and `media-src` in the CSP to `'self'`.

## Hero video and fonts
The hero plays a muted, looping, inline video from the MotionSite CDN:

```html
<video class="stage__video" id="stageVideo" autoplay muted loop playsinline preload="auto">
  <source src="https://strvid.nyc3.cdn.digitaloceanspaces.com/motionsite/floating_flowers.mp4" type="video/mp4">
</video>
```

It sits behind a dark gradient scrim at 35% opacity and only fades in after `loadeddata`/`playing`, so a blocked or offline CDN leaves the CSS gradient fallback in place. Under `prefers-reduced-motion: reduce` the video is hidden and paused. To use your own clip, change the `<source src>`.

Headings use Playfair Display and the interface uses Inter, both loaded from Google Fonts. Self-host them if you need the page to work fully offline.

## SEO checklist (no ranking is guaranteed)
1. Use a real domain with HTTPS and submit sitemap.xml in Google Search Console.
2. Add one useful page per task (signature resizer, JPG to PDF, PNG to JPG) with original instructions, not copied text.
3. Keep pages fast and mobile-friendly; earn links by being genuinely useful.

## Limits
Not included yet: multi-page PDFs, PDF merge/split, interactive perspective/keystone correction, and physical-size (mm) canvas output. Batch mode ignores the crop and applies the current rotation to every image; an enabled stamp is drawn on every batch result.
