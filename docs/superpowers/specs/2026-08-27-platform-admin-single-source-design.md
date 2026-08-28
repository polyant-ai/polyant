# Platform admin: una sola fonte di verità

**Date:** 2026-08-27
**Status:** proposed
**Scope:** due interventi indipendenti, in due repository
  - **A** — eliminare `users.role` e `RoleGuard` → **OSS** (`polyant`, da `develop`)
  - **B** — bypass platform admin in `resolveOrgForCaller` → **enterprise** (`polyant-enterprise`, da `develop`)

## Problema

Un account con `role = 'platform_admin'` **e** `is_platform_admin = true` non riusciva a
vedere le workspace di un'organizzazione finché non veniva reso Owner di quella
organizzazione. Il platform admin, per definizione, sta sopra ogni organizzazione: deve
vedere tutto, backend e frontend, senza alcuna membership.

L'analisi ha trovato tre rotture distinte e una ridondanza di schema che le rende
possibili.

### 1. Due colonne per un fatto solo

| | `users.role` | `users.is_platform_admin` |
|---|---|---|
| Origine | pre-RBAC (`superadmin` \| `user`) | migrazione 0051, backfillata da `role='superadmin'` |
| Oggi | `platform_admin` \| `user` (rinominata da 0084 / OSS 0071) | boolean |
| Chi la legge | **solo il claim JWT**: `RoleGuard`, 7 pagine della Admin Console web | **tutto l'engine**: `PermissionGuard`, `listAccessibleWorkspaces`, `TenantService`, impersonation |
| Come si scrive | esplicita | **derivata**: `isPlatformAdmin: isPlatformAdminRole(input.role)` |

`users.role` è un boolean scritto come testo; `is_platform_admin` ne è la copia derivata,
**senza alcun vincolo DB che le tenga allineate**. Il codice ammette la divergenza in tre
punti: `isPlatformAdminStanding()` (`users.service.ts`) fa l'OR delle due, `countPlatformAdmins()`
(`users.store.ts`) fa l'OR in SQL, e la migrazione 0084 contiene una `UPDATE` di
riconciliazione con il commento *"nothing stops a direct SQL write from putting the two out
of step"*. È esattamente il caso che ha prodotto il bug.

### 2. `RoleGuard` decide su un claim non revocabile

`auth/role.guard.ts` confronta `request.user.role`, che arriva dal JWT Auth.js
(`auth-user.service.ts` → `normalizeUserRole(payload.role)`). Il claim è uno **snapshot fatto
al sign-in** (`auth.config.ts`, callback `jwt`) e vive fino a 24 ore senza revoca.

`RoleGuard` è APP_GUARD #2b: gira **prima** di `PermissionGuard`, che invece saprebbe
rileggere il flag fresco dal DB — e infatti lo fa già, per le liste di ruoli puramente
platform-admin. Ma non ci arriva mai, perché `RoleGuard` ha già risposto 403.

Conseguenza: promuovere qualcuno a platform admin nel DB **non ha effetto sulla Admin
Console** (`/api/users`, `/api/platform/*`, impersonation, 2FA platform) finché quella
persona non fa logout/login. E, specularmente, revocare il ruolo non chiude l'accesso per
un massimo di 24 ore.

Lato web lo stesso errore è replicato in **7 pagine** che si gatano su
`session?.user?.role` invece che sul flag DB servito da `/api/me/access`:
`platform/settings/{plugins,plugins/[name],users,audit,skills,two-factor}` e
`platform/analytics`. Il resto del pannello è corretto: `hasPermission()` in
`lib/access-visibility.ts` fa bypass su `access.isPlatformAdmin`, che viene dal DB.

### 3. `resolveOrgForCaller` è l'unico choke-point che ignora il platform admin

`server/shared/resolve-org-for-caller.ee.ts` risolve un `:orgSlug` per un principal umano
con `resolveOrgIdBySlugForUser`, cioè una **INNER JOIN su `organization_memberships`**. Un
platform admin senza riga di membership prende `403 Organization not accessible`.

Quattro layer su cinque conoscono già il platform admin:

| layer | file | esente? |
|---|---|---|
| `PermissionGuard` (#3) | `authz/permission.guard.ts` | sì |
| `OrgRefGuard` (#4) | `organizations/org-ref.guard.ts` | sì |
| `resolveActiveWorkspace` | `organizations/active-workspace.ts` | sì |
| `listAccessibleWorkspaces` | `organizations/accessible-workspaces.store.ts` | sì |
| **`resolveOrgForCaller`** | `server/shared/resolve-org-for-caller.ee.ts` | **no** |

Impatto: **52 delle 55** rotte `/api/organizations/{orgSlug}/…` (workspaces, roles, secrets,
governance, audit, api-keys, skills catalog, analytics, 2FA policy, org-plugins,
workspace-assignments, invitations). Le uniche 3 salve sono `/members/*`, dove l'esenzione
è stata aggiunta **localmente** in `server/members/members.service.ts` con la motivazione
esplicita che *"nessuno degli altri service ha il problema dell'unica via d'ingresso"*.

Quella motivazione è sbagliata su un punto di fatto: il problema ce l'hanno tutti, solo che
altrove si manifesta come una pagina che si carica e poi mostra un toast d'errore, invece
che come un blocco totale. La pagina Workspaces è precisamente questo caso.

Corollario indipendente: `GET /api/organizations` risponde `listForUser` anche a un platform
admin (`organization-management.service.ee.ts`), mentre `/api/me` risponde `listAll()` per lo
stesso utente (`tenant.service.ts`). Due risposte diverse alla stessa domanda, e l'unico
consumatore della prima è `/platform/settings/organizations` — una pagina **della Admin
Console**, che quindi mostra zero organizzazioni a un platform admin senza membership.

## Decisione

### A — `is_platform_admin` è l'unica autorità; `users.role` sparisce

`users.role` viene eliminata dallo schema, dal wire e dal JWT. `RoleGuard` e
`@RequireRole()` vengono cancellati e sostituiti da `@PlatformAdminOnly()`, che
`PermissionGuard` risolve leggendo il flag dal DB — codice che **esiste già** in
`permission.guard.ts` per le liste puramente platform-admin. È una rimozione, non
un'aggiunta.

Effetti:
- la promozione/revoca ha effetto entro il TTL di 5 minuti della cache di
  `AuthorizationService.isPlatformAdmin`, non entro 24 ore;
- sparisce lo shim di compatibilità `superadmin` (`auth/user-role.ts` e il gemello web
  `lib/user-role.ts`), che era dichiarato "one release" e non è mai stato rimosso;
- sparisce la divergenza già presente fra OSS ed enterprise su `role.guard.ts` (OSS tollera
  lo spelling legacy, enterprise no);
- le 7 pagine web si gatano sul flag DB, coerenti con il resto del pannello.

CLAUDE.md dichiara che **tre** dichiarazioni soddisfano il guard, e
`route-authorization-guardrail.test.ts` accetta le stesse tre. Restano tre:
`@RequirePermission()`, `@PlatformAdminOnly()` (al posto di `@RequireRole()`) e
`@AuthenticatedOnly()`. Le cinque dichiarazioni — con `@ServicePrincipalOnly()` — sono il
conteggio ENTERPRISE: qui quel decoratore non esiste. Il test e CLAUDE.md vanno aggiornati
in lockstep.

**Contratto pubblico.** `POST /api/users` e `PATCH /api/users/:id` accettano oggi
`role: "platform_admin" | "user"` e lo restituiscono. Il campo diventa
`isPlatformAdmin: boolean`. Per una release l'input continua ad accettare `role` come alias
deprecato (mappato in `users.service.ts`, mai persistito); l'output emette solo
`isPlatformAdmin`. È un breaking change del wire e va nel changelog.

### B — il platform admin agisce in qualsiasi organizzazione

`resolveOrgForCaller` prende lo stesso ramo che `OrgRefGuard` ha già: se il caller è
platform admin, risolve con `resolveOrgIdBySlug`. L'eccezione locale in
`members.service.ts` viene cancellata. `OrganizationManagementService.list()` risponde
`listAll()` a un platform admin, allineandosi a `TenantService`.

Non è un allargamento della superficie di attacco: `PermissionGuard` ha **già** concesso
tutto a quel principal prima che il service giri, quindi il 403 attuale è solo un layer che
contraddice quello sopra — produce un rifiuto, non una protezione.

## Alternative scartate

**Tenere `users.role` come colonna generata da `is_platform_admin`.** Elimina la divergenza
ma non la ridondanza: resterebbero due nomi per un fatto, due predicati (`isPlatformAdminRole`,
`isPlatformAdmin`) e la tentazione di leggere quello sbagliato. Il costo evitato — non toccare
il contratto di `POST /api/users` — si paga comunque con l'alias deprecato di A.

**Bypass solo in lettura, membership per la scrittura.** Introdurrebbe una terza semantica
accanto a quella dell'impersonation (che gatea sul metodo HTTP), su un principal che
`PermissionGuard` tratta già come illimitato. Due regole diverse per lo stesso principal sono
il modo in cui questa base di codice è arrivata ad avere cinque layer che non concordano.

**Esenzione caso per caso nei service che servono al pannello.** È la scelta già fatta una
volta in `members.service.ts`; ha prodotto 52 rotte incoerenti e nessun test che lo notasse.

## Test mancanti oggi

Né `server/shared/resolve-org-for-caller.ee.test.ts` né `server/workspaces/workspaces.service.test.ts`
menzionano il platform admin. Il caso "platform admin non membro" non è coperto da nessun
test in nessuno dei due repository.
