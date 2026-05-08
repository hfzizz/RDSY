# RDSY

A cross-device PDF reader that runs entirely in the browser. Your books live in Google Drive. Your reading position, bookmarks, and highlights sync automatically across every device you sign in from.

No server. No subscription. Just your Google account.

---

## Features

- **Google Drive library** — upload PDFs once, read them anywhere
- **Cross-device sync** — page position syncs in the background every 60 seconds and on tab focus
- **Offline reading** — cached books open instantly with no internet connection
- **Bookmarks & highlights** — annotate pages with color-coded highlights and named bookmarks
- **Single / spread view** — single-page or two-page spread layout
- **Reading stats** — tracks sessions per device (pages read, time spent)
- **PWA** — installable on desktop and mobile, works offline after first load

---

## Tech stack

| Layer | Tool | Why |
|---|---|---|
| UI | React 19 + TypeScript | Component model, strict types |
| Routing | React Router v7 | `/` library, `/reader/:bookId` reader |
| State | Zustand | Minimal global store, no boilerplate |
| PDF render | pdfjs-dist | Mozilla's battle-tested PDF engine, renders in a Web Worker |
| Local DB | Dexie (IndexedDB) | Sidecar cache + offline write queue |
| PDF cache | OPFS | Fast binary blob storage, higher quota than IDB |
| Auth | Google Identity Services | Modern OAuth token client, no redirect flow |
| Build | Vite + vite-plugin-pwa | Fast builds, automatic service worker + precache |

---

## Getting started

### Prerequisites

- Node.js 18+
- A Google Cloud project with the **Google Drive API** enabled
- An OAuth 2.0 Client ID (Web application type) from Google Cloud Console

### Setup

```bash
git clone https://github.com/hfzizz/RDSY.git
cd RDSY
npm install
```

Create a `.env` file at the project root:

```
VITE_GOOGLE_CLIENT_ID=your-oauth-client-id-here
```

In your Google Cloud Console OAuth client settings, add `http://localhost:5173` to **Authorized JavaScript origins**.

### Run

```bash
npm run dev       # dev server at http://localhost:5173
npm run build     # production build → dist/
npm run preview   # preview the production build locally
```

---

## How it works

When you sign in, RDSY finds (or creates) a folder called `RDSY-Library` in your Google Drive and lists all PDFs inside it. For each book it also manages a small JSON sidecar file (`<bookId>.rdsy.json`) that stores your progress, bookmarks, and highlights.

**On open:** the PDF is loaded from a local OPFS cache (or downloaded from Drive on first open). The sidecar is fetched from Drive, merged with the local IndexedDB copy, and the most recently read page is restored.

**On page turn:** progress is debounced 2 seconds, written to IndexedDB immediately, then pushed to Drive. If you are offline the write is queued and flushed automatically when you reconnect.

**On conflict** (read on two devices while offline): last-write-wins for page position; bookmarks and highlights are merged additively with tombstone support.

---

## Project structure

```
src/
├── App.tsx               # Auth shell + route layout
├── store/index.ts        # Zustand global store
├── types/                # TypeScript types split by concern
├── components/
│   ├── Library.tsx       # Book list, upload, offline pin
│   ├── Reader.tsx        # PDF reader (composes 4 hooks)
│   └── Bookmarks.tsx     # Bookmarks sidebar
├── hooks/
│   ├── useBookLoader.ts      # PDF + sidecar load sequence
│   ├── usePDFRenderer.ts     # Canvas render loop
│   ├── useReadingProgress.ts # Page/zoom state + saves
│   └── useCrossDeviceSync.ts # Background remote poll
└── lib/
    ├── auth.ts           # GIS token client
    ├── drive.ts          # Google Drive API calls
    ├── sidecar.ts        # Load + conflict-merge logic
    ├── db.ts             # Dexie schema + queries
    ├── opfs.ts           # OPFS PDF cache
    ├── readerStorage.ts  # localStorage helpers
    └── SyncManager.ts    # Singleton Drive write coordinator
```

For a full walkthrough of how everything connects, see [ONBOARDING.md](./ONBOARDING.md).

---

## OAuth scope

RDSY requests only `https://www.googleapis.com/auth/drive.file` — the narrowest Drive scope available. This grants access **only to files that RDSY itself created**. It cannot see any other files in your Drive.

---

## License

MIT
