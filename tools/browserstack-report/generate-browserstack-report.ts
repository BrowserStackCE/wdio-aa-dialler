import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as XLSX from "xlsx";

type JsonObject = Record<string, unknown>;

type ColumnConfig = {
  key: string;
  header?: string;
  default?: string | number | boolean | null;
};

type ReportConfig = {
  credentials: {
    usernameEnv: string;
    accessKeyEnv: string;
  };
  inputs: {
    testReportingBuildIds: string[];
    appAutomateBuildIds: string[];
    appCustomIds?: string[];
    discoverRecentBuilds?: {
      enabled?: boolean;
      maxBuildsPerSource?: number;
      testReportingProjectIds?: number[];
    };
  };
  testReporting: {
    enabled: boolean;
    fetchAllPages: boolean;
    includeHooks: boolean;
    testRunQuery?: Record<string, string>;
  };
  appAutomate: {
    enabled: boolean;
    sessionLimit: number;
    includeSessionDetails: boolean;
    sessionStatusFilter?: string;
    appListLimit: number;
  };
  outputs: {
    directory: string;
    baseName: string;
    formats: Array<"csv" | "xlsx" | "md" | "json">;
    markdownMaxRows: number;
  };
  filters?: {
    days?: number | null;
    projects?: string[];
    teams?: string[];
    people?: string[];
    caseSensitive?: boolean;
    applyDaysToApps?: boolean;
  };
  columns?: {
    builds?: ColumnConfig[];
    tests?: ColumnConfig[];
    sessions?: ColumnConfig[];
    apps?: ColumnConfig[];
    overview?: ColumnConfig[];
  };
};

type BuildRow = Record<string, unknown>;
type TestRow = Record<string, unknown>;
type SessionRow = Record<string, unknown>;
type AppRow = Record<string, unknown>;
type OverviewRow = Record<string, unknown>;
type ProgressHandle = {
  tick: (detail?: string) => void;
  complete: (detail?: string) => void;
};

const DEFAULT_CONFIG_PATH = path.join(
  process.cwd(),
  "tools/browserstack-report/browserstack-report.config.sample.json",
);

const SPINNER_FRAMES = ["|", "/", "-", "\\"];
const API = {
  testReportingProjects: "https://api-automation.browserstack.com/ext/v1/projects",
  testReportingProjectBuilds: (projectId: number) =>
    `https://api-automation.browserstack.com/ext/v1/projects/${projectId}/builds`,
  testReportingBuildDetails: (buildId: string) =>
    `https://api-automation.browserstack.com/ext/v1/builds/${buildId}`,
  testReportingBuildTests: (buildId: string) =>
    `https://api-automation.browserstack.com/ext/v1/builds/${buildId}/testRuns`,
  appAutomateBuilds: "https://api-cloud.browserstack.com/app-automate/builds.json",
  appAutomateBuildSessions: (buildId: string) =>
    `https://api-cloud.browserstack.com/app-automate/builds/${buildId}/sessions.json`,
  appAutomateSessionDetails: (sessionId: string) =>
    `https://api-cloud.browserstack.com/app-automate/sessions/${sessionId}.json`,
  appAutomateRecentApps: "https://api-cloud.browserstack.com/app-automate/recent_apps",
  appAutomateRecentAppsByCustomId: (customId: string) =>
    `https://api-cloud.browserstack.com/app-automate/recent_apps/${encodeURIComponent(customId)}`,
} as const;
const LIMITS = {
  maxProjectPages: 200,
  maxBuildPagesPerProject: 500,
} as const;

function createProgress(label: string, total = 0): ProgressHandle {
  const interactive = Boolean(process.stdout.isTTY);
  let current = 0;
  let spinnerIndex = 0;
  let lastLength = 0;

  const render = (detail?: string): void => {
    if (!interactive) return;
    let line = "";
    if (total > 0) {
      const width = 24;
      const ratio = Math.max(0, Math.min(1, current / total));
      const filled = Math.round(ratio * width);
      const bar = `${"=".repeat(filled)}${"-".repeat(width - filled)}`;
      const pct = Math.round(ratio * 100);
      line = `${label} [${bar}] ${current}/${total} (${pct}%)`;
    } else {
      const spinner = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
      spinnerIndex += 1;
      line = `${label} ${spinner} ${current}`;
    }
    if (detail) {
      line += ` ${detail}`;
    }
    const padded = line.padEnd(lastLength, " ");
    lastLength = padded.length;
    process.stdout.write(`\r${padded}`);
  };

  if (!interactive) {
    // eslint-disable-next-line no-console
    console.log(`${label}...`);
  } else {
    render();
  }

  return {
    tick: (detail?: string) => {
      current += 1;
      render(detail);
    },
    complete: (detail?: string) => {
      if (!interactive) {
        // eslint-disable-next-line no-console
        console.log(`${label} done${detail ? ` (${detail})` : ""}.`);
        return;
      }
      const suffix = detail ? ` ${detail}` : "";
      const doneLine = `${label} done.${suffix}`.padEnd(lastLength, " ");
      process.stdout.write(`\r${doneLine}\n`);
    },
  };
}

function parseArgs(argv: string[]): { configPath: string } {
  let configPath = DEFAULT_CONFIG_PATH;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config" || arg === "-c") {
      const nextValue = argv[i + 1];
      if (!nextValue) {
        throw new Error("Missing value for --config");
      }
      configPath = path.resolve(process.cwd(), nextValue);
      i += 1;
    }
  }
  return { configPath };
}

async function loadConfig(configPath: string): Promise<ReportConfig> {
  const fileContent = await import("node:fs/promises").then((fs) =>
    fs.readFile(configPath, "utf-8"),
  );
  const parsed = JSON.parse(fileContent) as Partial<ReportConfig>;
  return resolveConfig(parsed);
}

