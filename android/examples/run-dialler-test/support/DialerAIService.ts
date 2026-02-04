import { browser } from '@wdio/globals';

/** Options for waiting and polling when answering an incoming call. */
export interface WaitForIncomingCallOptions {
  /** Max time to wait (ms). Default 120000 (2 min). */
  timeoutMs?: number;
  /** Interval between answer attempts (ms). Default 5000. */
  pollIntervalMs?: number;
}

const AI_EXECUTOR = 'browserstack_executor' as const;
const LOG_PREFIX = '[DialerAI]';

/** Write to terminal (stdout) so it appears in the local run. */
function logToTerminal(message: string): void {
  process.stdout.write(`${LOG_PREFIX} ${message}\n`);
}

/** Send a message to BrowserStack App Automate session logs (annotate). */
async function logToBrowserStack(message: string, level: 'info' | 'error' = 'info'): Promise<void> {
  try {
    await browser.execute(
      `browserstack_executor: {"action":"annotate","arguments":{"data":${JSON.stringify(LOG_PREFIX + ' ' + message)},"level":"${level}"}}`
    );
  } catch {
    // annotate may fail if session is gone
  }
}

/**
 * Logs an AI action to both the terminal and BrowserStack App Automate logs (annotate).
 */
async function logAIAction(
  action: string,
  instruction: string,
  outcome: 'start' | 'success' | 'error',
  errorMessage?: string
): Promise<void> {
  const timestamp = new Date().toISOString();
  const msg =
    outcome === 'start'
      ? `AI action: "${action}" | instruction: ${instruction}`
      : outcome === 'success'
        ? `AI action: "${action}" | success`
        : `AI action: "${action}" | error: ${errorMessage ?? 'unknown'}`;

  logToTerminal(`[${timestamp}] ${msg}`);

  const bstackData = `DialerAI ${outcome}: ${action} | ${instruction}${errorMessage ? ` | ${errorMessage}` : ''}`;
  try {
    await browser.execute(
      `browserstack_executor: {"action":"annotate","arguments":{"data":${JSON.stringify(bstackData)},"level":"${outcome === 'error' ? 'error' : 'info'}"}}`
    );
  } catch {
    // annotate may fail if session is gone; don't throw
  }
}

/**
 * Runs a natural-language command via BrowserStack Cross-Device Automation Agent.
 * Requires aiAuthoring: true in bstack:options.
 * Logs to terminal and BrowserStack for debugging.
 */
async function aiCommand(instruction: string, actionLabel?: string): Promise<unknown> {
  const action = actionLabel ?? instruction.slice(0, 50);
  await logAIAction(action, instruction, 'start');

  try {
    const payload = JSON.stringify({
      action: 'ai',
      arguments: [instruction],
    });
    const result = await browser.execute(`${AI_EXECUTOR}: ${payload}`);
    await logAIAction(action, instruction, 'success');
    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await logAIAction(action, instruction, 'error', errMsg);
    throw err;
  }
}

/**
 * Dialler actions using BrowserStack Cross-Device Automation Agent (natural language).
 * Use this when aiAuthoring is enabled; otherwise use DialerService (UI selectors).
 */
class DialerAIService {
  /**
   * Accepts an incoming call using AI. Tries swipe-up on the green Answer button first (common on Android), then tap as fallback.
   */
  async acceptIncomingCall(): Promise<void> {
    const swipeInstruction = 'Swipe up on the green Answer button to accept the incoming call';
    const tapInstruction = 'Tap the green Answer button to accept the incoming call';

    try {
      await aiCommand(swipeInstruction, 'acceptIncomingCall (swipe up green)');
    } catch {
      logToTerminal('Swipe-up accept failed, trying tap on green Answer button...');
      await aiCommand(tapInstruction, 'acceptIncomingCall (tap green)');
    }
  }

  /**
   * Waits for the incoming-call UI, then uses AI to answer (swipe up on green). Polls until success or timeout.
   */
  async waitForIncomingCallAndAccept(options?: WaitForIncomingCallOptions): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? 120_000;
    const pollIntervalMs = options?.pollIntervalMs ?? 5000;
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt++;
      const remainingSec = Math.round((deadline - Date.now()) / 1000);
      const attemptMsg = `Answer attempt ${attempt} (timeout in ${remainingSec}s)`;
      logToTerminal(attemptMsg);
      await logToBrowserStack(attemptMsg, 'info');

      try {
        await this.acceptIncomingCall();
        logToTerminal('Call accepted successfully.');
        await logToBrowserStack('Call accepted successfully.', 'info');
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const failMsg = `Answer attempt ${attempt} failed: ${msg}. Retrying in ${pollIntervalMs / 1000}s...`;
        logToTerminal(failMsg);
        await logToBrowserStack(failMsg, 'info');
        await browser.pause(pollIntervalMs);
      }
    }

    logToTerminal('Timeout: could not accept incoming call.');
    await logToBrowserStack('Timeout: could not accept incoming call.', 'error');
    throw new Error('Timeout waiting for incoming call Answer button');
  }

  /**
   * Ends the current call using AI.
   */
  async endCall(): Promise<void> {
    await aiCommand('Click the End call button to hang up', 'endCall');
  }

  /**
   * Brings the dial pad to the front using AI (optional; keypad may already be visible in-call).
   */
  async showKeypad(): Promise<void> {
    await aiCommand('Open the dial pad or keypad', 'showKeypad');
  }

  /**
   * Presses a single digit on the keypad using AI.
   */
  async pressDigit(digit: number | string): Promise<void> {
    const char = typeof digit === 'string' ? digit : String(digit);
    await aiCommand(`Tap the digit ${char} on the keypad only once`, `pressDigit(${char})`);
    await browser.pause(300);
  }

  /**
   * Enters a full DTMF/digit sequence using a single AI command (avoids repeated keystrokes from per-digit commands).
   */
  async enterSequence(sequence: string): Promise<void> {
    if (sequence.length === 0) return;
    await aiCommand(
      `Tap the digits ${sequence} on the keypad in order, once each`,
      `enterSequence(${sequence})`
    );
    await browser.pause(500);
  }
}

export default new DialerAIService();
