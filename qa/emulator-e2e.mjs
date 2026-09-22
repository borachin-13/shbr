import { chromium } from '@playwright/test';

const baseUrl = 'http://127.0.0.1:5000/?emulator=1';
const passwordA = 'QaTest1234!';
const passwordB = 'QbTest1234!';
const stamp = Date.now();
const emailA = `qa-ci-a-${stamp}@test.com`;
const emailB = `qa-ci-b-${stamp}@test.com`;

const browser = await chromium.launch({ headless: true });
const contextA = await browser.newContext();
const contextB = await browser.newContext();
const pageA = await contextA.newPage();
const pageB = await contextB.newPage();

async function signup(page, email, password) {
  const started = Date.now();
  await page.goto(baseUrl);
  const pageReadyMs = Date.now() - started;
  await page.locator('#auth-email').fill(email);
  await page.locator('#auth-password').fill(password);
  const authStarted = Date.now();
  await page.locator('#auth-signup-btn').click();
  await page.waitForFunction(() => typeof window.runEmulatorIntegrityProbe === 'function');
  await page.waitForFunction(() => document.getElementById('lock-screen')?.style.display === 'none');
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
  const signupA = await signup(pageA, emailA, passwordA);
  const signupB = await signup(pageB, emailB, passwordB);
  const uidA = signupA.uid;
  const uidB = signupB.uid;

  if (!uidA || !uidB || uidA === uidB) {
    throw new Error('CI accounts did not receive distinct authenticated UIDs.');
  }

  // Real-user-flow timing baseline. Emulator timing is a regression signal, not a production SLA.
  const monthSwitchStarted = Date.now();
  const monthSwitchResult = await pageA.evaluate(async () => window.changeMonth('2026-08'));
  const monthSwitchMs = Date.now() - monthSwitchStarted;
  if (!monthSwitchResult) throw new Error('month switch benchmark failed');

  const inputStarted = Date.now();
  const inputLatency = await pageA.evaluate(() => {
    const input = document.querySelector('#income-field-container input');
    if (!input) return null;
    const started = performance.now();
    window.handleIncomeInput('bora', input);
    return performance.now() - started;
  });
  if (inputLatency == null) throw new Error('income input benchmark could not find input');

  const smoke = await pageA.evaluate(() => window.runInternalSmokeTests());
  if (!Array.isArray(smoke) || smoke.some(item => !item.pass)) {
    throw new Error(`internal smoke tests failed: ${JSON.stringify(smoke)}`);
  }

  const integrity = await assertProbe(pageA, 'runEmulatorIntegrityProbe');
  const concurrency = await assertProbe(pageA, 'runEmulatorConcurrencyProbe');

  const authRecoverySetup = await pageA.evaluate(async () => window.runEmulatorAuthRecoveryProbe());
  if (!authRecoverySetup?.pass) throw new Error(`auth recovery setup failed: ${JSON.stringify(authRecoverySetup)}`);
  await pageA.locator('#auth-email').fill(emailA);
  await pageA.locator('#auth-password').fill(passwordA);
  await pageA.locator('#auth-login-btn').click();
  await pageA.waitForFunction(() => document.getElementById('lock-screen')?.style.display === 'none');
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
