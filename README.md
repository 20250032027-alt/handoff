# Handoff

Move camera footage from a shooter's laptop straight onto an editor's drive. Nothing gets uploaded to a cloud first, so there's no storage to fill up and nothing to delete the next day.

It also pulls footage out of shared Google Drive folders. You pick the clips you want and save them in one go, without Drive's 2 GB zip parts.

## How it works

**You're the editor.** Open the site on your computer. In Chrome or Edge you pick a folder (an external drive is a good idea). In Firefox, each delivery downloads to your Downloads folder as one .zip instead. Either way you get a link. That link never changes, so pin it wherever your shooters will find it.

**They're shooting.** They open your link in any browser, drag in the SD card, and hit send. You get a request with their name and how much they're sending. Accept it, and the files land in:

```
Your folder / Their name / 2026-11-21 Wedding day 1 / CARD / DCIM / ...
```

A few details:

- Each file is checked with a hash on both ends, so you know it matches the card.
- If the connection drops, it reconnects by itself. Files that already arrived get skipped.
- Sending the same card twice skips everything you already have.
- Several shooters can send at the same time.
- Hidden system files (`.DS_Store`, `._` files, `.Spotlight-V100` and so on) are left out.
- Both computers have to be online at once. That's the tradeoff for not storing anything anywhere.

Your own setup works the same way: Mac with the card is the "shooter", PC is the "editor".

## Letting the team watch

Turn on **Let the team watch** on the Receive page and you get a second link, separate from the send link. Teammates who open it see everything in your Handoff folder, grouped by shooter and day. They can play any clip in the browser and save a copy, straight from your computer.

- It only works while your computer is on and Handoff is open. The page tells teammates that in plain words when it can't connect.
- **Make a new link** kills the old one right away.
- Some camera formats (10-bit, RAW) won't play in a browser. Teammates can still save those.
- It needs folder mode (Chrome, Edge, Opera). Firefox's zip mode has nothing to serve from.

## Keeping it on all the time

1. Install Handoff as an app: use the "Install as an app" button, or the install icon in Chrome's address bar.
2. Go to `chrome://apps` (or `edge://apps`), right-click Handoff, and turn on **Start app when you sign in**.
3. Stop the computer from sleeping while it's plugged in.
4. When Chrome asks for folder access, choose **Allow on every visit**.

The page holds a Web Lock so Chrome won't freeze or discard it in the background.

## From Drive

Go to `/drive`, paste a folder shared as "Anyone with the link", and you can:

- see thumbnails, durations and resolution, and play any clip in a preview
- tick clips one by one, select all in a folder, or "select everything inside" a subfolder
- save them **into a folder** (keeps Drive's subfolders, skips files you already have) or **as one .zip** (no size cap, works past 4 GB)

**Preload** (the button above the clips) gets clips ready to play instantly. Pick a quality first:

- **360p, 480p, 720p (default), 1080p:** each clip is read from Drive in pieces and shrunk on your computer. Only the small copy is kept, so a whole event at 720p takes a few GB instead of hundreds. The original never sits on your disk.
- **Original:** keeps the exact file. Biggest by far, but saving from Drive afterwards needs no download.

A **space limit** (2 to 50 GB, default 10) caps the total. When it fills up, the clips you looked at longest ago are removed. In Chrome, Edge or Opera you can store copies in a folder you pick, like an external drive, instead of the browser. **Clear preloaded** removes everything.

Saving always gives you the originals. Small copies are only for watching. Clips in formats a browser can't decode (10-bit, RAW) are skipped and keep using Google's preview.

In Firefox, "Save to a folder" isn't available, but "One .zip" works and goes to Downloads.

Downloads go through Google's API, so you also skip the "can't scan for viruses" warning on big files. Google's own limit still applies: a file that's been downloaded a lot can get locked for a few hours ("download quota exceeded"). When that happens the app tells you.

## Deploying (free)

1. Push this repo to GitHub.
2. On [vercel.com/new](https://vercel.com/new), import the repo. Vercel detects Vite. Leave the defaults and deploy.

That's all you need for the main feature.

### Turning on Drive import

This needs a free Google API key (about five minutes):

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create a project (any name).
2. Open **APIs & Services > Library**, search for **Google Drive API**, and click **Enable**.
3. Open **APIs & Services > Credentials > Create credentials > API key**. Copy the key.
4. Edit the key so nobody else can use it:
   - **Application restrictions:** Websites. Add `https://your-site.vercel.app/*`
   - **API restrictions:** Restrict key, then pick Google Drive API only.
5. In Vercel, open your project's **Settings > Environment Variables** and add `VITE_GOOGLE_API_KEY` with that key. Then redeploy.

No billing account is needed. The key only reads files that are already public.

## Under the hood

- Vite, React, TypeScript, Tailwind
- WebRTC data channels through [PeerJS](https://peerjs.com). The free public PeerJS server only handles the handshake. Footage goes directly between the two browsers, encrypted (DTLS).
- In Chrome and Edge, the editor's browser writes into the chosen folder with the File System Access API. Firefox doesn't have that, so there a service worker (`public/sw.js`) streams each delivery into Downloads as a zip. Skipping files you already have only works in folder mode. Sending works in any browser.
- xxHash64 (via `hash-wasm`) for checking files, `client-zip` for streaming zips.

If the public PeerJS server ever gets flaky, you can run your own ([peerjs-server](https://github.com/peers/peerjs-server)) and set `VITE_PEER_HOST`, `VITE_PEER_PORT`, `VITE_PEER_PATH` and `VITE_PEER_SECURE`.

### Known limits

- Some strict networks (certain offices, hotels, campus Wi-Fi) block direct connections. Handoff doesn't use a relay, because relaying video costs money. A phone hotspot or a different Wi-Fi usually fixes it.
- Over the internet, speed depends on the sender's upload speed. On the same Wi-Fi it's as fast as your network.
- If a single file's transfer gets cut off, that file starts over. Everything that already arrived is kept.

## Running locally

```
npm install
npm run dev
```
