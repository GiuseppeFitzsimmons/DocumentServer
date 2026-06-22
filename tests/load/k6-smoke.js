/**
 * k6 Smoke Test - Quick sanity check
 *
 * Verifies all endpoints are working with minimal load.
 * Run this before the full load test to catch misconfigurations.
 *
 * Prerequisites: 25 test users created via SQL (loadtest+user0..24@eurobureau.eu)
 *
 * Usage:
 *   k6 run tests/load/k6-smoke.js
 *   k6 run --env BASE_URL=https://eurobureau.eu tests/load/k6-smoke.js
 */

import http from 'k6/http';
import { check, group } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'https://eurobureau.eu';
const TEST_EMAIL = 'loadtest+user0@eurobureau.eu';
const TEST_PASSWORD = 'LoadTest2026!';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    http_req_failed: ['rate==0'],
  },
};

export default function() {
  group('1. Public pages', function() {
    const homeRes = http.get(`${BASE_URL}/home`);
    check(homeRes, { 'home page': (r) => r.status === 200 });

    const loginPage = http.get(`${BASE_URL}/login`);
    check(loginPage, { 'login page': (r) => r.status === 200 });

    const registerPage = http.get(`${BASE_URL}/register`);
    check(registerPage, { 'register page': (r) => r.status === 200 });

    const forgotPage = http.get(`${BASE_URL}/forgot-password`);
    check(forgotPage, { 'forgot password page': (r) => r.status === 200 });
  });

  group('2. Login', function() {
    const res = http.post(`${BASE_URL}/login`, {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    }, { redirects: 0 });
    check(res, { 'login ok': (r) => r.status === 302 || r.status === 200 });
  });

  group('3. Dashboard', function() {
    const res = http.get(`${BASE_URL}/`);
    check(res, { 'dashboard ok': (r) => r.status === 200 });
  });

  group('4. Quota', function() {
    const res = http.get(`${BASE_URL}/api/files/quota`);
    check(res, {
      'quota ok': (r) => r.status === 200,
      'has limit': (r) => {
        try { return JSON.parse(r.body).limitBytes > 0; } catch(e) { return false; }
      },
    });
  });

  group('5. Create file', function() {
    const res = http.post(`${BASE_URL}/api/files/create`, JSON.stringify({
      type: 'docx',
      name: 'Smoke Test Doc',
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
    check(res, { 'create ok': (r) => r.status === 201 });

    if (res.status === 201) {
      const file = JSON.parse(res.body);

      group('6. File listing', function() {
        const listRes = http.get(`${BASE_URL}/api/files`);
        check(listRes, { 'list ok': (r) => r.status === 200 });
      });

      group('7. Editor page', function() {
        const editorRes = http.get(`${BASE_URL}/editor/${file.id}`);
        check(editorRes, {
          'editor ok': (r) => r.status === 200,
          'has DocsAPI': (r) => r.body && r.body.includes('DocsAPI'),
        });
      });

      group('8. Download', function() {
        const dlRes = http.get(`${BASE_URL}/api/files/${file.id}/download`);
        check(dlRes, {
          'download ok': (r) => r.status === 200,
          'has bytes': (r) => r.body && r.body.length > 0,
        });
      });

      group('9. Delete file', function() {
        const delRes = http.del(`${BASE_URL}/api/files/${file.id}`);
        check(delRes, { 'delete ok': (r) => r.status === 200 || r.status === 204 });
      });
    }
  });

  group('10. Account page', function() {
    const res = http.get(`${BASE_URL}/account`);
    check(res, { 'account page ok': (r) => r.status === 200 });
  });

  group('11. Logout', function() {
    const res = http.get(`${BASE_URL}/logout`, { redirects: 0 });
    check(res, { 'logout ok': (r) => r.status === 302 });
  });

  console.log('Smoke test passed!');
}
