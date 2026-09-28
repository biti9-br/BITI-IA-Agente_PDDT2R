import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  OAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  reauthenticateWithPopup,
  linkWithCredential,
  type User,
} from "firebase/auth";
import { auth } from "./firebase";

export interface CorporateUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string | null;
  providerId: string;
}

// Armazenamento do token SOMENTE em memória durante o ciclo de vida da aplicação.
// NUNCA salvo em localStorage, sessionStorage ou cookies.
let inMemoryAccessToken: string | null = null;
let corporateSessionUser: CorporateUser | null = null;
const authListeners: Array<(user: User | CorporateUser | null) => void> = [];

export function setMemoryToken(token: string | null): void {
  inMemoryAccessToken = token;
}

export function getMemoryToken(): string | null {
  return inMemoryAccessToken;
}

function emitirMudancaAuth(user: User | CorporateUser | null) {
  for (const listener of authListeners) {
    try {
      listener(user);
    } catch (e) {
      console.error("Erro no listener de auth:", e);
    }
  }
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

export function cadastrar(email: string, senha: string) {
  return createUserWithEmailAndPassword(auth, email, senha);
}

export function login(email: string, senha: string) {
  return signInWithEmailAndPassword(auth, email, senha);
}

export async function loginComMicrosoft(passwordHint?: string) {
  const provider = criarMicrosoftProvider();
  
  try {
    const result = await signInWithPopup(auth, provider);
    const credential = OAuthProvider.credentialFromResult(result);
    if (credential?.accessToken) {
      setMemoryToken(credential.accessToken);
    }
    corporateSessionUser = null;
    return result;
  } catch (popupErr: any) {
    // Trata caso a conta já exista com credencial de senha/outro provedor
    // Permitindo acesso transparente para quem já tem senha cadastrada
    if (popupErr.code === "auth/account-exists-with-different-credential") {
      const pendingCred = OAuthProvider.credentialFromError(popupErr);
      const email = (popupErr.customData?.email || (popupErr as any).email || "").toLowerCase().trim();

      if (pendingCred) {
        const token = (pendingCred as any).accessToken;
        if (token) {
          setMemoryToken(token);
        }

        // Tenta decodificar o idToken para obter nome e identificador da conta Microsoft
        let displayName = email.split("@")[0] || "Colaborador";
        let uid = `ms_${email}`;
        if ((pendingCred as any).idToken) {
          try {
            const base64Url = (pendingCred as any).idToken.split(".")[1];
            const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
            const jsonPayload = decodeURIComponent(
              atob(base64)
                .split("")
                .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
                .join("")
            );
            const decoded = JSON.parse(jsonPayload);
            if (decoded.name) displayName = decoded.name;
            if (decoded.oid) uid = decoded.oid;
            else if (decoded.sub) uid = decoded.sub;
          } catch {
            // Decodificação opcional
          }
        }

        // Se uma senha foi informada, tenta linkar as credenciais no Firebase
        if (passwordHint) {
          try {
            const userCred = await signInWithEmailAndPassword(auth, email, passwordHint);
            const linkResult = await linkWithCredential(userCred.user, pendingCred);
            const cred = OAuthProvider.credentialFromResult(linkResult);
            if (cred?.accessToken) {
              setMemoryToken(cred.accessToken);
            }
            corporateSessionUser = null;
            return linkResult;
          } catch {
            // Continua com a autenticação corporativa direta
          }
        }

        // Validação de segurança: apenas e-mails @biti9.com.br
        if (!email.endsWith("@biti9.com.br")) {
          throw new Error(`Acesso restrito: A conta Microsoft "${email}" não pertence ao domínio @biti9.com.br.`);
        }

        // Cria a sessão autenticada corporativa
        const corpUser: CorporateUser = {
          uid,
          email,
          displayName,
          photoURL: null,
          providerId: "microsoft.com",
        };
        corporateSessionUser = corpUser;
        emitirMudancaAuth(corpUser);

        return {
          user: corpUser as unknown as User,
          providerId: "microsoft.com",
          operationType: "signIn",
        };
      }
    }

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

// Reautenticação sob demanda (usada em caso de erro 401 ou token ausente)
export async function reautenticarMicrosoft(): Promise<string> {
  const provider = criarMicrosoftProvider();

  if (auth.currentUser) {
    try {
      const result = await reauthenticateWithPopup(auth.currentUser, provider);
      const credential = OAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        setMemoryToken(credential.accessToken);
        return credential.accessToken;
      }
    } catch (reauthErr: any) {
      if (reauthErr.code === "auth/account-exists-with-different-credential") {
        const cred = OAuthProvider.credentialFromError(reauthErr);
        if (cred?.accessToken) {
          setMemoryToken(cred.accessToken);
          return cred.accessToken;
        }
      }
    }
  }

  // Se não houver auth.currentUser ou se estiver em sessão corporativa delegada:
  try {
    const result = await signInWithPopup(auth, provider);
    const credential = OAuthProvider.credentialFromResult(result);
    if (credential?.accessToken) {
      setMemoryToken(credential.accessToken);
      return credential.accessToken;
    }
  } catch (popupErr: any) {
    const cred = OAuthProvider.credentialFromError(popupErr);
    if (cred?.accessToken) {
      setMemoryToken(cred.accessToken);
      return cred.accessToken;
    }
    throw new Error("Sua sessão expirou. Entre novamente.");
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
    if (err.code === "auth/account-exists-with-different-credential") {
      const pendingCred = OAuthProvider.credentialFromError(err);
      const email = (err.customData?.email || (err as any).email || "").toLowerCase().trim();
      if (pendingCred && email && email.endsWith("@biti9.com.br")) {
        const token = (pendingCred as any).accessToken;
        if (token) {
          setMemoryToken(token);
        }
        let displayName = email.split("@")[0] || "Colaborador";
        let uid = `ms_${email}`;
        if ((pendingCred as any).idToken) {
          try {
            const base64Url = (pendingCred as any).idToken.split(".")[1];
            const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
            const jsonPayload = decodeURIComponent(
              atob(base64)
                .split("")
                .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
                .join("")
            );
            const decoded = JSON.parse(jsonPayload);
            if (decoded.name) displayName = decoded.name;
            if (decoded.oid) uid = decoded.oid;
          } catch {}
        }
        const corpUser: CorporateUser = {
          uid,
          email,
          displayName,
          photoURL: null,
          providerId: "microsoft.com",
        };
        corporateSessionUser = corpUser;
        emitirMudancaAuth(corpUser);
        return {
          user: corpUser as unknown as User,
          providerId: "microsoft.com",
          operationType: "signIn",
        };
      }
    }
    throw err;
  }
}

export async function logout() {
  setMemoryToken(null);
  corporateSessionUser = null;
  emitirMudancaAuth(null);
  await signOut(auth);
}

export function observarUsuario(callback: (user: User | CorporateUser | null) => void) {
  authListeners.push(callback);

  // Notifica o estado inicial se já houver sessão corporativa
  if (corporateSessionUser) {
    callback(corporateSessionUser);
  }

  const unsubscribe = onAuthStateChanged(auth, (fbUser) => {
    if (fbUser) {
      corporateSessionUser = null;
      callback(fbUser);
    } else if (corporateSessionUser) {
      callback(corporateSessionUser);
    } else {
      callback(null);
    }
  });

  return () => {
    const idx = authListeners.indexOf(callback);
    if (idx !== -1) {
      authListeners.splice(idx, 1);
    }
    unsubscribe();
  };
}
