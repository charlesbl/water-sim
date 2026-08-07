# Étape 03 — Gel, glace, neige et fonte

## But

Ajouter un réservoir d'eau solide conservatif. L'eau doit geler et fondre selon
la chaleur disponible, modifier les hauteurs et les flux, protéger le terrain
de l'érosion et préparer l'arrivée ultérieure de neige atmosphérique.

## Dépendances

- Température de surface stable de l'étape 02.
- Pas de temps fixe et bilan hydrique instrumentable.

## Représentation

Utiliser `FluidCell.solid_water` comme hauteur en équivalent eau. Dans un
premier modèle, glace de lac et neige au sol partagent ce réservoir :

- sur une cellule contenant de l'eau, elle est rendue comme glace ;
- sur une cellule principalement terrestre, elle est rendue comme neige ;
- la densité visuelle peut différer sans modifier la masse conservée.

Une séparation glace/neige ne sera envisagée que si des mécaniques différentes
la rendent nécessaire après validation du modèle simple.

## Règle de changement de phase

Éviter un seuil binaire. Pour chaque tick :

1. Calculer l'échange thermique net vers la cellule.
2. Si de l'eau liquide existe et que l'énergie nette est négative à proximité
   de `0 °C`, utiliser cette énergie pour convertir de l'eau en solide.
3. Tant que le changement de phase se poursuit, maintenir la température près
   de `0 °C` pour représenter la chaleur latente.
4. Si de l'eau solide existe et que l'énergie nette est positive, effectuer la
   conversion inverse.
5. Appliquer des vitesses maximales de gel et de fonte exprimées par seconde.

Invariant local avant prise en compte des frontières :

`water_before + solid_before = water_after + solid_after`

Les petites valeurs sont remises à zéro avec un epsilon commun documenté.

## Couplage avec l'hydraulique

Modifier `simFlux.wgsl` :

- seul `water` est disponible pour les flux ;
- `solid_water` contribue à la hauteur solide ;
- une couche de glace n'est pas transportée par les flux liquides ;
- la hauteur d'eau utilisée par le solveur devient
  `rock + sand + solid_water + lava + water`.

Au bord :

- un réservoir marin imposé injecte de l'eau liquide à sa température de bord ;
- il ne crée pas automatiquement de glace ;
- l'eau solide peut fondre ou rester sur la dernière cellule, mais ne doit pas
  être supprimée silencieusement.

## Couplage avec sable et érosion

- Sous une couverture solide suffisante, réduire fortement l'érosion.
- La neige augmente la charge mais ne déclenche pas, dans cette étape,
  d'avalanche nivale séparée.
- Lorsqu'une eau chargée en sédiments gèle, laisser le mécanisme existant
  déposer le sédiment au tick suivant si l'eau liquide devient insuffisante.
  Ajouter un test pour confirmer qu'aucune masse de sable ne disparaît.
- À la fonte, l'eau libérée redevient immédiatement disponible pour le flux et
  peut produire une crue.

## Rendu provisoire

- glace : surface translucide plus opaque et plus rugueuse que l'eau ;
- neige : matériau clair augmentant l'albédo ;
- transition progressive selon l'épaisseur ;
- température et eau solide disponibles comme vues de diagnostic.

Le rendu final est traité à l'étape 08 ; ici il doit surtout rendre les erreurs
de phase visibles.

## Paramètres

- point de fusion ;
- chaleur latente effective ;
- vitesse maximale de gel ;
- vitesse maximale de fonte ;
- albédo de l'eau solide ;
- seuil de protection contre l'érosion.

Ces paramètres restent internes jusqu'à l'équilibrage.

## Fichiers concernés

- `src/shaders/simFlux.wgsl`
- `src/shaders/simFluids.wgsl`
- `src/shaders/simTerrainFlow.wgsl`
- `src/shaders/simTerrain.wgsl`
- `src/shaders/simSurfaceThermal.wgsl`
- `src/shaders/render.wgsl`
- `src/webgpuRenderer.ts`
- tests de bilan hydrique et de changement de phase

## Checklist d'implémentation

- [ ] Ajouter le calcul énergétique gel/fonte dans `simSurfaceState`.
- [ ] Faire contribuer `solid_water` à la hauteur mais pas aux flux liquides.
- [ ] Définir les règles de bord pour l'eau solide.
- [ ] Réduire érosion et transport sous couverture glacée.
- [ ] Adapter reset, pinceau effaceur et réactions eau–lave.
- [ ] Ajouter les matériaux provisoires glace/neige.
- [ ] Étendre le bilan global au réservoir solide.
- [ ] Valider gel, fonte, sédiments et cycles autour de zéro.

## Scénarios de test

1. Bassin fermé froid : l'eau gèle sans variation de masse totale.
2. Bassin gelé réchauffé : toute la glace redevient liquide.
3. Alternance autour de zéro : pas de clignotement ni création de masse.
4. Lac partiellement gelé sur pente thermique : le front de glace progresse
   depuis la zone froide.
5. Fonte rapide en altitude : l'eau libérée s'écoule et transporte le sable.
6. Eau et lave : la chaleur retarde ou inverse localement le gel.
7. Test frontière : le bilan explique précisément les entrées et sorties.

## Critères d'acceptation

- Erreur relative de masse eau liquide + solide inférieure au seuil défini par
  le validateur sur un bassin fermé.
- Aucun flux ne transporte plus d'eau que la quantité liquide disponible.
- Gel et fonte sont progressifs et indépendants du framerate.
- L'eau solide influence hauteur, albédo et érosion.
- Le coût mémoire pleine résolution n'augmente pas par rapport à l'étape 02.
