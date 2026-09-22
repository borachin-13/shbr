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
  await page.goto(baseUrl);
  await page.locator('#auth-email').fill(email);
  await page.locator('#auth-password').fill(password);
  await page.locator('#auth-signup-btn').click();
  await page.waitForFunction(() => typeof window.runEmulatorIntegrityProbe === 'function');
  await page.waitForFunction(() => document.getElementById('lock-screen')?.style.display === 'none');
  return page.evaluate(() => window.getAuthenticatedUid());
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
  const uidA = await signup(pageA, emailA, passwordA);
  const uidB = await signup(pageB, emailB, passwordB);

  if (!uidA || !uidB || uidA === uidB) {
    throw new Error('CI accounts did not receive distinct authenticated UIDs.');
  }

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
