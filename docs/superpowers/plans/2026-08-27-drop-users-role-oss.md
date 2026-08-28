# Piano A — `is_platform_admin` unica autorità, `users.role` eliminata (OSS-first)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un solo fatto persistito per lo standing platform-admin (`users.is_platform_admin`), letto dal DB a ogni richiesta; `users.role`, `RoleGuard` e `@RequireRole()` spariscono, e la revoca ha effetto entro 5 minuti invece che entro 30 giorni.

**Architecture:** `@RequireRole("platform_admin")` viene sostituito da `@PlatformAdminOnly()`, che `PermissionGuard` risolve leggendo il flag dal DB — codice che esiste già nel guard per le liste puramente platform-admin. Con l'ultimo lettore del claim eliminato, `RoleGuard` (APP_GUARD #2b) e il claim `role` nel JWT diventano morti e vengono rimossi; la colonna `role` viene infine droppata da una migrazione che prima riconcilia il flag un'ultima volta. La sessione web continua a portare un `isPlatformAdmin` booleano, ma **solo come suggerimento di presentazione**: nessuna decisione lato server lo legge.

**Tech Stack:** NestJS 11, Drizzle, Auth.js v5, Next.js 16, vitest, ESM.

**Spec:** [`docs/superpowers/specs/2026-08-27-platform-admin-single-source-design.md`](../specs/2026-08-27-platform-admin-single-source-design.md) — sezione «A».

**Repository:** `polyant` (OSS), clone locale `/Users/paolovalletta/Desktop/projects/polyant-ai/polyant`.
**Base branch:** `develop` (fare `git pull` prima: il clone è indietro di 12 commit).
**Branch:** `refactor/platform-admin-single-source`.
**Porting:** il Task 9 apre la PR gemella su `polyant-enterprise`.

## Global Constraints

- Import relativi in `packages/engine` **devono** terminare in `.js`; in `packages/web` un import di VALORE relativo deve essere **senza estensione**.
- `@Inject(ClassName)` esplicito su ogni parametro di costruttore NestJS.
- Migrazioni scritte a mano, journal aggiornato a mano. Su OSS l'ultima è `0074_add_a2a_enabled` con `when: 1781740800000`; la nuova è `0075_drop_users_role` con `when: 1787788800000`. Un file `.sql` senza voce nel journal è **saltato in silenzio** da `db:migrate`, che riporta successo.
- Le dichiarazioni che soddisfano `PermissionGuard` restano **cinque**, e `route-authorization-guardrail.test.ts` deve accettare esattamente le stesse cinque.
- Nessuna nuova stringa magica: il nome del permesso/decoratore vive in un solo modulo.

---

### Task 1: Il decoratore `@PlatformAdminOnly()` e il suo ramo nel guard

Additivo: `RoleGuard` e `@RequireRole` restano in piedi fino al Task 2, così ogni step ha una suite verde.

**Files:**
- Create: `packages/engine/src/authz/decorators/platform-admin-only.decorator.ts`
- Modify: `packages/engine/src/authz/permission.guard.ts` (il ramo `REQUIRED_ROLES_KEY` in `canActivate`)
- Modify: `packages/engine/src/authz/index.ts` (export)
- Test: `packages/engine/src/authz/permission.guard.test.ts`

**Interfaces:**
- Produce: `PLATFORM_ADMIN_ONLY_KEY = "platformAdminOnly"` e `PlatformAdminOnly(): ClassDecorator & MethodDecorator`. Usati dai Task 2 e 9 e dal guardrail test.

- [ ] **Step 1: Scrivere i test che falliscono**

In `permission.guard.test.ts`, accanto ai test già presenti per `@RequireRole` (che restano finché il Task 2 non li sostituisce):