function resolveConfig(raw: Partial<ReportConfig>): ReportConfig {
  return {
    credentials: {
      usernameEnv: raw.credentials?.usernameEnv ?? "BROWSERSTACK_USERNAME",
      accessKeyEnv: raw.credentials?.accessKeyEnv ?? "BROWSERSTACK_ACCESS_KEY",
    },
    inputs: {
      testReportingBuildIds: raw.inputs?.testReportingBuildIds ?? [],
      appAutomateBuildIds: raw.inputs?.appAutomateBuildIds ?? [],
      appCustomIds: raw.inputs?.appCustomIds ?? [],
      discoverRecentBuilds: {
        enabled: raw.inputs?.discoverRecentBuilds?.enabled ?? true,
        maxBuildsPerSource:
          raw.inputs?.discoverRecentBuilds?.maxBuildsPerSource ?? 20,
        testReportingProjectIds:
          raw.inputs?.discoverRecentBuilds?.testReportingProjectIds ?? [],
      },
    },
    testReporting: {
      enabled: raw.testReporting?.enabled ?? true,
      fetchAllPages: raw.testReporting?.fetchAllPages ?? true,
      includeHooks: raw.testReporting?.includeHooks ?? false,
      testRunQuery: raw.testReporting?.testRunQuery ?? {},
    },
    appAutomate: {
      enabled: raw.appAutomate?.enabled ?? true,
      sessionLimit: raw.appAutomate?.sessionLimit ?? 25,
      includeSessionDetails: raw.appAutomate?.includeSessionDetails ?? true,
      sessionStatusFilter: raw.appAutomate?.sessionStatusFilter ?? "",
      appListLimit: raw.appAutomate?.appListLimit ?? 10,
    },
    outputs: {
      directory: raw.outputs?.directory ?? "reports/browserstack-report",
      baseName: raw.outputs?.baseName ?? "browserstack-report",
      formats: raw.outputs?.formats ?? ["csv", "xlsx", "md", "json"],
      markdownMaxRows: raw.outputs?.markdownMaxRows ?? 0,
    },
    filters: {
      days: raw.filters?.days ?? null,
      projects: raw.filters?.projects ?? [],
      teams: raw.filters?.teams ?? [],
      people: raw.filters?.people ?? [],
      caseSensitive: raw.filters?.caseSensitive ?? false,
      applyDaysToApps: raw.filters?.applyDaysToApps ?? false,
    },
    columns: {
      overview: raw.columns?.overview,
      builds: raw.columns?.builds,
      tests: raw.columns?.tests,
      sessions: raw.columns?.sessions,
      apps: raw.columns?.apps,
    },
  };
}

function isPlaceholderValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized.includes("replace-with") ||
    normalized.includes("optional-") ||
    normalized.includes("your-")
  );
}

