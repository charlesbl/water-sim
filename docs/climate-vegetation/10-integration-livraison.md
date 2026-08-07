# Étape 10 — Intégration, migration et livraison

## But

Livrer le système environnemental sans casser les usages existants, documenter
ses limites et organiser une activation progressive. Cette étape ne doit pas
introduire de nouvelle loi physique majeure.

## Dépendances

- Suite de validation et budgets de l'étape 09 au vert.
- Interface et rendu finalisés.

## Stratégie de flags

Pendant le développement, conserver :

- `environmentEnabled`;
- `atmosphereEnabled`;
- `dynamicWindEnabled`;
- `ecologyEnabled`;
- coefficients individuels de rétroaction en développement ;
- `legacyWeatherMode`.

À la livraison :

- garder un interrupteur global environnement ;
- garder éventuellement les interrupteurs atmosphère/végétation pour les GPU
  modestes ;
- retirer les branches mortes et flags de migration ;
- ne garder `legacyWeatherMode` que si une comparaison ou un usage produit le
  justifie.

## Compatibilité et reset

- Un ancien lancement sans paramètres obtient un preset stable documenté.
- Le reset terrain précise s'il réinitialise aussi climat et végétation.
- Fournir deux actions si nécessaire :
  - réinitialiser le terrain et tout l'environnement ;
  - conserver le terrain et réinitialiser uniquement l'environnement.
- Les query parameters de validation restent réservés au développement.
- Si des snapshots sont supportés, versionner leur schéma ; sinon refuser
  explicitement les anciens formats.

## Presets proposés

Limiter le produit final à quelques situations lisibles :

- **Tempéré** : eau et végétation équilibrées ;
- **Froid** : ligne de neige basse et évaporation réduite ;
- **Aride** : air sec, forte évaporation, végétation rare ;
- **Volcanique** : sources de chaleur et recolonisation lente ;
- **Laboratoire** : accès aux diagnostics, sans prétention de gameplay.

Un preset définit les paramètres initiaux et les lois, pas un calendrier de
pluie.

## Découpage d'intégration recommandé

Même si le plan est développé sur une branche longue, intégrer par lots
révisables :

1. horloge, contrats et instrumentation ;
2. thermique ;
3. cryosphère ;
4. cycle hydrologique ;
5. dynamique atmosphérique ;
6. écologie ;
7. rétroactions ;
8. rendu et HUD ;
9. optimisation et presets.

Chaque lot doit conserver un chemin exécutable et ses propres tests. Éviter une
seule modification mêlant shaders, interface, rendu et équilibrage de toutes
les étapes.

## Documentation utilisateur

Mettre à jour le README principal avec :

- ce qui est simulé ;
- ce qui est simplifié ;
- contrôles ;
- signification des presets ;
- coût matériel indicatif ;
- instructions pour désactiver les couches coûteuses.

Ajouter une note technique courte expliquant :

- les trois résolutions ;
- les réservoirs d'eau ;
- l'origine émergente des précipitations ;
- les limites du modèle 2.5D.

## Qualification finale

Avant activation par défaut :

1. `npm run typecheck`
2. `npm run lint`
3. `npm run build`
4. validation physique legacy
5. validation environnementale complète
6. test longue durée
7. captures desktop et mobile
8. test sur un GPU ne supportant pas timestamp-query
9. test de perte ou recréation du device si possible
10. comparaison des performances avec environnement coupé et activé

## Checklist d'implémentation

- [ ] Auditer et supprimer les flags de migration devenus inutiles.
- [ ] Finaliser resets et éventuelle version de snapshots.
- [ ] Créer et valider les cinq presets.
- [ ] Mettre à jour README et note d'architecture.
- [ ] Exécuter toute la qualification sur configurations de référence.
- [ ] Tester la stratégie de repli sans corruption du ping-pong.
- [ ] Activer par défaut uniquement si budgets et compatibilité sont respectés.
- [ ] Consigner limites connues et futures extensions hors périmètre.

## Plan de repli

Si la configuration ne respecte pas les limites GPU :

1. réduire la résolution atmosphérique ;
2. réduire la résolution écologique ;
3. augmenter les intervalles de mise à jour ;
4. désactiver particules et instances ;
5. désactiver vent dynamique ;
6. revenir au mode physique actuel.

Le repli ne doit jamais modifier les buffers en cours de simulation sans reset
ou migration explicite.

## Critères d'acceptation

- Build, lint, typecheck et validateurs passent.
- Le mode désactivé conserve la simulation d'eau et de sable existante.
- Les presets ne déclenchent ni dérive de masse ni instabilité longue.
- L'utilisateur peut comprendre et désactiver les principaux coûts.
- Les limites du modèle sont documentées honnêtement.
- La météo observée provient des règles et des conditions initiales, pas d'une
  timeline événementielle cachée.

## Résultat attendu

TerraGPU devient une simulation couplée à trois vitesses :

- physique rapide de l'eau, du sable, de la lave et de la glace ;
- atmosphère lente transportant chaleur et eau ;
- écosystème très lent transformant le sol et rétroagissant sur le climat.

Cette séparation est la condition principale pour obtenir un monde vivant sans
perdre la performance ni la lisibilité du modèle.