```ts
describe("@PlatformAdminOnly", () => {
  it("allows a current platform admin", async () => {
    const { guard, context } = makeGuard(
      { platformAdminOnly: true },
      { user: { principalType: "user", userId: "u1" } },
      { isPlatformAdmin: true },
    );
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("denies a user whose DB flag is false, whatever the token says", async () => {
    const { guard, context } = makeGuard(
      { platformAdminOnly: true },
      { user: { principalType: "user", userId: "u1", role: "platform_admin" } },
      { isPlatformAdmin: false },
    );
    await expect(guard.canActivate(context)).rejects.toThrow(
      "Current platform administrator standing required",
    );
  });

  it("denies a management API key", async () => {
    const { guard, context } = makeGuard(
      { platformAdminOnly: true },
      { user: { principalType: "service", orgId: "org-1" } },
      { isPlatformAdmin: true },
    );
    await expect(guard.canActivate(context)).rejects.toThrow(
      "Current platform administrator standing required",
    );
  });

  it("denies when there is no principal at all", async () => {
    const { guard, context } = makeGuard({ platformAdminOnly: true }, {}, {});
    await expect(guard.canActivate(context)).rejects.toThrow(
      "Current platform administrator standing required",
    );
  });
});
```

Adattare `makeGuard` all'helper già presente nel file (che oggi prende la metadata del reflector, il request e gli override di `AuthorizationService`).

- [ ] **Step 2: Eseguire e verificare il fallimento**

```bash
npm run test:unit -w @polyant/engine -- src/authz/permission.guard.test.ts
```

Atteso: FAIL — il guard cade in `handleUndeclared` e nega con un messaggio diverso.

- [ ] **Step 3: Implementare il decoratore**

```ts
// packages/engine/src/authz/decorators/platform-admin-only.decorator.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SetMetadata } from "@nestjs/common";

export const PLATFORM_ADMIN_ONLY_KEY = "platformAdminOnly";

/**
 * La rotta richiede lo standing platform-admin CORRENTE, letto dal database.
 *
 * Sostituisce `@RequireRole("platform_admin")`, che veniva deciso da `RoleGuard`
 * sul claim `role` di un JWT valido fino a 30 giorni e senza revoca: promuovere o
 * revocare un platform admin nel DB non aveva effetto su queste rotte fino al
 * successivo sign-in. `PermissionGuard` risolve invece il flag con la stessa
 * lettura cached 5 minuti che ogni altro bypass platform-admin già usa.
 *
 * Solo principal UMANI: una management API key non ha standing platform-admin da
 * verificare, e concederglielo renderebbe la Admin Console raggiungibile con una
 * chiave org-scoped.
 */
export const PlatformAdminOnly = () => SetMetadata(PLATFORM_ADMIN_ONLY_KEY, true);
```

Esportarlo da `packages/engine/src/authz/index.ts` accanto agli altri decoratori.

- [ ] **Step 4: Aggiungere il ramo nel guard**

In `permission.guard.ts`, dentro `canActivate`, nel blocco `if (!permission) { … }`, **prima** del ramo `REQUIRED_ROLES_KEY`:

```ts
      if (this.reflector.getAllAndOverride<boolean>(PLATFORM_ADMIN_ONLY_KEY, targets)) {
        return this.handlePlatformAdminOnly(context);
      }
```

e il metodo privato accanto agli altri `handle*`:

```ts
  /**
   * Corsia @PlatformAdminOnly: passa solo un principal umano il cui
   * `users.is_platform_admin` è true ADESSO. Nessuna shadow mode: una rotta
   * deployment-level nega comunque, come già faceva la corsia `@RequireRole`.
   */
  private async handlePlatformAdminOnly(context: ExecutionContext): Promise<boolean> {
    const principal = context.switchToHttp().getRequest().user as Principal;
    if (isUserPrincipal(principal) && (await this.authz.isPlatformAdmin(principal.userId))) {
      return true;
    }
    throw new ForbiddenException("Current platform administrator standing required");
  }
```

Aggiornare il doc-comment in testa alla classe (righe ~110-125): elenca le dichiarazioni riconosciute e va tenuto onesto.

- [ ] **Step 5: Eseguire i test**

```bash
npm run test:unit -w @polyant/engine -- src/authz/
```

