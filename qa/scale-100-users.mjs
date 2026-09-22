import {
  initializeApp,
  deleteApp
} from 'firebase/app';
import {
  getAuth,
  createUserWithEmailAndPassword,
  deleteUser,
  signOut
} from 'firebase/auth';
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  setDoc,
  getDoc,
  deleteDoc
} from 'firebase/firestore';

const config = {
  apiKey: 'AIzaSyA_xbdI3K1KYa9qCYYd2SN7EJJkLcSLmE4',
  authDomain: 'shbr-family.firebaseapp.com',
  projectId: 'shbr-family',
  storageBucket: 'shbr-family.firebasestorage.app',
  messagingSenderId: '438280523923',
  appId: '1:438280523923:web:aa5a10883bc471b7c2fd66'
};

const COUNT = 100;
const stamp = Date.now();
const apps = [];
const users = [];

function monthRef(db, uid, month) {
  return doc(db, 'users', uid, 'months', `month_${month}`);
}

try {
  for (let i = 0; i < COUNT; i++) {
    const app = initializeApp(config, `qa-scale-${stamp}-${i}`);
    const auth = getAuth(app);
    const db = getFirestore(app);
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
    apps.push({ app, auth, db });

    const email = `qa-scale-${stamp}-${i}@test.com`;
    const credential = await createUserWithEmailAndPassword(auth, email, 'QaScale1234!');
    users.push({ uid: credential.user.uid, email });
  }

  const uidSet = new Set(users.map(u => u.uid));
  if (uidSet.size !== COUNT) throw new Error(`Expected ${COUNT} unique UIDs, got ${uidSet.size}`);

  // Every user writes two months with deliberately unique values.
  await Promise.all(users.map(async (user, i) => {
    const { db } = apps[i];
    await Promise.all([
      setDoc(monthRef(db, user.uid, '2099-01'), {
        bora: 1000000 + i,
        sang: 2000000 + i,
        marker: `user-${i}`
      }),
      setDoc(monthRef(db, user.uid, '2099-02'), {
        bora: 3000000 + i,
        sang: 4000000 + i,
        marker: `user-${i}-feb`
      })
    ]);
  }));

  // Verify every user's own data and ensure adjacent users cannot read/write it.
  const ownReads = [];
  const crossChecks = [];
  for (let i = 0; i < COUNT; i++) {
    const current = apps[i];
    const targetIndex = (i + 1) % COUNT;
    const target = users[targetIndex];
    const own = await getDoc(monthRef(current.db, users[i].uid, '2099-01'));
    const ownOk = own.exists()
      && own.data().bora === 1000000 + i
      && own.data().sang === 2000000 + i
      && own.data().marker === `user-${i}`;
    ownReads.push(ownOk);
    if (!ownOk) throw new Error(`Own-data mismatch for user ${i}`);

    let readDenied = false;
    try {
      await getDoc(monthRef(current.db, target.uid, '2099-01'));
    } catch (e) {
      readDenied = e?.code === 'permission-denied';
    }

    let writeDenied = false;
    try {
      await setDoc(monthRef(current.db, target.uid, '2099-01'), { attacker: i }, { merge: true });
    } catch (e) {
      writeDenied = e?.code === 'permission-denied';
    }

    crossChecks.push(readDenied && writeDenied);
    if (!readDenied || !writeDenied) {
      throw new Error(`Isolation failure: user ${i} -> user ${targetIndex}`);
    }
  }

  const monthIsolation = await Promise.all(users.map(async (user, i) => {
    const { db } = apps[i];
    const jan = await getDoc(monthRef(db, user.uid, '2099-01'));
    const feb = await getDoc(monthRef(db, user.uid, '2099-02'));
    return jan.exists() && feb.exists()
      && jan.data().marker === `user-${i}`
      && feb.data().marker === `user-${i}-feb`;
  }));

  console.log(JSON.stringify({
    pass: true,
    users: COUNT,
    uniqueUids: uidSet.size,
    ownDataReads: ownReads.filter(Boolean).length,
    crossUserIsolationChecks: crossChecks.filter(Boolean).length,
    monthIndependenceChecks: monthIsolation.filter(Boolean).length,
    summary: {
      '100 unique accounts': uidSet.size === COUNT,
      '100 own-data reads': ownReads.every(Boolean),
      '100 cross-user read/write denials': crossChecks.every(Boolean),
      '100 users x 2 months isolated': monthIsolation.every(Boolean)
    }
  }, null, 2));
} finally {
  await Promise.all(apps.map(async ({ auth, app }) => {
    try {
      if (auth.currentUser) await deleteUser(auth.currentUser);
    } catch (_) {}
    try { await signOut(auth); } catch (_) {}
    try { await deleteApp(app); } catch (_) {}
  }));
}