function validateConfig(config: ReportConfig): void {
  const errors: string[] = [];
  const canDiscover = Boolean(config.inputs.discoverRecentBuilds?.enabled);

  if (config.testReporting.enabled) {
    if (config.inputs.testReportingBuildIds.length === 0 && !canDiscover) {
      errors.push(
        "testReporting.enabled is true but inputs.testReportingBuildIds is empty.",
      );
    }
    const invalid = config.inputs.testReportingBuildIds.filter(isPlaceholderValue);
    if (invalid.length > 0) {
      errors.push(
        `testReportingBuildIds contains placeholder values: ${invalid.join(", ")}`,
      );
    }
  }

  if (config.appAutomate.enabled) {
    if (config.inputs.appAutomateBuildIds.length === 0 && !canDiscover) {
      errors.push(
        "appAutomate.enabled is true but inputs.appAutomateBuildIds is empty.",
      );
    }
    const invalid = config.inputs.appAutomateBuildIds.filter(isPlaceholderValue);
    if (invalid.length > 0) {
      errors.push(
        `appAutomateBuildIds contains placeholder values: ${invalid.join(", ")}`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      [
        "Invalid report configuration.",
        ...errors,
        "Tip: provide real BrowserStack build IDs, or disable the corresponding section (testReporting.enabled/appAutomate.enabled).",
      ].join("\n"),
    );
  }

  if (
    config.filters?.days !== undefined &&
    config.filters?.days !== null &&
    (!Number.isFinite(config.filters.days) || config.filters.days <= 0)
  ) {
    throw new Error("Invalid filters.days. Use a positive number or null.");
  }
}

function getAuthHeaders(config: ReportConfig): Record<string, string> {
  const username = process.env[config.credentials.usernameEnv];
  const accessKey = process.env[config.credentials.accessKeyEnv];

  if (!username || !accessKey) {
    throw new Error(
      `Missing BrowserStack credentials. Please set ${config.credentials.usernameEnv} and ${config.credentials.accessKeyEnv}.`,
    );
  }

  const token = Buffer.from(`${username}:${accessKey}`).toString("base64");
  return {
    Authorization: `Basic ${token}`,
    Accept: "application/json",
  };
}

function toQueryString(query: Record<string, string> = {}): string {
  const entries = Object.entries(query).filter(([, value]) => value !== "");
  if (entries.length === 0) return "";
  const searchParams = new URLSearchParams(entries);
  return `?${searchParams.toString()}`;
}

async function fetchJson<T>(
  url: string,
  headers: Record<string, string>,
): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Request failed ${response.status} ${response.statusText} for ${url}\n${body}`,
    );
  }
  return (await response.json()) as T;
}

function safeJoin(values: unknown[], delimiter = ", "): string {
  return values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0)
    .join(delimiter);
}

function getNested(input: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((acc, part) => {
    if (acc === null || acc === undefined || typeof acc !== "object") {
      return undefined;
    }
    return (acc as JsonObject)[part];
  }, input);
}

function toIsoOrEmpty(rawValue: unknown): string {
  if (!rawValue) return "";
  const date = new Date(String(rawValue));
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function normalizeTerms(values?: string[]): string[] {
  if (!values) return [];
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .filter((value) => !isPlaceholderValue(value));
}

function matchAnyTerm(text: string, terms: string[], caseSensitive: boolean): boolean {
  if (terms.length === 0) return true;
  if (caseSensitive) {
    return terms.some((term) => text.includes(term));
  }
  const haystack = text.toLowerCase();
  return terms.some((term) => haystack.includes(term.toLowerCase()));
}

function isWithinDays(
  row: Record<string, unknown>,
  dateKeys: string[],
  days?: number | null,
): boolean {
  if (!days) return true;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const timestamps = dateKeys
    .map((key) => row[key])
    .filter((value) => value !== null && value !== undefined && String(value) !== "")
    .map((value) => new Date(String(value)).getTime())
    .filter((timestamp) => Number.isFinite(timestamp));

  // Keep rows that don't carry a timestamp in this schema.
  if (timestamps.length === 0) return true;
  return timestamps.some((timestamp) => timestamp >= cutoff);
}

function applyFiltersToRows(
  rows: Record<string, unknown>[],
  options: {
    days?: number | null;
    projects?: string[];
    teams?: string[];
    people?: string[];
    caseSensitive: boolean;
    dateKeys: string[];
    projectKeys: string[];
    teamKeys: string[];
    peopleKeys: string[];
  },
): Record<string, unknown>[] {
  const projects = normalizeTerms(options.projects);
  const teams = normalizeTerms(options.teams);
  const people = normalizeTerms(options.people);

  return rows.filter((row) => {
    const projectText = safeJoin(options.projectKeys.map((key) => row[key]));
    const teamText = safeJoin(options.teamKeys.map((key) => row[key]));
    const peopleText = safeJoin(options.peopleKeys.map((key) => row[key]));

    const projectMatch = matchAnyTerm(projectText, projects, options.caseSensitive);
    const teamMatch = matchAnyTerm(teamText, teams, options.caseSensitive);
    const peopleMatch = matchAnyTerm(peopleText, people, options.caseSensitive);
    const dayMatch = isWithinDays(row, options.dateKeys, options.days);

    return projectMatch && teamMatch && peopleMatch && dayMatch;
  });
}

function flattenTestHierarchy(
  buildId: string,
  buildName: string,
  buildNumber: number | string,
  hierarchy: unknown[],
  includeHooks: boolean,
): TestRow[] {
  const rows: TestRow[] = [];

  type Node = {
    display_name?: string;
    type?: string;
    details?: JsonObject;
    children?: Node[];
  };

  function walk(
    node: Node,
    rootDetails: JsonObject,
    rootDisplayName: string,
    parentPath: string[],
  ): void {
    const type = String(node.type ?? "");
    const details = (node.details ?? {}) as JsonObject;
    const displayName = String(node.display_name ?? "");
    const nextPath = displayName ? [...parentPath, displayName] : parentPath;

    if ((type === "TEST" || (includeHooks && type === "HOOK")) && displayName) {
      const retries = Array.isArray(details.retries)
        ? (details.retries as JsonObject[])
        : [];
      const firstRetry = retries[0] ?? {};
      const logs = (firstRetry.logs ?? {}) as JsonObject;
      const failureLogs = Array.isArray(logs.TEST_FAILURE)
        ? (logs.TEST_FAILURE as unknown[])
        : [];

      rows.push({
        source_build_id: buildId,
        source_build_name: buildName,
        source_build_number: buildNumber,
        root_scope: rootDisplayName,
        scope_path: parentPath.join(" > "),
        test_type: type,
        test_name: displayName,
        test_status: details.status ?? "",
        test_duration_ms: details.duration ?? "",
        test_tags: safeJoin(
          Array.isArray(details.tags) ? (details.tags as unknown[]) : [],
        ),
        retries_count: retries.length,
        run_count: details.run_count ?? "",
        is_flaky: details.is_flaky ?? "",
        is_always_failing: details.is_always_failing ?? "",
        is_new_failure: details.is_new_failure ?? "",
        is_performance_anomaly: details.is_performance_anomaly ?? "",
        is_muted: details.is_muted ?? "",
        observability_url: details.observability_url ?? "",
        first_failure_log: failureLogs[0] ?? "",
        root_file_path: rootDetails.file_path ?? "",
        root_os_name: getNested(rootDetails.os, "name") ?? "",
        root_os_version: getNested(rootDetails.os, "version") ?? "",
        root_browser_name: getNested(rootDetails.browser, "name") ?? "",
        root_browser_version: getNested(rootDetails.browser, "version") ?? "",
        root_device: rootDetails.device ?? "",
        finished_at: rootDetails.finished_at ?? "",
      });
    }

    const children = Array.isArray(node.children) ? node.children : [];
    children.forEach((child) => walk(child, rootDetails, rootDisplayName, nextPath));
  }

  (hierarchy as Node[]).forEach((rootNode) => {
    const rootDetails = (rootNode.details ?? {}) as JsonObject;
    const rootDisplayName = String(rootNode.display_name ?? "");
    walk(rootNode, rootDetails, rootDisplayName, []);
  });

  return rows;
}

type TestRunsResponse = {
  name?: string;
  build_name?: string;
  build_number?: number;
  hierarchy?: unknown[];
  pagination?: {
    has_next?: boolean;
    next_page?: string;
  };
};

type BuildDetailsResponse = {
  name?: string;
  status?: string;
  duration?: number;
  user?: string;
  tags?: string[];
  build_uuid?: string;
  build_number?: number;
  original_name?: string;
  finished_at?: string;
  started_at?: string;
  status_stats?: Record<string, number>;
  failure_categories?: Record<string, number>;
  smart_tags?: Record<string, number>;
  observability_url?: string;
  tcmTestRunIdentifier?: string;
};

async function fetchTestReportingData(
  config: ReportConfig,
  headers: Record<string, string>,
): Promise<{ builds: BuildRow[]; tests: TestRow[] }> {
  if (!config.testReporting.enabled || config.inputs.testReportingBuildIds.length === 0) {
    return { builds: [], tests: [] };
  }

  const builds: BuildRow[] = [];
  const tests: TestRow[] = [];
  const progress = createProgress(
    "Fetching Test Reporting builds",
    config.inputs.testReportingBuildIds.length,
  );
  const requestProgress = createProgress("Fetching Test Reporting API pages");

  for (const [buildIndex, buildId] of config.inputs.testReportingBuildIds.entries()) {
    const buildDetailsUrl = API.testReportingBuildDetails(buildId);
    const buildDetails = await fetchJson<BuildDetailsResponse>(buildDetailsUrl, headers);
    requestProgress.tick(`build#=${buildIndex + 1} details`);

    builds.push({
      source: "test-reporting",
      build_id: buildId,
      build_name: buildDetails.name ?? "",
      original_build_name: buildDetails.original_name ?? "",
      build_number: buildDetails.build_number ?? "",
      build_status: buildDetails.status ?? "",
      duration_ms: buildDetails.duration ?? "",
      user: buildDetails.user ?? "",
      tags: safeJoin(buildDetails.tags ?? []),
      started_at: toIsoOrEmpty(buildDetails.started_at),
      finished_at: toIsoOrEmpty(buildDetails.finished_at),
      passed: buildDetails.status_stats?.passed ?? 0,
      failed: buildDetails.status_stats?.failed ?? 0,
      skipped: buildDetails.status_stats?.skipped ?? 0,
      pending: buildDetails.status_stats?.pending ?? 0,
      unknown: buildDetails.status_stats?.unknown ?? 0,
      flaky_count: buildDetails.smart_tags?.is_flaky ?? 0,
      always_failing_count: buildDetails.smart_tags?.is_always_failing ?? 0,
      performance_anomaly_count: buildDetails.smart_tags?.is_performance_anomaly ?? 0,
      new_failure_count: buildDetails.smart_tags?.is_new_failure ?? 0,
      observability_url: buildDetails.observability_url ?? "",
      tcm_test_run_identifier: buildDetails.tcmTestRunIdentifier ?? "",
    });

    let nextPage: string | undefined = undefined;
    let keepFetching = true;
    let pageCount = 0;
    while (keepFetching) {
      const query: Record<string, string> = {
        ...(config.testReporting.testRunQuery ?? {}),
      };
      if (nextPage) query.next_page = nextPage;
      const testRunsUrl = `${API.testReportingBuildTests(buildId)}${toQueryString(query)}`;
      const testRunsResponse = await fetchJson<TestRunsResponse>(testRunsUrl, headers);
      pageCount += 1;
      requestProgress.tick(`build#=${buildIndex + 1} test_runs page=${pageCount}`);

      const flattenedRows = flattenTestHierarchy(
        buildId,
        testRunsResponse.build_name ?? buildDetails.name ?? "",
        testRunsResponse.build_number ?? buildDetails.build_number ?? "",
        testRunsResponse.hierarchy ?? [],
        config.testReporting.includeHooks,
      );
      const buildStartedAt = toIsoOrEmpty(buildDetails.started_at);
      const buildFinishedAt = toIsoOrEmpty(buildDetails.finished_at);
      flattenedRows.forEach((row) => {
        row.build_started_at = buildStartedAt;
        row.build_finished_at = buildFinishedAt;
      });
      tests.push(...flattenedRows);

      const hasNext = Boolean(testRunsResponse.pagination?.has_next);
      nextPage = testRunsResponse.pagination?.next_page;
      keepFetching = config.testReporting.fetchAllPages && hasNext && Boolean(nextPage);
    }

    progress.tick(`build#=${buildIndex + 1}`);
  }

  requestProgress.complete();
  progress.complete(`${builds.length} builds, ${tests.length} tests`);

  return { builds, tests };
}