Atteso: PASS, inclusi i test `@RequireRole` esistenti che non sono stati toccati.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/authz/
git commit -m "feat(engine): add @PlatformAdminOnly, resolved from the DB flag"
```

---

### Task 2: Migrare `UsersController`, cancellare `RoleGuard` e `@RequireRole`

**Files:**
- Modify: `packages/engine/src/users/users.controller.ts:15-28`
- Delete: `packages/engine/src/auth/role.guard.ts` (+ il suo test se esiste)
- Delete: `packages/engine/src/auth/decorators/require-role.decorator.ts` (+ test)
- Modify: `packages/engine/src/auth/auth.module.ts` (rimuovere il provider `APP_GUARD` di `RoleGuard`)
- Modify: `packages/engine/src/authz/permission.guard.ts` (rimuovere il ramo `REQUIRED_ROLES_KEY`)
- Modify: `packages/engine/src/server/route-authorization-guardrail.test.ts:27-33,131,284-286`
- Modify: `packages/engine/src/authz/permission.guard.test.ts` (rimuovere i test `@RequireRole`)

- [ ] **Step 1: Migrare il controller**

In `users.controller.ts` sostituire

```ts
import { RequireRole } from "../auth/decorators/require-role.decorator.js";
import { PLATFORM_ADMIN_ROLE } from "../auth/user-role.js";
…
@RequireRole(PLATFORM_ADMIN_ROLE)
```

con

```ts
import { PlatformAdminOnly } from "../authz/index.js";
…
@PlatformAdminOnly()
```

- [ ] **Step 2: Verificare che nessun altro usi `@RequireRole` su OSS**

```bash
grep -rn "RequireRole\|REQUIRED_ROLES_KEY" packages/engine/src --include="*.ts"
```

Atteso su OSS: solo `role.guard.ts`, `require-role.decorator.ts`, `permission.guard.ts`, il guardrail test e i loro test. Se compare un controller non previsto, **fermarsi** e migrarlo prima di proseguire.

- [ ] **Step 3: Cancellare guard e decoratore**

```bash
git rm packages/engine/src/auth/role.guard.ts packages/engine/src/auth/decorators/require-role.decorator.ts
git rm packages/engine/src/auth/role.guard.test.ts packages/engine/src/auth/decorators/require-role.decorator.test.ts 2>/dev/null || true
```

In `auth.module.ts` rimuovere il provider `{ provide: APP_GUARD, useClass: RoleGuard }` e il suo import. In `permission.guard.ts` rimuovere l'intero ramo `REQUIRED_ROLES_KEY` (righe ~184-234) e l'import di `isPlatformAdminRole`: il ramo `@PlatformAdminOnly` del Task 1 lo sostituisce interamente.

- [ ] **Step 4: Aggiornare il guardrail**

In `route-authorization-guardrail.test.ts` sostituire `REQUIRED_ROLES_KEY` con `PLATFORM_ADMIN_ONLY_KEY` ovunque compaia, e riscrivere la funzione che oggi valuta la lista di ruoli (riga ~131) perché legga un booleano. Il test che nega una `@RequireRole` non-platform-admin senza `@RequirePermission` (righe ~284-286) **non ha più oggetto** e va cancellato, non adattato: quella forma non è più esprimibile.

- [ ] **Step 5: Eseguire tutta la suite engine**

```bash
npm run test -w @polyant/engine && npm run typecheck -w @polyant/engine
```

Atteso: PASS. Un fallimento su un test che stubba `role` nel request è **TEST OUTDATED** — la rotta non lo legge più — e va aggiornato; classificarlo esplicitamente.

- [ ] **Step 6: Commit**

```bash
git add -A packages/engine/src
git commit -m "refactor(engine): replace @RequireRole with @PlatformAdminOnly and delete RoleGuard"
```

---

### Task 3: Togliere `role` dal principal e dal JWT

**Files:**
- Modify: `packages/engine/src/auth/auth.types.ts:53`
- Modify: `packages/engine/src/auth/auth-user.service.ts:62-90`
- Modify: `packages/engine/src/auth/auth.guard.ts` (righe che stampano `role` sul principal impersonato e sul ramo gateway)
- Modify: `packages/web/src/lib/auth.config.ts` (callback `jwt` e `session`)
- Modify: `packages/web/src/lib/auth.ts` (`platformAdminBootstrapped`)
- Modify: `packages/web/src/types/next-auth.d.ts`
- Test: `packages/engine/src/auth/auth-user.service.test.ts`, `packages/web/src/lib/auth.jwt-with-org.test.ts`, `packages/web/src/lib/auth.config.two-factor.test.ts`

**Interfaces:**
- Produce: `AuthenticatedUser` perde `role`. La sessione web porta `isPlatformAdmin?: boolean` al suo posto — **solo presentazione**, nessun guard lo legge.

- [ ] **Step 1: Aggiornare i test esistenti al nuovo contratto, e vederli fallire**

`auth.jwt-with-org.test.ts` asserisce oggi `token.role`. Riscrivere quelle assertion su `token.isPlatformAdmin` (stessi casi: bootstrap che eleva, membership esistente che non eleva, patch client che **non** deve elevare — quest'ultimo è il test di sicurezza più importante del file e va conservato riga per riga).

```bash
npm test -w @polyant/web -- src/lib/auth.jwt-with-org.test.ts
```

Atteso: FAIL.

- [ ] **Step 2: Rimuovere `role` dall'engine**

- `auth.types.ts`: togliere `role: UserRole` da `AuthenticatedUser` e l'import di `UserRole`.
- `auth-user.service.ts`: togliere `const role = normalizeUserRole(payload.role)` e il campo dal principal costruito. Il commento «trust boundary for the role claim» va cancellato, non riadattato: non c'è più un claim di cui fidarsi.
- `auth.guard.ts`: togliere `role: active.targetRole` dal principal impersonato (e `targetRole` dalla riga di impersonation se non serve altrove) e `role: user.role` dal ramo gateway, che su questa build è comunque rifiutato al boot.

- [ ] **Step 3: Sostituire il claim lato web**

In `auth.config.ts`, callback `jwt`: dove oggi c'è `if (u.role) token.role = u.role;` scrivere `if (typeof u.isPlatformAdmin === "boolean") token.isPlatformAdmin = u.isPlatformAdmin;`, e nel fallback Google `if (token.isPlatformAdmin === undefined) token.isPlatformAdmin = false;`.

**Conservare intatta** la difesa già presente: il patch `update()` lato client non deve mai poter impostare questo campo. Il commento SECURITY esistente va riscritto sul nuovo nome, non rimosso — l'attacco («qualunque utente autenticato diventa platform admin POSTando il campo») è identico.

Nel callback `session`, esporre `session.user.isPlatformAdmin`. In `next-auth.d.ts` sostituire `role: PersistedUserRole` con `isPlatformAdmin: boolean` nelle tre dichiarazioni.

In `auth.ts`, `if (resolution.platformAdminBootstrapped) token.role = "platform_admin"` diventa `token.isPlatformAdmin = true`.

- [ ] **Step 4: Eseguire i test**

```bash
npm test -w @polyant/web -- src/lib/ && npm run test -w @polyant/engine -- src/auth/
```

Atteso: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/auth packages/web/src/lib packages/web/src/types
git commit -m "refactor(auth): carry isPlatformAdmin on the session, not a role claim"
```

