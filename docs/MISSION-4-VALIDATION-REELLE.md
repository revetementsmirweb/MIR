# Mission 4 — validation Supabase réelle

## État vérifié le 6 novembre 2026

Référence : `main` à `8341486` (inclut PR 26 et PR 27).
Branche de travail : `codex/mission-4-real-supabase`.

| Élément | Preuve et limite |
| --- | --- |
| Configuration du navigateur | `shared-config.js` active le projet `gccltmaulvrnthrbnrpd.supabase.co` avec une clé publique. Aucun secret serveur ajouté. |
| Enregistrement réel Admin | L’utilisateur a confirmé le message serveur après PR 26. Preuve manuelle antérieure, pas un essai automatisé de cette mission. |
| Migration 004 hébergée | Captures antérieures : RPC Admin/employé fonctionnelles. L’état actuel et les politiques complètes restent à lire sur le serveur. |
| Connexion depuis cet environnement | Refus du proxy : `Tunnel connection failed: 403 Forbidden`. Aucun essai de mot de passe effectué. |
| Comptes de test | Aucun secret de compte configuré au moment du précontrôle. |
| Tests RLS locaux | PostgreSQL PGlite jetable, identités simulées par paramètres SQL. Ne prouvent pas les politiques du projet hébergé. |
| Tests navigateur locaux | Auth simulée dans `mir-shared-workspace-browser.cjs`; SDK réel chargé dans le test de démarrage. Ni l’un ni l’autre n’est une connexion utilisateur réelle hébergée. |
| Nouvelle suite réelle | `tools/validation/real-supabase.cjs`. Utilise le SDK embarqué et les vrais endpoints Auth/RPC. Aucun remplacement de réponse Auth. Non exécutée au-delà du précontrôle bloqué. |
| Données de cet iPad | Inaccessibles depuis ce poste. Aucune certification de migration complète ni suppression des originaux. |

Aucune migration réappliquée, ressource créée, activation d’accès, publication de site, paiement ou envoi de courriel. Les tables de courriels ne sont jamais appelées par la suite.

## Accès à préparer (sans mot de passe dans le clavardage)

Dans les paramètres de l’environnement Codex, autoriser uniquement le domaine supplémentaire :

`gccltmaulvrnthrbnrpd.supabase.co`

L’accès au tableau de bord Supabase ne donne pas automatiquement l’accès réseau à son API depuis Codex. Ne contournez pas le proxy et ne désactivez pas la vérification TLS.

Configurer ces noms dans les secrets de l’environnement :

| Secret | Compte dédié déjà créé |
| --- | --- |
| `MIR_TEST_ADMIN_EMAIL`, `MIR_TEST_ADMIN_PASSWORD` | Admin de l’organisation de test principale |
| `MIR_TEST_EMPLOYEE_EMAIL`, `MIR_TEST_EMPLOYEE_PASSWORD` | Employé de cette organisation |
| `MIR_TEST_CLIENT_EMAIL`, `MIR_TEST_CLIENT_PASSWORD` | Client de cette organisation |
| `MIR_TEST_OTHER_CLIENT_EMAIL`, `MIR_TEST_OTHER_CLIENT_PASSWORD` | Second client de cette organisation (isolation entre propriétaires du même rôle) |
| `MIR_TEST_OUTSIDER_EMAIL`, `MIR_TEST_OUTSIDER_PASSWORD` | Compte actif uniquement dans une autre organisation de test |

Variables non secrètes :

- `MIR_TEST_ORG_ID` : UUID de l’organisation principale.
- `MIR_TEST_FOREIGN_ORG_ID` : UUID de la seconde organisation.
- `MIR_TEST_ALLOW_FIXTURES=yes` : autoriser les objets techniques dans cette organisation uniquement.
- Facultatif : `MIR_CHROMIUM_EXECUTABLE` et `MIR_TEST_REPORT`.

