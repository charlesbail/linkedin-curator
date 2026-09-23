# Aufwieder-zen

A Chrome Extension (Manifest V3) that curates and calms your LinkedIn feed —
hide promoted posts, reshares, or posts matching blocked keywords.

Built with vanilla TypeScript, plain HTML/CSS, and Vite. No UI framework.

## Project structure

```
manifest.json           # MV3 manifest (source of truth for permissions/entry points)
src/
  popup/                 # UI and toggles (popup.html, popup.ts, popup.css)
  content_scripts/       # DOM manipulation/injection on linkedin.com
  background/            # Service worker: cross-tab orchestration
  utils/                 # Pure parsing/business logic + typed storage helpers
public/
  icons/                 # Add icon16/48/128.png here, then wire into manifest.json
```

See `.cursorrules` for the strict architectural boundaries this project follows.

## Setup

```bash
npm install
```

## Development

```bash
npm run dev
```

This starts Vite in watch mode. Load the `dist/` folder as an unpacked
extension in Chrome (`chrome://extensions` → Developer mode → Load unpacked)
and it will hot-reload as you edit.

## Build

```bash
npm run build
```

Outputs a production build to `dist/`, ready to load unpacked or zip for the
Chrome Web Store.

## Translations

Phrases and UI copy live in `src/utils/linkedinPhrases.ts`. Regenerate the Google Sheets file with `npm run export:csv`. See [TRANSLATIONS.md](TRANSLATIONS.md) for adding a language.

## Type checking

```bash
npm run typecheck
```

## State

All settings (`enableButtonsInFeed`, `enableFadeAnimation`) are persisted via
`chrome.storage.local` through the typed helpers in `src/utils/storage.ts`.
The popup writes settings and asks the background worker to notify content
scripts; content scripts also listen directly to `chrome.storage.onChanged`
so state stays in sync across tabs.