type AppAutomateSessionListItem = {
  automation_session: {
    name?: string;
    duration?: number;
    created_at?: string;
    started_at?: string;
    finished_at?: string;
    os?: string;
    os_version?: string;
    device?: string;
    status?: string;
    hashed_id?: string;
    reason?: string;
    build_name?: string;
    project_name?: string;
    logs?: string;
    appium_logs_url?: string;
    video_url?: string;
    public_url?: string;
  };
};

type AppAutomateSessionDetailsResponse = {
  automation_session: {
    created_at?: string;
    started_at?: string;
    finished_at?: string;
    app_details?: {
      app_url?: string;
      app_name?: string;
      app_version?: string;
      app_custom_id?: string;
      uploaded_at?: string;
    };
  };
};

type AppListItem = {
  app_name?: string;
  app_version?: string;
  app_url?: string;
  app_id?: string;
  uploaded_at?: string;
  custom_id?: string;
  shareable_id?: string;
};

async function fetchAppAutomateSessionsForBuild(
  buildId: string,
  config: ReportConfig,
  headers: Record<string, string>,
): Promise<SessionRow[]> {
  const rows: SessionRow[] = [];
  const limit = Math.max(1, config.appAutomate.sessionLimit);
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const query: Record<string, string> = {
      limit: String(limit),
      offset: String(offset),
    };
    if (config.appAutomate.sessionStatusFilter) {
      query.status = config.appAutomate.sessionStatusFilter;
    }

    const url = `${API.appAutomateBuildSessions(buildId)}${toQueryString(query)}`;
    const response = await fetchJson<AppAutomateSessionListItem[]>(url, headers);

    for (const item of response) {
      const session = item.automation_session ?? {};
      const sessionId = session.hashed_id ?? "";
      const baseRow: SessionRow = {
        source: "app-automate",
        build_id: buildId,
        session_id: sessionId,
        session_name: session.name ?? "",
        session_created_at: toIsoOrEmpty(session.created_at),
        session_started_at: toIsoOrEmpty(session.started_at),
        session_finished_at: toIsoOrEmpty(session.finished_at),
        session_status: session.status ?? "",
        session_duration_sec: session.duration ?? "",
        os: session.os ?? "",
        os_version: session.os_version ?? "",
        device: session.device ?? "",
        reason: session.reason ?? "",
        build_name: session.build_name ?? "",
        project_name: session.project_name ?? "",
        logs_url: session.logs ?? "",
        appium_logs_url: session.appium_logs_url ?? "",
        video_url: session.video_url ?? "",
        public_url: session.public_url ?? "",
      };

      if (config.appAutomate.includeSessionDetails && sessionId) {
        const detailsUrl = API.appAutomateSessionDetails(sessionId);
        const details = await fetchJson<AppAutomateSessionDetailsResponse>(
          detailsUrl,
          headers,
        );
        const appDetails = details.automation_session?.app_details ?? {};
        const sessionDetails = details.automation_session ?? {};
        baseRow.session_created_at =
          toIsoOrEmpty(sessionDetails.created_at) ||
          String(baseRow.session_created_at ?? "");
        baseRow.session_started_at =
          toIsoOrEmpty(sessionDetails.started_at) ||
          String(baseRow.session_started_at ?? "");
        baseRow.session_finished_at =
          toIsoOrEmpty(sessionDetails.finished_at) ||
          String(baseRow.session_finished_at ?? "");
        baseRow.app_url = appDetails.app_url ?? "";
        baseRow.app_name = appDetails.app_name ?? "";
        baseRow.app_version = appDetails.app_version ?? "";
        baseRow.app_custom_id = appDetails.app_custom_id ?? "";
        baseRow.app_uploaded_at = toIsoOrEmpty(appDetails.uploaded_at);
      }

      rows.push(baseRow);
    }

    hasMore = response.length === limit;
    offset += limit;
  }

  return rows;
}

