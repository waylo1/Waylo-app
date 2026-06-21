---
description: Analyse rapide de l'état du backlog P0 Waylo et retourne les actions prioritaires
argument-hint: "[domaine optionnel: escrow|stripe|ci|db]"
allowed-tools: Bash(git status*), Bash(git log*), Bash(git branch*), Bash(npx tsc*), Bash(gh secret list*), Bash(grep*), Read, Glob
---

# /p0-status — État du backlog P0

Tu es l'architecte senior de Waylo. Produis un **état P0 actionnable** (priorité 0 = bloquant
mise en prod / risque financier). Sois terse, factuel, pas de prose. Domaine ciblé : `$ARGUMENTS`
(si vide → tous les domaines).

## Collecte (exécute en parallèle)

1. **Git** : branche courante, working tree (`git status --short`), divergence vs `origin/main`
   (`git rev-list --left-right --count origin/main...HEAD`), 5 derniers commits.
2. **Typecheck** : `npx tsc --noEmit` → compter les erreurs (0 = vert).
3. **Dette "temporaire"** : `git log --oneline -40 | grep -iE 'temporaire|TEMP|force|HACK|FIXME'`.
4. **Marqueurs code** : `grep -rnE 'TODO|FIXME|XXX|@p0' src/ --include='*.ts'` (hors tests).
5. **Secrets prod** : `gh secret list` → vérifier la présence de `DATABASE_URL`, `JWT_SECRET`,
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_ISSUING_WEBHOOK_SECRET`.
6. **Garde-fous financiers** (rappel `CLAUDE.md` / `gotchas.md`) : toute écriture argent doit être
   en `$transaction()` + transition conditionnelle atomique. Signaler tout écart visible.

## Sortie (format strict)

```
🎯 P0 STATUS — <branche> — <date>

🔴 BLOQUANT (à traiter immédiatement)
  - <action> → <fichier:ligne ou commit> → <pourquoi c'est P0>

🟡 À SURVEILLER (P1, non bloquant)
  - <item> → <référence>

✅ VERT
  - typecheck: <n> erreurs ; secrets prod: <n>/5 ; working tree: <clean|N fichiers>

➡️ PROCHAINE ACTION UNIQUE: <la seule chose à faire maintenant>
```

Règles : 1 ligne = 1 fait. Classe en 🔴 **uniquement** ce qui bloque la prod ou crée un risque
de perte de fonds (escrow non atomique, secret manquant, test rouge, typecheck cassé). Ne propose
jamais de refonte. Termine par **une seule** prochaine action.
