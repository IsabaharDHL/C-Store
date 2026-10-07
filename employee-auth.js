/**
 * LOCAL REVIEW DRAFT. Requires matching reviewed Rules and owner-run migration.
 * No Admin SDK, Cloud Functions, privileged browser secret, or Firestore password.
 * The public route deliberately exposes only an exact personal-number lookup.
 */
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, onAuthStateChanged, getIdTokenResult
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  doc, getDocFromServer, writeBatch, runTransaction, onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

function authError(code) {
  return Object.assign(new Error(code), { code });
}
function normalizeId(value) {
  const id = String(value ?? '').trim().replace(/[٠-٩۰-۹]/g, c =>
    String('٠١٢٣٤٥٦٧٨٩'.includes(c) ? '٠١٢٣٤٥٦٧٨٩'.indexOf(c) : '۰۱۲۳۴۵۶۷۸۹'.indexOf(c)));
  if (!/^[0-9]{1,30}$/.test(id)) throw authError('employee/invalid-id');
  return id;
}
function newAlias() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('') + '@employees.invalid';
}
function profileInput(profile = {}) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw authError('employee/invalid-profile');
  // Profile metadata never controls authorization. Do not accept credentials here.
  const forbidden = /password|passwd|credential|secret|hash|token|^uid$|^generation$|^active$|^role$|^isOwnerAdmin$/i;
  for (const key of Object.keys(profile)) if (forbidden.test(key)) throw authError('employee/invalid-profile');
  return { ...profile };
}

export function employeeAuthErrorMessage(error) {
  const messages = {
    'employee/invalid-id': 'اكتب الرقم الشخصي بالأرقام فقط.',
    'employee/not-registered': 'الرقم غير مسجل. تواصل مع المسؤول.',
    'employee/inactive': 'تم إيقاف صلاحية هذا الرقم. تواصل مع المسؤول.',
    'employee/route-invalid': 'إعداد تسجيل الدخول غير مكتمل. تواصل مع المسؤول.',
    'employee/first-login-required': 'هذا أول دخول. اختر كلمة مرور جديدة.',
    'employee/already-enrolled': 'تم تعيين كلمة مرور لهذا الرقم. استخدم تسجيل الدخول المعتاد.',
    'employee/readd-required': 'تعذر إكمال التسجيل بهذه الكلمة. اطلب من المسؤول إيقاف الرقم ثم إعادة إضافته.',
    'employee/access-denied': 'لا توجد صلاحية دخول فعالة لهذا الحساب.',
    'employee/admin-required': 'هذه الصفحة متاحة للمسؤول المعتمد فقط.',
    'employee/already-active': 'الموظف مضاف بالفعل. استخدم إعادة تعيين لتغيير كلمة المرور.',
    'employee/remove-first': 'أوقف دخول الموظف أولاً، ثم أعد إضافته.',
    'employee/not-provisioned': 'بيانات الدخول غير مهيأة لهذا الرقم. يلزم ترحيلها بواسطة مالك المشروع.',
    'employee/section-change-not-supported': 'إعادة الإضافة تحتفظ بقسم الموظف الحالي.',
    'employee/invalid-profile': 'بيانات الموظف غير صالحة.',
    'employee/busy': 'انتظر اكتمال العملية الحالية.',
    'auth/weak-password': 'اختر كلمة مرور من 8 أحرف على الأقل.',
    'auth/invalid-credential': 'الرقم أو كلمة المرور غير صحيحة.',
    'auth/wrong-password': 'كلمة المرور غير صحيحة.',
    'auth/user-not-found': 'تعذر تسجيل الدخول. تواصل مع المسؤول.',
    'auth/too-many-requests': 'محاولات كثيرة. انتظر قليلاً ثم حاول مجدداً.',
    'auth/network-request-failed': 'تعذر الاتصال. تحقق من الإنترنت وحاول مجدداً.',
    'unavailable': 'يلزم اتصال بالإنترنت للتحقق من صلاحية الدخول.',
    'permission-denied': 'الصلاحية غير متاحة أو إعدادات الأمان لم تكتمل بعد.'
  };
  return messages[error?.code] || 'تعذر إكمال العملية. حاول مجدداً أو تواصل مع المسؤول.';
}