async function fetchAppAutomateApps(
  config: ReportConfig,
  headers: Record<string, string>,
): Promise<AppRow[]> {
  if (!config.appAutomate.enabled) return [];

  const appCustomIds = config.inputs.appCustomIds ?? [];
  const appRows: AppRow[] = [];

  if (appCustomIds.length === 0) {
    const listUrl = `${API.appAutomateRecentApps}${toQueryString({
      limit: String(config.appAutomate.appListLimit),
    })}`;
    const apps = await fetchJson<AppListItem[]>(listUrl, headers);
    apps.forEach((app) => {
      appRows.push({
        app_name: app.app_name ?? "",
        app_version: app.app_version ?? "",
        app_url: app.app_url ?? "",
        app_id: app.app_id ?? "",
        uploaded_at: toIsoOrEmpty(app.uploaded_at),
        custom_id: app.custom_id ?? "",
        shareable_id: app.shareable_id ?? "",
      });
    });
    return appRows;
  }

  for (const customId of appCustomIds) {
    const listUrl = API.appAutomateRecentAppsByCustomId(customId);
    const apps = await fetchJson<AppListItem[]>(listUrl, headers);
    apps.slice(0, config.appAutomate.appListLimit).forEach((app) => {
      appRows.push({
        app_name: app.app_name ?? "",
        app_version: app.app_version ?? "",
        app_url: app.app_url ?? "",
        app_id: app.app_id ?? "",
        uploaded_at: toIsoOrEmpty(app.uploaded_at),
        custom_id: app.custom_id ?? "",
        shareable_id: app.shareable_id ?? "",
      });
    });
  }

  return appRows;
}

async function fetchAppAutomateData(
  config: ReportConfig,
  headers: Record<string, string>,
): Promise<{ sessions: SessionRow[]; apps: AppRow[] }> {
  if (!config.appAutomate.enabled) return { sessions: [], apps: [] };

  const sessions: SessionRow[] = [];
  const progress = createProgress(
    "Fetching App Automate session builds",
    config.inputs.appAutomateBuildIds.length,
  );
  for (const [buildIndex, buildId] of config.inputs.appAutomateBuildIds.entries()) {
    const perBuildSessions = await fetchAppAutomateSessionsForBuild(
      buildId,
      config,
      headers,
    );
    sessions.push(...perBuildSessions);
    progress.tick(`build#=${buildIndex + 1} sessions=${perBuildSessions.length}`);
  }
  progress.complete(`${sessions.length} sessions`);

  const appsProgress = createProgress("Fetching App Automate apps");
  const apps = await fetchAppAutomateApps(config, headers);
  appsProgress.tick(`apps=${apps.length}`);
  appsProgress.complete();
  return { sessions, apps };
}

function createOverviewRows(
  buildRows: BuildRow[],
  testRows: TestRow[],
  sessionRows: SessionRow[],
): OverviewRow[] {
  const testsByStatus = new Map<string, number>();
  testRows.forEach((row) => {
    const status = String(row.test_status ?? "unknown");
    testsByStatus.set(status, (testsByStatus.get(status) ?? 0) + 1);
  });

  const sessionsByStatus = new Map<string, number>();
  sessionRows.forEach((row) => {
    const status = String(row.session_status ?? "unknown");
    sessionsByStatus.set(status, (sessionsByStatus.get(status) ?? 0) + 1);
  });

  const uniqueBuildIds = new Set<string>();
  buildRows.forEach((row) => {
    const id = String(row.build_id ?? "").trim();
    if (id) uniqueBuildIds.add(id);
  });
  testRows.forEach((row) => {
    const id = String(row.source_build_id ?? "").trim();
    if (id) uniqueBuildIds.add(id);
  });
  sessionRows.forEach((row) => {
    const id = String(row.build_id ?? "").trim();
    if (id) uniqueBuildIds.add(id);
  });

  const totalBuilds = uniqueBuildIds.size;
  const totalTests = testRows.length;
  const totalSessions = sessionRows.length;

  return [
    { metric: "total_builds", value: totalBuilds },
    { metric: "total_tests", value: totalTests },
    { metric: "total_sessions", value: totalSessions },
    ...Array.from(testsByStatus.entries()).map(([status, count]) => ({
      metric: `tests_${status}`,
      value: count,
    })),
    ...Array.from(sessionsByStatus.entries()).map(([status, count]) => ({
      metric: `sessions_${status}`,
      value: count,
    })),
  ];
}

