import { useState, useEffect } from "react";
import {
  observarUsuario,
  logout as authLogout,
  verificarResultadoRedirect,
} from "../auth";
import { garantirUsuario } from "../services/usuarios";
import type { User as FirebaseUser } from "firebase/auth";
import type { CorporateUser } from "../auth";

export type AppUser = FirebaseUser | CorporateUser;

export function useAuth() {
  const [usuario, setUsuario] = useState<AppUser | null>(null);
  const [carregandoAuth, setCarregandoAuth] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    let montado = true;

    // 1. Checa resultado de redirect (Microsoft / Provedor)
    verificarResultadoRedirect()
      .then(async (result) => {
        if (!montado) return;
        if (result?.user) {
          const userEmail = result.user.email?.toLowerCase().trim() || "";
          if (!userEmail.endsWith("@biti9.com.br")) {
            await authLogout();
            if (montado) {
              setAuthError(`Acesso negado: O e-mail "${userEmail}" não pertence ao domínio corporativo @biti9.com.br.`);
              setUsuario(null);
              setCarregandoAuth(false);
            }
            return;
          }
          if (montado) {
            setUsuario(result.user);
          }
          await garantirUsuario(result.user);
        }
      })
      .catch((err) => {
        console.error("Erro no redirect de autenticação:", err);
        if (montado) {
          setAuthError(err.code || err.message);
        }
      });

    // 2. Observador oficial do Firebase Auth
    const unsubscribe = observarUsuario(async (user) => {
      if (!montado) return;
      if (user) {
        const userEmail = user.email?.toLowerCase().trim() || "";
        if (userEmail && !userEmail.endsWith("@biti9.com.br")) {
          await authLogout();
          if (montado) {
            setAuthError("Acesso restrito: Apenas colaboradores da BITI9 (@biti9.com.br) têm autorização para acessar.");
            setUsuario(null);
            setCarregandoAuth(false);
          }
          return;
        }
        if (montado) {
          setUsuario(user);
        }
        await garantirUsuario(user);
      } else {
        if (montado) {
          setUsuario(null);
        }
      }
      if (montado) {
        setCarregandoAuth(false);
      }
    });

    return () => {
      montado = false;
      unsubscribe();
    };
  }, []);

  const logout = async () => {
    await authLogout();
    setUsuario(null);
  };

  const userEmail = usuario?.email || "";

  return {
    usuario,
    carregandoAuth,
    userEmail,
    authError,
    logout,
  };
}

export default useAuth;
