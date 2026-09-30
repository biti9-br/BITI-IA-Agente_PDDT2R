import {
  signOut,
  onAuthStateChanged,
  OAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  reauthenticateWithPopup,
  type User,
} from "firebase/auth";
import { auth } from "./firebase";

// Armazenamento do token em memória, sessionStorage e localStorage com tolerância a reload (F5)
const SESSION_MS_TOKEN_KEY = "biti9_ms_graph_token";
const SESSION_MS_TOKEN_TIME_KEY = "biti9_ms_graph_token_time";
let inMemoryAccessToken: string | null = null;
let ultimoMotivoLogout: string | null = null;

export function setMemoryToken(token: string | null): void {
  inMemoryAccessToken = token;
  if (typeof sessionStorage !== "undefined") {
    try {
      if (token) {
        sessionStorage.setItem(SESSION_MS_TOKEN_KEY, token);
      } else {
        sessionStorage.removeItem(SESSION_MS_TOKEN_KEY);
      }
    } catch {}
  }
  if (typeof localStorage !== "undefined") {
    try {
      if (token) {
        localStorage.setItem(SESSION_MS_TOKEN_KEY, token);
        localStorage.setItem(SESSION_MS_TOKEN_TIME_KEY, String(Date.now()));
      } else {
        localStorage.removeItem(SESSION_MS_TOKEN_KEY);
        localStorage.removeItem(SESSION_MS_TOKEN_TIME_KEY);
      }
    } catch {}
  }
}

export function getMemoryToken(): string | null {
  if (inMemoryAccessToken) return inMemoryAccessToken;
  if (typeof sessionStorage !== "undefined") {
    try {
      const saved = sessionStorage.getItem(SESSION_MS_TOKEN_KEY);
      if (saved) {
        inMemoryAccessToken = saved;
        return saved;
      }
    } catch {}
  }
  if (typeof localStorage !== "undefined") {
    try {
      const saved = localStorage.getItem(SESSION_MS_TOKEN_KEY);
      const savedTime = localStorage.getItem(SESSION_MS_TOKEN_TIME_KEY);
      // Tokens da Microsoft expiram em 3600 segundos (1 hora). Usamos tolerância de 55 minutos.
      if (saved && savedTime) {
        const ageMs = Date.now() - Number(savedTime);
        if (ageMs < 55 * 60 * 1000) {
          inMemoryAccessToken = saved;
          return saved;
        } else {
          localStorage.removeItem(SESSION_MS_TOKEN_KEY);
          localStorage.removeItem(SESSION_MS_TOKEN_TIME_KEY);
        }
      } else if (saved) {
        inMemoryAccessToken = saved;
        return saved;
      }
    } catch {}
  }
  return null;
}

/**
 * 1. MOTIVO VISÍVEL
 * Registra o motivo de encerramento da sessão para exibição transparente na tela de login.
 */
export function registrarMotivoLogout(motivo: string): void {
  ultimoMotivoLogout = motivo;
  if (typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.setItem("biti9_logout_reason", motivo);
    } catch {}
  }
}

export function obterMotivoLogout(): string | null {
  if (ultimoMotivoLogout) {
    return ultimoMotivoLogout;
  }
  if (typeof sessionStorage !== "undefined") {
    try {
      return sessionStorage.getItem("biti9_logout_reason");
    } catch {}
  }
  return null;
}

export function limparMotivoLogout(): void {
  ultimoMotivoLogout = null;
  if (typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.removeItem("biti9_logout_reason");
    } catch {}
  }
}

/**
 * 2. E-MAIL
 * Obtenha o e-mail nesta ordem estrita:
 * 1. user.email
 * 2. user.providerData[0].email
 * 3. claim "email" do ID token
 * 4. claim "preferred_username" do token da Microsoft
 * 
 * Retorna sempre em minúsculas e sem espaços ao redor.
 */
export async function extrairEmailUsuario(user: User | null): Promise<string> {
  if (!user) return "";

  // 1. user.email
  if (user.email && user.email.trim()) {
    return user.email.trim().toLowerCase();
  }

  // 2. user.providerData[0].email (ou outros providers)
  if (user.providerData && user.providerData.length > 0) {
    for (const provider of user.providerData) {
      if (provider.email && provider.email.trim()) {
        return provider.email.trim().toLowerCase();
      }
    }
  }

  // 3. claim "email" do ID token e 4. claim "preferred_username" do token da Microsoft
  try {
    const tokenResult = await user.getIdTokenResult();
    const claims = tokenResult.claims;

    // 3. claim "email"
    if (typeof claims.email === "string" && claims.email.trim()) {
      return claims.email.trim().toLowerCase();
    }

    // 4. claim "preferred_username"
    if (typeof claims.preferred_username === "string" && claims.preferred_username.trim()) {
      return claims.preferred_username.trim().toLowerCase();
    }

    // Claims complementares do Azure AD / Microsoft Entra
    if (typeof (claims as any).upn === "string" && (claims as any).upn.trim()) {
      return (claims as any).upn.trim().toLowerCase();
    }
    if (typeof (claims as any).unique_name === "string" && (claims as any).unique_name.trim()) {
      return (claims as any).unique_name.trim().toLowerCase();
    }
  } catch (err) {
    console.warn("[extrairEmailUsuario] Falha ao extrair claims do ID token:", err);
  }

  return "";
}