function applyConfiguredFilters(
  config: ReportConfig,
  data: {
    builds: BuildRow[];
    tests: TestRow[];
    sessions: SessionRow[];
    apps: AppRow[];
  },
): {
  builds: BuildRow[];
  tests: TestRow[];
  sessions: SessionRow[];
  apps: AppRow[];
} {
  const filters = config.filters;
  if (!filters) return data;

  const caseSensitive = Boolean(filters.caseSensitive);

  const builds = applyFiltersToRows(data.builds, {
    days: filters.days,
    projects: filters.projects,
    teams: filters.teams,
    people: filters.people,
    caseSensitive,
    dateKeys: ["started_at", "finished_at"],
    projectKeys: ["build_name", "original_build_name", "tags"],
    teamKeys: ["tags", "build_name"],
    peopleKeys: ["user", "tags"],
  }) as BuildRow[];

  const tests = applyFiltersToRows(data.tests, {
    days: filters.days,
    projects: filters.projects,
    teams: filters.teams,
    people: filters.people,
    caseSensitive,
    dateKeys: ["build_started_at", "build_finished_at", "finished_at"],
    projectKeys: ["source_build_name", "root_scope", "test_tags"],
    teamKeys: ["test_tags", "root_scope"],
    peopleKeys: ["test_tags", "test_name", "scope_path"],
  }) as TestRow[];

  const sessions = applyFiltersToRows(data.sessions, {
    days: filters.days,
    projects: filters.projects,
    teams: filters.teams,
    people: filters.people,
    caseSensitive,
    dateKeys: ["session_created_at", "app_uploaded_at"],
    projectKeys: ["project_name", "build_name", "session_name"],
    teamKeys: ["project_name", "session_name"],
    peopleKeys: ["session_name", "project_name", "build_name"],
  }) as SessionRow[];

  const apps = applyFiltersToRows(data.apps, {
    days: filters.applyDaysToApps ? filters.days : undefined,
    projects: filters.projects,
    teams: filters.teams,
    people: filters.people,
    caseSensitive,
    dateKeys: ["uploaded_at"],
    projectKeys: ["custom_id", "shareable_id", "app_name"],
    teamKeys: ["custom_id", "shareable_id"],
    peopleKeys: ["shareable_id", "custom_id"],
  }) as AppRow[];

  return { builds, tests, sessions, apps };
}

function extractObjectsFromUnknownPayload(payload: unknown): JsonObject[] {
  if (Array.isArray(payload)) {
    return payload.filter((item): item is JsonObject => typeof item === "object" && item !== null);
  }
  if (typeof payload !== "object" || payload === null) return [];
  const root = payload as JsonObject;
  const candidates = ["builds", "projects", "items", "data", "results"];
  for (const key of candidates) {
    const value = root[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is JsonObject => typeof item === "object" && item !== null);
    }
  }
  return [];
}

function getPagination(payload: unknown): { hasNext: boolean; nextPage: string } {
  const hasNext = Boolean(getNested(payload, "pagination.has_next"));
  const nextPage =
    String(getNested(payload, "pagination.next_page") ?? "") ||
    String((payload as JsonObject | undefined)?.next_page ?? "");
  return { hasNext, nextPage };
}

async function discoverTestReportingProjectIds(
  headers: Record<string, string>,
): Promise<number[]> {
  const projectIds: number[] = [];
  let nextPage = "";
  let keepFetching = true;
  const progress = createProgress("Discovering Test Reporting projects");
  let pageCount = 0;
  const seenNextPages = new Set<string>();

  while (keepFetching) {
    const url = `${API.testReportingProjects}${toQueryString({
      next_page: nextPage,
    })}`;
    let payload: unknown;
    try {
      payload = await fetchJson<unknown>(url, headers);
    } catch {
      break;
    }

    const projectRecords = extractObjectsFromUnknownPayload(payload);
    pageCount += 1;
    projectIds.push(
      ...projectRecords
        .map((project) => Number(project.id ?? project.project_id))
        .filter((value) => Number.isFinite(value)),
    );
    progress.tick(`page=${pageCount} projects_so_far=${projectIds.length}`);

    const { hasNext, nextPage: paginationNext } = getPagination(payload);

    // Stop on explicit end, repeated cursor, missing cursor, or safety cap.
    keepFetching =
      hasNext &&
      paginationNext.length > 0 &&
      !seenNextPages.has(paginationNext) &&
      pageCount < LIMITS.maxProjectPages;
    if (keepFetching) {
      seenNextPages.add(paginationNext);
      nextPage = paginationNext;
    }
  }

  progress.complete(`projects=${uniqueNumbers(projectIds).length}`);
  return uniqueNumbers(projectIds);
}

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values.filter((value) => Number.isFinite(value))));
}

function isRecentByDays(
  source: JsonObject,
  days?: number | null,
  startedAtKeys: string[] = ["started_at", "created_at", "uploaded_at"],
): boolean {
  if (!days) return true;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const timestamps = startedAtKeys
    .map((key) => source[key])
    .filter((value) => value !== null && value !== undefined)
    .map((value) => new Date(String(value)).getTime())
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) return true;
  return timestamps.some((timestamp) => timestamp >= cutoff);
}

