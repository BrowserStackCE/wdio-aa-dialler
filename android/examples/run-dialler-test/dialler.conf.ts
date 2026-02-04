import { platform } from 'os';
import path from 'path';

type ConfigWithCommon = WebdriverIO.Config & {
  commonCapabilities?: Record<string, object>;
} & Record<string, unknown>;

export const config: ConfigWithCommon = {
  user: process.env.BROWSERSTACK_USERNAME || 'BROWSERSTACK_USERNAME',
  key: process.env.BROWSERSTACK_ACCESS_KEY || 'BROWSERSTACK_ACCESS_KEY',

  hostname: 'hub.browserstack.com',

  tsConfigPath: path.join(__dirname, '../../tsconfig.json'),

  services: [
    [
      'browserstack',
      {
        accessibility: false,
        buildIdentifier: '${BUILD_NUMBER}',
        browserstackLocal: true,
        opts: { forcelocal: false, localIdentifier: 'webdriverio-appium-app-browserstack-repo' },
        // For dedicated devices: upload app via REST API, then set BROWSERSTACK_APP_ID to app_url (bs://...) or custom_id
        app:
          process.env.BROWSERSTACK_APP_ID ||
          process.env.BROWSERSTACK_APP_PATH ||
          path.resolve(__dirname, '../WikipediaSample.apk'),
      },
    ],
  ],

  // Android device with US SIM. Use osVersion (not platformVersion) to avoid BrowserStack CLI JSON parse error.
  // For "any" device, try deviceName: '.*' and osVersion: '.*' once CLI runs successfully.
  capabilities: [
    {
      platformName: 'android',
      'bstack:options': {
        deviceName: 'Samsung .*',
        osVersion: '14.0',
        dedicatedDevice: true,
        //deviceId: 'R3CX5055PYF',
        enableSim: 'false',
        aiAuthoring: true, // Cross-Device Automation Agent for natural-language dialler actions
        // simOptions: {
        //   region: 'Ireland',
        // },
      } as Record<string, unknown>,
    },
  ],

  commonCapabilities: {
    'bstack:options': {
      projectName: 'BrowserStack Dialler Test',
      buildName: 'dialler build',
      sessionName: 'Dialler: Wikipedia + incoming call + DTMF',
      debug: true,
      networkLogs: true,
      source: 'webdriverio:appium-sample-sdk:v1.0',
      aiAuthoring: true,
      interactiveDebugging: true,
    },
  },

  // Sequential run: one worker so dialler_test.ts runs in order (tests are interdependent)
  maxInstances: 1,

  updateJob: false,
  specs: ['./specs/dialler_test.ts'],
  exclude: [],

  logLevel: 'warn',
  coloredLogs: true,
  screenshotPath: './errorShots/',
  baseUrl: '',
  waitforTimeout: 15000,
  connectionRetryTimeout: 90000,
  connectionRetryCount: 3,

  framework: 'mocha',
  mochaOpts: {
    ui: 'bdd',
    timeout: 300000, // 5 min for user to dial and complete call
  },

  reporters: [
    'spec',
    [
      'junit',
      {
        outputDir: path.join(__dirname, 'reports/junit'),
        outputFileFormat: () => `dialler-${new Date().toISOString().replace(/[:.]/g, '-')}.xml`,
      },
    ],
  ],
};

// Merge common capabilities into each capability
config.capabilities!.forEach((caps) => {
  if (config.commonCapabilities) {
    for (const key in config.commonCapabilities) {
      const cap = (caps as Record<string, object>)[key];
      const commonCap = config.commonCapabilities[key];
      (caps as Record<string, object>)[key] = { ...(cap && typeof cap === 'object' ? cap : {}), ...commonCap };
    }
  }
});
