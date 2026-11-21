# Dailies

Move camera footage from a shooter's laptop straight onto an editor's drive. Nothing gets uploaded to a cloud first, so there's no storage to fill up and nothing to delete the next day.

It also pulls footage out of shared Google Drive folders. You pick the clips you want and save them in one go, without Drive's 2 GB zip parts.

## How it works

**You're the editor.** Open the site in Chrome or Edge on your computer. Pick a folder (an external drive is a good idea) and you get a link. That link never changes, so pin it wherever your shooters will find it.

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

## From Drive

Go to `/drive`, paste a folder shared as "Anyone with the link", and you can:

- see thumbnails, durations and resolution, and play any clip in a preview
- tick clips one by one, select all in a folder, or "select everything inside" a subfolder
- save them **into a folder** (keeps Drive's subfolders, skips files you already have) or **as one .zip** (no size cap, works past 4 GB)

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
- The editor's browser writes into the chosen folder with the File System Access API. That's why receiving needs Chrome or Edge. Sending works anywhere.
- xxHash64 (via `hash-wasm`) for checking files, `client-zip` for streaming zips.

If the public PeerJS server ever gets flaky, you can run your own ([peerjs-server](https://github.com/peers/peerjs-server)) and set `VITE_PEER_HOST`, `VITE_PEER_PORT`, `VITE_PEER_PATH` and `VITE_PEER_SECURE`.

### Known limits

- Some strict networks (certain offices, hotels, campus Wi-Fi) block direct connections. Dailies doesn't use a relay, because relaying video costs money. A phone hotspot or a different Wi-Fi usually fixes it.
- Over the internet, speed depends on the sender's upload speed. On the same Wi-Fi it's as fast as your network.
- If a single file's transfer gets cut off, that file starts over. Everything that already arrived is kept.

## Running locally

```
npm install
npm run dev
```
