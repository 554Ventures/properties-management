import type { CapacitorConfig } from '@capacitor/cli';

// Remote-URL shell (docs/MOBILE.md): the WKWebView loads the deployed web app
// directly, so every web deploy updates the installed app instantly and API
// calls stay same-origin. The shell itself only needs rebuilding when a
// @capacitor/* version changes (bridge/version-skew policy).
//
// Local dev loop: CAP_SERVER_URL=http://<lan-ip>:5173 npm run sync -w apps/mobile
// (cleartext allows plain-http LAN Vite; production stays https-only).
//
// No `allowNavigation` needed — Supabase auth is fetch-based email/password,
// no OAuth redirects leave the origin.
// appId deviates from the plan's com.554properties.hearth: the Capacitor CLI
// enforces Java-package rules (segments must start with a letter) even though
// Apple allows digit-leading bundle-ID segments. Register exactly this id
// with Apple (Part D) and set APNS_BUNDLE_ID to match.
const config: CapacitorConfig = {
  appId: 'com.properties554.hearth',
  appName: '554 Properties',
  webDir: 'www',
  server: process.env.CAP_SERVER_URL
    ? { url: process.env.CAP_SERVER_URL, cleartext: true }
    : { url: 'https://app.554properties.com' },
};

export default config;
