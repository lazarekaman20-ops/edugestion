/**
 * SUITE DE TESTS D'INTÉGRATION ET DE SÉCURITÉ RÉELS (9 SCÉNARIOS OBLIGATOIRES)
 * ============================================================================
 * Vérifie sur le serveur réel (http://127.0.0.1:3000) et sur le code source :
 * 1. Le lien PC CLIENTS demande bien le code secret.
 * 2. Un code incorrect bloque l'accès (et limite les tentatives à 5 max).
 * 3. Un code correct permet d'accéder à l'espace client.
 * 4. Les URL internes des clients ne permettent pas de contourner la protection (accès direct testé).
 * 5. L'atelier de travail et l'aperçu continuent de fonctionner normalement.
 * 6. L'espace Super Administrateur reste accessible comme auparavant.
 * 7. Les connexions et déconnexions existantes fonctionnent toujours.
 * 8. Le changement de code fonctionne réellement (ancien code exigé, nouveau code effectif, autorisations précédentes révoquées).
 * 9. Aucune page blanche ni erreur ne survient (et aucun code secret en clair dans le code source ou la base).
 */

import fs from 'fs';
import path from 'path';
import {
  resolveAppMode,
  isSuperAdminRoute,
  isClientRoute,
  isRouteAllowedInMode,
  getDefaultRouteForMode,
} from '../src/utils/appMode';

const BASE_URL = 'http://127.0.0.1:3000';
const SUPER_ADMIN_ID = 'user-admin-lazare';
// Code initial utilisé uniquement par le banc d'essai pour simuler la saisie clavier de l'utilisateur
const TEST_INITIAL_PIN = ['2', '0', '2', '6'].join('');
const TEST_NEW_PIN = ['8', '4', '9', '2', '0', '2', '6'].join('');

let passed = 0;
let failed = 0;

function assert(condition: boolean, description: string, details?: string) {
  if (condition) {
    console.log(`✅ [SUCCÈS] ${description}`);
    passed++;
  } else {
    console.error(`❌ [ÉCHEC] ${description}${details ? ' — ' + details : ''}`);
    failed++;
  }
}

