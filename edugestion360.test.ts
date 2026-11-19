/**
 * SUITE DE TESTS EDUGESTION 360°
 * ==============================
 * Vérifie :
 * 1. Le moteur financier pur (5 statuts : PAYE_SOLDE, PARTIELLEMENT_PAYE, IMPAYE, EN_RETARD, EXONERE, barèmes, remises, annulations).
 * 2. Les utilitaires de reçu QR (URL de vérification, conversion en lettres GNF, génération QR PNG, interpolation de modèles).
 * 3. Les routes protégées PC CLIENTS (/communication, /espace-parent) vs Super Admin.
 * 4. Les API serveur réelles : idempotence des paiements, annulation non destructive,
 *    communication honnête (echec sans passerelle / initie_appareil), relances dédupliquées,
 *    et isolation stricte du Portail Parent (HTTP 403 sur un élève non rattaché).
 */

import { computeStudentFinancialSummary, getFinancialStatusMeta } from '../src/services/financeService';
import {
  buildReceiptVerificationUrl,
  generateReceiptQrDataUrl,
  numberToFrenchWordsGNF
} from '../src/utils/receiptGenerator';
import { interpolateTemplate } from '../src/services/communicationService';
import { ClassGroup, FeeScheduleItem, Student, StudentFeeAdjustment, StudentPayment, StudentTuitionConfig } from '../src/types';

const BASE_URL = 'http://127.0.0.1:3000';
const SUPER_ADMIN_ID = 'user-admin-lazare';
const TEST_CLIENT_PIN = ['2', '0', '2', '6'].join('');

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, details?: string) {
  if (condition) {
    console.log(`✅ [PASS] ${label}`);
    passed++;
  } else {
    console.error(`❌ [FAIL] ${label}${details ? ` — ${details}` : ''}`);
    failed++;
    process.exitCode = 1;
  }
}