---

### Task 4: `role` esce dall'API utenti

**Files:**
- Modify: `packages/engine/src/users/users.service.ts:45-70,100-110,170-230`
- Modify: `packages/engine/src/users/users.controller.ts:55-100`
- Modify: `packages/engine/src/users/users.store.ts:16-60,95-200`
- Modify: `packages/web/src/lib/api-types.ts` (DTO utente)
- Test: `packages/engine/src/users/users.service.test.ts`, `users.store.test.ts`, `users.controller.test.ts`

**Interfaces:**
- Produce: `UserDto` espone `isPlatformAdmin: boolean` e **non** `role`. `CreateUserInput` / `UpdateUserInput` prendono `isPlatformAdmin: boolean`. `countPlatformAdmins()` conta `is_platform_admin = true` e basta.

- [ ] **Step 1: Scrivere i test che falliscono**

```ts
it("creates a platform admin from isPlatformAdmin", async () => {
  const { user } = await service.create({ email: "a@b.c", password: "x", isPlatformAdmin: true });
  expect(user.isPlatformAdmin).toBe(true);
  expect(user).not.toHaveProperty("role");
});

it("still accepts the deprecated role alias on input for one release", async () => {
  const { user } = await service.create({ email: "d@e.f", password: "x", role: "platform_admin" });
  expect(user.isPlatformAdmin).toBe(true);
});

it("refuses to demote the last platform admin", async () => {
  countPlatformAdmins.mockResolvedValue(1);
  await expect(service.update("u1", { isPlatformAdmin: false }, actor)).rejects.toThrow();
});
```

