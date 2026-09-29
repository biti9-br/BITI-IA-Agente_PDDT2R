import React, { useState, useEffect } from "react";
import {
  loginComMicrosoft,
  logout,
  extrairEmailUsuario,
  obterMotivoLogout,
  limparMotivoLogout,
} from "../auth";
import { AlertCircle, Sun, Moon, ArrowRight } from "lucide-react";
import { useTheme } from "../hooks/useTheme";

interface TelaDeLoginProps {
  initialError?: string | null;
}

export default function TelaDeLogin({ initialError }: TelaDeLoginProps) {
  const [erro, setErro] = useState<string>(() => obterMotivoLogout() || (initialError ? traduzErro(initialError) : ""));
  const [carregando, setCarregando] = useState(false);
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    const motivo = obterMotivoLogout();
    if (motivo) {
      setErro(motivo);
    } else if (initialError) {
      setErro(traduzErro(initialError));
    }
  }, [initialError]);

  async function handleMicrosoft() {
    limparMotivoLogout();
    setErro("");
    setCarregando(true);
    try {
      const result = await loginComMicrosoft();
      
      // 2. E-MAIL: Obtenha o e-mail na ordem definida (user.email -> providerData[0].email -> claim email -> preferred_username)
      const userEmail = await extrairEmailUsuario(result.user);

      // 3. NÃO DESLOGAR POR ERRO DE API: Único motivo para signOut() automático: e-mail fora do domínio @biti9.com.br
      if (!userEmail.endsWith("@biti9.com.br")) {
        const motivo = `Sessão encerrada: e-mail fora do domínio permitido (${userEmail || "não informado"})`;
        await logout(motivo);
        setErro(motivo);
        return;
      }
    } catch (err: any) {
      if (err?.code === "auth/popup-closed-by-user") {
        setErro("Autenticação cancelada: A janela de login foi fechada antes da conclusão.");
        return;
      }
      console.error("Erro no login com Microsoft:", err);
      setErro(traduzErro(err.code || err.message));
    } finally {
      setCarregando(false);
    }
  }

  return (
    <div className="min-h-screen w-screen bg-[var(--cor-superficie)] flex flex-col items-center justify-center p-4 selection:bg-blue-100 selection:text-blue-900">
      <div className="relative w-full max-w-[400px] bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)] rounded-2xl p-8 shadow-xl">
        {/* Header com Logo */}
        <div className="flex flex-col items-center mb-8">
          <img
            src="https://www.biti9.com.br/wp-content/uploads/2024/07/LOGO-BRANCA-1024x619.png"
            alt="biti9"
            referrerPolicy="no-referrer"
            className="h-12 sm:h-14 w-auto object-contain mb-4 select-none transition-all duration-200"
            style={{
              filter: theme === "dark" 
                ? "none" 
                : "brightness(0) saturate(100%) invert(13%) sepia(28%) saturate(1982%) hue-rotate(170deg) brightness(96%) contrast(96%)"
            }}
          />
          <h2 className="text-xl sm:text-2xl font-extrabold tracking-tight text-[#0F2942] dark:text-white">
            CHAT PDDxT2R
          </h2>
          <p className="mt-2.5 text-center text-[11px] sm:text-xs text-[var(--cor-texto-secundario)] leading-relaxed">
            Agente de IA da BITi9 que lê documentos, valida e responde perguntas sobre os processos em linguagem natural.
          </p>
        </div>

        {/* Mensagem de Erro */}
        {erro && (
          <div className="mb-6 flex items-start gap-2.5 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-500 text-xs animate-shake">
            <AlertCircle className="w-4 h-4 text-rose-500 flex-shrink-0 mt-0.5" />
            <span>{erro}</span>
          </div>
        )}

        {/* Botão Único de Login Microsoft (Restrito aos colaboradores da BITI9) */}
        <div className="space-y-4">
          <button
            type="button"
            onClick={handleMicrosoft}
            disabled={carregando}
            className="w-full relative flex items-center justify-between gap-3 py-3.5 px-4 sm:px-5 bg-[var(--cor-card-fundo)] hover:bg-[var(--cor-hover)] border border-[var(--cor-borda)] hover:border-[#00a4ef]/70 active:scale-[0.985] text-[var(--cor-texto)] text-sm font-semibold rounded-xl transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 shadow-xs hover:shadow-md hover:shadow-sky-500/10 group select-none"
            title="Autenticação exclusiva para colaboradores da BITI9 via conta corporativa Microsoft"
          >
            {carregando ? (
              <div className="w-full flex items-center justify-center gap-2.5 py-0.5">
                <span className="w-4 h-4 border-2 border-[var(--cor-primaria)] border-t-transparent rounded-full animate-spin"></span>
                <span className="text-xs font-semibold text-[var(--cor-texto)]">Autenticando na Microsoft...</span>
              </div>
            ) : (
              <>
                {/* Logo Oficial Microsoft e Label */}
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-5 h-5 grid grid-cols-2 gap-0.5 flex-shrink-0 p-0.5 rounded-[3px] bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10 group-hover:scale-105 transition-transform duration-200">
                    <span className="w-full h-full bg-[#f25022] rounded-[1px]"></span>
                    <span className="w-full h-full bg-[#7fba00] rounded-[1px]"></span>
                    <span className="w-full h-full bg-[#00a4ef] rounded-[1px]"></span>
                    <span className="w-full h-full bg-[#ffb900] rounded-[1px]"></span>
                  </div>
                  <span className="text-xs sm:text-sm font-semibold text-[var(--cor-texto)] tracking-tight">
                    Entrar com conta Microsoft
                  </span>
                </div>

                {/* Badge BITI9 e seta de transição */}
                <div className="flex items-center gap-1.5 text-[var(--cor-texto-secundario)] group-hover:text-[var(--cor-primaria)] transition-colors duration-200">
                  <span className="text-[10px] font-bold tracking-wider uppercase bg-[var(--cor-superficie)] group-hover:bg-[var(--cor-primaria-clara)] px-2 py-0.5 rounded-md border border-[var(--cor-borda)] group-hover:border-[var(--cor-borda-primaria)] transition-colors">
                    BITI9
                  </span>
                  <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform duration-200" />
                </div>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Alternador de Tema na Tela de Login */}
      <div className="fixed top-4 right-4 z-50">
        <button
          type="button"
          onClick={toggleTheme}
          className="w-7 h-7 rounded-full bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)] hover:bg-[var(--cor-hover)] flex items-center justify-center text-[var(--cor-texto)] transition-all cursor-pointer shadow-xs"
          title={theme === "dark" ? "Alternar para Versão Clara" : "Alternar para Versão Escura"}
          aria-label="Alternar tema"
        >
          {theme === "dark" ? (
            <Sun className="w-3.5 h-3.5 text-white" />
          ) : (
            <Moon className="w-3.5 h-3.5 text-slate-700" />
          )}
        </button>
      </div>
    </div>
  );
}

