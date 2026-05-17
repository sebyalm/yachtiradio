# Yachtie Radio

A browser-based push-to-talk radio MVP for crew on the same yacht Wi-Fi network.

The app uses a tiny local Node server for peer discovery and WebRTC signaling. Voice audio travels peer-to-peer between browsers on the LAN rather than through the internet or Bluetooth.

## Run

```powershell
npm start
```

Open `http://localhost:3000` on the host machine.

For phones on the same Wi-Fi network, open:

```text
http://<host-lan-ip>:3000
```

Browsers only allow microphone access from secure contexts. `localhost` works for development, but iPhones on a LAN usually need HTTPS. To serve HTTPS, provide a local certificate and key:

```powershell
$env:YACHTIE_TLS_CERT="C:\path\to\cert.pem"
$env:YACHTIE_TLS_KEY="C:\path\to\key.pem"
npm start
```

Then open `https://<host-lan-ip>:3000`.

## MVP Features

- Room-based LAN channels.
- Press-and-hold push-to-talk.
- WebRTC peer-to-peer audio with no cloud relay.
- Crew presence, receive/transmit state, and connection status.
- Mobile-first PWA metadata for iPhone home-screen use.

## Vercel Hosting

Vercel can host the static web UI, but it cannot replace the onboard LAN signaling server. The deployed Vercel URL is useful as a preview that the app shell loads. For actual radio behavior, run `npm start` on a computer connected to the yacht Wi-Fi and open that LAN address from crew devices.

## Reality Check

"Zero latency" is not literally possible in browsers, but WebRTC on the same Wi-Fi network is the right low-latency path for this MVP. Apple Watch browser support for WebRTC microphone capture is limited, so the web MVP targets phones first; a watch-friendly version would likely need a native companion app.
