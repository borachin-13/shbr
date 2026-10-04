import { getApps, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { chromium } from '@playwright/test';

const baseUrl = 'http://127.0.0.1:5000/?emulator=1';
const passwordA = 'QaTest1234!';
const passwordB = 'QbTest1234!';
const stamp = Date.now().toString(36);
const emailA = `qa-ci-a-${stamp}@test.com`;
const emailB = `qa-ci-b-${stamp}@test.com`;
const usernameA = `qa_ci_a_${stamp}`;
const usernameB = `qa_ci_b_${stamp}`;

const browser = await chromium.launch({ headless: true });
const contextA = await browser.newContext();
const contextB = await browser.newContext();
const pageA = await contextA.newPage();
const pageB = await contextB.newPage();

async function signup(page, username, email, password) {
  const started = Date.now();
  await page.goto(baseUrl);
  const pageReadyMs = Date.now() - started;
  await page.locator('#auth-signup-btn').click();
  await page.locator('#signup-name').fill(username);
  await page.locator('#signup-username').fill(username);
  await page.locator('#signup-email').fill(email);
  await page.locator('#signup-password').fill(password);
  await page.locator('#signup-password-confirm').fill(password);
  const formValues = await page.evaluate(() => ({ username: document.getElementById('signup-username')?.value, passwordLength: document.getElementById('signup-password')?.value?.length, confirmLength: document.getElementById('signup-password-confirm')?.value?.length }));
  if (formValues.passwordLength < 8 || formValues.confirmLength !== formValues.passwordLength) throw new Error(`Signup fixture values invalid: ${JSON.stringify(formValues)}`);
  const authStarted = Date.now();
  await page.locator('#signup-submit-btn').click();
  await page.waitForFunction(() => typeof window.runEmulatorIntegrityProbe === 'function');
  await page.waitForFunction(() => document.getElementById('lock-screen')?.style.display === 'none' || !!document.getElementById('signup-error')?.innerText, null, { timeout: 10000 });
  const signupError = await page.locator('#signup-error').innerText();
  if (signupError) throw new Error(`Signup failed: ${signupError}`);
  const authenticatedMs = Date.now() - authStarted;
  return {
    uid: await page.evaluate(() => window.getAuthenticatedUid()),
    timing: { pageReadyMs, signupToAppMs: authenticatedMs }
  };
}

async function assertProbe(page, name) {
  const result = await page.evaluate(async (fnName) => {
    const result = await window[fnName]();
    return result;
  }, name);
  if (!result?.pass) {
    throw new Error(`${name} failed: ${JSON.stringify(result)}`);
  }
  return result;
}

try {
  const signupA = await signup(pageA, usernameA, emailA, passwordA);
  const signupB = await signup(pageB, usernameB, emailB, passwordB);
  const uidA = signupA.uid;
  const uidB = signupB.uid;

  if (!uidA || !uidB || uidA === uidB) {
    throw new Error('CI accounts did not receive distinct authenticated UIDs.');
  }

  // Password-change compatibility: simulate a Firebase password reset result by changing
  // the authenticated QA user's password server-side, then verify the new password works
  // and the old password no longer works. This validates the app's email/password path
  // independently of the email-delivery UI.
  const adminApp = getApps()[0] || initializeAdminApp({ projectId: 'shbr-family' });
  const adminAuth = getAdminAuth(adminApp);
  const changedPassword = 'QaChanged5678!';
  await adminAuth.updateUser(uidB, { password: changedPassword });
  await pageB.evaluate(async () => window.logoutUser());
  await pageB.locator('#auth-username').fill(emailB);
  await pageB.locator('#auth-password').fill(changedPassword);
  await pageB.locator('#auth-login-btn').click();
  await pageB.waitForFunction(() => document.getElementById('lock-screen')?.style.display === 'none' || !!document.getElementById('lock-error')?.innerText, null, { timeout: 10000 });
  const changedPasswordError = await pageB.locator('#lock-error').innerText();
  if (changedPasswordError) throw new Error(`Changed-password email login failed: ${changedPasswordError}`);
  const changedPasswordUid = await pageB.evaluate(() => window.getAuthenticatedUid());
  if (changedPasswordUid !== uidB) throw new Error(`Changed-password login authenticated as wrong user: expected=${uidB}, actual=${changedPasswordUid}`);

  await pageB.evaluate(async () => window.logoutUser());
  await pageB.locator('#auth-username').fill(emailB);
  await pageB.locator('#auth-password').fill(passwordB);
  await pageB.locator('#auth-login-btn').click();
  await pageB.waitForTimeout(500);
  const oldPasswordError = await pageB.locator('#lock-error').innerText();
  if (!oldPasswordError) throw new Error('Old password unexpectedly authenticated after password change.');
  await pageB.evaluate(async () => window.setAuthError(''));

  // Legacy-compatible login path: email + password must also authenticate successfully.
  await pageB.evaluate(async () => window.logoutUser());
  await pageB.locator('#auth-username').fill(emailB);
  await pageB.locator('#auth-password').fill(passwordB);
  await pageB.locator('#auth-login-btn').click();
  await pageB.waitForFunction(() => document.getElementById('lock-screen')?.style.display === 'none' || !!document.getElementById('lock-error')?.innerText, null, { timeout: 10000 });
  const emailLoginError = await pageB.locator('#lock-error').innerText();
  if (emailLoginError) throw new Error(`Email login failed: ${emailLoginError}`);
  const emailLoginUid = await pageB.evaluate(() => window.getAuthenticatedUid());
  if (emailLoginUid !== uidB) throw new Error(`Email login authenticated as wrong user: expected=${uidB}, actual=${emailLoginUid}`);

  await pageB.evaluate(async () => window.logoutUser());
  await pageB.locator('#auth-username').fill(usernameB);
  await pageB.locator('#auth-password').fill(passwordB);
  await pageB.locator('#auth-login-btn').click();
  await pageB.waitForFunction(() => document.getElementById('lock-screen')?.style.display === 'none' || !!document.getElementById('lock-error')?.innerText, null, { timeout: 10000 });
  const usernameLoginError = await pageB.locator('#lock-error').innerText();
  if (usernameLoginError) throw new Error(`Username login failed after email login: ${usernameLoginError}`);

  // Real-user-flow timing baseline. Emulator timing is a regression signal, not a production SLA.
  const monthSwitchStarted = Date.now();
  const monthSwitchResult = await pageA.evaluate(async () => window.changeMonth('2026-08'));
  const monthSwitchMs = Date.now() - monthSwitchStarted;
  if (!monthSwitchResult) throw new Error('month switch benchmark failed');

  // Generous CI regression guards: emulator timing is not a production SLA,
  // but a sudden jump means a loading-path regression should be investigated.
  if (signupA.timing.signupToAppMs > 5000 || signupB.timing.signupToAppMs > 5000) {
    throw new Error(`Login/signup flow exceeded 5s: A=${signupA.timing.signupToAppMs}ms, B=${signupB.timing.signupToAppMs}ms`);
  }
  if (monthSwitchMs > 4000) {
    throw new Error(`Lazy month load exceeded 4s: ${monthSwitchMs}ms`);
  }

  const inputStarted = Date.now();
  const inputLatency = await pageA.evaluate(() => {
    const input = document.createElement('input');
    input.value = '1234567';
    document.body.appendChild(input);
    const started = performance.now();
    window.handleIncomeInput('bora', input);
    const elapsed = performance.now() - started;
    input.remove();
    return elapsed;
  });
  if (inputLatency > 100) {
    throw new Error(`Income input handler exceeded 100ms: ${inputLatency.toFixed(2)}ms`);
  }

  const smoke = await pageA.evaluate(() => window.runInternalSmokeTests());
  if (!Array.isArray(smoke) || smoke.some(item => !item.pass)) {
    throw new Error(`internal smoke tests failed: ${JSON.stringify(smoke)}`);
  }

  const integrity = await assertProbe(pageA, 'runEmulatorIntegrityProbe');
  const concurrency = await assertProbe(pageA, 'runEmulatorConcurrencyProbe');

  const authRecoverySetup = await pageA.evaluate(async () => window.runEmulatorAuthRecoveryProbe());
  if (!authRecoverySetup?.pass) throw new Error(`auth recovery setup failed: ${JSON.stringify(authRecoverySetup)}`);
  const authConsoleErrors = [];
  pageA.on('console', msg => { if (msg.type() === 'error' && msg.text().includes('로그인 실패')) authConsoleErrors.push(msg.text()); });
  await pageA.locator('#auth-username').fill(usernameA);
  await pageA.locator('#auth-password').fill(passwordA);
  await pageA.locator('#auth-login-btn').click();
  await pageA.waitForFunction(() => document.getElementById('lock-screen')?.style.display === 'none' || !!document.getElementById('lock-error')?.innerText, null, { timeout: 10000 });
  const loginError = await pageA.locator('#lock-error').innerText();
  if (loginError) throw new Error(`Recovery login failed: ${loginError}; console=${authConsoleErrors.join(' | ')}`);
  const authRecovery = await pageA.evaluate(async () => window.runEmulatorAuthRecoveryVerify());
  if (!authRecovery?.pass) throw new Error(`auth recovery failed: ${JSON.stringify(authRecovery)}`);

  const monthLoadGuard = await pageA.evaluate(async () => window.runEmulatorMonthLoadFailureGuardProbe());
  if (!monthLoadGuard?.pass) throw new Error(`month load failure guard failed: ${JSON.stringify(monthLoadGuard)}`);

  const resetIsolation = await pageA.evaluate(async () => window.runEmulatorResetIsolationProbe());
  if (!resetIsolation?.pass) throw new Error(`reset isolation failed: ${JSON.stringify(resetIsolation)}`);

  const recoverySetup = await pageA.evaluate(async () => window.runEmulatorSaveFailureRecoveryProbe());
  if (!recoverySetup?.pass) throw new Error(`save recovery setup failed: ${JSON.stringify(recoverySetup)}`);
  await contextA.setOffline(true);
  let failedWrite;
  try {
    failedWrite = await pageA.evaluate(async () => window.runEmulatorSaveFailureWriteProbe());
  } finally {
    await contextA.setOffline(false);
  }
  if (!failedWrite?.pass) throw new Error(`offline save did not fail as expected: ${JSON.stringify(failedWrite)}`);
  const recovery = await pageA.evaluate(async () => window.runEmulatorSaveRecoveryCheck());
  if (!recovery?.pass) throw new Error(`save failure recovery failed: ${JSON.stringify(recovery)}`);

  const bToA = await pageB.evaluate(async (uidA) => {
    return window.runCrossUserRulesTest(uidA);
  }, uidA);
  if (!bToA?.pass) throw new Error(`B->A isolation failed: ${JSON.stringify(bToA)}`);

  const aToB = await pageA.evaluate(async (uidB) => {
    return window.runCrossUserRulesTest(uidB);
  }, uidB);
  if (!aToB?.pass) throw new Error(`A->B isolation failed: ${JSON.stringify(aToB)}`);

  console.log(JSON.stringify({
    pass: true,
    uidA,
    uidB,
    performanceBaseline: {
      signupA: signupA.timing,
      signupB: signupB.timing,
      monthSwitchMs,
      inputHandlerMs: Number(inputLatency.toFixed(2)),
      note: 'These values run against local Firebase Emulator/CI and are used to detect regressions. Production network time will differ.'
    },
    smoke,
    integrity,
    concurrency,
    authRecovery,
    monthLoadGuard,
    resetIsolation,
    recovery,
    bToA,
    aToB
  }, null, 2));
} finally {
  await browser.close();
}
