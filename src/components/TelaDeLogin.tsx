import React, { useState, useEffect } from "react";
import { login, cadastrar, loginComMicrosoft, logout } from "../auth";
import { Lock, Mail, AlertCircle, ArrowRight, ExternalLink, Sun, Moon } from "lucide-react";
import { useTheme } from "../hooks/useTheme";

export function validarEmailBiti9(email: string): boolean {
  const regex = /^[a-zA-Z0-9._%+-]+@biti9\.com\.br$/i;
  return regex.test(email.trim());
}

interface TelaDeLoginProps {
  initialError?: string | null;
}

export default function TelaDeLogin({ initialError }: TelaDeLoginProps) {
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState(initialError ? traduzErro(initialError) : "");
  const [carregando, setCarregando] = useState(false);
  const { theme, toggleTheme } = useTheme();

  const isInIframe = typeof window !== "undefined" && window.self !== window.top;

  useEffect(() => {
    if (initialError) {
      setErro(traduzErro(initialError));
    }
  }, [initialError]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErro("");

    const emailLimpo = email.trim().toLowerCase();
    if (!validarEmailBiti9(emailLimpo)) {
      setErro("Acesso restrito: O e-mail deve pertencer ao domínio corporativo @biti9.com.br.");
      return;
    }

    const senhaFinal = senha.trim();
    if (!senhaFinal) {
      setErro("Por favor, digite sua senha.");
      return;
    }

    setCarregando(true);
    try {
      try {
        await login(emailLimpo, senhaFinal);
        return;
      } catch (loginErr: any) {
        if (
          loginErr?.code === "auth/user-not-found" ||
          loginErr?.code === "auth/invalid-credential"
        ) {
          await cadastrar(emailLimpo, senhaFinal);
          return;
        }
        throw loginErr;
      }
    } catch (err: any) {
      console.error("Erro no login por e-mail/senha:", err);
      setErro(traduzErro(err.code || err.message));
    } finally {
      setCarregando(false);
    }
  }

  async function handleMicrosoft() {
    setErro("");
    setCarregando(true);
    try {
      const result = await loginComMicrosoft(senha.trim());
      const userEmail = result.user?.email?.toLowerCase().trim() || "";

      // Após o login, só permita acesso se user.email terminar com '@biti9.com.br'; caso contrário, faça signOut().
      if (!userEmail.endsWith("@biti9.com.br")) {
        await logout();
        setErro(`Acesso restrito: A conta Microsoft "${userEmail}" não pertence ao domínio @biti9.com.br. Apenas colaboradores da BITI9 podem acessar este sistema.`);
        return;
      }
    } catch (err: any) {
      if (err?.code === "auth/popup-closed-by-user") {
        return;
      }
      console.error("Erro no login com Microsoft:", err);
      setErro(traduzErro(err.code || err.message));
    } finally {
      setCarregando(false);
    }
  }

  function handleOpenInNewTab() {
    window.open(window.location.href, "_blank");
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
            className="h-14 sm:h-16 w-auto object-contain mb-5 select-none transition-all duration-200"
            style={{
              filter: theme === "dark" 
                ? "none" 
                : "brightness(0) saturate(100%) invert(13%) sepia(28%) saturate(1982%) hue-rotate(170deg) brightness(96%) contrast(96%)"
            }}
          />
          <h2 className="text-xl font-semibold text-[var(--cor-texto)] tracking-tight">
            Entrar na plataforma
          </h2>
          <p className="text-xs text-[var(--cor-texto-secundario)] mt-1 text-center">
            Acesse o painel centralizado de automações, PDD e T2R
          </p>
        </div>

        {/* Mensagem de Erro */}
        {erro && (
          <div className="mb-5 flex items-start gap-2.5 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-500 text-xs animate-shake">
            <AlertCircle className="w-4 h-4 text-rose-500 flex-shrink-0 mt-0.5" />
            <span>{erro}</span>
          </div>
        )}

        {/* Formulário de Login */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-[var(--cor-texto)] mb-1.5">
              E-mail corporativo
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-[var(--cor-texto-secundario)] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="email"
                placeholder="nome.sobrenome@biti9.com.br"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full bg-[var(--cor-superficie)] border border-[var(--cor-borda)] rounded-xl pl-10 pr-3.5 py-2.5 text-xs text-[var(--cor-texto)] placeholder-[var(--cor-texto-secundario)] focus:outline-none focus:border-[var(--cor-primaria)] focus:bg-[var(--cor-card-fundo)] focus:ring-1 focus:ring-[var(--cor-primaria)]/20 transition-all font-sans"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--cor-texto)] mb-1.5">
              Senha de acesso
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-[var(--cor-texto-secundario)] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="password"
                placeholder="••••••••"
                value={senha}
                onChange={(e) => setSenha(e.target.value)}
                required
                minLength={6}
                className="w-full bg-[var(--cor-superficie)] border border-[var(--cor-borda)] rounded-xl pl-10 pr-3.5 py-2.5 text-xs text-[var(--cor-texto)] placeholder-[var(--cor-texto-secundario)] focus:outline-none focus:border-[var(--cor-primaria)] focus:bg-[var(--cor-card-fundo)] focus:ring-1 focus:ring-[var(--cor-primaria)]/20 transition-all font-sans"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={carregando}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-[var(--cor-balaousuario-fundo)] hover:opacity-90 text-white text-sm font-semibold rounded-xl shadow-xs transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed mt-2"
          >
            {carregando ? (
              <span className="inline-flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                Aguarde...
              </span>
            ) : (
              <>
                <span>Entrar</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        {/* Divisor */}
        <div className="flex items-center my-6">
          <div className="flex-1 border-t border-[var(--cor-borda)]"></div>
          <span className="px-3 text-xs text-[var(--cor-texto-secundario)] font-medium">
            ou
          </span>
          <div className="flex-1 border-t border-[var(--cor-borda)]"></div>
        </div>

        {/* Botão Microsoft (Restrito aos colaboradores da BITI9) */}
        <button
          type="button"
          onClick={handleMicrosoft}
          disabled={carregando}
          className="w-full flex items-center justify-center gap-3 py-2.5 px-4 bg-[var(--cor-card-fundo)] hover:bg-[var(--cor-hover)] border border-[var(--cor-borda)] hover:border-[#00a4ef]/60 text-[var(--cor-texto)] text-sm font-medium rounded-xl transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shadow-2xs group"
          title="Autenticação restrita para funcionários da BITI9 via conta corporativa Microsoft"
        >
          {/* Logo Oficial Microsoft (4 quadrados coloridos) */}
          <div className="w-4 h-4 grid grid-cols-2 gap-0.5 flex-shrink-0">
            <span className="w-1.5 h-1.5 bg-[#f25022] rounded-[0.5px]"></span>
            <span className="w-1.5 h-1.5 bg-[#7fba00] rounded-[0.5px]"></span>
            <span className="w-1.5 h-1.5 bg-[#00a4ef] rounded-[0.5px]"></span>
            <span className="w-1.5 h-1.5 bg-[#ffb900] rounded-[0.5px]"></span>
          </div>
          <span className="font-semibold text-xs sm:text-sm">Entrar com a conta Microsoft</span>
          <span className="ml-auto text-[10px] font-semibold tracking-wider uppercase text-[var(--cor-texto-secundario)] bg-[var(--cor-superficie)] px-1.5 py-0.5 rounded border border-[var(--cor-borda)]">
            BITI9
          </span>
        </button>

        {/* Aviso de acesso restrito aos funcionários da BITI9 */}
        <p className="text-[11px] text-[var(--cor-texto-secundario)] text-center mt-2.5 leading-relaxed">
          Acesso exclusivo para colaboradores da <strong className="text-[var(--cor-texto)] font-semibold">BITI9</strong> (@biti9.com.br).
        </p>

        {/* Dica para iFrame / Nova Aba */}
        {isInIframe && (
          <div className="mt-3 p-2.5 rounded-lg bg-[var(--cor-primaria-clara)] border border-[var(--cor-borda-primaria)] text-xs text-[var(--cor-texto-secundario)] text-center">
            <span>Para melhor compatibilidade com o login Microsoft no preview: </span>
            <button
              onClick={handleOpenInNewTab}
              className="text-[var(--cor-primaria)] hover:text-[var(--cor-texto)] underline font-medium inline-flex items-center gap-1 ml-1 cursor-pointer"
            >
              <span>Abrir em nova aba</span>
              <ExternalLink className="w-3 h-3" />
            </button>
          </div>
        )}
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
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/account-exists-with-different-credential": "Já existe uma conta com este e-mail no sistema. Digite sua senha no campo acima e clique em 'Entrar com a conta Microsoft' para vinculá-las.",
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
