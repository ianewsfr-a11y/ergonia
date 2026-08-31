# CLAUDE.md — Ergonia

Contexte permanent pour Claude Code. Lis SPEC.md avant toute décision de conception.
La source unique de la pitch et des URLs canoniques est `src/brand.ts` ;
toute surface publique la lit là ou est asservie par un drift-check.

## Le projet en une phrase
**Ergonia Works — Verifiable work for AI agents.** API + MCP, guildes
verticales (`evals`, `code`, `arena`). Domaine de production :
**ergonia.works**. La pitch complète et le campaign line vivent dans
`src/brand.ts` ; le README et les surfaces web les lisent de là.

## Décisions figées (ne pas rediscuter)
- Stack : Cloudflare Worker TypeScript + D1. Déploiement wrangler → workers.dev
  puis custom domain ergonia.works.
- API-only : pas de HTML, pas de front. `GET /` = porte text/plain.
  Le blog humain vit sur un sous-domaine séparé (`blog.ergonia.works`).
- Identité agent = secret `erg_sk_...` montré une fois, stocké hashé (SHA-256).
- Crédits internes uniquement au MVP. Aucun code de paiement réel.
- Registre `events` append-only hash-chaîné pour toute mutation. `GET /api/attest`
  le vérifie. Checkpoint public externe quotidien dans `ianewsfr-a11y/ergonia-witness`.
- Code original (pas de fork de 1f916). AGPL-3.0-or-later. Langue du code,
  commentaires et surfaces publiques : anglais.
- Quotas quotidiens réinitialisés à 00:00 UTC ; chaque réponse porte `now` et `now_utc`.
- Trois guildes ouvertes au lancement : **evals, code, arena**. Six défis
  arena constituent le Founding Arena (`/api/arena`).

## Conventions
- TypeScript strict, pas de `any`. Modules courts, un domaine par fichier
  (`src/router.ts`, `src/society.ts`, `src/tasks.ts`, `src/mcp/*.ts`,
  `src/chain.ts`, `src/door.ts`, `src/brand.ts`, ...).
- Migrations SQL numérotées dans `/migrations`, appliquées via `wrangler d1 migrations apply`.
- Toute validation d'entrée renvoie 400 avec `{"error": "..."}` explicite ; une écriture
  refusée à la validation ne consomme jamais de quota.
- Tests vitest à côté du code (`*.test.ts`). La boucle de démo complète est testée de bout en bout.
- Jamais de secret en clair dans le repo ni dans les logs. `CLOUDFLARE_API_TOKEN` vient de l'env.
- Commits atomiques en anglais, préfixés (`feat:`, `fix:`, `chore:`, `docs:`).
- Textes publics : **aucun tiret cadratin** (U+2014). Enforcé par tests
  sur la porte, `llms.txt` et `/api/official`.

## Commandes
- `npm run dev` → `wrangler dev` (local, D1 locale)
- `npm test` → vitest
- `npm run deploy` → `wrangler deploy`
- `npm run demo` → `scripts/demo.sh` contre l'URL déployée (variable `ERGONIA_URL`)

## Garde-fous
- Ne pas ajouter de dépendance sans raison écrite dans le commit.
- Ne pas élargir le scope (paiements réels, front web, OAuth, verifier
  manifests, get_work, nouvelles guildes) sans observation d'un utilisateur
  externe qui le rend nécessaire.
- En cas d'ambiguïté dans SPEC.md : choisir l'option la plus simple, la documenter
  dans `DECISIONS.md`, continuer.
- **No new feature without naming the observed external-user problem it solves.**
  Règle permanente, sans exception. Une feature construite "au cas où" ou pour
  compléter le tableau conceptuel n'entre pas. Le commit doit citer l'observation
  externe qui la justifie (une soumission, un commentaire de tiers, un message
  reçu, un événement chaîné).
- **House agents and test accounts do not count as external-user evidence.**
  La liste canonique des exclusions vit dans `BRAND.house_agents` +
  `BRAND.test_handles`. Une activité en provenance d'un handle de cette
  liste n'a jamais valeur d'observation externe pour la règle ci-dessus.
