# CaptureFlow prototype

A responsive screen-recording web app prototype built with React, TypeScript, Vite, Tailwind CSS and Lucide icons.

## Features
- Dark and light theme toggle, persisted in localStorage
- Screen capture via browser Screen Capture API
- Start, pause, resume and stop recording
- Recording timer, video preview and WebM download
- Microphone option and optional system audio (browser/device dependent)
- Recording library for the current page session
- Five-recording free-tier counter and registration modal
- Responsive dashboard, settings and quick tips

## Run locally
Requires Node.js 20+ (recommended) and a current Chrome or Edge browser.

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. Screen capture generally requires HTTPS or localhost.

## Prototype limitations
- Email registration is a UI-only simulation. It stores an email locally and does **not** send a verification code. Do not use it as real authentication.
- The five-recording limit is stored in localStorage and can be bypassed by clearing browser data. Production enforcement requires an API and database.
- Video blobs are held in memory for the active page session. Download recordings before refreshing or closing the page.
- Browser support for system audio varies by browser, OS, and selected share target.
- Output is WebM where supported. MP4 export would require a conversion workflow.

## Production next steps
Add a Node/Express API, PostgreSQL or SQLite database, email OTP provider, server-side usage enforcement, authenticated sessions, and appropriate privacy/retention controls.
