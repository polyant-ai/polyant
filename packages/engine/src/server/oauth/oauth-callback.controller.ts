// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Param, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "../../auth/decorators/public.decorator.js";
import { setPrincipalSecret } from "../../conversations/principal-secrets.store.js";
import {
  getOAuthProvider,
  exchangeCodeForToken,
  resolveOAuthCredentials,
  oauthTokenStateKey,
  oauthRefreshStateKey,
} from "./oauth-providers.js";
import { consumeOAuthState } from "./oauth-states.store.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import { errMsg } from "../../utils/error.js";

/** Minimal browser-facing page. The user lands here after authorizing. */
function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;text-align:center"><h2>${title}</h2><p>${body}</p></body>`;
}

// Generic OAuth callback for every provider in the registry. `state` is a
// single-use nonce mapped (via oauth_states) to the conversation + provider +
// PKCE verifier. Runs OUTSIDE a pipeline turn → direct vault write; the next
// turn reads the token from the encrypted vault.
@Controller("oauth")
export class OAuthCallbackController {
  @Public()
  @Get(":provider/callback")
  async callback(
    @Param("provider") providerName: string,
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const provider = getOAuthProvider(providerName);
    if (!provider) {
      res.status(404).type("html").send(page("Errore", `Provider OAuth sconosciuto: ${providerName}.`));
      return;
    }
    if (!code || !state) {
      res.status(400).type("html").send(page("Errore", "Parametri OAuth mancanti (code/state)."));
      return;
    }

    // Consume the single-use state nonce → conversation + PKCE verifier. Reject
    // unknown/expired (CSRF) and a provider that doesn't match the path.
    const pending = await consumeOAuthState(state);
    if (!pending || pending.provider !== providerName) {
      res.status(400).type("html").send(page("Errore", "state OAuth non valido o scaduto. Riprova a collegare."));
      return;
    }
    const { conversationId, instanceId: slug, codeVerifier } = pending;

    try {
      const creds = await resolveOAuthCredentials(providerName, asInstanceSlug(slug));
      if (!creds.clientId || !creds.clientSecret) {
        res
          .status(400)
          .type("html")
          .send(page("Errore", `Credenziali OAuth non configurate per "${providerName}" su questa istanza.`));
        return;
      }
      const { accessToken, refreshToken, expiresIn } = await exchangeCodeForToken(provider, code, creds, codeVerifier);
      // Encrypted vault (NOT conversation_state) so tokens are never in the
      // cleartext, promptable state blob.
      const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
      await setPrincipalSecret(conversationId, slug, oauthTokenStateKey(providerName), accessToken, expiresAt);
      if (refreshToken) {
        await setPrincipalSecret(conversationId, slug, oauthRefreshStateKey(providerName), refreshToken, null);
      }
      res.type("html").send(page(`${providerName} collegato ✅`, "Puoi tornare alla chat e continuare."));
    } catch (err) {
      res
        .status(502)
        .type("html")
        .send(page("Connessione fallita", `Scambio token ${providerName} fallito: ${errMsg(err)}`));
    }
  }
}
