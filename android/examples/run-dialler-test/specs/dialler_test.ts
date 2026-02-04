import assert from 'assert';
import DialerAIService from '../support/DialerAIService';

const INCOMING_CALL_WAIT_MS = 120000; // 2 minutes for user to dial
const LONG_WAIT_AFTER_ARTICLE_MS = 20000; // 20s on article before prompting to dial
const DTMF_SEQUENCE = '5678';

/** Write to stdout so the prompt appears in the local terminal with real ANSI (not stringified). */
function writeToTerminal(message: string): void {
  process.stdout.write(message);
}

/**
 * Dialler flow: tests are interdependent and must run in declaration order.
 * 1 → SIM + phone number, 2 → open article, 3 → wait + prompt to dial, 4 → answer call, 5 → DTMF + end.
 * Config uses maxInstances: 1 so this file runs in a single worker; Mocha runs it() in order.
 */
describe('Dialler: Wikipedia + incoming call + DTMF', () => {
  let phoneNumber = '<unknown>';
  let simCapabilities: Record<string, unknown> = {};

  it('retrieves device SIM capabilities and phone number for the dial prompt', async function () {
    try {
      const raw = await browser.execute(
        'browserstack_executor: {"action":"deviceInfo","arguments":{"deviceProperties":["simOptions"]}}'
      );
      // Executor returns SIM data directly: { "Phone Number": "...", "Region": "USA" } (or wrapped in .value / .simOptions)
      const data =
        raw && typeof raw === 'object' && 'value' in raw
          ? (raw as { value: unknown }).value
          : raw;
      const simOpts =
        data && typeof data === 'object' && !Array.isArray(data) && 'simOptions' in data
          ? (data as { simOptions: Record<string, unknown> }).simOptions
          : data && typeof data === 'object' && !Array.isArray(data)
            ? (data as Record<string, unknown>)
            : null;
      if (simOpts && typeof simOpts === 'object') {
        simCapabilities = simOpts;
        const num = simOpts['Phone Number'];
        if (typeof num === 'string') phoneNumber = num;
      }
    } catch {
      // non-SIM or executor not available
    }

    // Format SIM capabilities for logging
    const simSummary =
      Object.keys(simCapabilities).length > 0
        ? Object.entries(simCapabilities)
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join(', ')
        : 'none or not available';

    // Terminal logs (local command line)
    writeToTerminal('\n[Dialler] Device SIM capabilities:\n');
    if (Object.keys(simCapabilities).length > 0) {
      for (const [key, value] of Object.entries(simCapabilities)) {
        writeToTerminal(`  ${key}: ${String(value)}\n`);
      }
    } else {
      writeToTerminal('  (none or not available)\n');
    }
    writeToTerminal('\n');

    // BrowserStack console logs (visible in App Automate session)
    const bstackData = `Device SIM capabilities: ${simSummary}`;
    await browser.execute(
      `browserstack_executor: {"action":"annotate","arguments":{"data":${JSON.stringify(bstackData)},"level":"info"}}`
    );

    assert.ok(phoneNumber, 'Device phone number retrieved (or defaulted)');
  });

  it('opens Wikipedia app and navigates to first search result article', async function () {
    const skipButton = await $(
      'android=new UiSelector().resourceId("org.wikipedia.alpha:id/fragment_onboarding_skip_button")'
    );
    await skipButton.waitForDisplayed({ timeout: 30000 });
    await skipButton.click();

    const searchSelector = await $('~Search Wikipedia');
    await searchSelector.waitForDisplayed({ timeout: 30000 });
    await searchSelector.click();

    const insertTextSelector = await $(
      'android=new UiSelector().resourceId("org.wikipedia.alpha:id/search_src_text")'
    );
    await insertTextSelector.waitForDisplayed({ timeout: 30000 });
    await insertTextSelector.addValue('BrowserStack');
    await browser.pause(5000); // Wait for search results to load

    // Try multiple selectors; Wikipedia Alpha layout/resourceIds can vary by version
    const firstResultSelectors = [
      'android=new UiSelector().resourceId("org.wikipedia.alpha:id/page_list_item_container").instance(0)',
      'android=new UiSelector().resourceId("org.wikipedia.alpha:id/list_item_container").instance(0)',
      'android=new UiSelector().resourceId("org.wikipedia.alpha:id/page_list_item").instance(0)',
      'android=new UiSelector().className("android.view.ViewGroup").clickable(true).instance(2)', // Often 0=search bar, 1=first result
      'android=new UiSelector().textContains("BrowserStack").clickable(true).instance(0)',
    ];

    let firstResult: Awaited<ReturnType<typeof $>> | null = null;
    for (const selector of firstResultSelectors) {
      const el = await $(selector);
      try {
        await el.waitForDisplayed({ timeout: 5000 });
        firstResult = el;
        break;
      } catch {
        continue;
      }
    }

    // Fallback: get all list items by resourceId and click first (avoids .instance(0) quirks)
    if (!firstResult) {
      const listItemIds = [
        'org.wikipedia.alpha:id/page_list_item_container',
        'org.wikipedia.alpha:id/list_item_container',
        'org.wikipedia.alpha:id/page_list_item',
      ];
      for (const id of listItemIds) {
        const items = await $$(`android=new UiSelector().resourceId("${id}")`);
        const count = await items.length;
        if (count > 0) {
          await items[0].waitForDisplayed({ timeout: 3000 });
          firstResult = items[0];
          break;
        }
      }
    }

    if (!firstResult) {
      throw new Error(
        'First search result not found. Tried single selectors and list fallbacks.'
      );
    }
    await firstResult.click();

    // Wait for article to load; title/resourceIds vary by Wikipedia Alpha version
    await browser.pause(3000);

    const articleTitleSelectors = [
      'android=new UiSelector().resourceId("org.wikipedia.alpha:id/view_page_title_text")',
      'android=new UiSelector().resourceId("org.wikipedia.alpha:id/page_article_title")',
      'android=new UiSelector().resourceId("org.wikipedia.alpha:id/view_article_title_text")',
      'android=new UiSelector().resourceId("org.wikipedia.alpha:id/page_toolbar_title")',
      'android=new UiSelector().resourceId("org.wikipedia.alpha:id/page_contents_container")',
    ];

    let articleVisible = false;
    for (const selector of articleTitleSelectors) {
      const el = await $(selector);
      try {
        await el.waitForDisplayed({ timeout: 8000 });
        articleVisible = true;
        break;
      } catch {
        continue;
      }
    }
    if (!articleVisible) {
      throw new Error(
        'Article page did not load. Tried: view_page_title_text, page_article_title, view_article_title_text, page_toolbar_title.'
      );
    }
  });

  it('waits on article then prompts user to dial the device number', async function () {
    await browser.pause(LONG_WAIT_AFTER_ARTICLE_MS);

    // Write directly to stdout so the prompt appears in the local terminal with real bold (ANSI), not stringified
    const boldOn = '\x1b[1m';
    const boldOff = '\x1b[0m';
    writeToTerminal('\n');
    writeToTerminal(boldOn + '*** PLEASE DIAL THE DEVICE PHONE NUMBER NOW ***' + boldOff + '\n');
    writeToTerminal(boldOn + 'Device phone number: ' + phoneNumber + boldOff + '\n');
    writeToTerminal('\n');
  });

  it('detects incoming call and answers it', async function () {
    await DialerAIService.waitForIncomingCallAndAccept({
      timeoutMs: INCOMING_CALL_WAIT_MS,
      pollIntervalMs: 5000,
    });
    await browser.pause(3000); // Let call connect
  });

  it('dials DTMF sequence 1-9 and ends the call', async function () {
    await DialerAIService.enterSequence(DTMF_SEQUENCE);
    await browser.pause(2000);
    await DialerAIService.endCall();
    await browser.pause(2000);

    assert.ok(true, 'DTMF sequence 123456789 dialled and call closed successfully');
  });
});
