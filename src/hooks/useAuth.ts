import { useState, useEffect } from "react";
import {
  observarUsuario,
  logout as authLogout,
  verificarResultadoRedirect,
  extrairEmailUsuario,
  obterMotivoLogout,
} from "../auth";
import { auth } from "../firebase";
import { garantirUsuario } from "../services/usuarios";
import type { User as FirebaseUser } from "firebase/auth";

export type AppUser = FirebaseUser;

export function useAuth() {
  const [usuario, setUsuario] = useState<AppUser | null>(null);
  const [carregandoAuth, setCarregandoAuth] = useState(true);
  const [userEmail, setUserEmail] = useState<string>("");
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    let montado = true;

    async function inicializarAutenticacao() {
      // 4. AGUARDAR O FIREBASE:
      // Antes de qualquer verificação de sessão ou chamada à API, aguarde await auth.authStateReady().
      // Não trate currentUser null como logout enquanto o Firebase ainda carrega.
      if (typeof auth.authStateReady === "function") {
        await auth.authStateReady();
      }

      // Checa resultado de redirect se houver
      verificarResultadoRedirect().catch((err) => {
        console.warn("Aviso no redirect de autenticação:", err);
      });

      // Observador do Firebase Auth
      const unsubscribe = observarUsuario(async (fbUser) => {
        if (!montado) return;

        if (fbUser) {
          // 2. E-MAIL: Obtenha o e-mail na ordem definida (user.email -> providerData[0].email -> claim email -> preferred_username)
          const emailResolvido = await extrairEmailUsuario(fbUser);

          // 3. NÃO DESLOGAR POR ERRO DE API
          // Único motivo para signOut() automático: e-mail fora do domínio @biti9.com.br
          if (!emailResolvido.endsWith("@biti9.com.br")) {
            const motivo = `Sessão encerrada: e-mail fora do domínio permitido (${emailResolvido || "não informado"})`;
            console.warn(`[useAuth] ${motivo}`);
            await authLogout(motivo);
            if (montado) {
              setAuthError(motivo);
              setUsuario(null);
              setUserEmail("");
              setCarregandoAuth(false);
            }
            return;
          }

          if (montado) {
            setUsuario(fbUser);
            setUserEmail(emailResolvido);
            setAuthError(null);
            setCarregandoAuth(false);
          }

          await garantirUsuario(fbUser, emailResolvido);
        } else {
          if (montado) {
            setUsuario(null);
            setUserEmail("");
            const motivoRegistrado = obterMotivoLogout();
            if (motivoRegistrado) {
              setAuthError(motivoRegistrado);
            }
            setCarregandoAuth(false);
          }
        }
      });

      return unsubscribe;
    }

    let unsub: (() => void) | undefined;
    inicializarAutenticacao().then((fn) => {
      unsub = fn;
    });

    return () => {
      montado = false;
      if (unsub) unsub();
    };
  }, []);

  const logout = async (motivo?: string) => {
    await authLogout(motivo);
    setUsuario(null);
    setUserEmail("");
  };

  return {
    usuario,
    carregandoAuth,
    userEmail,
    authError,
    logout,
  };
}

export default useAuth;
