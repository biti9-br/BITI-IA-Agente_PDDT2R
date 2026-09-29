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

// Armazenamento do token SOMENTE em memória durante o ciclo de vida da aplicação.
// NUNCA salvo em localStorage, sessionStorage ou cookies.
let inMemoryAccessToken: string | null = null;
let ultimoMotivoLogout: string | null = null;

export function setMemoryToken(token: string | null): void {
  inMemoryAccessToken = token;
}

export function getMemoryToken(): string | null {
  return inMemoryAccessToken;
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
  return provider;
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
    if (credential?.accessToken) {
      setMemoryToken(credential.accessToken);
    }
    return result;
  } catch (popupErr: any) {
    const isInIframe = typeof window !== "undefined" && window.self !== window.top;
    if (!isInIframe && (popupErr.code === "auth/popup-blocked" || popupErr.code === "auth/popup-closed-by-user")) {
      return await signInWithRedirect(auth, provider);
    }
    throw popupErr;
  }
}

export function loginComMicrosoftRedirect() {
  const provider = criarMicrosoftProvider();
  return signInWithRedirect(auth, provider);
}

/**
 * Reautenticação sob demanda com o Microsoft Graph via reauthenticateWithPopup.
 * Usada pelo navegador do SharePoint quando o token do Graph não estiver em memória
 * (por exemplo, após recarregar a página com F5), SEM deslogar o usuário do Firebase.
 */
export async function reautenticarMicrosoft(): Promise<string> {
  const provider = criarMicrosoftProvider();
  if (typeof auth.authStateReady === "function") {
    await auth.authStateReady();
  }

  // Se o usuário está logado no Firebase, reautentica sem deslogar
  if (auth.currentUser) {
    try {
      const result = await reauthenticateWithPopup(auth.currentUser, provider);
      const credential = OAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        setMemoryToken(credential.accessToken);
        return credential.accessToken;
      }
    } catch (reauthErr: any) {
      if (reauthErr.code === "auth/popup-closed-by-user" || reauthErr.code === "auth/cancelled-popup-request") {
        throw new Error("Janela de autenticação cancelada pelo usuário.");
      }
      if (reauthErr.code === "auth/popup-blocked") {
        throw new Error("Pop-up bloqueado pelo navegador. Ative as permissões de pop-up para conectar ao SharePoint.");
      }
      console.warn("[reautenticarMicrosoft] reauthenticateWithPopup falhou, tentando signInWithPopup como fallback:", reauthErr);
      
      try {
        const signInResult = await signInWithPopup(auth, provider);
        const cred = OAuthProvider.credentialFromResult(signInResult);
        if (cred?.accessToken) {
          setMemoryToken(cred.accessToken);
          return cred.accessToken;
        }
      } catch (signInErr: any) {
        if (signInErr.code === "auth/popup-closed-by-user" || signInErr.code === "auth/cancelled-popup-request") {
          throw new Error("Janela de autenticação cancelada pelo usuário.");
        }
        if (signInErr.code === "auth/popup-blocked") {
          throw new Error("Pop-up bloqueado pelo navegador. Ative as permissões de pop-up para conectar ao SharePoint.");
        }
        throw signInErr;
      }
    }
  } else {
    // Se não há usuário no Firebase, faz login via popup
    try {
      const result = await signInWithPopup(auth, provider);
      const credential = OAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        setMemoryToken(credential.accessToken);
        return credential.accessToken;
      }
    } catch (popupErr: any) {
      if (popupErr.code === "auth/popup-closed-by-user" || popupErr.code === "auth/cancelled-popup-request") {
        throw new Error("Janela de autenticação cancelada pelo usuário.");
      }
      if (popupErr.code === "auth/popup-blocked") {
        throw new Error("Pop-up bloqueado pelo navegador. Ative as permissões de pop-up para conectar ao SharePoint.");
      }
      throw popupErr;
    }
  }

  throw new Error("Não foi possível obter o token de acesso da Microsoft.");
}

// Captura do token após redirect, mantendo estritamente em memória
export async function verificarResultadoRedirect() {
  try {
    const result = await getRedirectResult(auth);
    if (result) {
      const credential = OAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        setMemoryToken(credential.accessToken);
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