Les organisations doivent déjà exister, avec un nom commençant par **MIR TEST**. Le programme refuse d’écrire dans « Les Revêtements MIR ». Les utilisateurs doivent déjà être créés dans Auth et leurs memberships actifs; la suite ne crée aucun compte, organisation ni rôle. Les mots de passe temporaires doivent être propres aux comptes de test. Ni `service_role`, ni clé `sb_secret_`, ni mot de passe de base de données ne sont nécessaires au parcours navigateur.

Avec seulement les trois premiers comptes, une partie du parcours peut être exercée, mais l’isolation entre clients et organisations restera explicitement **BLOCKED**. L’Admin principal ne doit pas avoir de membership dans l’organisation étrangère.

## Audit hébergé sans écriture ni réinstallation

Dans le SQL Editor du projet existant, exécuter **seulement** :

`supabase/verification/mission-4-read-only.sql`

Ce fichier utilise `BEGIN READ ONLY`, des SELECT sur les catalogues et `ROLLBACK`. Aucun `SET ROLE`, JWT forgé ou changement d’utilisateur. Il relève :

- Les 19 tables attendues après 001–004 et leur activation RLS.
- Les sept RPC publiques, leur présence, `SECURITY DEFINER`, search path et droits anonymes/authentifiés.
- Les politiques RLS effectivement présentes, la colonne de longueur de vente et les signatures de définition.
- La présence éventuelle du registre des migrations.

Exporter le résultat JSON comme preuve horodatée. La présence des objets n’atteste pas que le fichier 004 exact a été exécuté : une installation manuelle peut ne pas alimenter `supabase_migrations`. Si un objet manque, s’arrêter et comparer au dépôt; **ne pas relancer les migrations à l’aveugle**.

Le runner ne transforme pas un rapport SQL local en preuve hébergée. L’audit SQL reste une étape manuelle à examiner. Les RPC `SECURITY DEFINER` font leurs contrôles de rôle; leur succès ne prouve pas, à lui seul, le fonctionnement de toutes les politiques RLS des tables. Ne pas exposer `mir_core` dans PostgREST pour faciliter les tests.

## Exécution réelle

Prérequis du poste : Node 24, Python 3, Playwright et Chromium installés. Utiliser l’installation Playwright déjà disponible dans l’environnement; sur un autre poste, installer Playwright et son Chromium selon la documentation du projet. Aucun secret ne doit être inscrit dans un fichier commité ou dans une commande contenant sa valeur.

Précontrôle (aucune connexion utilisateur, aucune écriture) :

```sh
node tools/validation/real-supabase.cjs --preflight
```

Après configuration des secrets et de l’organisation de test :

```sh
node tools/validation/real-supabase.cjs
```

Le serveur local sert uniquement les fichiers `dist`. Les requêtes Supabase passent par le proxy configuré. Cinq contextes navigateur distincts sont possibles; vues 1440 px, 1024 px et 390 px. Ce sont des sessions indépendantes et des tailles d’écran émulées, **pas des appareils physiques iPad/iPhone**.

La suite crée un modèle unique « MIR TEST », l’importe deux fois pour vérifier le dédoublonnage, le publie dans les deux destinations, crée un chantier de test et deux demandes, puis modifie uniquement le prix technique de ce modèle. Les prix 1234/2345/3456 cents sont des fixtures réservées à l’organisation de test; ils ne définissent aucun tarif commercial MIR.

Elle vérifie aussi les refus de publication employé/client, les données visibles, le propriétaire, un compte étranger, une panne réseau et la perte de réponse après une **vraie transaction**. Seule la livraison de cette réponse est interrompue; aucune réponse Auth ni résultat serveur réussi n’est inventé. Après déconnexion et reconnexion, la même référence est renvoyée pour vérifier l’absence de doublon.

Rapport local : `artifacts/mission-4-real.json`, ignoré par Git. Aucun mot de passe, jeton ou adresse de compte n’est journalisé; aucun tracing navigateur des formulaires de connexion. Codes de sortie : 0 parcours complet, 1 échec, 2 accès/prérequis/validation manuelle manquants. À ce stade l’audit SQL hébergé et les données locales de l’iPad restent des étapes manuelles : **un parcours navigateur réussi ne conclut donc pas la mission entière**.

