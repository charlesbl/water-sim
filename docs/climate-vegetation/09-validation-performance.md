# Étape 09 — Validation, performances et équilibrage

## But

Transformer les prototypes couplés en système fiable. Cette étape consolide les
validateurs développés précédemment, fixe les budgets de performance et règle
les paramètres à partir de scénarios reproductibles plutôt qu'à l'œil seul.

## Dépendances

- Étapes 01 à 08 fonctionnelles.
- Timestamp queries et readbacks asynchrones disponibles quand le GPU les
  supporte.

## Suite de validation

Créer une entrée de validation environnementale distincte de la comparaison
bit à bit historique. Elle exécute de petites grilles déterministes et retourne
un résultat structuré dans `document.body.dataset` comme le validateur actuel.

### Invariants hydriques

Mesurer :

`liquide + solide + sol + vapeur + nuage`

Puis expliquer :

- pluie et neige : transferts internes ;
- évaporation et évapotranspiration : transferts internes ;
- infiltration et drainage de retour : transferts internes ;
- frontière : entrée ou sortie externe comptée ;
- pinceaux : source ou puits utilisateur compté.

Tests :

- monde fermé sans pinceau ;
- monde ouvert avec débit de frontière attendu ;
- cycles répétés gel/fonte ;
- cycles répétés évaporation/précipitation ;
- végétation active.

### Invariants terrain

- roche créée uniquement par réaction eau–lave ou pinceau autorisé ;
- sable total au sol + suspendu conservé hors frontières et pinceaux ;
- végétation ne crée ni ne détruit directement du sable ;
- glace protectrice ne provoque pas de sable négatif.

### Bornes thermiques et dynamiques

- aucune valeur NaN ou infinie ;
- températures dans les bornes physiques du modèle ;
- humidité, nuages et biomasse non négatifs ;
- CFL sous la limite ;
- vent sous sa vitesse maximale ;
- pression sans dérive moyenne incontrôlée.

### Déterminisme

- même seed et commandes : buffers identiques sur la même machine ;
- résultat indépendant du nombre d'images rendues ;
- reset complet ne dépend pas du côté ping-pong précédent ;
- pause/reprise ne change pas le résultat à temps simulé égal.

### Convergence temporelle et spatiale

Comparer :

- un pas climatique contre deux demi-pas ;
- atmosphère 128² contre 256² sur un scénario simple ;
- écologie 256² contre 512² ;
- quantités globales et structures principales, sans exiger l'identité bit à
  bit entre résolutions.

## Tests de scénarios émergents

Créer des fixtures ou paramètres nommés :

- `snowline`;
- `freeze-thaw-basin`;
- `closed-water-cycle`;
- `orographic-rain`;
- `river-vegetation`;
- `drought-and-recovery`;
- `lava-succession`;
- `vegetation-erosion-ab`.

Pour chaque scénario :

- seed ;
- taille ;
- durée simulée ;
- paramètres ;
- métriques attendues ;
- capture finale facultative ;
- tolérances numériques.

Les tests doivent vérifier des relations, par exemple « davantage de pluie au
vent que sous le vent », plutôt qu'une image exacte fragile.

## Budgets de performance

Mesurer au minimum à 256², 1024² et 2048² quand le matériel le permet.

Budgets initiaux à confirmer sur la machine de référence :

- aucun coût environnemental permanent lorsque le système est désactivé ;
- passe physique rapide : régression médiane inférieure à 15 % ;
- atmosphère amortie : moins de 10 % du budget total d'une image ;
- écologie amortie : moins de 5 % ;
- rendu environnemental optionnel : moins de 15 % ;
- mémoire permanente ajoutée à 2048² : cible inférieure à 16 Mio, plafond 32
  Mio sans décision explicite ;
- aucun readback synchrone dans la boucle normale.

Si un budget est dépassé, optimiser dans cet ordre :

1. réduire fréquence ;
2. réduire résolution ;
3. réduire lectures ou fusionner une passe prouvée compatible ;
4. compacter les champs ;
5. simplifier la règle.

Ne pas réduire silencieusement la conservation ou la stabilité pour gagner du
temps GPU.

## Tests longue durée

Faire tourner des scénarios sans interaction pendant au moins :

- 10 000 ticks physiques ;
- 1 000 ticks climatiques ;
- 500 ticks écologiques.

Collecter périodiquement :

- bilan d'eau ;
- extrema ;
- surface végétalisée ;
- énergie cinétique atmosphérique ;
- temps GPU ;
- erreurs WebGPU.

## Méthode d'équilibrage

1. Régler les systèmes isolés.
2. Activer une rétroaction à la fois.
3. Balayer les coefficients sur une petite grille.
4. Conserver des plages stables, pas un unique réglage magique.
5. Tester plusieurs seeds et reliefs.
6. Valider ensuite sur grande grille.

Les paramètres finaux doivent être regroupés en quelques presets cohérents
plutôt qu'en dizaines de sliders.

## Fichiers concernés

- `src/physicsValidation.ts`
- nouveau `src/environmentValidation.ts`
- éventuels shaders de réduction
- scripts ou query parameters de test
- documentation des métriques et presets

## Checklist d'implémentation

- [ ] Regrouper les réductions d'invariants dans un validateur asynchrone.
- [ ] Implémenter toutes les fixtures de scénarios nommées.
- [ ] Ajouter tests de déterminisme, reset, pause et ping-pong.
- [ ] Comparer pas de temps et résolutions.
- [ ] Mesurer médiane/p95 et mémoire pour chaque configuration.
- [ ] Exécuter les tests longue durée avec journal périodique.
- [ ] Optimiser dans l'ordre fréquence, résolution, lectures, compaction.
- [ ] Balayer les coefficients et figer des plages stables.
- [ ] Documenter toute tolérance et tout budget finalement retenu.

## Critères d'acceptation

- Tous les invariants ont un test automatisable ou un diagnostic explicite.
- Les scénarios longs restent bornés et sans erreur GPU.
- Les dépassements de budget sont visibles par pipeline.
- Trois seeds au minimum produisent des structures différentes mais plausibles.
- Les presets finaux respectent les mêmes unités et restent stables lorsque la
  vitesse de rendu varie.
