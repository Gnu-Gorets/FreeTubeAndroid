# Android external player

## VLC cannot open local FreeTube relay over mobile data

If VLC for Android reports `503 ERR_CONNECT_FAIL` for FreeTube external player URL while mpv works, check active mobile APN. Some carriers configure HTTP proxy that incorrectly receives loopback requests to `127.0.0.1`.

### Fix

1. Open **Settings → Network & internet → SIMs → Access Point Names**.
2. Copy active APN as backup.
3. Edit active APN and clear **Proxy** and **Port**.
4. Save and select modified APN.
5. Disable and reenable mobile data.
6. Restart VLC.

On test device, problematic values were:

```text
Proxy: 217.65.192.33
Port: 8080
```

Do not copy these values. Remove proxy configured by carrier.

### Verify

On connected development device, check that Android no longer reports HTTP proxy:

```bash
adb shell dumpsys connectivity | grep -i HttpProxy
```

Relay URL should remain `http://127.0.0.1:<port>/...`. Do not replace it with `localhost`; both names refer to Android device and may still be sent through same proxy.

If carrier locks APN or restores proxy automatically, stock VLC for Android has no reliable per app loopback bypass setting. Use mpv or VLC/LibVLC build that explicitly opens loopback connections with `Proxy.NO_PROXY`.
