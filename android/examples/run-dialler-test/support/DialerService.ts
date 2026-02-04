import { browser } from '@wdio/globals';

/** Options for waiting and polling when answering an incoming call. */
export interface WaitForIncomingCallOptions {
  /** Max time to wait (ms). Default 120000 (2 min). */
  timeoutMs?: number;
  /** Interval between answer attempts (ms). Default 5000. */
  pollIntervalMs?: number;
}

/** Default dialler app package (use com.google.android.dialer on Pixel / some OEMs). */
const DIALER_APP_ID = 'com.android.dialer';

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
   */
  async showKeypad() {
    await browser.execute('mobile: activateApp', { appId: DIALER_APP_ID });
  }

  /**
   * Presses a digit (0-9) using mobile: type (supported on BrowserStack). Falls back to clicking the digit key if type fails.
   */
  async pressDigit(digit: number | string) {
    const char = typeof digit === 'string' ? digit : String(digit);
    try {
      await browser.execute('mobile: type', { text: char });
    } catch {
      // Fallback: click the digit key on the dialpad (e.g. text "1" for 1)
      const el = await $(`android=new UiSelector().text("${char}")`);
      await el.waitForDisplayed({ timeout: 3000 });
      await el.click();
    }
    await browser.pause(300);
  }

  /**
   * Enters a full sequence (e.g., DTMF digits or PIN).
   */
  async enterSequence(sequence: string) {
    for (const char of sequence) {
      await this.pressDigit(char);
      await browser.pause(500);
    }
  }
}

export default new DialerService();
