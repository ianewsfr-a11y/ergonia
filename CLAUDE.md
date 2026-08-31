# CLAUDE.md — Ergonia

Contexte permanent pour Claude Code. Lis SPEC.md avant toute décision de conception.

## Le projet en une phrase
Place de marché API-only + MCP de tâches vérifiables pour agents IA, en guildes verticales.
Marque : **Ergonia** (ergonia.dev). Première guilde : flightsim.

## Décisions figées (ne pas rediscuter)
- Stack : Cloudflare Worker TypeScript + D1. Déploiement wrangler → workers.dev d'abord.
- API-only : pas de HTML, pas de front. `GET /` = porte text/plain.
- Identité agent = secret `erg_sk_...` montré une fois, stocké hashé (SHA-256).
- Crédits internes uniquement au MVP. Aucun code de paiement réel.
- Registre `events` append-only hash-chaîné pour toute mutation. `GET /api/attest` le vérifie.
- Code original (pas de fork de 1f916). Langue du code, commentaires et porte publique : anglais.
- Quotas quotidiens réinitialisés à 00:00 UTC ; chaque réponse porte `now` et `now_utc`.

## Conventions
- TypeScript strict, pas de `any`. Modules courts, un domaine par fichier
  (`src/router.ts`, `src/society.ts`, `src/tasks.ts`, `src/mcp.ts`, `src/chain.ts`, `src/door.ts`).
- Migrations SQL numérotées dans `/migrations`, appliquées via `wrangler d1 migrations apply`.
- Toute validation d'entrée renvoie 400 avec `{"error": "..."}` explicite ; une écriture
  refusée à la validation ne consomme jamais de quota.
- Tests vitest à côté du code (`*.test.ts`). La boucle de démo complète est testée de bout en bout.
- Jamais de secret en clair dans le repo ni dans les logs. `CLOUDFLARE_API_TOKEN` vient de l'env.
- Commits atomiques en anglais, préfixés (`feat:`, `fix:`, `chore:`).

## Commandes
- `npm run dev` → `wrangler dev` (local, D1 locale)
- `npm test` → vitest
- `npm run deploy` → `wrangler deploy`
- `npm run demo` → `scripts/demo.sh` contre l'URL déployée (variable `ERGONIA_URL`)

## Garde-fous
- Ne pas ajouter de dépendance sans raison écrite dans le commit.
- Ne pas élargir le scope (paiements, guildes multiples actives, front web) : phase 2.
- En cas d'ambiguïté dans SPEC.md : choisir l'option la plus simple, la documenter
  dans `DECISIONS.md`, continuer.
- **No new feature without naming the observed external-user problem it solves.**
  Règle permanente, sans exception. Une feature construite "au cas où" ou pour
  compléter le tableau conceptuel n'entre pas. Le commit doit citer l'observation
  externe qui la justifie (une soumission, un commentaire de tiers, un message
  reçu, un événement chaîné). Reformulation autorisée d'un besoin déjà observé,
  invention de besoin, non.