async function discoverTestReportingBuildIds(
  config: ReportConfig,
  headers: Record<string, string>,
): Promise<string[]> {
  const maxBuilds = Math.max(1, config.inputs.discoverRecentBuilds?.maxBuildsPerSource ?? 20);
  const now = Date.now();
  const days = config.filters?.days ?? 7;
  const from = now - days * 24 * 60 * 60 * 1000;
  const dateRange = `${from},${now}`;

  const configuredProjectIds =
    config.inputs.discoverRecentBuilds?.testReportingProjectIds ?? [];
  let projectIds = uniqueNumbers(configuredProjectIds);

  if (projectIds.length === 0) {
    projectIds = await discoverTestReportingProjectIds(headers);
  }

  if (projectIds.length === 0) {
    return [];
  }

  const progress = createProgress(
    "Discovering Test Reporting builds",
    projectIds.length,
  );
  const discoveredIds: string[] = [];

  for (const projectId of projectIds) {
    const pageProgress = createProgress(
      `Project ${projectId} build pages`,
    );
    let nextPage = "";
    let keepFetching = true;
    let collectedForProject = 0;
    let pageCount = 0;
    const seenNextPages = new Set<string>();

    while (keepFetching) {
      const url = `${API.testReportingProjectBuilds(projectId)}${toQueryString({
        date_range: dateRange,
        limit: String(maxBuilds),
        next_page: nextPage,
      })}`;
      let payload: unknown;
      try {
        payload = await fetchJson<unknown>(url, headers);
      } catch {
        break;
      }

      const records = extractObjectsFromUnknownPayload(payload);
      pageCount += 1;
      const pageIds = records
        .map((record) =>
          String(
            record.build_id ??
              record.build_uuid ??
              record.id ??
              "",
          ),
        )
        .filter((value) => value.length > 0);
      discoveredIds.push(...pageIds);
      collectedForProject += pageIds.length;
      pageProgress.tick(
        `page=${pageCount} builds_in_project=${collectedForProject}`,
      );

      const { hasNext, nextPage: paginationNext } = getPagination(payload);
      keepFetching =
        hasNext &&
        paginationNext.length > 0 &&
        !seenNextPages.has(paginationNext) &&
        collectedForProject < maxBuilds &&
        pageCount < LIMITS.maxBuildPagesPerProject;
      if (keepFetching) {
        seenNextPages.add(paginationNext);
        nextPage = paginationNext;
      }
    }

    pageProgress.complete(`pages=${pageCount}`);
    progress.tick(`project=${projectId} builds=${collectedForProject}`);
  }

  progress.complete(`found ${discoveredIds.length} build refs`);
  return uniqueNonEmpty(discoveredIds);
}

async function discoverAppAutomateBuildIds(
  config: ReportConfig,
  headers: Record<string, string>,
): Promise<string[]> {
  const maxBuilds = Math.max(1, config.inputs.discoverRecentBuilds?.maxBuildsPerSource ?? 20);
  const progress = createProgress("Discovering App Automate builds");
  const listUrl = `${API.appAutomateBuilds}${toQueryString({
    limit: String(maxBuilds),
    offset: "0",
  })}`;
  const payload = await fetchJson<unknown>(listUrl, headers);
  const records = extractObjectsFromUnknownPayload(payload);
  progress.tick(`records=${records.length}`);
  const ids = records
    .map((record) =>
      (getNested(record, "automation_build") as JsonObject | undefined) ?? record,
    )
    .filter((record) => isRecentByDays(record, config.filters?.days))
    .map(
      (record) =>
        String(
          record.hashed_id ??
            record.id ??
            record.build_id ??
            record.uuid ??
            "",
        ),
    )
    .filter((value) => value.length > 0);
  const unique = uniqueNonEmpty(ids);
  progress.complete(`builds=${unique.length}`);
  return unique;
}

async function resolveBuildInputs(
  config: ReportConfig,
  headers: Record<string, string>,
): Promise<ReportConfig> {
  const canDiscover = Boolean(config.inputs.discoverRecentBuilds?.enabled);
  if (!canDiscover) return config;

  let testReportingBuildIds = config.inputs.testReportingBuildIds;
  let appAutomateBuildIds = config.inputs.appAutomateBuildIds;

  if (config.testReporting.enabled && testReportingBuildIds.length === 0) {
    testReportingBuildIds = await discoverTestReportingBuildIds(config, headers);
  }
  if (config.appAutomate.enabled && appAutomateBuildIds.length === 0) {
    appAutomateBuildIds = await discoverAppAutomateBuildIds(config, headers);
  }

  if (config.testReporting.enabled && testReportingBuildIds.length === 0) {
    throw new Error([
      "No Test Reporting build IDs available.",
      "Could not discover builds using GET /ext/v1/projects/{project_id}/builds.",
      "Set inputs.discoverRecentBuilds.testReportingProjectIds (one or more project IDs),",
      "or set inputs.testReportingBuildIds manually, or disable testReporting.",
    ].join("\n"));
  }
  if (config.appAutomate.enabled && appAutomateBuildIds.length === 0) {
    throw new Error(
      "No App Automate builds found. Add inputs.appAutomateBuildIds manually, increase inputs.discoverRecentBuilds.maxBuildsPerSource, or disable appAutomate.",
    );
  }

  return {
    ...config,
    inputs: {
      ...config.inputs,
      testReportingBuildIds,
      appAutomateBuildIds,
    },
  };
}

function pickColumns(
  rows: Record<string, unknown>[],
  columns?: ColumnConfig[],
): Record<string, unknown>[] {
  if (!columns || columns.length === 0) {
    return rows;
  }
  return rows.map((row) => {
    const nextRow: Record<string, unknown> = {};
    columns.forEach((column) => {
      const header = column.header ?? column.key;
      const value = getNested(row, column.key);
      nextRow[header] =
        value !== undefined && value !== null ? value : (column.default ?? "");
    });
    return nextRow;
  });
}

function getLatestTimestamp(
  row: Record<string, unknown>,
  preferredDateKeys: string[],
): number {
  const timestamps = preferredDateKeys
    .map((key) => row[key])
    .filter((value) => value !== null && value !== undefined && String(value) !== "")
    .map((value) => new Date(String(value)).getTime())
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) return Number.NEGATIVE_INFINITY;
  return Math.max(...timestamps);
}

function sortRowsByDateDesc(
  rows: Record<string, unknown>[],
  preferredDateKeys: string[],
): Record<string, unknown>[] {
  const cloned = [...rows];
  cloned.sort((left, right) => {
    const rightTs = getLatestTimestamp(right, preferredDateKeys);
    const leftTs = getLatestTimestamp(left, preferredDateKeys);
    if (rightTs !== leftTs) return rightTs - leftTs;
    return 0;
  });
  return cloned;
}

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const headerLine = headers.map(csvEscape).join(",");
  const lines = rows.map((row) => headers.map((key) => csvEscape(row[key])).join(","));
  return [headerLine, ...lines].join("\n");
}

