import { browser } from '@wdio/globals';

/** Options for waiting and polling when answering an incoming call. */
export interface WaitForIncomingCallOptions {
  /** Max time to wait (ms). Default 120000 (2 min). */
  timeoutMs?: number;
  /** Interval between answer attempts (ms). Default 5000. */
  pollIntervalMs?: number;
}

/** Dialler app packages by OEM (Samsung S24 and others use Samsung dialler). */
const DIALER_PACKAGES = [
  'com.samsung.android.dialer', // Samsung Galaxy (e.g. S24)
  'com.android.dialer',
  'com.google.android.dialer',
];
const DIALER_APP_ID = DIALER_PACKAGES[0]; // default for showKeypad

/** Selectors for Answer/Accept and End call (OEM-specific; extend if needed). */
const ANSWER_SELECTORS = [
  'android=new UiSelector().textMatches("(?i)(Answer|Accept|Accept call)")',
  'android=new UiSelector().descriptionMatches("(?i)(Answer|Accept)")',
];
const END_CALL_SELECTORS = [
  'android=new UiSelector().textMatches("(?i)(End call|Hang up|Disconnect)")',
  'android=new UiSelector().descriptionMatches("(?i)(End|Hang up|Disconnect)")',
];

/**
 * Service for Android dialer and in-call actions (answer, DTMF, end call).
 * Uses only UI automation and supported mobile commands (no adb_shell, no pressKey).
 */
class DialerService {
  /**
   * Accepts an incoming call by finding and clicking the Answer/Accept button.
   */
  async acceptIncomingCall() {
    for (const selector of ANSWER_SELECTORS) {
      const el = await $(selector);
      try {
        await el.waitForDisplayed({ timeout: 3000 });
        await el.click();
        return;
      } catch {
        continue;
      }
    }
    throw new Error('Could not find Answer/Accept button');
  }

  /**
   * Waits for the incoming-call UI, then clicks Answer. Polls until the button appears or timeout.
   */
  async waitForIncomingCallAndAccept(options?: WaitForIncomingCallOptions) {
    const timeoutMs = options?.timeoutMs ?? 120_000;
    const pollIntervalMs = options?.pollIntervalMs ?? 5000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      for (const selector of ANSWER_SELECTORS) {
        const el = await $(selector);
        try {
          await el.waitForDisplayed({ timeout: 2000 });
          await el.click();
          return;
        } catch {
          continue;
        }
      }
      await browser.pause(pollIntervalMs);
    }
    throw new Error('Timeout waiting for incoming call Answer button');
  }

  /**
   * Ends the current call by finding and clicking the End call / Hang up button.
   */
  async endCall() {
    for (const selector of END_CALL_SELECTORS) {
      const el = await $(selector);
      try {
        await el.waitForDisplayed({ timeout: 5000 });
        await el.click();
        return;
      } catch {
        continue;
      }
    }
    throw new Error('Could not find End call / Hang up button');
  }

  /**
   * Brings the Android Dialler app to the foreground.
   * Uses mobile: startActivity (activateApp is not supported on BrowserStack).
   * Tries DIAL intent first (opens default dialler), then MAIN/LAUNCHER per OEM package.
   */
  async showKeypad() {
    // 1) DIAL intent: opens default dialler (Samsung, Pixel, AOSP) without hardcoding package
    try {
      await browser.execute('mobile: startActivity', {
        action: 'android.intent.action.DIAL',
        uri: 'tel:',
      });
      await browser.pause(1500);
      return;
    } catch {
      // continue to package-specific launch
    }

    // 2) Fallback: start each known dialler package by MAIN/LAUNCHER
    for (const pkg of DIALER_PACKAGES) {
      try {
        await browser.execute('mobile: startActivity', {
          package: pkg,
          action: 'android.intent.action.MAIN',
          categories: ['android.intent.category.LAUNCHER'],
        });
        await browser.pause(1500);
        return;
      } catch {
        continue;
      }
    }
    throw new Error('Could not bring dialler to foreground (tried DIAL intent and packages: ' + DIALER_PACKAGES.join(', ') + ')');
  }

  /** Options for digit entry (e.g. force mobile: type only for testing). */
  pressDigitOptions?: { useMobileTypeOnly?: boolean };

  /**
   * Presses a digit (0-9) using mobile: type (supported on BrowserStack). Falls back to clicking the digit key if type fails, unless useMobileTypeOnly is set.
   */
  async pressDigit(digit: number | string, options?: { useMobileTypeOnly?: boolean }) {
    const useMobileTypeOnly = options?.useMobileTypeOnly ?? this.pressDigitOptions?.useMobileTypeOnly ?? false;
    const char = typeof digit === 'string' ? digit : String(digit);
    try {
      await browser.execute('mobile: type', { text: char });
    } catch (err) {
      if (useMobileTypeOnly) {
        throw new Error(`mobile: type failed for digit "${char}": ${err instanceof Error ? err.message : String(err)}`);
      }
      // Fallback: click the digit key on the dialpad (e.g. text "1" for 1)
      const el = await $(`android=new UiSelector().text("${char}")`);
      await el.waitForDisplayed({ timeout: 3000 });
      await el.click();
    }
    await browser.pause(300);
  }

  /**
   * Enters a full sequence (e.g., DTMF digits or PIN). Pass { useMobileTypeOnly: true } to test mobile: type path only.
   */
  async enterSequence(sequence: string, options?: { useMobileTypeOnly?: boolean }) {
    for (const char of sequence) {
      await this.pressDigit(char, options);
      await browser.pause(500);
    }
  }
}

export default new DialerService();
