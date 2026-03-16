# Viron – PWA Store Submission Guide

This guide explains how to publish Viron to the **Google Play Store** (via Trusted Web Activity) and the **Apple App Store** (via the App Store using a native wrapper or the Apple PWA/Add-to-Home-Screen flow).

---

## Prerequisites

- The game must be served over **HTTPS**.
- The domain must be yours and stable (e.g. `https://viron.example.com`).
- All assets listed in `sw.js` must return HTTP 200 before the service worker installs.

---

## 1 – Google Play Store (Android)

Android supports **Trusted Web Activity (TWA)** which wraps your PWA in a native Android app shell. When the Digital Asset Link is verified, Chrome renders your PWA full-screen with no browser chrome — identical to a native app.

### 1a – Fill in `.well-known/assetlinks.json`

This file proves to Android that your web domain and your Android app are owned by the same entity.

1. Generate your Android signing key (or use the one from the Play Console):
   ```
   keytool -genkey -v -keystore viron.keystore -alias viron \
     -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Get the SHA-256 fingerprint:
   ```
   keytool -list -v -keystore viron.keystore -alias viron | grep SHA256
   ```
3. Replace the placeholder values in `.well-known/assetlinks.json`:
   - `REPLACE_WITH_YOUR_PACKAGE_NAME` → e.g. `com.yourname.viron`
   - `REPLACE_WITH_YOUR_SHA256_CERT_FINGERPRINT` → the colon-delimited fingerprint

4. Deploy `.well-known/assetlinks.json` to your server so it is reachable at:
   `https://yourdomain.com/.well-known/assetlinks.json`

### 1b – Build the TWA wrapper

Use **PWABuilder** (recommended, free):

1. Go to <https://www.pwabuilder.com>
2. Enter your HTTPS URL and click **Start**
3. Download the **Android** package
4. Open the project in Android Studio
5. Set the same package name and signing key you used above
6. Build a signed AAB (`Build → Generate Signed Bundle`)

Or use **Bubblewrap** (Google's CLI):
```
npm i -g @bubblewrap/cli
bubblewrap init --manifest https://yourdomain.com/manifest.json
bubblewrap build
```

### 1c – Play Store listing requirements

| Requirement | Details |
|---|---|
| App icon | 512×512 PNG — use `icons/icon-512.png` |
| Feature graphic | 1024×500 PNG (create a banner image) |
| Screenshots | Min 2 phone screenshots, min 1 tablet (7" and 10") |
| Short description | ≤ 80 chars |
| Full description | ≤ 4000 chars |
| Content rating | Complete the IARC questionnaire in the Play Console |
| Target API level | Ensure TWA targets API ≥ 33 (Android 13) |

### 1d – Age rating / content

Viron is a shooting game. In Play Console, complete the content rating questionnaire:
- Category: **Games → Action**
- Violence: **Mild cartoon / fantasy violence**
- Expected rating: **Everyone 10+** (E10+) or **Teen** depending on answers

Once you have the IARC rating ID, add it to `manifest.json`:
```json
"iarc_rating_id": "YOUR_IARC_ID"
```

---

## 2 – Apple App Store (iOS / iPadOS)

Apple does **not** support PWA installs from the App Store. To distribute Viron through the App Store you need a native wrapper.

### Option A – Capacitor (recommended)

Capacitor wraps your existing web app in a native WKWebView shell:

```
npm install @capacitor/core @capacitor/cli
npx cap init Viron com.yourname.viron
npm install @capacitor/ios
npx cap add ios
npx cap sync
```

Then open Xcode:
```
npx cap open ios
```

Key Xcode settings:
- **Deployment target**: iOS 16+ (covers all modern iPhones and Apple Silicon iPads)
- **Supported orientations**: landscape left, landscape right
- **Status bar style**: Black Translucent (matches `black-translucent` meta tag)
- **App icon**: Use `icons/icon-1024.png` (1024×1024, no alpha channel, no rounded corners — Xcode clips automatically)
- **Requires full screen**: ✓ (prevents split-view on iPad)

### Option B – PWABuilder (simpler)

1. Go to <https://www.pwabuilder.com>
2. Enter your HTTPS URL
3. Download the **iOS** package
4. Open in Xcode and follow the README inside the package

### App Store listing requirements

| Requirement | Details |
|---|---|
| App icon | 1024×1024 PNG, no alpha — use `icons/icon-1024.png` |
| iPhone screenshots | 6.7" display required (1290×2796 or 2796×1290 for landscape) |
| iPad screenshots | 12.9" display required (2048×2732 or 2732×2048 for landscape) |
| App name | "Viron" (≤ 30 chars) |
| Subtitle | ≤ 30 chars, e.g. "Alien Virus Shooter" |
| Description | No limit but first 3 lines shown without "more" tap |
| Category | **Games → Action** |
| Age rating | Complete the questionnaire; expected: **12+** |
| Privacy policy URL | Required — host a simple privacy-policy page |

### Apple Silicon iPad (M1/M2/M3/M4)

- Runs the same iOS app binary on iPad Pro (all M-series chips).
- Ensure the Capacitor project targets **iPadOS 16+** alongside iOS 16+.
- The 167×167 apple-touch-icon (`icons/apple-touch-icon-167.png`) is used for the home-screen icon on all iPad Pro models.
- In Xcode → Target → General, set **Supports iPad** ✓ and **Requires full screen** ✓.
- Landscape lock: in `Info.plist` set `UISupportedInterfaceOrientations` (and `UISupportedInterfaceOrientations~ipad` for iPad-specific overrides if needed) to `UIInterfaceOrientationLandscapeLeft` and `UIInterfaceOrientationLandscapeRight` only. In modern Xcode (15+) you can set this in the target's **Info** tab under **Supported Interface Orientations**.

---

## 3 – Add-to-Home-Screen (iOS Safari — no App Store)

This is the native PWA flow on iOS. Users can install Viron directly from Safari:

1. Open `https://yourdomain.com` in **Safari** (not Chrome, Firefox, etc.)
2. Tap the **Share** button (⬆)
3. Tap **"Add to Home Screen"**
4. The app launches full-screen from the home screen icon

The in-page install banner in `index.html` detects Safari on iOS/iPadOS and shows these instructions automatically.

---

## 4 – HTTPS & Hosting

A service worker requires HTTPS. Recommended free/low-cost options:

| Host | Notes |
|---|---|
| **GitHub Pages** | Free, HTTPS automatic, custom domain supported |
| **Cloudflare Pages** | Free tier, edge CDN, automatic HTTPS |
| **Netlify** | Free tier, easy CI/CD from GitHub |
| **Vercel** | Free tier, instant deploys from GitHub |

Ensure your server sends the correct MIME type for the service worker:
- `sw.js` must be served as `application/javascript` (not `text/plain`).

---

## 5 – Checklist before store submission

- [ ] Site is live on HTTPS
- [ ] Lighthouse PWA audit scores 100 (run in Chrome DevTools → Lighthouse)
- [ ] `.well-known/assetlinks.json` is reachable and valid (Android only)
- [ ] `manifest.json` `id`, `iarc_rating_id` filled in
- [ ] App icon 1024×1024 PNG prepared for App Store Connect
- [ ] Privacy policy page hosted
- [ ] Screenshots prepared for all required device sizes
- [ ] Age-rating questionnaire completed in both stores
- [ ] In-app purchase / subscription set up if monetising