export function createEmployeeAuth(app, db) {
  const auth = getAuth(app);
  let authBusy = false;
  const refreshers = new Set();
  const ref = (collection, id) => doc(db, collection, id);
  const read = async (collection, id) => {
    const snap = await getDocFromServer(ref(collection, id));
    return snap.exists() ? snap.data() : null;
  };

  async function readRoute(value) {
    const employeeId = normalizeId(value);
    const route = await read('loginRoutes', employeeId); // Never trust offline cached routing.
    if (!route) return null;
    if (!Number.isSafeInteger(route.generation) || route.generation < 1 ||
        !['pending', 'claimed'].includes(route.state) || typeof route.enabled !== 'boolean' ||
        !/^[a-f0-9]{32}@employees\.invalid$/.test(route.alias || '')) throw authError('employee/route-invalid');
    return { employeeId, generation: route.generation, state: route.state, enabled: route.enabled, alias: route.alias };
  }
  async function activeRoute(value) {
    const route = await readRoute(value);
    if (!route) throw authError('employee/not-registered');
    if (!route.enabled) throw authError('employee/inactive');
    return route;
  }

  async function identityFor(user, expectedId = null) {
    if (!user || user.uid !== auth.currentUser?.uid) return null;
    const token = await getIdTokenResult(user);
    if (token.signInProvider !== 'password') return null;
    const [administrator, binding] = await Promise.all([
      read('administrators', user.uid), read('uidBindings', user.uid)
    ]);
    const isOwnerAdmin = administrator?.active === true;
    const employeeId = isOwnerAdmin
      ? (administrator.employeeId || binding?.employeeId || expectedId)
      : binding?.employeeId;
    if (expectedId && employeeId !== expectedId) return null;
    // A manually bootstrapped owner without a personal-number mapping can still
    // use admin management after an owner-controlled Auth login elsewhere.
    if (isOwnerAdmin && !employeeId) {
      return { uid: user.uid, employeeId: null, generation: null, profile: {}, isOwnerAdmin: true };
    }
    if (!employeeId) return null;
    const route = await readRoute(employeeId);
    if (!route?.enabled || route.state !== 'claimed' || route.alias !== user.email) return null;
    if (!isOwnerAdmin) {
      if (!binding || binding.generation !== route.generation) return null;
      const access = await read('employeeAccess', employeeId);
      if (!access?.active || access.role !== 'employee' || access.uid !== user.uid ||
          access.generation !== binding.generation) return null;
      const profile = await read('employees', employeeId);
      if (!profile || user.uid !== auth.currentUser?.uid) return null;
      return { uid: user.uid, employeeId, generation: binding.generation,
        profile: { ...profile, section: access.section }, isOwnerAdmin: false };
    }
    const profile = await read('employees', employeeId);
    if (user.uid !== auth.currentUser?.uid) return null;
    return { uid: user.uid, employeeId, generation: route.generation, profile: profile || {}, isOwnerAdmin: true };
  }

  async function withAuthOperation(operation) {
    if (authBusy) throw authError('employee/busy');
    authBusy = true;
    try { return await operation(); }
    catch (error) {
      // A Firebase user alone is not an app login. Failed/partial flows stay locked.
      try { await signOut(auth); } catch (_) { /* Access checks still fail closed. */ }
      throw error;
    } finally {
      authBusy = false;
      for (const refresh of refreshers) refresh();
    }
  }
  async function login(value, password) {
    const id = normalizeId(value);
    return withAuthOperation(async () => {
      const route = await activeRoute(id);
      if (route.state !== 'claimed') throw authError('employee/first-login-required');
      const { user } = await signInWithEmailAndPassword(auth, route.alias, password);
      const identity = await identityFor(user, id);
      if (!identity) throw authError('employee/access-denied');
      return identity;
    });
  }
  async function enroll(value, password) {
    const id = normalizeId(value);
    if (typeof password !== 'string' || password.length < 8) throw authError('auth/weak-password');
    return withAuthOperation(async () => {
      const route = await activeRoute(id);
      if (route.state !== 'pending') throw authError('employee/already-enrolled');
      let user;
      try {
        ({ user } = await createUserWithEmailAndPassword(auth, route.alias, password));
      } catch (error) {
        if (error.code !== 'auth/email-already-in-use') throw error;
        // Resume an interrupted signup only using the exact password just entered.
        try { ({ user } = await signInWithEmailAndPassword(auth, route.alias, password)); }
        catch (signInError) {
          if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found'].includes(signInError.code)) {
            throw authError('employee/readd-required');
          }
          throw signInError;
        }
      }
      const currentRoute = await activeRoute(id);
      if (currentRoute.generation !== route.generation || currentRoute.alias !== route.alias) throw authError('employee/access-denied');
      if (currentRoute.state === 'pending') {
        const batch = writeBatch(db);
        batch.set(ref('uidBindings', user.uid), { employeeId: id, generation: route.generation });
        batch.update(ref('employeeAccess', id), { uid: user.uid });
        batch.update(ref('loginRoutes', id), { state: 'claimed' });
        try { await batch.commit(); }
        catch (error) {
          // The commit may have succeeded while its response was interrupted.
          const resumed = await identityFor(user, id).catch(() => null);
          if (!resumed) throw error;
          return resumed;
        }
      }
      const identity = await identityFor(user, id);
      if (!identity) throw authError('employee/access-denied');
      return identity;
    });
  }
  async function restore() {
    await auth.authStateReady();
    if (authBusy) throw authError('employee/busy');
    const user = auth.currentUser;
    try {
      const identity = await identityFor(user);
      if (authBusy) throw authError('employee/busy');
      if (!identity && user && auth.currentUser?.uid === user.uid) await signOut(auth);
      return identity;
    } catch (error) {
      if (error.code === 'permission-denied' && !authBusy && auth.currentUser?.uid === user?.uid) {
        await signOut(auth);
        return null;
      }
      throw error;
    }
  }
  async function logout() { await signOut(auth); }
  async function assertAdmin() {
    await auth.authStateReady();
    if (!auth.currentUser) throw authError('employee/admin-required');
    const identity = await identityFor(auth.currentUser);
    if (!identity || !(identity.isOwnerAdmin || identity.profile.isAdmin === true || identity.profile.isSuper === true)) {
      throw authError('employee/admin-required');
    }
    // Section scope and allowed profile fields must also be enforced by reviewed Rules.
    return identity;
  }

  async function addEmployee(value, input) {
    const id = normalizeId(value);
    const profile = profileInput(input);
    const administrator = await assertAdmin();
    const assertSameAdministrator = () => {
      if (auth.currentUser?.uid !== administrator.uid) throw authError('employee/access-denied');
    };
    const alias = newAlias();
    await runTransaction(db, async tx => {
      assertSameAdministrator();
      const routeRef = ref('loginRoutes', id), accessRef = ref('employeeAccess', id), profileRef = ref('employees', id);
      const route = await tx.get(routeRef), access = await tx.get(accessRef), existing = await tx.get(profileRef);
      assertSameAdministrator();
      if (route.exists() || access.exists()) throw authError('employee/already-active');
      const section = profile.section || existing.data()?.section || 'dhl';
      tx.set(routeRef, { generation: 1, state: 'pending', enabled: true, alias });
      tx.set(accessRef, { generation: 1, uid: '', active: true, role: 'employee', section });
      tx.set(profileRef, profile, { merge: true });
    });
  }
  async function removeEmployee(value) {
    const id = normalizeId(value);
    const administrator = await assertAdmin();
    const assertSameAdministrator = () => {
      if (auth.currentUser?.uid !== administrator.uid) throw authError('employee/access-denied');
    };
    await runTransaction(db, async tx => {
      assertSameAdministrator();
      const routeRef = ref('loginRoutes', id), accessRef = ref('employeeAccess', id);
      const route = await tx.get(routeRef), access = await tx.get(accessRef);
      assertSameAdministrator();
      if (!route.exists() || !access.exists()) throw authError('employee/not-provisioned');
      if (!route.data().enabled && !access.data().active) return;
      tx.update(routeRef, { enabled: false });
      tx.update(accessRef, { active: false });
    });
  }
  async function readdEmployee(value, input = {}) {
    const id = normalizeId(value), profile = profileInput(input);
    const administrator = await assertAdmin();
    const assertSameAdministrator = () => {
      if (auth.currentUser?.uid !== administrator.uid) throw authError('employee/access-denied');
    };
    const alias = newAlias();
    await runTransaction(db, async tx => {
      assertSameAdministrator();
      const routeRef = ref('loginRoutes', id), accessRef = ref('employeeAccess', id), profileRef = ref('employees', id);
      const routeSnap = await tx.get(routeRef), accessSnap = await tx.get(accessRef), existing = await tx.get(profileRef);
      assertSameAdministrator();
      if (!routeSnap.exists() || !accessSnap.exists() || !existing.exists()) throw authError('employee/not-provisioned');
      const route = routeSnap.data(), access = accessSnap.data();
      if (route.enabled || access.active) throw authError('employee/remove-first');
      if (profile.section && profile.section !== access.section) throw authError('employee/section-change-not-supported');
      if (route.generation !== access.generation) throw authError('employee/route-invalid');
      const generation = route.generation + 1;
      tx.update(routeRef, { generation, alias, state: 'pending', enabled: true });
      tx.update(accessRef, { generation, uid: '', active: true });
      tx.set(profileRef, profile, { merge: true });
      // Previous UID binding, Auth user, employee profile and business history remain intact.
    });
  }

  const resettingEmployees = new Set();
  async function resetEmployee(value) {
    const id = normalizeId(value);
    if (resettingEmployees.has(id)) throw authError('employee/busy');
    resettingEmployees.add(id);
    try {
      const administrator = await assertAdmin();
      await removeEmployee(id);
      if (auth.currentUser?.uid !== administrator.uid) throw authError('employee/access-denied');
      // An interrupted reset stays revoked. Retrying resumes from the disabled
      // state; readd with no profile changes preserves every employee field.
      await readdEmployee(id);
    } finally { resettingEmployees.delete(id); }
  }

  // Backward compatible: legacy callbacks can ignore the optional metadata.
  // null + locked is temporary, never an instruction to discard an unsaved draft.
  // null + signed-out confirms no valid session; ready contains a verified identity.
  function watch(onIdentity, onError = () => {}) {
    let stopped = false, validating = false, queued = false, version = 0, watchedKey = '';
    let docUnsubscribers = [], retryTimer = null, retryDelay = 1000;
    const clearRetry = () => { clearTimeout(retryTimer); retryTimer = null; };
    const retryVerification = () => {
      if (stopped || retryTimer || globalThis.navigator?.onLine === false) return;
      retryTimer = setTimeout(() => { retryTimer = null; refresh(); }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 10000);
    };
    const emitLocked = reason => onIdentity(null, { status: 'locked', reason, uid: auth.currentUser?.uid || null });
    const clearDocs = () => { docUnsubscribers.forEach(unsubscribe => unsubscribe()); docUnsubscribers = []; watchedKey = ''; };
    const refresh = async () => {
      if (stopped || authBusy) return;
      if (validating) { queued = true; return; }
      validating = true;
      const thisVersion = version;
      try {
        const identity = await restore();
        if (stopped || thisVersion !== version || authBusy) return;
        clearRetry(); retryDelay = 1000;
        const key = identity ? `${identity.uid}:${identity.employeeId || ''}:${identity.generation || ''}` : '';
        if (key !== watchedKey) {
          clearDocs();
          watchedKey = key;
          if (identity) {
            const paths = [['administrators', identity.uid], ['uidBindings', identity.uid]];
            if (identity.employeeId) paths.push(['loginRoutes', identity.employeeId], ['employees', identity.employeeId]);
            if (identity.employeeId && !identity.isOwnerAdmin) paths.push(['employeeAccess', identity.employeeId]);
            docUnsubscribers = paths.map(([collection, id]) => onSnapshot(ref(collection, id), { includeMetadataChanges: true }, snapshot => {
              // Ignore cache-only notifications as proof of access; server validation is mandatory.
              if (!snapshot.metadata.fromCache) refresh();
            }, error => { if (stopped) return; emitLocked('listener-error'); onError(error); refresh(); }));
          }
        }
        onIdentity(identity, { status: identity ? 'ready' : 'signed-out', reason: identity ? 'verified' : 'no-valid-session', uid: identity?.uid || null });
      } catch (error) {
        if (!stopped && thisVersion === version && error.code !== 'employee/busy') { emitLocked('verification-error'); onError(error); retryVerification(); }
      } finally {
        validating = false;
        if (queued && !stopped) { queued = false; queueMicrotask(refresh); }
      }
    };
    const unsubscribeAuth = onAuthStateChanged(auth, () => {
      version++; clearDocs();
      if (!authBusy) {
        if (auth.currentUser) emitLocked('verifying');
        else onIdentity(null, { status: 'signed-out', reason: 'auth-state', uid: null });
      }
      refresh();
    }, error => { emitLocked('auth-error'); onError(error); });
    const recheckVisible = () => { if (!document.hidden) refresh(); };
    const lockOffline = () => { clearRetry(); version++; emitLocked('offline'); onError(authError('unavailable')); };
    window.addEventListener('offline', lockOffline);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', recheckVisible);
    refreshers.add(refresh);
    return () => {
      stopped = true; version++; clearRetry(); clearDocs(); unsubscribeAuth(); refreshers.delete(refresh);
      window.removeEventListener('offline', lockOffline);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', recheckVisible);
    };
  }
  return { auth, readRoute, login, enroll, restore, logout, addEmployee, removeEmployee, readdEmployee, resetEmployee, watch };
}
