# webdriverio-appium-app-browserstack

This repository demonstrates how to run Appium tests using [WebdriverIO](http://webdriver.io/) on [BrowserStack App Automate](https://www.browserstack.com/app-automate).

<div align="center">
<img src="https://www.browserstack.com/images/layout/browserstack-logo-600x315.png" alt="BrowserStack" width="300"><br>
<img src="https://webdriver.io/img/webdriverio.png" alt="WebdriverIO" height="140">
</div>

The project is written in **TypeScript** and uses [Mocha](https://mochajs.org/) as the test framework. It includes standard sample tests and **dialler tests** that use [BrowserStack Cross-Device Automation Agent](https://www.browserstack.com/docs/app-automate/appium/set-up-test-env/cross-device-automation-agent) (AI authoring) to answer incoming calls and perform DTMF.

---

## Setup

### Requirements

- **Node.js 18+** — [Download](https://nodejs.org/) if needed.
- **BrowserStack account** — [Sign up](https://www.browserstack.com/users/sign_up) and get your username and access key from [Account Settings](https://www.browserstack.com/accounts/settings).

### Install dependencies

Android and iOS have separate `package.json` files. Install the one you need:

```sh
# Android
cd android && npm i

# iOS
cd ios && npm i
```

### Environment variables

Set these before running tests (or export in your shell):

- `BROWSERSTACK_USERNAME` — your BrowserStack username  
- `BROWSERSTACK_ACCESS_KEY` — your BrowserStack access key  

**Upload the app first, then set `BROWSERSTACK_APP_ID`:**  
Upload your `.apk` or `.ipa` to BrowserStack (e.g. via [App Automate Dashboard](https://app-automate.browserstack.com/) → Upload App, or the [Upload App API](https://www.browserstack.com/docs/app-automate/appium/appium-upload-app)). After upload, set `BROWSERSTACK_APP_ID` to the returned app URL (e.g. `bs://...` or your custom_id). This avoids re-uploading on every run and is required for some setups (e.g. dedicated devices).

- `BROWSERSTACK_APP_ID` — app URL from BrowserStack after upload (e.g. `bs://...`); set this when using a pre-uploaded app.  

---

## Running tests

From the **android** or **ios** directory:

| Command           | Description |
|-------------------|-------------|
| `npm run test`    | Parallel tests (BStack sample app) |
| `npm run dialler` | Dialler flow: app test → wait → prompt to dial → answer call (AI) → DTMF → end call |
| `npm run typecheck` | TypeScript check only |

Examples:

```sh
cd android
npm run test      # parallel
npm run dialler   # dialler (Wikipedia app + incoming call + DTMF)

cd ios
npm run test      # parallel
npm run dialler   # dialler (BStack sample app + incoming call + DTMF)
```

---

## Test suites

### Parallel tests (`run-parallel-test`)

- **Android:** `android/examples/run-parallel-test/` — runs against multiple devices.  
- **iOS:** `ios/examples/run-parallel-test/` — BStack sample app: Text Button → Text Input → assert Text Output.  
- Docs: [Parallel testing on App Automate](https://www.browserstack.com/docs/app-automate/appium/getting-started/nodejs/webdriverio/parallelize-tests).

### Dialler tests (`run-dialler-test`)

End-to-end flow that uses a real (or SIM-capable) device, then an **incoming call** and **DTMF**:

1. **Device info** — read SIM/phone number from the device (for the “dial this number” prompt).  
2. **App flow** — run the main app test (Wikipedia on Android, BStack sample app on iOS).  
3. **Wait & prompt** — wait ~20s, then print **“PLEASE DIAL THE DEVICE PHONE NUMBER NOW”** and the number in the terminal.  
4. **Answer call** — you call the device; the test uses **BrowserStack AI** (Cross-Device Automation Agent) to accept the call (e.g. swipe/tap the green Answer button).  
5. **DTMF & end** — AI taps the digit sequence on the keypad, then ends the call.

**Config:**

- **Android:** `android/examples/run-dialler-test/dialler.conf.ts` — uses **WikipediaSample.apk**, `aiAuthoring: true`, optional SIM capabilities.  
- **iOS:** `ios/examples/run-dialler-test/dialler.conf.ts` — uses **BStackSampleApp.ipa**, `aiAuthoring: true`.

**AI service:** `DialerAIService` (in `support/DialerAIService.ts`) sends natural-language commands via `browserstack_executor: {"action": "ai", "arguments": ["..."]}` for answer, keypad, DTMF, and end call. Logging goes to both the terminal and BrowserStack session logs.

**Requirements:**

- **Upload the app first** and set `BROWSERSTACK_APP_ID` to the app URL (e.g. `bs://...`) — see [Environment variables](#environment-variables) above.  
- BrowserStack AI / Cross-Device Automation Agent enabled for your account.  
- For real incoming calls: device with SIM (or BrowserStack SIM) and a phone to dial from.

**Reports:** JUnit XML is written under `examples/run-dialler-test/reports/junit/` (per platform).

---

## Project structure

```
android/
  examples/
    run-parallel-test/    # parallel BStack sample tests
    run-dialler-test/    # dialler: Wikipedia + call + DTMF (DialerAIService)
    WikipediaSample.apk, LocalSample.apk
ios/
  examples/
    run-parallel-test/   # parallel BStack sample tests
    run-dialler-test/    # dialler: BStack sample + call + DTMF (DialerAIService)
    BStackSampleApp.ipa, LocalSample.ipa
```

---

## Getting help

- [BrowserStack App Automate docs](https://www.browserstack.com/docs/app-automate)  
- [Cross-Device Automation Agent (AI)](https://www.browserstack.com/docs/app-automate/appium/set-up-test-env/cross-device-automation-agent)  
- [BrowserStack Support](https://www.browserstack.com/support/app-automate) | [Contact](https://www.browserstack.com/contact?ref=help)
