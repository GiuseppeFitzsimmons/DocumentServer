/**
 * k6 Load Test for EuroBureau
 *
 * Prerequisites:
 *   - Install k6: https://k6.io/docs/get-started/installation/
 *   - 25 test users created via SQL (loadtest+user0..24@eurobureau.eu, password: LoadTest2026!)
 *
 * Usage:
 *   k6 run tests/load/k6-load-test.js
 *   k6 run --env BASE_URL=https://eurobureau.eu tests/load/k6-load-test.js
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend } from 'k6/metrics';

// --- Configuration ---

const BASE_URL = __ENV.BASE_URL || 'https://eurobureau.eu';
const TEST_PASSWORD = 'LoadTest2026!';
const NUM_TEST_USERS = 25;

export const options = {
  scenarios: {
    login_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: 10 },
        { duration: '30s', target: 10 },
        { duration: '15s', target: 0 },
      ],
      exec: 'loginScenario',
    },
    file_creation: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: 10 },
        { duration: '30s', target: 10 },
        { duration: '15s', target: 0 },
      ],
      startTime: '65s',
      exec: 'fileCreationScenario',
    },
    dashboard_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 20 },
        { duration: '30s', target: 20 },
        { duration: '10s', target: 0 },
      ],
      startTime: '130s',
      exec: 'dashboardScenario',
    },
    editor_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 15 },
        { duration: '30s', target: 15 },
        { duration: '10s', target: 0 },
      ],
      startTime: '185s',
      exec: 'editorScenario',
    },
    download_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 15 },
        { duration: '30s', target: 15 },
        { duration: '10s', target: 0 },
      ],
      startTime: '240s',
      exec: 'downloadScenario',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    http_req_failed: ['rate<0.05'],
  },
};

// --- Custom metrics ---

const loginDuration = new Trend('login_duration');
const createFileDuration = new Trend('create_file_duration');
const fileListDuration = new Trend('file_list_duration');
const editorPageDuration = new Trend('editor_page_duration');
const downloadDuration = new Trend('download_duration');

// --- Helpers ---

function getTestEmail(vuId) {
  return `loadtest+user${vuId % NUM_TEST_USERS}@eurobureau.eu`;
}

function loginUser(vuId) {
  const email = getTestEmail(vuId);
  http.post(`${BASE_URL}/login`, {
    email: email,
    password: TEST_PASSWORD,
  }, { redirects: 0 });
}

// --- Scenario 1: Login ---

export function loginScenario() {
  const email = getTestEmail(__VU);

  group('Login Flow', function() {
    const pageRes = http.get(`${BASE_URL}/login`);
    check(pageRes, { 'login page loads': (r) => r.status === 200 });

    sleep(0.5);

    const loginRes = http.post(`${BASE_URL}/login`, {
      email: email,
      password: TEST_PASSWORD,
    }, { redirects: 0 });

    loginDuration.add(loginRes.timings.duration);

    check(loginRes, {
      'login succeeds': (r) => r.status === 302 || r.status === 200,
    });
  });

  sleep(1 + Math.random() * 2);
}

// --- Scenario 2: File Creation ---

export function fileCreationScenario() {
  loginUser(__VU);

  group('Create File', function() {
    const res = http.post(`${BASE_URL}/api/files/create`, JSON.stringify({
      type: 'docx',
      name: `Stress Doc ${__VU}-${__ITER}`,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });

    createFileDuration.add(res.timings.duration);

    check(res, {
      'file created': (r) => r.status === 201,
      'has file id': (r) => {
        try { return JSON.parse(r.body).id !== undefined; } catch(e) { return false; }
      },
    });
  });

  sleep(1 + Math.random() * 2);
}

// --- Scenario 3: Dashboard Load ---

export function dashboardScenario() {
  loginUser(__VU);

  group('Dashboard', function() {
    const pageRes = http.get(`${BASE_URL}/`);
    check(pageRes, { 'dashboard loads': (r) => r.status === 200 });

    sleep(0.3);

    const listRes = http.get(`${BASE_URL}/api/files`);
    fileListDuration.add(listRes.timings.duration);

    check(listRes, {
      'file list ok': (r) => r.status === 200,
      'returns array': (r) => {
        try { return Array.isArray(JSON.parse(r.body)); } catch(e) { return false; }
      },
    });

    sleep(0.3);

    const quotaRes = http.get(`${BASE_URL}/api/files/quota`);
    check(quotaRes, { 'quota ok': (r) => r.status === 200 });
  });

  sleep(1 + Math.random() * 2);
}

// --- Scenario 4: Editor Page Load ---

export function editorScenario() {
  loginUser(__VU);

  group('Editor Page', function() {
    const createRes = http.post(`${BASE_URL}/api/files/create`, JSON.stringify({
      type: 'docx',
      name: `Editor Test ${__VU}`,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });

    if (createRes.status !== 201) return;

    const fileId = JSON.parse(createRes.body).id;

    const editorRes = http.get(`${BASE_URL}/editor/${fileId}`);
    editorPageDuration.add(editorRes.timings.duration);

    check(editorRes, {
      'editor loads': (r) => r.status === 200,
      'has DocsAPI script': (r) => r.body && r.body.includes('DocsAPI'),
    });
  });

  sleep(2 + Math.random() * 3);
}

// --- Scenario 5: File Download ---

export function downloadScenario() {
  loginUser(__VU);

  group('Download', function() {
    const createRes = http.post(`${BASE_URL}/api/files/create`, JSON.stringify({
      type: 'docx',
      name: `Download Test ${__VU}-${__ITER}`,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });

    if (createRes.status !== 201) return;

    const fileId = JSON.parse(createRes.body).id;

    sleep(0.2);

    const dlRes = http.get(`${BASE_URL}/api/files/${fileId}/download`);
    downloadDuration.add(dlRes.timings.duration);

    check(dlRes, {
      'download ok': (r) => r.status === 200,
      'has content': (r) => r.body && r.body.length > 0,
    });
  });

  sleep(1 + Math.random() * 2);
}