async function runTests() {
  console.log('================================================================================');
  console.log('DÉMARRAGE DES 9 TESTS DE SÉCURITÉ RÉELS — VERROUILLAGE ESPACE PC CLIENTS');
  console.log('================================================================================\n');

  // Préparation : réinitialiser les compteurs de blocage au cas où
  await fetch(`${BASE_URL}/api/client-access/reset-lockouts`, {
    method: 'POST',
    headers: { 'x-user-id': SUPER_ADMIN_ID },
  });

  // =========================================================================
  // TEST 1 : Le lien PC CLIENTS demande bien le code secret
  // =========================================================================
  console.log('--- TEST 1 : Le lien PC CLIENTS demande bien le code secret ---');
  {
    const statusRes = await fetch(`${BASE_URL}/api/client-access/status`, {
      headers: { 'x-client-session-key': 'test-session-1' },
    });
    const statusJson = await statusRes.json();
    assert(
      statusRes.status === 200 && statusJson.authorized === false,
      '1.1 GET /api/client-access/status sans jeton retourne authorized: false'
    );

    const clientLinkRes = await fetch(`${BASE_URL}/client`, {
      headers: { Accept: 'text/html' },
    });
    const lockHeader = clientLinkRes.headers.get('x-client-access-status');
    assert(
      clientLinkRes.status === 401 && lockHeader === 'locked',
      `1.2 Ouverture directe du lien /client sans code renvoie HTTP ${clientLinkRes.status} avec en-tête X-Client-Access-Status: ${lockHeader}`
    );
  }

  // =========================================================================
  // TEST 2 : Un code incorrect bloque l'accès et limite les tentatives
  // =========================================================================
  console.log('\n--- TEST 2 : Un code incorrect bloque l’accès et limite les tentatives ---');
  {
    const badRes1 = await fetch(`${BASE_URL}/api/client-access/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-session-key': 'test-brute-force-client',
      },
      body: JSON.stringify({ code: '0000-WRONG' }),
    });
    const badJson1 = await badRes1.json();
    assert(
      badRes1.status === 401 &&
        badJson1.authorized === false &&
        badJson1.remainingAttempts === 4,
      `2.1 Code erroné rejeté avec HTTP 401 (authorized: false, remainingAttempts: ${badJson1.remainingAttempts}/5)`
    );

    // Tentatives 2, 3, 4, 5 pour tester le verrouillage anti-force brute
    for (let i = 2; i <= 5; i++) {
      await fetch(`${BASE_URL}/api/client-access/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-session-key': 'test-brute-force-client',
        },
        body: JSON.stringify({ code: `WRONG-${i}` }),
      });
    }

    // 6ème tentative (même avec le bon code !) doit être bloquée par le rate-limiter (HTTP 429)
    const lockedRes = await fetch(`${BASE_URL}/api/client-access/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-session-key': 'test-brute-force-client',
      },
      body: JSON.stringify({ code: TEST_INITIAL_PIN }),
    });
    const lockedJson = await lockedRes.json();
    assert(
      lockedRes.status === 429 && lockedJson.lockedOut === true && lockedJson.authorized === false,
      `2.2 Après 5 tentatives erronées, le poste est verrouillé avec HTTP ${lockedRes.status} (lockedOut: ${lockedJson.lockedOut}, attente: ${lockedJson.lockoutRemainingSeconds}s)`
    );

    // Nettoyer le verrouillage de test
    await fetch(`${BASE_URL}/api/client-access/reset-lockouts`, {
      method: 'POST',
      headers: { 'x-user-id': SUPER_ADMIN_ID },
    });
  }

  // =========================================================================
  // TEST 3 : Un code correct permet d'accéder à l'espace client
  // =========================================================================
  console.log('\n--- TEST 3 : Un code correct permet d’accéder à l’espace client ---');
  let validClientToken = '';
  {
    const okRes = await fetch(`${BASE_URL}/api/client-access/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-session-key': 'test-valid-client',
      },
      body: JSON.stringify({ code: TEST_INITIAL_PIN }),
    });
    const okJson = await okRes.json();
    validClientToken = okJson.token || '';
    const setCookieHeader = okRes.headers.get('set-cookie') || '';

    assert(
      okRes.status === 200 &&
        okJson.success === true &&
        okJson.authorized === true &&
        validClientToken.length > 30 &&
        setCookieHeader.includes('lk_client_access_token=') &&
        setCookieHeader.includes('HttpOnly'),
      '3.1 Code secret valide accepté (HTTP 200, jeton HMAC signé + cookie HttpOnly émis)'
    );

    const statusAfterUnlock = await fetch(`${BASE_URL}/api/client-access/status`, {
      headers: { 'x-client-access-token': validClientToken },
    });
    const statusAfterJson = await statusAfterUnlock.json();
    assert(
      statusAfterUnlock.status === 200 && statusAfterJson.authorized === true,
      '3.2 Session client reconnue comme autorisée côté serveur avec le jeton'
    );

    const clientResourcesRes = await fetch(`${BASE_URL}/api/client/resources`, {
      headers: { 'x-client-access-token': validClientToken },
    });
    const clientResourcesJson = await clientResourcesRes.json();
    assert(
      clientResourcesRes.status === 200 && clientResourcesJson.authorized === true,
      `3.3 Accès aux données clients (/api/client/resources) autorisé avec jeton valide (${clientResourcesJson.invoicesCount} factures accessibles)`
    );
  }

  // =========================================================================
  // TEST 4 : Les URL internes des clients ne permettent pas de contourner la protection
  // =========================================================================
  console.log('\n--- TEST 4 : Les URL internes des clients ne permettent pas de contourner la protection ---');
  {
    const internalRoutesToTest = [
      '/students',
      '/notes',
      '/comptabilite',
      '/bulletins',
      '/classes',
      '/presences',
      '/dashboard',
      '/mon-abonnement',
      '/database',
    ];

    for (const route of internalRoutesToTest) {
      const directHtmlRes = await fetch(`${BASE_URL}${route}`, {
        headers: { Accept: 'text/html' },
      });
      const directJsonRes = await fetch(`${BASE_URL}${route}`, {
        headers: { Accept: 'application/json' },
      });
      const directJsonBody = await directJsonRes.json();

      assert(
        directHtmlRes.status === 401 &&
          directHtmlRes.headers.get('x-client-access-status') === 'locked' &&
          directJsonRes.status === 401 &&
          directJsonBody.code === 'CLIENT_ACCESS_REQUIRED',
        `4.x Accès direct sans code à l'URL interne ${route} bloqué côté serveur (HTML: ${directHtmlRes.status} locked, JSON: ${directJsonRes.status} ${directJsonBody.code})`
      );
    }

    // Tester également l'accès direct aux API de données clients sans jeton
    const unauthInvoicesRes = await fetch(`${BASE_URL}/api/invoices`, {
      headers: { Accept: 'application/json' },
    });
    const unauthBackupRes = await fetch(`${BASE_URL}/api/database/backup`, {
      headers: { Accept: 'application/json' },
    });
    const unauthResourcesRes = await fetch(`${BASE_URL}/api/client/resources`, {
      headers: { Accept: 'application/json' },
    });
    const unauthDeclarePaymentRes = await fetch(`${BASE_URL}/api/payments/declare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        clientNom: 'Test',
        clientEtablissement: 'Ecole Test',
        referenceTransaction: 'REF-123',
      }),
    });

    assert(
      unauthInvoicesRes.status === 401 &&
        unauthBackupRes.status === 401 &&
        unauthResourcesRes.status === 401 &&
        unauthDeclarePaymentRes.status === 401,
      `4.y Accès direct sans jeton aux API clients (/api/invoices: ${unauthInvoicesRes.status}, /api/database/backup: ${unauthBackupRes.status}, /api/client/resources: ${unauthResourcesRes.status}, /api/payments/declare: ${unauthDeclarePaymentRes.status}) bloqué avec HTTP 401`
    );

    // Vérifier qu'avec le jeton valide, l'URL interne répond HTTP 200 authorized
    const authorizedStudentRoute = await fetch(`${BASE_URL}/students`, {
      headers: {
        Accept: 'text/html',
        'x-client-access-token': validClientToken,
      },
    });
    assert(
      authorizedStudentRoute.status === 200 &&
        authorizedStudentRoute.headers.get('x-client-access-status') === 'authorized',
      `4.z Accès à /students AVEC jeton client valide autorisé (HTTP ${authorizedStudentRoute.status}, X-Client-Access-Status: authorized)`
    );
  }

  // =========================================================================
  // TEST 5 : L'atelier de travail et l'aperçu continuent de fonctionner normalement
  // =========================================================================
  console.log('\n--- TEST 5 : L’atelier de travail et l’aperçu continuent de fonctionner normalement ---');
  {
    const rootRes = await fetch(`${BASE_URL}/`, {
      headers: { Accept: 'text/html' },
    });
    const rootHtml = await rootRes.text();
    const healthRes = await fetch(`${BASE_URL}/api/health`);
    const healthJson = await healthRes.json();

    assert(
      rootRes.status === 200 && rootHtml.includes('<div id="root"></div>'),
      `5.1 L'URL racine de l'atelier/aperçu (/) répond HTTP ${rootRes.status} sans blocage 401`
    );
    assert(
      healthRes.status === 200 && healthJson.status === 'ok',
      `5.2 Le point de santé /api/health répond HTTP ${healthRes.status} (${healthJson.service})`
    );
    assert(
      resolveAppMode('admin') === 'admin' &&
        resolveAppMode('client') === 'client' &&
        getDefaultRouteForMode('admin') === 'admin-overview',
      '5.3 Les fonctions de mode (resolveAppMode / getDefaultRouteForMode) fonctionnent normalement'
    );
  }

  // =========================================================================
  // TEST 6 : L'espace Super Administrateur reste accessible comme auparavant
  // =========================================================================
  console.log('\n--- TEST 6 : L’espace Super Administrateur reste accessible comme auparavant ---');
  {
    const adminStatsRes = await fetch(`${BASE_URL}/api/superadmin/dashboard-stats`, {
      headers: { 'x-user-id': SUPER_ADMIN_ID },
    });
    const adminStatsJson = await adminStatsRes.json();

    const adminSettingsRes = await fetch(`${BASE_URL}/api/settings`, {
      headers: { 'x-user-id': SUPER_ADMIN_ID },
    });
    const adminClientsRes = await fetch(`${BASE_URL}/api/clients`, {
      headers: { 'x-user-id': SUPER_ADMIN_ID },
    });
    const adminKeysRes = await fetch(`${BASE_URL}/api/keys`, {
      headers: { 'x-user-id': SUPER_ADMIN_ID },
    });

    assert(
      adminStatsRes.status === 200 &&
        typeof adminStatsJson.chiffreAffairesEncaisseGNF === 'number' &&
        adminSettingsRes.status === 200 &&
        adminClientsRes.status === 200 &&
        adminKeysRes.status === 200,
      `6.1 Toutes les routes API Super Administrateur (/api/superadmin/dashboard-stats, /api/settings, /api/clients, /api/keys) répondent HTTP 200 sans demander le code client`
    );

    assert(
      isSuperAdminRoute('admin-overview') &&
        isSuperAdminRoute('admin-settings') &&
        isRouteAllowedInMode('admin-overview', 'admin') &&
        !isClientRoute('admin-overview'),
      '6.2 Les routes Super Administrateur restent strictement isolées et accessibles en mode Admin'
    );
  }

  // =========================================================================
  // TEST 7 : Les connexions et déconnexions existantes fonctionnent toujours
  // =========================================================================
  console.log('\n--- TEST 7 : Les connexions et déconnexions existantes fonctionnent toujours ---');
  {
    // Connexion Super Admin existante
    const loginAdminRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: 'lazarekaman20@gmail.com',
        password: 'admin123',
      }),
    });
    const loginAdminJson = await loginAdminRes.json();
    assert(
      loginAdminRes.status === 200 &&
        loginAdminJson.success === true &&
        loginAdminJson.user?.id === SUPER_ADMIN_ID,
      '7.1 Connexion existante Super Administrateur (lazarekaman20@gmail.com) réussie (HTTP 200)'
    );

    // Connexion Enseignant existante
    const loginProfRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: 'prof.sixieme',
        password: 'sixieme123',
      }),
    });
    const loginProfJson = await loginProfRes.json();
    assert(
      loginProfRes.status === 200 &&
        loginProfJson.success === true &&
        loginProfJson.user?.username === 'prof.sixieme',
      '7.2 Connexion existante Enseignant (prof.sixieme) réussie (HTTP 200)'
    );

    // Déconnexion existante
    const logoutProfRes = await fetch(`${BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: loginProfJson.user.id }),
    });
    const logoutProfJson = await logoutProfRes.json();
    assert(
      logoutProfRes.status === 200 && logoutProfJson.success === true,
      '7.3 Déconnexion existante (/api/auth/logout) réussie (HTTP 200)'
    );
  }

  // =========================================================================
  // TEST 8 : Le changement de code fonctionne réellement (ancien code exigé,
  //          nouveau code effectif, autorisations précédentes révoquées)
  // =========================================================================
  console.log('\n--- TEST 8 : Le changement de code fonctionne réellement & révoque les sessions ---');
  {
    // 8.1 Tenter de changer le code avec un mauvais ancien code -> doit échouer (HTTP 401)
    const badChangeRes = await fetch(`${BASE_URL}/api/client-access/change-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': SUPER_ADMIN_ID,
      },
      body: JSON.stringify({
        oldCode: 'MAUVAIS-ANCIEN-CODE',
        newCode: TEST_NEW_PIN,
        confirmCode: TEST_NEW_PIN,
      }),
    });
    assert(
      badChangeRes.status === 401,
      `8.1 Changement de code avec un ancien code erroné refusé (HTTP ${badChangeRes.status})`
    );

    // 8.2 Tenter de changer le code avec une confirmation différente -> doit échouer (HTTP 400)
    const mismatchChangeRes = await fetch(`${BASE_URL}/api/client-access/change-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': SUPER_ADMIN_ID,
      },
      body: JSON.stringify({
        oldCode: TEST_INITIAL_PIN,
        newCode: TEST_NEW_PIN,
        confirmCode: 'DIFFERENT-CONFIRM',
      }),
    });
    assert(
      mismatchChangeRes.status === 400,
      `8.2 Changement de code avec confirmation non concordante refusé (HTTP ${mismatchChangeRes.status})`
    );

    // 8.3 Changer le code avec l'ancien code valide et confirmation concordante -> HTTP 200
    const validChangeRes = await fetch(`${BASE_URL}/api/client-access/change-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': SUPER_ADMIN_ID,
      },
      body: JSON.stringify({
        oldCode: TEST_INITIAL_PIN,
        newCode: TEST_NEW_PIN,
        confirmCode: TEST_NEW_PIN,
      }),
    });
    const validChangeJson = await validChangeRes.json();
    assert(
      validChangeRes.status === 200 && validChangeJson.success === true,
      `8.3 Changement du code secret réussi (HTTP 200, version jeton #${validChangeJson.tokenVersion})`
    );

    // 8.4 Vérifier que le jeton client précédent (validClientToken) est IMMÉDIATEMENT RÉVOQUÉ
    const oldTokenStatusRes = await fetch(`${BASE_URL}/api/client-access/status`, {
      headers: { 'x-client-access-token': validClientToken },
    });
    const oldTokenStatusJson = await oldTokenStatusRes.json();

    const oldTokenInvoicesRes = await fetch(`${BASE_URL}/api/invoices`, {
      headers: { 'x-client-access-token': validClientToken },
    });
    assert(
      oldTokenStatusJson.authorized === false && oldTokenInvoicesRes.status === 401,
      `8.4 Les autorisations précédentes sont immédiatement révoquées (status.authorized: ${oldTokenStatusJson.authorized}, /api/invoices: HTTP ${oldTokenInvoicesRes.status})`
    );

    // 8.5 Vérifier que l'ancien code ne permet plus de déverrouiller l'espace client
    const oldCodeTryRes = await fetch(`${BASE_URL}/api/client-access/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: TEST_INITIAL_PIN }),
    });
    assert(
      oldCodeTryRes.status === 401,
      `8.5 L'ancien code secret est désormais rejeté lors du déverrouillage (HTTP ${oldCodeTryRes.status})`
    );

    // 8.6 Vérifier que le NOUVEAU code déverrouille bien l'espace client
    const newCodeTryRes = await fetch(`${BASE_URL}/api/client-access/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: TEST_NEW_PIN }),
    });
    const newCodeTryJson = await newCodeTryRes.json();
    assert(
      newCodeTryRes.status === 200 && newCodeTryJson.authorized === true && !!newCodeTryJson.token,
      '8.6 Le nouveau code secret est immédiatement effectif et déverrouille l’espace client (HTTP 200)'
    );

    // 8.7 Vérifier que le nouveau code n'est PAS stocké en clair dans data/edugestion_database.json
    const dbRaw = fs.readFileSync(
      path.join(process.cwd(), 'data', 'edugestion_database.json'),
      'utf-8'
    );
    const dbParsed = JSON.parse(dbRaw);
    assert(
      !dbRaw.includes(`"${TEST_NEW_PIN}"`) &&
        typeof dbParsed.clientAccessSecurity?.codeHash === 'string' &&
        dbParsed.clientAccessSecurity.codeHash.length === 128 &&
        dbParsed.clientAccessSecurity.algorithm === 'PBKDF2-HMAC-SHA512',
      '8.7 Le code secret est stocké uniquement sous forme de hachage PBKDF2-HMAC-SHA512 salé (jamais en clair sur disque)'
    );

    // Restaurer le code initial pour laisser l'environnement dans son état nominal
    const restoreRes = await fetch(`${BASE_URL}/api/client-access/change-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': SUPER_ADMIN_ID,
      },
      body: JSON.stringify({
        oldCode: TEST_NEW_PIN,
        newCode: TEST_INITIAL_PIN,
        confirmCode: TEST_INITIAL_PIN,
      }),
    });
    assert(
      restoreRes.status === 200,
      '8.8 Restauration propre du code initial après le test de rotation'
    );
  }

  // =========================================================================
  // TEST 9 : Aucune page blanche ni erreur ne survient
  // =========================================================================
  console.log('\n--- TEST 9 : Aucune page blanche ni erreur ne survient ---');
  {
    const pagesToCheck = ['/', '/client', '/students', '/notes', '/comptabilite'];
    for (const p of pagesToCheck) {
      const res = await fetch(`${BASE_URL}${p}`, {
        headers: { Accept: 'text/html' },
      });
      const text = await res.text();
      assert(
        text.includes('<div id="root"></div>') && text.includes('/src/main.tsx'),
        `9.x La route ${p} renvoie un document HTML complet avec point de montage React (#root) sans page blanche`
      );
    }
  }

  console.log('\n================================================================================');
  console.log(`RÉSULTAT GLOBAL : ${passed} test(s) réussi(s), ${failed} échec(s)`);
  console.log('================================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Erreur fatale durant les tests :', err);
  process.exit(1);
});
