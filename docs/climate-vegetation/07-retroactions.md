# Étape 07 — Rétroactions climat–végétation–terrain

## But

Passer d'une végétation spectatrice à un système couplé. La biomasse doit
modifier l'eau, l'érosion et le microclimat, sans créer de boucle incontrôlée.

## Dépendances

- Étape 06 validée en couplage à sens unique.
- Bilans hydrique, thermique et écologique observables.

## Rétroactions à introduire séparément

Chaque rétroaction est ajoutée derrière un coefficient indépendant, avec un
test A/B coefficient zéro contre coefficient nominal.

### Infiltration et rétention

- racines et litière augmentent la capacité d'infiltration ;
- biomasse réduit le ruissellement immédiat ;
- litière ralentit l'évaporation du sol ;
- la capacité reste bornée pour éviter un puits d'eau sans limite.

### Stabilisation du terrain

- augmenter localement le seuil de repos statique du sable ;
- réduire le taux d'érosion hydraulique ;
- ne jamais stabiliser la roche ou un terrain submergé par la lave ;
- limiter l'effet par la profondeur effective des racines.

Le shader terrain échantillonne la biomasse écologique. L'interpolation doit
être douce afin de ne pas révéler la grille plus grossière.

### Évapotranspiration

- retirer une quantité bornée d'humidité du sol ;
- ajouter exactement cette quantité à la vapeur atmosphérique ;
- refroidir la surface selon la chaleur latente effective ;
- dépendre de biomasse, température, lumière et déficit de saturation.

Cette boucle est le principal mécanisme par lequel la végétation humidifie et
refroidit son environnement.

L'atmosphère produit un budget d'évapotranspiration à partir du résumé
écologique. Une passe `applyAtmosphereEcologyExchange` retire ensuite ce budget
du côté écologique courant et écrit l'autre côté, sans recalculer croissance
ou mortalité. L'ordonnanceur tient donc séparément les bascules dues à un tick
écologique et celles dues à un échange climatique.

### Albédo et ombrage

- interpoler l'albédo entre substrat nu et couverture végétale ;
- ajouter un refroidissement de surface par ombrage ;
- conserver des coefficients séparés : une forêt sombre peut absorber plus de
  lumière tout en refroidissant par évapotranspiration ;
- éviter un unique curseur « végétation refroidit » qui masquerait ces effets
  opposés.

### Rugosité atmosphérique

- la végétation augmente le frottement du vent près de la surface ;
- l'effet dépend de la biomasse, pas d'instances d'arbres rendues ;
- limiter la décélération par tick pour préserver la stabilité.

### Fertilité et sédiments

- le dépôt de sédiments peut améliorer lentement la fertilité ;
- l'érosion retire proportionnellement litière et fertilité ;
- les zones fraîchement déposées restent peu végétalisées puis se colonisent.

## Prévention des emballements

Mettre en place :

- saturation douce de chaque rétroaction ;
- vitesses maximales par seconde ;
- hystérésis entre mort et recolonisation ;
- temps de réponse différents pour sol, plante et atmosphère ;
- coefficients nominaux centralisés ;
- possibilité de couper chaque rétroaction à chaud en développement.

Éviter les corrections globales artificielles du type « si trop de désert,
faire pleuvoir ». L'équilibre doit venir des ressources et des lois locales.

## Matrice d'expériences

Comparer au minimum :

| Expérience | Eau | Climat | Végétation | Rétroactions           |
| ---------- | --- | ------ | ---------- | ---------------------- |
| Contrôle   | oui | oui    | non        | non                    |
| Réactive   | oui | oui    | oui        | non                    |
| Hydrologie | oui | oui    | oui        | infiltration seulement |
| Atmosphère | oui | oui    | oui        | ET + albédo + rugosité |
| Complète   | oui | oui    | oui        | toutes                 |

Mesurer surface végétalisée, humidité moyenne, précipitation, érosion et erreur
de masse sur le même seed.

## Scénarios émergents attendus

1. Les berges végétalisées résistent mieux à l'érosion que le sable nu.
2. Une région verte conserve plus longtemps son humidité après l'arrêt de la
   pluie.
3. La disparition de végétation augmente ruissellement et érosion.
4. Une grande zone végétalisée augmente légèrement humidité ou précipitation
   sous le vent.
5. Une sécheresse peut provoquer un recul progressif, pas une mort simultanée
   de toute la carte.
6. Après retour de conditions favorables, la recolonisation part des refuges.

## Fichiers concernés

- shaders terrain et terrain-flow
- shader écologique
- shaders de résumé de surface et atmosphère
- configuration des rétroactions
- rendu des diagnostics
- scénarios de validation couplée

## Checklist d'implémentation

- [ ] Ajouter les coefficients derrière des flags de développement.
- [ ] Coupler biomasse à infiltration et rétention.
- [ ] Échantillonner racines dans érosion et angle de repos.
- [ ] Ajouter budget et passe conservatrice d'évapotranspiration.
- [ ] Coupler albédo et ombrage au thermique.
- [ ] Coupler biomasse à la rugosité du vent.
- [ ] Relier sédiments, litière et fertilité.
- [ ] Exécuter la matrice A/B puis régler plafonds et hystérésis.
- [ ] Valider les scénarios émergents sans correction globale cachée.

## Critères d'acceptation

- Chaque échange d'eau entre sol, plante et atmosphère est conservatif.
- Couper un coefficient retrouve le comportement de l'étape 06.
- Les effets restent lisses malgré les différences de résolution.
- Aucun scénario nominal ne converge systématiquement vers tout vert ou tout
  désert.
- Au moins trois phénomènes attendus apparaissent sans masque géographique ni
  événement météo programmé.