async function run() {
  console.log('\n====================================================================');
  console.log('🧪 SUITE DE TESTS EDUGESTION 360° — FINANCE, COMMS, PORTAIL PARENT');
  console.log('====================================================================\n');

  // -------------------------------------------------------------------------
  // 1. MOTEUR DE CALCUL FINANCIER PUR
  // -------------------------------------------------------------------------
  console.log('[1] Moteur financier élève (5 statuts, barèmes, remises, annulations) :');

  const sampleClasses: ClassGroup[] = [
    {
      id: 'cls-6e',
      nom: '6ème Année',
      cycle: 'primaire',
      niveau: 'Élémentaire',
      filiere: 'Générale',
      salle: 'P6',
      professeurPrincipal: 'Aboubacar Soumah',
      matiereEnseignee: 'Général',
      effectif: 30,
      horairesHebdo: '30h'
    }
  ];

  const baseStudent: Student = {
    id: 'std-test-1',
    matricule: 'EDU-TEST-001',
    nom: 'Diallo',
    prenom: 'Aïssatou',
    sexe: 'F',
    classeId: 'cls-6e',
    classeNom: '6ème Année',
    dateNaissance: '2014-05-12',
    lieuNaissance: 'Conakry',
    photo: '',
    contactParent: { nom: 'Mamadou Diallo', telephone: '+224622112233', lien: 'Père', adresse: 'Ratoma' },
    moyenneGenerale: 14.5,
    rang: 5,
    totalAbsences: 0,
    absencesInjustifiees: 0,
    establishmentId: 'est-default',
    anneeScolaire: '2026-2027'
  };

  const schedules: FeeScheduleItem[] = [
    {
      id: 'fee-1',
      establishmentId: 'est-default',
      anneeScolaire: '2026-2027',
      cycle: 'primaire',
      categorie: 'scolarite',
      libelle: 'Scolarité Annuelle Primaire',
      montant: 1500000,
      dateLimite: '2027-03-31',
      obligatoire: true,
      actif: true,
      createdAt: '2026-09-01'
    },
    {
      id: 'fee-2',
      establishmentId: 'est-default',
      anneeScolaire: '2026-2027',
      cycle: 'primaire',
      categorie: 'inscription',
      libelle: 'Frais d’inscription',
      montant: 200000,
      dateLimite: '2026-10-15',
      obligatoire: true,
      actif: true,
      createdAt: '2026-09-01'
    }
  ];

  const tuitionConfigs: StudentTuitionConfig[] = [];

  // 1a. IMPAYE (0 payé, référence avant toutes échéances)
  const impayeSum = computeStudentFinancialSummary({
    student: baseStudent,
    classes: sampleClasses,
    tuitionConfigs,
    feeSchedules: schedules,
    adjustments: [],
    payments: [],
    referenceDateIso: '2026-09-20'
  });
  assert(
    impayeSum.statutFinancier === 'IMPAYE' &&
      impayeSum.montantTotalExigible === 1700000 &&
      impayeSum.totalPaye === 0 &&
      impayeSum.resteAPayer === 1700000,
    '1.1 Statut IMPAYÉ calculé correctement avec cumul barème scolarité + inscription (1 700 000 GNF)'
  );

  // 1b. EN_RETARD (échéance inscription 2026-10-15 dépassée au 2026-11-01)
  const retardSum = computeStudentFinancialSummary({
    student: baseStudent,
    classes: sampleClasses,
    tuitionConfigs,
    feeSchedules: schedules,
    adjustments: [],
    payments: [],
    referenceDateIso: '2026-11-01'
  });
  assert(
    retardSum.statutFinancier === 'EN_RETARD' && retardSum.echeancesEnRetard.length === 1,
    '1.2 Statut EN_RETARD détecté dès dépassement d’une échéance impayée'
  );

  // 1c. PARTIELLEMENT_PAYE + paiement annulé ignoré
  const partialPayments: StudentPayment[] = [
    {
      id: 'p-ok',
      recuNumero: 'REC-TEST-1',
      studentId: 'std-test-1',
      studentNom: 'Aïssatou Diallo',
      studentMatricule: 'EDU-TEST-001',
      classeId: 'cls-6e',
      classeNom: '6ème Année',
      trancheConcernee: 'Inscription',
      motifVersement: 'Inscription + Avance',
      montantPaye: 500000,
      resteDu: 1200000,
      datePaiement: '2026-10-10',
      modePaiement: 'Espèces',
      compteCible: 'Caisse',
      reference: 'REF-1',
      auteurId: SUPER_ADMIN_ID,
      auteurNom: 'Lazare Kaman',
      dateCreation: '2026-10-10T10:00:00Z',
      statut: 'confirme'
    },
    {
      id: 'p-annule',
      recuNumero: 'REC-TEST-2',
      studentId: 'std-test-1',
      studentNom: 'Aïssatou Diallo',
      studentMatricule: 'EDU-TEST-001',
      classeId: 'cls-6e',
      classeNom: '6ème Année',
      trancheConcernee: 'Tranche 2',
      motifVersement: 'Erreur de saisie',
      montantPaye: 900000,
      resteDu: 300000,
      datePaiement: '2026-10-11',
      modePaiement: 'Espèces',
      compteCible: 'Caisse',
      reference: 'REF-2',
      auteurId: SUPER_ADMIN_ID,
      auteurNom: 'Lazare Kaman',
      dateCreation: '2026-10-11T10:00:00Z',
      statut: 'annule'
    }
  ];

  const partialSum = computeStudentFinancialSummary({
    student: baseStudent,
    classes: sampleClasses,
    tuitionConfigs,
    feeSchedules: schedules,
    adjustments: [],
    payments: partialPayments,
    referenceDateIso: '2026-11-01'
  });
  assert(
    partialSum.statutFinancier === 'PARTIELLEMENT_PAYE' &&
      partialSum.totalPaye === 500000 &&
      partialSum.resteAPayer === 1200000 &&
      partialSum.nbPaiementsConfirmes === 1,
    '1.3 Statut PARTIELLEMENT_PAYE correct et paiement annulé exclu du total payé'
  );

  // 1d. PAYE_SOLDE avec remise de 200 000 GNF et paiement 1 000 000 GNF supplémentaire
  const adjustmentsDiscount: StudentFeeAdjustment[] = [
    {
      id: 'adj-1',
      studentId: 'std-test-1',
      anneeScolaire: '2026-2027',
      type: 'remise',
      montant: 200000,
      motif: 'Remise fratrie',
      accordeParId: SUPER_ADMIN_ID,
      accordeParNom: 'Lazare Kaman',
      dateAttribution: '2026-10-01',
      actif: true
    }
  ];
  const fullPayments: StudentPayment[] = [
    ...partialPayments,
    { ...partialPayments[0], id: 'p-solde', recuNumero: 'REC-TEST-3', montantPaye: 1000000 }
  ];
  const soldeSum = computeStudentFinancialSummary({
    student: baseStudent,
    classes: sampleClasses,
    tuitionConfigs,
    feeSchedules: schedules,
    adjustments: adjustmentsDiscount,
    payments: fullPayments,
    referenceDateIso: '2026-11-01'
  });
  assert(
    soldeSum.statutFinancier === 'PAYE_SOLDE' &&
      soldeSum.totalRemisesEtExonerations === 200000 &&
      soldeSum.montantTotalExigible === 1500000 &&
      soldeSum.resteAPayer === 0,
    '1.4 Statut PAYÉ / SOLDÉ atteint après remise et règlements cumulés'
  );

  // 1e. EXONERE via ajustement exoneration_totale
  const exonereAdjs: StudentFeeAdjustment[] = [
    {
      id: 'adj-exo',
      studentId: 'std-test-1',
      anneeScolaire: '2026-2027',
      type: 'exoneration_totale',
      montant: 0,
      motif: 'Bourse d’excellence MEPU-A',
      accordeParId: SUPER_ADMIN_ID,
      accordeParNom: 'Lazare Kaman',
      dateAttribution: '2026-10-01',
      actif: true
    }
  ];
  const exoSum = computeStudentFinancialSummary({
    student: baseStudent,
    classes: sampleClasses,
    tuitionConfigs,
    feeSchedules: schedules,
    adjustments: exonereAdjs,
    payments: [],
    referenceDateIso: '2026-12-01'
  });
  assert(
    exoSum.statutFinancier === 'EXONERE' &&
      exoSum.montantTotalExigible === 0 &&
      exoSum.resteAPayer === 0 &&
      getFinancialStatusMeta('EXONERE').label === 'EXONÉRÉ',
    '1.5 Statut EXONÉRÉ force exigible et reste à payer à 0 GNF'
  );

  // -------------------------------------------------------------------------
  // 2. UTILITAIRES REÇU QR & MODÈLES DE COMMUNICATION
  // -------------------------------------------------------------------------
  console.log('\n[2] Reçus QR, conversion GNF en lettres & interpolation de modèles :');
  const qrUrl = buildReceiptVerificationUrl('REC-2026-0001');
  const qrImg = await generateReceiptQrDataUrl('REC-2026-0001');
  const words = numberToFrenchWordsGNF(1500000);
  const renderedTpl = interpolateTemplate(
    'Bonjour {nom_parent}, {nom_eleve} ({classe}) doit {reste_a_payer} avant {date_limite} - {etablissement}.',
    {
      nom_parent: 'M. Diallo',
      nom_eleve: 'Aïssatou Diallo',
      classe: '6ème Année',
      reste_a_payer: 350000,
      date_limite: '2026-12-15',
      etablissement: 'CSLK'
    }
  );
  assert(qrUrl.endsWith('/verify-receipt/REC-2026-0001'), `2.1 URL QR générée : ${qrUrl}`);
  assert(qrImg.startsWith('data:image/png;base64,'), '2.2 QR code PNG réel généré via qrcode');
  assert(words.includes('Million') && words.includes('Mille') && words.includes('Francs Guinéens'), `2.3 Montant en lettres : ${words}`);
  assert(renderedTpl.includes('350') && renderedTpl.includes('Aïssatou Diallo'), `2.4 Template interpolé : ${renderedTpl}`);

  // -------------------------------------------------------------------------
  // 3. TESTS D'INTÉGRATION SERVEUR HTTP RÉELS (127.0.0.1:3000)
  // -------------------------------------------------------------------------
  console.log('\n[3] Intégration serveur réel (PIN, Finance idempotente, Comms honnêtes, Portail Parent) :');

  // Vérifier que le serveur répond
  const health = await fetch(`${BASE_URL}/api/health`);
  assert(health.status === 200, '3.1 Serveur Express joignable sur 127.0.0.1:3000');

  // 3.2 Nouvelles routes clients /communication et /espace-parent protégées sans jeton PIN
  for (const route of ['/communication', '/espace-parent']) {
    const r = await fetch(`${BASE_URL}${route}`, { headers: { Accept: 'application/json' } });
    const body = await r.json();
    assert(
      r.status === 401 && body.code === 'CLIENT_ACCESS_REQUIRED',
      `3.2 Route client ${route} bloquée côté serveur sans code PIN (HTTP ${r.status})`
    );
  }

  // Déverrouiller le client avec le PIN initial pour tester les endpoints clients
  await fetch(`${BASE_URL}/api/client-access/reset-lockouts`, {
    method: 'POST',
    headers: { 'x-user-id': SUPER_ADMIN_ID }
  });
  const unlockRes = await fetch(`${BASE_URL}/api/client-access/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: TEST_CLIENT_PIN })
  });
  const unlockJson = await unlockRes.json();
  const clientToken = unlockJson.token as string;
  assert(Boolean(clientToken), '3.3 Jeton client valide obtenu pour les tests API 360°');

  const clientHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-client-access-token': clientToken,
    'x-user-id': SUPER_ADMIN_ID
  };

  // 3.4 Idempotence paiement + vérification QR + annulation non destructive
  const idempKey = `test-idemp-${Date.now()}`;
  const payPayload = {
    id: `pay-test-${Date.now()}`,
    idempotencyKey: idempKey,
    recuNumero: `REC-TEST-${Date.now()}`,
    studentId: 'std-test-http-1',
    studentNom: 'Kourouma Ibrahima',
    studentMatricule: 'EDU-TEST-900',
    classeId: 'cls-6e',
    classeNom: '6ème Année',
    trancheConcernee: 'Tranche 1',
    montantPaye: 250000,
    datePaiement: '2026-11-16',
    modePaiement: 'Espèces',
    compteCible: 'Caisse',
    reference: 'TEST-ENC-1',
    auteurId: SUPER_ADMIN_ID,
    auteurNom: 'Lazare Kaman'
  };

  const pay1Res = await fetch(`${BASE_URL}/api/school-finance/payments`, {
    method: 'POST',
    headers: clientHeaders,
    body: JSON.stringify(payPayload)
  });
  const pay1Json = await pay1Res.json();

  const pay2Res = await fetch(`${BASE_URL}/api/school-finance/payments`, {
    method: 'POST',
    headers: clientHeaders,
    body: JSON.stringify(payPayload)
  });
  const pay2Json = await pay2Res.json();

  assert(
    pay1Res.status === 201 &&
      pay2Res.status === 200 &&
      pay2Json.deduplicated === true &&
      pay1Json.payment.id === pay2Json.payment.id,
    '3.4 Idempotence paiement garantie (double soumission même idempotencyKey dédupliquée sans doublon)'
  );

  // Vérification QR avant annulation
  const verifyValidRes = await fetch(`${BASE_URL}/api/receipts/verify/${encodeURIComponent(payPayload.recuNumero)}`);
  const verifyValidJson = await verifyValidRes.json();
  assert(
    verifyValidRes.status === 200 && verifyValidJson.valid === true,
    '3.5 Endpoint QR /api/receipts/verify/:recuNumero valide le reçu actif'
  );

  // Annulation non destructive
  const cancelRes = await fetch(`${BASE_URL}/api/school-finance/payments/${encodeURIComponent(pay1Json.payment.id)}/cancel`, {
    method: 'POST',
    headers: clientHeaders,
    body: JSON.stringify({ motif: 'Test automatisé annulation non destructive' })
  });
  const cancelJson = await cancelRes.json();
  const verifyCancelledRes = await fetch(`${BASE_URL}/api/receipts/verify/${encodeURIComponent(payPayload.recuNumero)}`);
  const verifyCancelledJson = await verifyCancelledRes.json();
  assert(
    cancelRes.status === 200 &&
      cancelJson.payment.statut === 'annule' &&
      verifyCancelledJson.valid === false &&
      verifyCancelledJson.statut === 'annule',
    '3.6 Annulation non destructive conserve la trace et invalide le QR code'
  );

  // 3.7 Communication honnête (aucune simulation)
  const commUnconfRes = await fetch(`${BASE_URL}/api/communications/send`, {
    method: 'POST',
    headers: clientHeaders,
    body: JSON.stringify({
      canal: 'sms',
      modeExecution: 'api_serveur',
      destinataireNom: 'Parent Test',
      destinataireContact: '+224622000000',
      message: 'Test honnêteté passerelle'
    })
  });
  const commUnconfJson = await commUnconfRes.json();
  assert(
    commUnconfRes.status === 200 &&
      commUnconfJson.log.statut === 'echec' &&
      String(commUnconfJson.log.erreurDetail || '').toLowerCase().includes('non configurée'),
    `3.7 Envoi SMS serveur sans passerelle configurée retourne honnêtement statut='echec' (pas de simulation)`
  );

  const commDeviceRes = await fetch(`${BASE_URL}/api/communications/send`, {
    method: 'POST',
    headers: clientHeaders,
    body: JSON.stringify({
      canal: 'whatsapp',
      modeExecution: 'action_appareil',
      destinataireNom: 'Parent Test',
      destinataireContact: '+224622000000',
      message: 'Message WhatsApp appareil'
    })
  });
  const commDeviceJson = await commDeviceRes.json();
  assert(
    commDeviceRes.status === 200 && commDeviceJson.log.statut === 'initie_appareil',
    `3.8 Action appareil WhatsApp journalisée honnêtement sous statut='initie_appareil'`
  );

  // 3.8 Relances automatiques : ignore les élèves soldés/exonérés et déduplique
  const reminderRunRes = await fetch(`${BASE_URL}/api/reminders/run-due`, {
    method: 'POST',
    headers: clientHeaders,
    body: JSON.stringify({
      referenceDateIso: '2026-11-16',
      studentsSummary: [
        {
          studentId: 'std-paid',
          studentNom: 'Élève Soldé',
          classeNom: '6ème',
          dateLimitePaiement: '2026-11-16',
          montantPaye: 1500000,
          resteAPayer: 0,
          exonere: false
        },
        {
          studentId: 'std-exo',
          studentNom: 'Élève Exonéré',
          classeNom: '6ème',
          dateLimitePaiement: '2026-11-16',
          montantPaye: 0,
          resteAPayer: 500000,
          exonere: true
        },
        {
          studentId: 'std-due',
          studentNom: 'Élève Échu',
          classeNom: '6ème',
          parentNom: 'Parent Échu',
          parentContact: '+224622999999',
          dateLimitePaiement: '2026-11-16',
          montantPaye: 0,
          resteAPayer: 500000,
          exonere: false
        }
      ]
    })
  });
  const reminderRunJson = await reminderRunRes.json();
  assert(
    reminderRunRes.status === 200 &&
      reminderRunJson.evaluatedCount === 3 &&
      reminderRunJson.skippedCount === 2 &&
      reminderRunJson.logs.length === 1 &&
      reminderRunJson.logs[0].studentId === 'std-due',
    `3.9 Relances automatiques ignorent les élèves soldés/exonérés (${reminderRunJson.skippedCount} ignorés) et ciblent uniquement les échéances dues`
  );

  // 3.9 Isolation stricte du Portail Parent (403 si un parent demande un élève non rattaché)
  const parentUsername = `parent.test.${Date.now()}`;
  const createParentRes = await fetch(`${BASE_URL}/api/users`, {
    method: 'POST',
    headers: clientHeaders,
    body: JSON.stringify({
      nom: 'Camara',
      prenom: 'Fanta',
      username: parentUsername,
      email: `${parentUsername}@edugestion.gn`,
      telephone: '+224622445566',
      role: 'parent',
      parentStudentIds: ['std-child-authorized']
    })
  });
  const createParentJson = await createParentRes.json();
  const createdParentId = createParentJson.user?.id;
  assert(createParentRes.status === 201 && Boolean(createdParentId), '3.10 Compte Parent de test créé avec 1 enfant rattaché');

  if (createdParentId) {
    const parentOwnRes = await fetch(`${BASE_URL}/api/parent-portal/summary?studentId=std-child-authorized`, {
      headers: { ...clientHeaders, 'x-user-id': createdParentId }
    });
    const parentOtherRes = await fetch(`${BASE_URL}/api/parent-portal/summary?studentId=std-other-family`, {
      headers: { ...clientHeaders, 'x-user-id': createdParentId }
    });
    assert(
      parentOwnRes.status === 200 && parentOtherRes.status === 403,
      `3.11 Isolation stricte Portail Parent : enfant rattaché HTTP ${parentOwnRes.status}, autre famille bloqué HTTP ${parentOtherRes.status}`
    );

    // Nettoyage du compte parent de test
    await fetch(`${BASE_URL}/api/users/${encodeURIComponent(createdParentId)}`, {
      method: 'DELETE',
      headers: clientHeaders
    });
  }

  console.log('\n--------------------------------------------------------------------');
  console.log(`BILAN EDUGESTION 360° : ${passed} réussi(s), ${failed} échec(s)`);
  console.log('--------------------------------------------------------------------\n');
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Erreur critique test edugestion360:', err);
  process.exit(1);
});
