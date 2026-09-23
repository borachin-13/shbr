import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID = 'shbr-family';
const LEGACY_COLLECTION = 'gotgan';
const LEGACY_META_DOC = 'settings_v1';
const LEGACY_DATA_DOC = 'gotgan_data_v1';
const USER_COLLECTION = 'users';
const USER_MONTHS = 'months';
const USER_SETTINGS = 'settings';
const USER_SETTINGS_DOC = 'profile_v1';

const targetUid = String(process.env.TARGET_UID || '').trim();
const targetEmail = String(process.env.TARGET_EMAIL || '').trim();
const execute = process.env.MIGRATION_EXECUTE === '1';
const confirmation = process.env.MIGRATION_CONFIRM || '';
const backupDir = path.resolve(process.env.MIGRATION_BACKUP_DIR || 'migration-backups');

if (!targetUid || !targetEmail) throw new Error('TARGET_UID and TARGET_EMAIL are required.');
if (execute && confirmation !== 'I_UNDERSTAND') {
  throw new Error('Refusing to write without MIGRATION_CONFIRM=I_UNDERSTAND.');
}

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore();
const auth = getAuth();

const clone = value => JSON.parse(JSON.stringify(value));
const defaultMonthData = () => ({
  usdRate: null, usdRateDate: null,
  bora: 0, bora_extra: 0, sang: 0, sang_other_income: 0, trip_usd: 0,
  sectionTitles: {
    expense: '공통 고정지출', bora_personal: '보라 개인 지출',
    sang_personal: '상훈 개인 지출', living: '공동 생활비',
    savings: '고정 저축', reserve: '비상금 (남겨둘 돈)'
  },
  categories: {
    expense: [{ name: '월세', amount: 0 }, { name: '공과금', amount: 0 }],
    bora_personal: [{ name: '휴대폰비', amount: 0 }, { name: '보험료', amount: 0 }],
    sang_personal: [{ name: '휴대폰비', amount: 0 }, { name: '주유비', amount: 0 }],
    living: [{ name: '공동 생활비 예산', amount: 0 }],
    variable_expense: [],
    savings: [
      { name: '보라 청년계좌', amount: 0, owner: 'bora' },
      { name: '상훈 청년계좌', amount: 0, owner: 'sang' }
    ],
    reserve: [{ name: '남겨둘 돈', amount: 0, owner: 'shared' }]
  }
});
const sanitizeMonthData = data => ({
  ...defaultMonthData(),
  ...(data && typeof data === 'object' ? clone(data) : {})
});

const user = await auth.getUserByEmail(targetEmail);
if (user.uid !== targetUid) {
  throw new Error(`TARGET_UID does not match TARGET_EMAIL. Expected ${user.uid}, received ${targetUid}.`);
}

const [legacyMetaSnap, legacyDataSnap, legacyMonthsSnap] = await Promise.all([
  db.collection(LEGACY_COLLECTION).doc(LEGACY_META_DOC).get(),
  db.collection(LEGACY_COLLECTION).doc(LEGACY_DATA_DOC).get(),
  db.collection(LEGACY_COLLECTION).get()
]);

const legacyData = legacyDataSnap.exists ? legacyDataSnap.data() : {};
const legacyStore = legacyData?.store && typeof legacyData.store === 'object' ? legacyData.store : {};
const legacyMeta = legacyMetaSnap.exists ? legacyMetaSnap.data() : {};

const monthData = {};
const sourceDocs = [];

for (const snap of legacyMonthsSnap.docs) {
  if (/^month_\d{4}-\d{2}$/.test(snap.id)) {
    const month = snap.id.slice('month_'.length);
    monthData[month] = sanitizeMonthData(snap.data());
    sourceDocs.push(snap.id);
  }
}
for (const [month, value] of Object.entries(legacyStore)) {
  if (/^\d{4}-\d{2}$/.test(month) && !monthData[month]) {
    monthData[month] = sanitizeMonthData(value);
    sourceDocs.push('gotgan_data_v1.store.' + month);
  }
}

const months = Object.keys(monthData).sort();
const categoryList = Array.isArray(legacyMeta.categoryList)
  ? legacyMeta.categoryList
  : (Array.isArray(legacyData.categoryList) ? legacyData.categoryList : ['식비', '생필품', '경조사', '기타']);
const fixedExpenseCategoryList = Array.isArray(legacyMeta.fixedExpenseCategoryList)
  ? legacyMeta.fixedExpenseCategoryList
  : ['월세', '관리비', '전기/가스/수도', '인터넷', '공동 구독료'];

const report = {
  projectId: PROJECT_ID,
  target: { uid: targetUid, email: user.email || targetEmail },
  source: { collection: LEGACY_COLLECTION, monthCount: months.length, months, sourceDocs,
    hasLegacyMeta: legacyMetaSnap.exists, hasLegacyData: legacyDataSnap.exists },
  destination: {
    monthsPath: `users/${targetUid}/months`,
    settingsPath: `users/${targetUid}/settings/profile_v1`
  },
  mode: execute ? 'EXECUTE' : 'DRY_RUN',
  timestamp: new Date().toISOString()
};

await fs.mkdir(backupDir, { recursive: true });
const backupPath = path.join(
  backupDir,
  `legacy-migration-${targetUid}-${new Date().toISOString().replaceAll(':', '-')}.json`
);
await fs.writeFile(
  backupPath,
  JSON.stringify({ report, monthData, categoryList, fixedExpenseCategoryList }, null, 2),
  'utf8'
);

if (!execute) {
  console.log(JSON.stringify({
    ...report, backupPath,
    next: 'Review the report, then use MIGRATION_EXECUTE=1 and MIGRATION_CONFIRM=I_UNDERSTAND.'
  }, null, 2));
  process.exit(0);
}

const targetRefs = [
  db.collection(USER_COLLECTION).doc(targetUid).collection(USER_SETTINGS).doc(USER_SETTINGS_DOC),
  ...months.map(month =>
    db.collection(USER_COLLECTION).doc(targetUid).collection(USER_MONTHS).doc('month_' + month)
  )
];
const targetSnaps = await Promise.all(targetRefs.map(ref => ref.get()));
const existing = targetSnaps.filter(snap => snap.exists);
if (existing.length) {
  throw new Error('Target account already has data; refusing to overwrite any existing destination document.');
}

const migratedAt = Date.now();
const batch = db.batch();

for (const month of months) {
  const ref = db.collection(USER_COLLECTION).doc(targetUid)
    .collection(USER_MONTHS).doc('month_' + month);
  batch.create(ref, { ...monthData[month], migratedFromLegacy: true, migratedAt });
}

const settingsRef = db.collection(USER_COLLECTION).doc(targetUid)
  .collection(USER_SETTINGS).doc(USER_SETTINGS_DOC);
batch.create(settingsRef, {
  categoryList: clone(categoryList),
  fixedExpenseCategoryList: clone(fixedExpenseCategoryList),
  migratedFromLegacy: true,
  migratedAt
});

await batch.commit();

const verificationRefs = [settingsRef, ...months.map(month =>
  db.collection(USER_COLLECTION).doc(targetUid).collection(USER_MONTHS).doc('month_' + month)
)];
const verification = await Promise.all(verificationRefs.map(ref => ref.get()));
if (!verification.every(snap => snap.exists)) {
  throw new Error('Migration verification failed: one or more destination documents are missing.');
}

console.log(JSON.stringify({
  ...report, migratedAt, backupPath,
  writtenMonths: months.length,
  verifiedDocuments: verification.length,
  legacySourceLeftUntouched: true
}, null, 2));
