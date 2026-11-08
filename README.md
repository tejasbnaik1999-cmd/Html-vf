# Folio: offline HTML viewer for iPad

Folio is a Home Screen app for iPad that opens the HTML files you've made: hearing codexes, study notes, interactive artefacts.
Whatever you do inside a file (Apple Pencil ink, highlights, sticky notes, typed text) is **saved on the iPad as you go** and stays there between launches, fully offline.

## How it saves your work

Self-contained HTML files like the R.A. 6/2024 Codex save their own ink and notes into the browser's storage (IndexedDB and localStorage).
Opened from the Files app or a plain Safari tab, that storage is temporary or gets lost. Folio fixes this:

- **Each file gets its own private storage.** Folio quietly namespaces each file's localStorage, sessionStorage and IndexedDB, so two files never overwrite each other's notes.
- **Saves are confirmed.** A small tab on the edge of the screen shows a green dot after every save. Tap it for the menu (Library, Reload, Back up).
- **Flush before closing.** When you go back to the Library or switch apps, Folio tells the file to write any pending strokes first.
- **Reopens where you were.** If iPadOS closes the app in the background, Folio reopens the same file on the next launch.
- **Keep page edits (optional, per file).** For simple pages without their own saving, Folio can remember typed text, editable areas, checkboxes and form answers.
- **Backups.** Use ⋯ → Backup & restore to export *all notes* (a small file) or a *full backup* (HTML files plus notes) to Files or iCloud Drive, and restore it later on this or another iPad.
- **Newer versions keep notes.** On a file's ⋯ menu, use *Replace with a newer version*, or re-add a file with the same name and choose *Replace*. Your notes carry over.
- Files' own export buttons (those using `window.claude.use('downloads')`) open the iPad share sheet.

## Install on the iPad (one time)

1. Publish this repository with GitHub Pages: **Settings → Pages → Source: GitHub Actions**. The included workflow deploys on every push to the default branch.
   The app is then at `https://<your-username>.github.io/<repo-name>/`.
   GitHub Pages on a private repo needs a paid plan. On a free account, make the repo public. The repo holds only the app code; your HTML files and notes never leave the iPad.
2. On the iPad, open that address in **Safari**, tap **Share → Add to Home Screen**.
3. Always open Folio from the **Home Screen icon**. Home Screen apps get permanent storage, and iPadOS does not clear it the way it clears ordinary website data.
4. Tap **＋ Add HTML** and pick your files from Files or iCloud Drive (or drag them in via Split View).

After the first launch Folio works without internet.

## Files

| File | Role |
| --- | --- |
| `index.html`, `app.css`, `app.js` | Library, viewer, backup and restore |
| `core.js` | App database, the in-document storage shim, and how a stored file is served |
| `sw.js` | Service worker: offline cache, and serves stored files at `./doc/<id>/` |
| `manifest.webmanifest`, `icons/` | Home Screen app metadata |

When you change app code, bump `VERSION` in `sw.js` so installed copies pick up the update.