// Configuração do provedor Microsoft com escopo Sites.Selected e tenant corporativo
export function criarMicrosoftProvider(): OAuthProvider {
  const provider = new OAuthProvider("microsoft.com");
  provider.setCustomParameters({
    tenant: "963ca415-7dad-4569-b6df-554fbb071304",
    prompt: "select_account",
  });
  provider.addScope("Sites.Selected");
  provider.addScope("User.Read");
  provider.addScope("offline_access");
  return provider;
}

function formatAuthError(err: any): Error {
  const code = err?.code || "";
  const msg = err?.message || String(err);
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
    return new Error("Janela de autenticação cancelada pelo usuário.");
  }
  if (code === "auth/popup-blocked") {
    return new Error("Pop-up bloqueado pelo navegador. Por favor, ative as permissões de pop-up nas configurações do navegador para conectar ao SharePoint.");
  }
  if (code === "auth/unauthorized-domain") {
    const host = typeof window !== "undefined" ? window.location.hostname : "produção";
    return new Error(`O domínio "${host}" não está autorizado no Firebase Authentication. Para liberar o acesso em produção, adicione "${host}" no Firebase Console (Authentication > Configurações > Domínios autorizados).`);
  }
  if (code === "auth/network-request-failed") {
    return new Error("Falha de conexão com os serviços de autenticação. Verifique sua conexão com a internet.");
  }
  return new Error(msg);
}

/**
 * Login oficial via Microsoft com Firebase Auth.
 * O usuário logado no app vem exclusivamente do Firebase.
 */
export async function loginComMicrosoft() {
  const provider = criarMicrosoftProvider();
  
  try {
    const result = await signInWithPopup(auth, provider);
    const credential = OAuthProvider.credentialFromResult(result);
    const token =
      credential?.accessToken ||
      (result as any)?._tokenResponse?.oauthAccessToken ||
      (result as any)?._tokenResponse?.accessToken ||
      null;
    if (token) {
      setMemoryToken(token);
    }
    return result;
  } catch (popupErr: any) {
    const isInIframe = typeof window !== "undefined" && window.self !== window.top;
    if (!isInIframe && (popupErr.code === "auth/popup-blocked" || popupErr.code === "auth/popup-closed-by-user")) {
      return await signInWithRedirect(auth, provider);
    }
    throw formatAuthError(popupErr);
  }
}

export function loginComMicrosoftRedirect() {
  const provider = criarMicrosoftProvider();
  return signInWithRedirect(auth, provider);
}

/**
 * Reautenticação sob demanda com o Microsoft Graph via popup.
 * Usada pelo navegador do SharePoint quando o token do Graph não estiver em memória/sessão,
 * SEM deslogar o usuário do Firebase.
 */
export async function reautenticarMicrosoft(): Promise<string> {
  const provider = criarMicrosoftProvider();

  // 1. Se o usuário já está autenticado no Firebase, tenta reauthenticateWithPopup diretamente
  if (auth.currentUser) {
    try {
      const reauthResult = await reauthenticateWithPopup(auth.currentUser, provider);
      const cred = OAuthProvider.credentialFromResult(reauthResult);
      const token =
        cred?.accessToken ||
        (reauthResult as any)?._tokenResponse?.oauthAccessToken ||
        (reauthResult as any)?._tokenResponse?.accessToken ||
        null;
      if (token) {
        setMemoryToken(token);
        return token;
      }
    } catch (reauthErr: any) {
      console.warn("[reautenticarMicrosoft] reauthenticateWithPopup falhou, tentando fallback com signInWithPopup:", reauthErr);
      if (
        reauthErr.code === "auth/unauthorized-domain" ||
        reauthErr.code === "auth/popup-blocked"
      ) {
        throw formatAuthError(reauthErr);
      }
    }
  }

  // 2. Fallback com signInWithPopup (preserva o usuário e obtém as credenciais do provedor)
  try {
    const result = await signInWithPopup(auth, provider);
    const credential = OAuthProvider.credentialFromResult(result);
    const token =
      credential?.accessToken ||
      (result as any)?._tokenResponse?.oauthAccessToken ||
      (result as any)?._tokenResponse?.accessToken ||
      null;
    if (token) {
      setMemoryToken(token);
      return token;
    }
  } catch (err: any) {
    throw formatAuthError(err);
  }

  throw new Error("Não foi possível obter o token de acesso da Microsoft. Verifique se sua conta corporativa possui acesso ao SharePoint.");
}

// Captura do token após redirect, mantendo estritamente em memória
export async function verificarResultadoRedirect() {
  try {
    const result = await getRedirectResult(auth);
    if (result) {
      const credential = OAuthProvider.credentialFromResult(result);
      const token =
        credential?.accessToken ||
        (result as any)?._tokenResponse?.oauthAccessToken ||
        (result as any)?._tokenResponse?.accessToken ||
        null;
      if (token) {
        setMemoryToken(token);
      }
    }
    return result;
  } catch (err: any) {
    console.warn("[Redirect Result]", err);
    return null;
  }
}

/**
 * 3. NÃO DESLOGAR POR ERRO DE API
 * Único motivo para signOut() automático: e-mail fora do domínio @biti9.com.br.
 */
export async function logout(motivo?: string) {
  if (motivo) {
    registrarMotivoLogout(motivo);
  }
  setMemoryToken(null);
  await signOut(auth);
}

/**
 * Observador oficial do Firebase Auth.
 * O estado "usuário logado" vem exclusivamente de onAuthStateChanged.
 */
export function observarUsuario(callback: (user: User | null) => void) {
  return onAuthStateChanged(auth, callback);
}