function toMarkdownTable(rows: Record<string, unknown>[], maxRows: number): string {
  if (rows.length === 0) return "_No rows_";
  const headers = Object.keys(rows[0]);
  const separator = headers.map(() => "---").join(" | ");
  const visibleRows = maxRows > 0 ? rows.slice(0, maxRows) : rows;
  const body = visibleRows
    .map((row) => {
      const cells = headers.map((header) =>
        String(row[header] ?? "")
          .replace(/\r?\n/g, " <br> ")
          .replace(/\|/g, "\\|"),
      );
      return `| ${cells.join(" | ")} |`;
    })
    .join("\n");
  const truncatedMessage =
    maxRows > 0 && rows.length > maxRows
      ? `\n\n_Showing ${maxRows} of ${rows.length} rows. See CSV/XLSX for full data._`
      : "";
  return `| ${headers.join(" | ")} |\n| ${separator} |\n${body}${truncatedMessage}`;
}

async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

async function writeCsvFiles(
  outputDir: string,
  baseName: string,
  sections: Record<string, Record<string, unknown>[]>,
): Promise<void> {
  const tasks = Object.entries(sections).map(async ([sectionName, rows]) => {
    const filePath = path.join(outputDir, `${baseName}-${sectionName}.csv`);
    await writeFile(filePath, toCsv(rows), "utf-8");
  });
  await Promise.all(tasks);
}

async function writeJsonFiles(
  outputDir: string,
  baseName: string,
  sections: Record<string, Record<string, unknown>[]>,
): Promise<void> {
  const tasks = Object.entries(sections).map(async ([sectionName, rows]) => {
    const filePath = path.join(outputDir, `${baseName}-${sectionName}.json`);
    await writeFile(filePath, JSON.stringify(rows, null, 2), "utf-8");
  });
  await Promise.all(tasks);
}

async function writeExcelFile(
  outputDir: string,
  baseName: string,
  sections: Record<string, Record<string, unknown>[]>,
): Promise<void> {
  const workbook = XLSX.utils.book_new();
  Object.entries(sections).forEach(([sheetName, rows]) => {
    const worksheet = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(
      workbook,
      worksheet,
      sheetName.slice(0, 31) || "sheet",
    );
  });
  const filePath = path.join(outputDir, `${baseName}.xlsx`);
  XLSX.writeFile(workbook, filePath);
}

async function writeMarkdownFile(
  outputDir: string,
  baseName: string,
  sections: Record<string, Record<string, unknown>[]>,
  markdownMaxRows: number,
): Promise<void> {
  const lines: string[] = [];
  lines.push("# BrowserStack Report");
  lines.push("");
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push("");

  const sectionLabels: Record<string, string> = {
    overview: "Overview",
    builds: "Test Reporting Builds",
    tests: "Test Reporting Tests",
    sessions: "App Automate Sessions",
    apps: "App Automate Apps",
  };

  Object.entries(sections).forEach(([sectionName, rows]) => {
    lines.push(`## ${sectionLabels[sectionName] ?? sectionName}`);
    lines.push("");
    lines.push(toMarkdownTable(rows, markdownMaxRows));
    lines.push("");
  });

  const filePath = path.join(outputDir, `${baseName}.md`);
  await writeFile(filePath, lines.join("\n"), "utf-8");
}

async function main(): Promise<void> {
  const { configPath } = parseArgs(process.argv.slice(2));
  let config = await loadConfig(configPath);
  validateConfig(config);
  const headers = getAuthHeaders(config);
  config = await resolveBuildInputs(config, headers);

  const { builds, tests } = await fetchTestReportingData(config, headers);
  const { sessions, apps } = await fetchAppAutomateData(config, headers);

  const filtered = applyConfiguredFilters(config, { builds, tests, sessions, apps });
  const sorted = {
    builds: sortRowsByDateDesc(filtered.builds, ["finished_at", "started_at"]),
    tests: sortRowsByDateDesc(filtered.tests, [
      "build_finished_at",
      "build_started_at",
      "finished_at",
    ]),
    sessions: sortRowsByDateDesc(filtered.sessions, [
      "session_started_at",
      "session_created_at",
      "session_finished_at",
      "app_uploaded_at",
    ]),
    apps: sortRowsByDateDesc(filtered.apps, ["uploaded_at"]),
  };
  const overview = createOverviewRows(
    sorted.builds,
    sorted.tests,
    sorted.sessions,
  );

  const transformedSections: Record<string, Record<string, unknown>[]> = {
    overview: pickColumns(overview, config.columns?.overview),
    builds: pickColumns(sorted.builds, config.columns?.builds),
    tests: pickColumns(sorted.tests, config.columns?.tests),
    sessions: pickColumns(sorted.sessions, config.columns?.sessions),
    apps: pickColumns(sorted.apps, config.columns?.apps),
  };

  const outputDir = path.resolve(process.cwd(), config.outputs.directory);
  await ensureDir(outputDir);

  if (config.outputs.formats.includes("csv")) {
    await writeCsvFiles(outputDir, config.outputs.baseName, transformedSections);
  }
  if (config.outputs.formats.includes("xlsx")) {
    await writeExcelFile(outputDir, config.outputs.baseName, transformedSections);
  }
  if (config.outputs.formats.includes("md")) {
    await writeMarkdownFile(
      outputDir,
      config.outputs.baseName,
      transformedSections,
      config.outputs.markdownMaxRows,
    );
  }
  if (config.outputs.formats.includes("json")) {
    await writeJsonFiles(outputDir, config.outputs.baseName, transformedSections);
  }

  // Print generated files location for easy discovery in terminal output.
  // eslint-disable-next-line no-console
  console.log(`Report generated in: ${outputDir}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