- [ ] **Step 2: Eseguire e verificare il fallimento**

```bash
npm run test:unit -w @polyant/engine -- src/users/
```

- [ ] **Step 3: Implementare**

- `users.service.ts`: `validRole()` diventa `readPlatformAdminFlag(body)`, che accetta `isPlatformAdmin: boolean` e, **per una sola release**, l'alias deprecato `role` mappato con `isPlatformAdminRole()` (l'unico uso residuo di quel predicato). `isPlatformAdminStanding()` collassa a `user.isPlatformAdmin`: non c'è più una seconda fonte da mettere in OR.
- `users.controller.ts`: il body dichiara `isPlatformAdmin?: boolean` (più `role?: string` deprecato), e l'audit log registra `{ isPlatformAdmin }`.
- `users.store.ts`: `role` esce da `mapRow`, da `insertUser`, da `updateUser` (dove `isPlatformAdmin` diventa un campo diretto, non più derivato); l'ordinamento a riga ~105 usa `desc(users.isPlatformAdmin)`; `countPlatformAdmins()` diventa `where(eq(users.isPlatformAdmin, true))` e il commento sull'OR va cancellato — la ragione dell'OR era la divergenza, che sparisce.
- L'invalidazione `invalidatePlatformAdminCache(id)` deve continuare ad accompagnare **ogni** scrittura del flag.

- [ ] **Step 4: Eseguire i test**

```bash
npm run test -w @polyant/engine -- src/users/
```

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/users packages/web/src/lib/api-types.ts
git commit -m "refactor(engine): the users API speaks isPlatformAdmin, not role"
```

---

### Task 5: Boot promotion, seed e primo accesso

**Files:**
- Modify: `packages/engine/src/organizations/organizations.store.ts:160-175,225-240,320-390`
- Modify: `packages/engine/src/users/seed.ts:45-90`
- Modify: `packages/engine/src/users/credentials.controller.ts:140-150`
- Test: i test già esistenti su questi moduli

- [ ] **Step 1: Trovare ogni scrittura accoppiata**

```bash
grep -rn "PLATFORM_ADMIN_ROLE\|isPlatformAdminRole" packages/engine/src --include="*.ts" | grep -v "\.test\."
```

Ogni `.set({ isPlatformAdmin: true, role: PLATFORM_ADMIN_ROLE, … })` perde il secondo campo. In `ensureGatewayUserProvisioned` (riga ~341) `const isPlatformAdmin = isPlatformAdminRole(role)` diventa una lettura diretta del flag dall'identità gateway, e il confronto `or(ne(users.role, role), ne(users.isPlatformAdmin, isPlatformAdmin))` si riduce al secondo termine.

- [ ] **Step 2: Aggiornare seed e credentials**

`seed.ts` scrive `isPlatformAdmin: true` al posto di `role: "platform_admin"`; il commento `// also sets isPlatformAdmin` sparisce perché non c'è più una derivazione. `credentials.controller.ts:143` (`{ organizationId, role: "platform_admin" as const }`) passa `isPlatformAdmin: true`.

