# Bull Racing OS

Sistema de gestão da equipe Bull Racing Formula SAE. O frontend continua sendo
HTML/JavaScript estático e pode ser publicado gratuitamente no GitHub Pages. Os
dados compartilhados são armazenados no Supabase com autenticação, permissões,
controle de versão e histórico das últimas 100 alterações.

## Situação atual

- Sem configuração do Supabase, o sistema funciona em modo local e preserva o
  comportamento antigo (`localStorage` e backup JSON).
- Com Supabase configurado, usuários autenticados carregam a base da equipe.
- Administradores e editores salvam automaticamente.
- Visualizadores apenas consultam.
- Administradores aprovam usuários, alteram permissões e restauram versões pelo
  próprio sistema, sem precisar editar tabelas no Supabase.
- Uma gravação concorrente nunca sobrescreve silenciosamente a versão de outro
  computador: o sistema detecta conflito e recarrega a versão remota.

## Configuração do Supabase

1. Crie um projeto gratuito em <https://supabase.com/dashboard>.
2. Abra **SQL Editor**, cole todo o conteúdo de `supabase/schema.sql` e execute.
3. Em **Project Settings > API**, copie a Project URL e a chave `anon` ou
   `publishable`. Nunca use a chave `service_role` no navegador.
4. Preencha `supabaseUrl` e `supabaseAnonKey` em `config.js`.
5. Abra o sistema, clique em **Entrar para sincronizar** e use **Criar primeiro
   acesso**. A primeira conta criada recebe papel de administrador.
6. Depois do primeiro acesso, desative novos cadastros públicos no painel de
   autenticação. Crie ou convide as demais contas pelo painel.

Contas posteriores entram como `viewer` inativo. Para aprovar uma conta, o
administrador abre o indicador **Nuvem** no canto inferior direito e seleciona
**Gerenciar acessos**.

## Publicação no GitHub Pages

O workflow `.github/workflows/pages.yml` publica automaticamente quando a
branch `main` recebe um push. No repositório do GitHub, configure **Settings >
Pages > Source** como **GitHub Actions**.

## Recuperação e segurança

- O botão existente **Exportar** continua produzindo um backup JSON.
- Antes de substituir dados locais por dados remotos diferentes, o sistema cria
  uma cópia no `localStorage` com a chave `bull_cloud_pre_pull_backup_bull-racing`.
- O banco mantém as últimas 100 versões em `team_state_history`.
- Telefones e dados financeiros não devem ser publicados dentro do repositório;
  eles ficam no banco protegido pelas políticas de acesso.