À la fin, le modèle technique est masqué et archivé. Les demandes et le chantier de test sont conservés comme traces; aucune suppression n’est tentée. Si le réseau empêche l’archivage, le rapport précise `cleanup-unconfirmed` et l’identifiant exact à traiter par l’Admin. La suite ne touche pas aux fournisseurs ni aux tâches d’envoi.

## Préserver les modèles et bons de l’iPad

1. Sur l’iPad/Safari d’origine, exporter la bibliothèque et les sauvegardes de bons disponibles. Garder les fichiers originaux dans Fichiers; ne pas effacer les données Safari.
2. Le helper `mir-local-backup.js` peut capturer exactement les sept clés métier autorisées, sans clé Auth. Ce helper n’est pas activé automatiquement dans le site public.
3. Valider le JSON et son SHA-256; relever le nombre de modèles, versions, bons et pièces avant toute migration.
4. Vérifier les dessins et PDF originaux, y compris les ajouts sans modèle et les historiques.
5. Importer les modèles via le parcours existant, répéter le même import et confirmer les identifiants stables. Conserver le fichier source.
6. Les anciens bons ne sont **pas** tous automatiquement transférés dans Supabase par l’import de modèles. Le staging en quarantaine existe dans le schéma privé, mais n’est pas accessible par une nouvelle API publique dans cette mission. Sa connexion et le contrôle visuel des bons restent à faire.
7. Pour revenir en arrière, garder l’ancien stockage intact et masquer les publications importées. Ne pas restaurer en écrasant des données locales plus récentes; `reconcile` doit signaler les conflits.

## Correctif préparé, non appliqué

Défaut observé dans le code 004 : `mir_add_master_version` stocke seulement `template` et perd `specification.allowed`. Un modèle limité à l’aluminium peut ainsi perdre cette restriction lors d’une révision.

`supabase/proposals/202611060005_preserve_version_options.sql` conserve les options de la version publiée précédente. Il ne modifie pas les instantanés antérieurs et ne republie pas le modèle. Ce fichier est dans **proposals**, pas dans la chaîne de migrations : il n’est exécuté que sur PostgreSQL jetable pour sa vérification. Son application au projet hébergé demande une étape d’infrastructure distincte après examen de l’audit. Aucune migration historique n’est modifiée.

## Résultats exécutés dans cette branche

- `node tests/mir-database.cjs` : 17 tests réussis (base locale jetable, dont correctif proposé).
- `node tests/mir-local-backup.cjs` : 5 tests réussis (capture exacte, doublons, anciens bons, conflits, refus serveur simulé).
- `node tests/mir-shared-client.cjs` : 3 tests réussis (transport simulé explicitement).
- `node tests/mir-direct-model-save.cjs` : sauvegarde directe, droits, conflit et panne réseau réussis (client de test).
- `node tests/mir-live-validation.cjs` : 3 tests réussis (prérequis sans secrets, configuration fermée, audit SQL lu dans PostgreSQL jetable).
- `node tests/mir-shared-workspace-browser.cjs` : réussi, vues PC/mobile/tablette et sauvegarde directe; Auth simulée, PostgreSQL réel **local**.
- `node tests/mir-shared-startup-browser.cjs` : réussi, SDK embarqué réel et erreur SDK absent; aucune connexion utilisateur hébergée.
- `node tools/validation/real-supabase.cjs --preflight` : code 2, **BLOCKED**. Aucune session réelle de test ouverte.
- Syntaxe JavaScript et `git diff --check` : réussis.

L’audit SQL hébergé, les trois connexions réelles, les cinq sessions d’isolation, la synchronisation hébergée et le contrôle de l’iPad d’origine restent non certifiés. Aucun résultat local n’a été comptabilisé comme résultat Supabase hébergé.