- [ ] **Step 3: Eseguire i test**

```bash
npm run test -w @polyant/engine -- src/organizations/ src/users/
```

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/organizations packages/engine/src/users
git commit -m "refactor(engine): boot promotion and seed write only is_platform_admin"
```

---

### Task 6: La migrazione, e la cancellazione dello shim

Va **per ultima** fra i cambi engine: finché un lettore di `role` esiste, droppare la colonna rompe un deploy rolling.

**Files:**
- Create: `packages/engine/src/database/migrations/0075_drop_users_role.sql`
- Modify: `packages/engine/src/database/migrations/meta/_journal.json`
- Modify: `packages/engine/src/auth/users.schema.ts:23-36`
- Delete: `packages/engine/src/auth/user-role.ts` (+ `user-role.test.ts`)

- [ ] **Step 1: Verificare che non resti nessun lettore**

```bash
grep -rn "users.role\|UserRole\|normalizeUserRole\|PLATFORM_ADMIN_ROLE\|LEGACY_PLATFORM_ADMIN" packages/engine/src --include="*.ts" | grep -v "\.test\."
```

Atteso: solo l'alias deprecato in `users.service.ts` (Task 4) e le definizioni in `user-role.ts`. Qualunque altra occorrenza va chiusa prima di proseguire.

- [ ] **Step 2: Scrivere la migrazione**

```sql
-- packages/engine/src/database/migrations/0075_drop_users_role.sql
--
-- `users.role` e `users.is_platform_admin` erano due rappresentazioni dello stesso
-- fatto: la seconda DERIVATA dalla prima al momento della scrittura, senza alcun
-- vincolo di database a tenerle allineate. Da qui in avanti la colonna booleana è
-- l'unica autorità, letta dal DB a ogni richiesta.
--
-- ORDERING NOTE: il codice che smette di leggere `role` (RoleGuard cancellato, il
-- claim JWT sostituito, l'API utenti convertita) ship nella STESSA release e mai
-- dopo questa migrazione. Durante un deploy rolling, codice vecchio che trova la
-- colonna assente fallisce su ogni SELECT della tabella users.

-- Ultima riconciliazione prima del drop: una riga promossa con una UPDATE diretta
-- a `role` e mai al flag perderebbe altrimenti ogni potere, in silenzio. Scoped
-- alle sole divergenze, quindi no-op su un database coerente e idempotente.
UPDATE users
SET is_platform_admin = true, updated_at = now()
WHERE is_platform_admin = false
  AND role IN ('platform_admin', 'superadmin');

ALTER TABLE users DROP COLUMN IF EXISTS role;
```

- [ ] **Step 3: Aggiungere la voce di journal**

In coda a `meta/_journal.json` (OSS: l'ultima è `idx: 67`, `0074_add_a2a_enabled`, `when: 1781740800000`):

```json
    {
      "idx": 68,
      "version": "7",
      "when": 1787788800000,
      "tag": "0075_drop_users_role",
      "breakpoints": true
    }
```

Il `tag` deve essere **esattamente** il nome file senza `.sql`, e `when` maggiore di ogni voce già applicata al database bersaglio, altrimenti `db:migrate` la salta in silenzio riportando successo.

- [ ] **Step 4: Aggiornare lo schema e cancellare lo shim**

In `users.schema.ts` rimuovere la riga `role`, il re-export `export type { UserRole }` e l'import; riscrivere il doc-comment di `isPlatformAdmin` togliendo il riferimento a `role` e a 0084/0071. Poi:

```bash
git rm packages/engine/src/auth/user-role.ts packages/engine/src/auth/user-role.test.ts
```

Se l'alias deprecato del Task 4 usa ancora `isPlatformAdminRole`, inlinearne il confronto in `users.service.ts` con un commento che dice che è un alias di wire in scadenza, non un fatto persistito.

- [ ] **Step 5: Applicare e verificare sul database**

```bash
npm run db:migrate -w @polyant/engine
psql "$DATABASE_URL" -c "\d users" | grep -c role
```

Atteso: `0`. Se `db:migrate` dice «applied» ma la colonna c'è ancora, il journal è sbagliato — rileggere lo Step 3.

- [ ] **Step 6: Suite completa**

```bash
npm run typecheck && npm run lint && npm test
```

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/database packages/engine/src/auth
git commit -m "refactor(engine)!: drop users.role — is_platform_admin is the only authority"
```

---

### Task 7: Il pannello web smette di leggere il ruolo

**Files:**
- Delete: `packages/web/src/lib/user-role.ts`, `packages/web/src/lib/user-role.test.ts`
- Modify: `packages/web/src/components/layout/app-sidebar.tsx`
- Modify: `packages/web/src/app/(admin)/settings/{page.tsx,users-tab.tsx,create-user-dialog.tsx,edit-user-dialog.tsx}`
- Modify: `packages/web/src/app/(admin)/about/page.tsx`, `packages/web/src/hooks/use-changelog-check.ts`, `packages/web/src/lib/api.ts`
- Test: i test co-locati a ciascuno

- [ ] **Step 1: Elencare i consumatori**

```bash
grep -rln "isPlatformAdminRole\|user?.role\|UserRole\|normalizeUserRole" packages/web/src
```

Su OSS sono 13 file (uno è il test dello shim). Nessuno è `/platform/*`: quelle pagine esistono solo in enterprise e sono nel Task 9.

- [ ] **Step 2: Sostituire ogni gate**

Ogni `isPlatformAdminRole(session?.user?.role)` diventa `session?.user?.isPlatformAdmin === true`. Ogni `<Select>` di ruolo nei dialog utente diventa uno `<Switch>`/checkbox su `isPlatformAdmin`; il badge in `users-tab.tsx` legge `u.isPlatformAdmin`. `create-user-dialog.tsx` **conserva** il suo comportamento attuale (il ruolo è dichiarato, non scelto): il campo resta non modificabile, solo con l'etichetta nuova.

Cancellare `lib/user-role.ts` e il suo test.

- [ ] **Step 3: Verificare**

```bash
npm run typecheck -w @polyant/web && npm run lint -w @polyant/web && npm test -w @polyant/web
```

Atteso: PASS. Un `Property 'role' does not exist` è la prova che il Task 3 ha stretto i tipi correttamente.

- [ ] **Step 4: Commit**

```bash
git add -A packages/web/src
git commit -m "refactor(web): the panel reads isPlatformAdmin, never a role claim"
```

---

### Task 8: Artefatti, documentazione, PR OSS

- [ ] **Step 1: Rigenerare gli artefatti HTTP**

```bash
npm run openapi:generate -w @polyant/engine
npm test -w @polyant/engine -- openapi-artifacts.guardrail
```

Atteso: `api-index.md` e `openapi.json` aggiornati (la colonna auth delle rotte `/api/users` cambia) e guardrail verde.

- [ ] **Step 2: Suite completa**

```bash
npm run typecheck && npm run lint && npm test
```

- [ ] **Step 3: Verifica manuale**

Con un account promosso via SQL **mentre la sessione è aperta**:

```sql
UPDATE users SET is_platform_admin = true WHERE email = '<la tua mail>';
```

Senza fare logout, attendere il TTL della cache (5 minuti) e ricaricare: la Admin Console deve diventare raggiungibile. Prima di questo piano richiedeva logout/login. Poi la prova inversa: `SET is_platform_admin = false` e verificare che l'accesso si chiuda entro lo stesso TTL.

- [ ] **Step 4: CLAUDE.md**

Sotto «Authentication & Authorization», la voce «Three declarations satisfy the guard» nomina `@RequireRole()`: sostituirla con `@PlatformAdminOnly()` e dire che è risolta dal DB, non dal claim. Rimuovere ogni riferimento a `users.role` e allo shim `superadmin` — sono affermazioni ora false, e vanno **sostituite**, non affiancate.

- [ ] **Step 5: Changelog e PR**

Il changelog registra il breaking change del wire: `POST /api/users` e `PATCH /api/users/:id` prendono `isPlatformAdmin: boolean`; `role` è accettato come alias deprecato per una release e non è più restituito.

```bash
git push -u origin refactor/platform-admin-single-source
gh pr create --base develop --title "refactor!: is_platform_admin is the single source of platform-admin standing"
```

---

### Task 9: Porting in enterprise

Da eseguire in `polyant-enterprise` **dopo** il merge della PR OSS. Repo separato, PR separata: branch `refactor/platform-admin-single-source` da `develop`.

- [ ] **Step 1: Merge di `oss/develop`**

```bash
cd /Users/paolovalletta/Desktop/projects/polyant-ai/polyant-enterprise
git checkout develop && git pull
git checkout -b refactor/platform-admin-single-source
git -c rerere.enabled=false merge oss/develop
```

`rerere` **disattivato**: risoluzioni memorizzate stale hanno già auto-risolto male merge OSS→enterprise in passato.

- [ ] **Step 2: Rinumerare la migrazione**

La `0075_drop_users_role.sql` di OSS collide con la numerazione enterprise (ultima: `0095_org_plugin_read_permission`, `when: 1786492800000`). Rinominarla in `0096_drop_users_role.sql`, e nel journal enterprise usare `idx: 93`, `tag: "0096_drop_users_role"`, `when: 1787788800000` (già maggiore del massimo enterprise). Verificare che il file OSS `0075_*` non sopravviva al merge.

- [ ] **Step 3: Convertire i 6 controller enterprise rimasti**

```bash
grep -rn "^@RequireRole" packages/engine/src --include="*.ts"
```

Atteso: `server/platform/platform-audit.controller.ts:24`, `platform-skills.controller.ts:26`, `platform-plugins.controller.ts:29`, `platform-analytics.controller.ts:29`, `impersonation/impersonation.controller.ts:27`, `two-factor/platform-two-factor.controller.ts:31`. Ognuno passa a `@PlatformAdminOnly()`. Aggiornare i doc-comment che citano «la stessa dichiarazione che usa `/api/users`»: la dichiarazione è cambiata.

- [ ] **Step 4: Le 7 pagine della Admin Console leggono il flag DB**

`platform/settings/{users,skills,plugins,plugins/[name],audit,two-factor}/page.tsx` e `platform/analytics/page.tsx` gatano oggi su `isPlatformAdminRole(session?.user?.role)`. Sostituire con `useAccessState(null).access.isPlatformAdmin`, usando `resolved` per **non** mostrare il rifiuto durante il frame di pre-fetch — è esattamente il caso che `useAccessState` documenta («una falsa affermazione mostrata a chi invece ha accesso»).

- [ ] **Step 5: Verificare che il pannello sia coerente**

```bash
grep -rn "session?.user?.role\|isPlatformAdminRole" packages/web/src
```

Atteso: nessun risultato. `lib/access-visibility.ts` continua a fare bypass su `access.isPlatformAdmin` e non va toccato.

- [ ] **Step 6: Confronto anti-regressione dei default di config**

```bash
git diff $(git merge-base HEAD develop) HEAD -- packages/engine/src/config.ts | grep -n "default("
```

Un merge OSS→enterprise ha già revertato in silenzio i `.default(...)` di `config.ts` in passato, invisibile a 3000 test perché tutti mockano config. Ispezionare a mano ogni riga che compare.

- [ ] **Step 7: Verifica e PR**

```bash
npm run db:migrate && npm run typecheck && npm run lint && npm test
```

Poi la verifica manuale del Task 8 Step 3, più quella del Piano B se già mergiato: con i due piani insieme, un platform admin senza alcuna membership deve vedere Admin Console, lista organizzazioni, workspace e ogni pagina di impostazioni org.

```bash
git push -u origin refactor/platform-admin-single-source
gh pr create --base develop --title "refactor!: is_platform_admin is the single source of platform-admin standing"
```