function traduzErro(codeOrMessage: string) {
  const currentHost = typeof window !== "undefined" ? window.location.hostname : "";
  const mapa: Record<string, string> = {
    "auth/invalid-email": "E-mail inválido.",
    "auth/user-not-found": "Usuário não encontrado.",
    "auth/wrong-password": "Senha incorreta.",
    "auth/email-already-in-use": "Este e-mail já está cadastrado.",
    "auth/weak-password": "Senha muito fraca (mínimo 6 caracteres).",
    "auth/invalid-credential": "Credenciais incorretas.",
    "auth/account-exists-with-different-credential": "Já existe uma conta associada a este e-mail no sistema.",
    "auth/popup-closed-by-user": "Janela de autenticação cancelada pelo usuário.",
    "auth/popup-blocked": "Pop-up bloqueado pelo navegador. Ative as permissões de pop-up ou abra em uma nova aba.",
    "auth/operation-not-allowed": "Provedor Microsoft não ativado no Firebase Console. Utilize a autenticação corporativa direta.",
    "auth/api-key-not-valid": "Chave de API do Firebase não configurada no .env.",
    "auth/unauthorized-domain": `Domínio não autorizado pelo Firebase. Adicione o domínio "${currentHost}" no Firebase Console > Authentication > Settings > Authorized domains.`,
    "auth/operation-not-supported-in-this-environment": "Operação não suportada dentro do iFrame. Abra em nova aba para entrar com a conta Microsoft.",
    "auth/web-storage-unsupported": "Armazenamento bloqueado no iFrame por cookies de terceiros. Abra em nova aba.",
  };

  if (mapa[codeOrMessage]) {
    return mapa[codeOrMessage];
  }

  return `Erro de autenticação (${codeOrMessage}). Verifique se o domínio "${currentHost}" está em Authorized Domains no Firebase.`;
}
